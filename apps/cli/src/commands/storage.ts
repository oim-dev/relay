import type { Command } from "commander";
import { InvalidArgumentError, Option } from "commander";
import { isAbsolute, resolve } from "node:path";
import { StorageService } from "@relay/core/application/storage/service";
import { AppError } from "@relay/core/shared/errors";
import {
  STORAGE_MAINTENANCE_ERROR_EXIT_CODES,
  storageMigrateOptionsSchema,
} from "@relay/contracts/storage-maintenance";
import type {
  StorageMaintenanceErrorCode,
  StorageStatus,
} from "@relay/contracts/storage-maintenance";
import { commandGroup, createCommand, registerCommand } from "../command.js";
import type { Runtime } from "../context.js";
import { author } from "../context.js";
import { randomUUID } from "node:crypto";
import { receiptText } from "../presentation/common.js";
import { commandInvocation } from "../command-kit.js";
import {
  inspectStorage,
  maintenanceAction,
  migrateStorage,
  planStorageMigration,
} from "../maintenance.js";
import { PresentedError } from "../output.js";
import {
  storagePlanText,
  storageMigrationText,
  storageStatusText,
  storageStatusTitle,
} from "../presentation/storage.js";
import type { Invocation } from "../presentation/storage.js";

const CONFIG = "/project/.relay/config.json";
const PREFIX = `npx @oim-dev/relay-cli --local --config ${CONFIG}`;
const UNSUPPORTED: readonly StorageMaintenanceErrorCode[] = [
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_TRANSITION_MISSING",
  "UNKNOWN_ENTITY_KIND",
  "STORAGE_FORMAT_UNKNOWN",
];

/** Машинная причина ненулевого статуса: представление §5.3, не правило миграции. */
function statusCode(status: StorageStatus): StorageMaintenanceErrorCode {
  if (status.status === "recovery-required") return "STORAGE_RECOVERY_REQUIRED";
  if (status.status === "unsupported") {
    if (status.pending?.kind === "unknown") return "STORAGE_VERSION_UNSUPPORTED";
    return (
      status.blockers.find((blocker) => UNSUPPORTED.includes(blocker.code))?.code ??
      "STORAGE_FORMAT_UNKNOWN"
    );
  }
  return status.blockers[0]?.code ?? "STORAGE_FORMAT_UNKNOWN";
}

/** Ненулевой статус: AppError с кодом причины и details = полный отчёт без содержания. */
function statusFailure(status: StorageStatus, invocation: Invocation, message: string) {
  const code = statusCode(status);
  return new PresentedError(
    code,
    message,
    STORAGE_MAINTENANCE_ERROR_EXIT_CODES[code],
    status,
    (options) => storageStatusText(status, invocation, options),
  );
}

function registerMaintenance(group: Command, runtime: Runtime): void {
  const status = createCommand(group, {
    name: "status",
    description: "Проверить версии и пригодность базы без изменения файлов",
    details:
      "Диагностика начинается с минимального чтения конфигурации и manifest; текущая схема проекта не требуется, поэтому команда работает и для базы старой версии. Не создаёт базу, не выполняет recovery, reindex, миграцию или очистку; временный замок удаляется. Статусы: current и migration-required — exit 0; recovery-required, unsupported и invalid — ненулевой exit с машинной причиной и полным отчётом в details. Только локально: в HTTP-режиме LOCAL_REQUIRED без запроса к Server.",
    examples: [
      [`${PREFIX} storage status`, "Проверить состояние базы проекта"],
      [`${PREFIX} --format json storage status`, "Получить машинный отчёт storageStatusSchema"],
      [
        "npx @oim-dev/relay-cli --local --config relay.workspace.json --project web storage status",
        "Проверить проект, выбранный из workspace-реестра",
      ],
    ],
  });
  maintenanceAction(status, runtime, async (context) => {
    const data = await inspectStorage({ configPath: context.target.configPath });
    if (data.status !== "current" && data.status !== "migration-required")
      throw statusFailure(data, context.invocation, storageStatusTitle(data));
    return {
      data,
      text: (options) => storageStatusText(data, context.invocation, options),
    };
  });

  const migrate = createCommand(group, {
    name: "migrate",
    description: "Проверить план или перенести базу в актуальный формат",
    details:
      "Перед переносом остановите процессы Relay. --dry-run строит и проверяет точный план изолированно: база и backup не создаются и не меняются, ответ содержит planFingerprint. Без --dry-run команда сама строит свежий план под замком; --if-plan останавливает исполнение до изменений, если база или реестр переходов изменились после dry-run. --backup-dir обязателен для изменяющего переноса и должен находиться вне базы; при no-op копия не создаётся. Второго подтверждения нет: migrate — явная команда записи. ID, ключи, алиасы, тексты, ревизии и комментарии сохраняются; история запросов не переносится. Только локально: в HTTP-режиме LOCAL_REQUIRED без запроса к Server.",
    examples: [
      [`${PREFIX} storage migrate --dry-run`, "Проверить точный план без изменения базы"],
      [
        `${PREFIX} storage migrate --backup-dir /backups/relay-project --if-plan PLAN_FINGERPRINT`,
        "Перенести базу по проверенному плану с резервной копией",
      ],
    ],
    configure: (command) =>
      command
        .addOption(
          new Option(
            "--dry-run",
            "Построить и проверить план без изменения базы и без backup",
          ).conflicts("ifPlan"),
        )
        .option(
          "--backup-dir <dir>",
          "Каталог резервной копии вне базы; обязателен для изменяющего переноса",
        )
        .option(
          "--if-plan <fingerprint>",
          "planFingerprint из --dry-run; несовпадение останавливает до изменений",
          (value) => {
            if (!storageMigrateOptionsSchema.shape.ifPlan.unwrap().safeParse(value).success)
              throw new InvalidArgumentError(
                "Ожидается planFingerprint из storage migrate --dry-run: 64 шестнадцатеричных символа",
              );
            return value;
          },
        ),
  });
  maintenanceAction<{ dryRun?: boolean; backupDir?: string; ifPlan?: string }>(
    migrate,
    runtime,
    async (context, options) => {
      const target = { configPath: context.target.configPath };
      if (options.dryRun) {
        const plan = await planStorageMigration(target);
        if (!plan.applicable) {
          const code =
            plan.status === "migration-required" || plan.status === "current"
              ? (plan.blockers[0]?.code ?? "STORAGE_FORMAT_UNKNOWN")
              : statusCode(plan);
          throw new PresentedError(
            code,
            "План переноса неприменим — база не изменена",
            STORAGE_MAINTENANCE_ERROR_EXIT_CODES[code],
            plan,
            (text) => storagePlanText(plan, context.invocation, text),
          );
        }
        return {
          data: plan,
          text: (text) => storagePlanText(plan, context.invocation, text),
        };
      }
      const backupDir =
        options.backupDir === undefined
          ? undefined
          : isAbsolute(options.backupDir)
            ? options.backupDir
            : resolve(context.runtime.cwd, options.backupDir);
      const data = await migrateStorage(target, {
        ...(backupDir !== undefined ? { backupDir } : {}),
        ...(options.ifPlan !== undefined ? { ifPlan: options.ifPlan } : {}),
      });
      return {
        data,
        text: (text) =>
          storageMigrationText(data, context.target.configPath, context.invocation, text),
      };
    },
  );
}

/** Явное обслуживание выбранной файловой базы, с собственным результатом для человека. */
export function registerStorage(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "storage",
    description: "Формат единого хранилища, перенос версий и восстановление индексов",
    details:
      "Обслуживание выполняется только локально для выбранного файла конфигурации проекта (любого имени) или проекта workspace-реестра через --project. В HTTP-режиме команды возвращают LOCAL_REQUIRED без запроса к Server. Обычное открытие использует готовые индексы и не перестраивает базу.",
    examples: [
      [`${PREFIX} storage status`, "Проверить версии и пригодность базы"],
      [`${PREFIX} storage migrate --dry-run`, "Проверить план переноса без изменения базы"],
      [
        "npx @oim-dev/relay-cli storage reindex --local",
        "Восстановить производные индексы после внешних изменений",
      ],
    ],
  });
  registerMaintenance(group, runtime);
  registerCommand(group, runtime, {
    name: "reindex",
    localOnly: true,
    description: "Перестроить адреса, карточки и связи из постоянных данных",
    details:
      "Используйте после Git-слияния, ручной правки либо потери индекса. Предметные данные не удаляются. Команда работает и при отсутствующем заголовке индекса. Недостающие предметные отношения из полей не создаёт; для этого используйте storage reconcile-relations.",
    examples: [["npx @oim-dev/relay-cli storage reindex --local", "Восстановить индексы проекта"]],
    run: async (context) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).reindex();
      return {
        data,
        text: (options) =>
          receiptText(
            {
              title: "Индексы единого хранилища перестроены",
              fields: [
                ["Действующих связей", data.edges],
                ["Ревизия графа", data.revision],
                ["Конфигурация", workspace.configPath],
                ["Границы", "Недостающие предметные отношения из полей не создавались."],
              ],
              commands: [
                {
                  label: "Проверить целостность после обслуживания",
                  command: commandInvocation(context, ["doctor", "check"]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
  registerCommand<{ requestId?: string }>(group, runtime, {
    name: "reconcile-relations",
    localOnly: true,
    description: "Согласовать сохранённые связи Core с предметными линками существующих сущностей",
    details:
      "Явное обслуживание единого формата после обновления: добавляет недостающие и отзывает лишние связи предметных групп. Сохраняет ID неизменённых связей, независимые диагностические рёбра и ревизии сущностей. Все изменения публикуются одной транзакцией. После потери ответа проверьте состояние связей; request-id служит только корреляции.",
    examples: [
      [
        "npx @oim-dev/relay-cli storage reconcile-relations --local --actor agent --request-id relations-v1",
        "Согласовать предметные связи проекта",
      ],
    ],
    configure: (command) =>
      command.option(
        "--request-id <id>",
        "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
      ),
    run: async (context, input) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).reconcileRelations(
        { requestId: input.options.requestId ?? randomUUID() },
        author(context),
      );
      return {
        data,
        text: (options) =>
          receiptText(
            {
              title:
                data.added + data.updated + data.removed > 0
                  ? "Предметные связи согласованы — изменения сохранены"
                  : "Предметные связи согласованы — изменений не потребовалось",
              fields: [
                ["Добавлено", data.added],
                ["Обновлено", data.updated],
                ["Отозвано", data.removed],
                ["Конфигурация", workspace.configPath],
                ["Идентификатор запроса", data.requestId],
              ],
              commands: [
                {
                  label: "Проверить целостность после обслуживания",
                  command: commandInvocation(context, ["doctor", "check"]),
                },
                {
                  label: "Прочитать сохранённые отношения",
                  command: commandInvocation(context, ["inspect", "graph", "list"]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
}
