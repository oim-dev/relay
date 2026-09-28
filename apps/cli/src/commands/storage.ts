import type { Command } from "commander";
import { StorageService } from "@relay/core/application/storage/service";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import type { Runtime } from "../context.js";
import { author } from "../context.js";
import { randomUUID } from "node:crypto";
import { receiptText } from "../presentation/common.js";
import { commandInvocation } from "../command-kit.js";

/** Явное обслуживание выбранной файловой базы, с собственным результатом для человека. */
export function registerStorage(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "storage",
    description: "Формат единого хранилища и восстановление индексов",
    details:
      "Обслуживание выполняется локально для выбранного .relay/config.json. Обычное открытие использует готовые индексы и не перестраивает базу.",
    examples: [
      ["npx @oim-dev/relay-cli storage migrate --local", "Явно перенести прежнюю базу"],
      [
        "npx @oim-dev/relay-cli storage reindex --local",
        "Восстановить производные индексы после внешних изменений",
      ],
    ],
  });
  registerCommand(group, runtime, {
    name: "migrate",
    description: "Перенести поддерживаемую базу в единый формат 4",
    details:
      "Перед переносом остановите старые версии клиентов и сохраните резервную копию. Поддерживаемые legacy-базы и физические версии 1/2/3 переводятся в формат 4; актуальная база не требует переноса. ID, ключи, алиасы, текущие тексты, ревизии и комментарии сохраняются, история и результаты запросов не переносятся. Прежние предметные версии планов и релизов не поддерживаются: автоматического преобразования или сброса нет.",
    examples: [["npx @oim-dev/relay-cli storage migrate --local", "Перенести выбранный проект"]],
    run: async (context) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).migrate();
      return {
        data,
        text: (options) =>
          receiptText(
            {
              title: data.migrated
                ? "Хранилище перенесено"
                : "Перенос не требуется — хранилище не изменено",
              fields: [
                ["Формат", data.format],
                ["Перенесено записей", data.entities],
                ["Конфигурация", workspace.configPath],
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
  registerCommand(group, runtime, {
    name: "reindex",
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
