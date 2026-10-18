import { join, resolve } from "node:path";
import { Option, type Command } from "commander";
import { invariant } from "@relay/core/shared/errors";
import { managedRoot, migrateToWorktree } from "@relay/project-runtime/git-storage/bootstrap";
import { currentOrigin } from "@relay/project-runtime/git-storage/remote";
import { marker, readState } from "@relay/project-runtime/git-storage/state";
import {
  conflicts,
  resolveConflict,
  synchronize,
} from "@relay/project-runtime/git-storage/service";
import { commandGroup, createCommand } from "../command.js";
import { outputOptions } from "../context.js";
import type { GlobalOptions, Runtime } from "../context.js";
import { printResult } from "../output.js";
import { cardText } from "../presentation/common.js";
import { safeText } from "../presentation/safe.js";
import { localInvocation, shellCommand } from "../command-kit.js";
import { readInitializationConfiguration } from "@relay/project-runtime/config";
import { AppError } from "@relay/core/shared/errors";

/** Управление Git доступно и при блокировке предметного Backend. */
export function registerSync(program: Command, runtime: Runtime) {
  const group = commandGroup(program, {
    name: "sync",
    description: "Git-синхронизация внешней базы и разрешение конфликтов",
    details:
      "Работает с локальной служебной копией в ~/.relay. База текущего Git-проекта определяется автоматически; без настроенного HTTP дополнительные флаги подключения не нужны. Статус и материалы доступны при SYNC_CONFLICT. now отправляет согласованный снимок без ожидания debounce. Решение конфликта требует его исходный ID; обычные предметные команды заблокированы до успешной публикации решения.",
    examples: [["npx @oim-dev/relay-cli sync status", "Проверить состояние синхронизации"]],
  });
  for (const name of ["status", "now", "conflicts", "resolve", "migrate"] as const) {
    const description = {
      status: "Прочитать состояние отправки и блокировки",
      now: "Получить origin и отправить текущий снимок",
      conflicts: "Прочитать причины и версии конфликтующих файлов",
      resolve: "Разрешить конфликт по файлам или выбрать полный снимок",
      migrate: "Перенести существующую базу в Git worktree проекта",
    }[name];
    const command = createCommand(group, {
      name,
      description,
      details:
        name === "migrate"
          ? "Запускайте из исходного Git-проекта. --from-config выбирает файловую базу или прежнюю самостоятельную Git-копию. Перенос сохраняет projectId, записи и исходную базу как резервную копию; прежняя Git-история также сохраняется. Остановите писателей исходной базы на время перехода. Если на origin другая база, перенос отклоняется. Обычный CLI после переноса выбирает worktree; явный --config по-прежнему позволяет открыть сохранённую исходную копию."
          : name === "resolve"
            ? "Передайте --decisions-file с объектом путь → {take: local|remote} либо {value: полный JSON записи}; '-' читает stdin. Остальные однозначные изменения сохраняются. Для каждого конфликтующего файла нужно решение. Вместо файла --take выбирает весь снимок базы, включая неконфликтующие изменения: сначала изучите sync conflicts. Выбранный снимок проверяется Core. --if-conflict берётся из актуального списка; изменение origin отклоняет старое решение. Отправка не использует force-push."
            : name === "conflicts"
              ? "Показывает ID, причины, пути и полное сохранённое содержание B/L/R конфликтующих файлов. $integrity обозначает нарушение предметной целостности; в этом случае показываются все файлы. Markdown в диагностике отражён в дисковом JSON без потери содержания."
              : "База текущего Git-проекта определяется автоматически. --local нужен для отключения настроенного HTTP; --config — для явного выбора другой базы. Выбор через --project не поддерживается: для зарегистрированной Git-базы запускайте команду из её проекта либо укажите прямой --config. Статус не означает публикацию ещё ожидающих данных. now выполняет сетевую проверку, объединение и публикацию; предметные команды не повторяются.",
      examples: [
        [
          `npx @oim-dev/relay-cli sync ${name}${name === "resolve" ? " --if-conflict conflict-id --take local" : name === "migrate" ? " --from-config .relay/config.json" : ""}`,
          description,
        ],
      ],
      configure: (entry) =>
        name === "migrate"
          ? entry.requiredOption(
              "--from-config <path>",
              "Конфигурация исходной базы, которую нужно сохранить в worktree",
            )
          : name === "resolve"
            ? entry
                .requiredOption("--if-conflict <id>", "ID прочитанного конфликта")
                .addOption(
                  new Option("--take <side>", "Полный снимок: local или remote")
                    .choices(["local", "remote"])
                    .conflicts("decisionsFile"),
                )
                .option("--decisions-file <path>", "Решения по путям в JSON; '-' читает stdin")
            : entry,
    });
    command.action(async () => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const resolveOptions = command.opts<{
        ifConflict: string;
        take?: "local" | "remote";
        decisionsFile?: string;
      }>();
      let decision: unknown = resolveOptions.take;
      if (name === "resolve") {
        invariant(
          (resolveOptions.take !== undefined ? 1 : 0) +
            (resolveOptions.decisionsFile !== undefined ? 1 : 0) ===
            1,
          "INPUT_SOURCE_REQUIRED",
          "Передайте --take или --decisions-file",
          2,
        );
        if (resolveOptions.decisionsFile !== undefined) {
          const input = await runtime.input.text(
            undefined,
            resolveOptions.decisionsFile,
            128 * 1024 * 1024,
          );
          try {
            decision = JSON.parse(input!);
          } catch {
            throw new AppError("INVALID_JSON", "Некорректный JSON решений конфликта", 2);
          }
        }
      }
      invariant(
        !globals.project,
        "LOCAL_REQUIRED",
        "sync не принимает --project. Выполните команду из каталога нужного Git-проекта или укажите его прямой --config.",
        2,
      );
      invariant(
        globals.local || !(globals.serverUrl ?? runtime.env.RELAY_SERVER_URL),
        "LOCAL_REQUIRED",
        "Для управления Git-синхронизацией при настроенном HTTP укажите --local.",
        2,
      );
      if (name === "migrate") {
        const source = await readInitializationConfiguration(
          runtime.cwd,
          command.opts<{ fromConfig: string }>().fromConfig,
        );
        invariant(
          source.kind === "project",
          "LOCAL_REQUIRED",
          "Перенос принимает config базы, не реестр workspace",
          2,
        );
        invariant(
          globals.local || !source.value.server.url,
          "LOCAL_REQUIRED",
          "Для управления Git-синхронизацией при настроенном HTTP укажите --local.",
          2,
        );
        const configPath = await migrateToWorktree(
          runtime.cwd,
          command.opts<{ fromConfig: string }>().fromConfig,
          runtime.env.RELAY_HOME === undefined
            ? undefined
            : resolve(runtime.cwd, runtime.env.RELAY_HOME),
        );
        printResult(
          runtime.stdout,
          {
            data: { configPath },
            text: (options) =>
              cardText(
                {
                  title: "База перенесена в Git worktree",
                  fields: [
                    ["Конфигурация", configPath, "opaque"],
                    ["Исходная база", "сохранена как резервная копия"],
                  ],
                },
                options,
              ),
          },
          outputOptions(runtime, globals),
        );
        return;
      }
      let config = globals.config ?? runtime.env.RELAY_CONFIG;
      if (!config) {
        const source = await readInitializationConfiguration(runtime.cwd).catch(
          (error: unknown) => {
            if (error instanceof AppError && error.code === "CONFIG_NOT_FOUND") return undefined;
            throw error;
          },
        );
        invariant(
          source?.kind !== "registry",
          "LOCAL_REQUIRED",
          "Для sync нужен прямой config Git-базы, не реестр workspace",
          2,
        );
        config = source?.path;
      }
      const root = await managedRoot(
        runtime.cwd,
        config ? resolve(runtime.cwd, config) : undefined,
        runtime.env.RELAY_HOME === undefined
          ? undefined
          : resolve(runtime.cwd, runtime.env.RELAY_HOME),
      );
      const selected = await readInitializationConfiguration(
        runtime.cwd,
        config ?? join(root, "config.json"),
      );
      invariant(
        selected.kind === "project" && (globals.local || !selected.value.server.url),
        "LOCAL_REQUIRED",
        "Для управления Git-синхронизацией при настроенном HTTP укажите --local.",
        2,
      );
      const info = await marker(root);
      const origin = await currentOrigin(root);
      const prefix = localInvocation(
        runtime,
        globals,
        config ? resolve(runtime.cwd, config) : join(root, "config.json"),
      );
      const recovery = (args: readonly string[]) => shellCommand([...prefix, ...args]);
      runtime.recovery = { command: recovery, maintenance: recovery };
      runtime.output = outputOptions(runtime, globals);
      if (name === "conflicts") {
        const data = await conflicts(root);
        printResult(
          runtime.stdout,
          {
            data,
            text: (options) =>
              cardText(
                {
                  title: data ? "База заблокирована конфликтом" : "Конфликтов нет",
                  fields: data
                    ? [
                        ["ID", data.id, "opaque"],
                        ["Причина", data.reason],
                        ["Общая версия", data.base, "opaque"],
                        ["Локальная версия", data.local, "opaque"],
                        ["Удалённая версия", data.remote, "opaque"],
                      ]
                    : [],
                  sections: data
                    ? (data.paths.some((path) => path.startsWith("$"))
                        ? [
                            ...new Set([
                              ...Object.keys(data.localFiles),
                              ...Object.keys(data.remoteFiles),
                            ]),
                          ]
                        : data.paths
                      ).map((path) => ({
                        title: path,
                        body: (
                          [
                            ["Общая", data.baseFiles],
                            ["Локальная", data.localFiles],
                            ["Удалённая", data.remoteFiles],
                          ] as const
                        )
                          .map(
                            ([label, files]) =>
                              `${label}:\n${safeText(JSON.stringify(files[path] ?? null, null, 2))}`,
                          )
                          .join("\n\n"),
                      }))
                    : [],
                },
                options,
              ),
          },
          runtime.output,
        );
        return;
      }
      const data =
        name === "now"
          ? await synchronize(root)
          : name === "resolve"
            ? await resolveConflict(
                root,
                command.opts<{ ifConflict: string }>().ifConflict,
                decision,
              )
            : await readState(root);
      printResult(
        runtime.stdout,
        {
          data: { ...data, identity: info?.identity, origin: origin?.origin ?? null, root },
          text: (options) =>
            cardText(
              {
                title: data.conflict
                  ? "Синхронизация: конфликт"
                  : data.error
                    ? "Синхронизация требует внимания"
                    : !origin
                      ? "Синхронизация: локальная база, origin не настроен"
                      : data.firstDirty === null
                        ? "Синхронизация: нет ожидающей отправки"
                        : "Синхронизация: ожидается отправка",
                fields: [
                  ["Репозиторий", info?.version === 2 ? info.sourceRoot : info?.identity],
                  ["Origin", origin?.origin ?? "не настроен", "opaque"],
                  ["База", root, "opaque"],
                  ["Последняя удалённая версия", data.remote, "opaque"],
                  [
                    "Последняя проверка",
                    data.lastFetch === null
                      ? "не выполнена"
                      : new Date(data.lastFetch).toISOString(),
                  ],
                  ["Конфликт", data.conflict?.id, "opaque"],
                  ["Ошибка", data.error?.message],
                ],
              },
              options,
            ),
        },
        runtime.output,
      );
    });
  }
}
