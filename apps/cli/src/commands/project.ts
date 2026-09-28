import type { Command } from "commander";
import { AppError, invariant } from "@relay/core/shared/errors";
import { selectProject } from "@relay/project-runtime/config";
import { cliConfiguration } from "../configuration.js";
import { initialize } from "@relay/core/storage/workspace";
import { outputOptions } from "../context.js";
import type { GlobalOptions, Runtime } from "../context.js";
import { printResult } from "../output.js";
import { createCommand, commandGroup, registerCommand } from "../command.js";
import {
  configText,
  initializedText,
  projectText,
  projectSavedText,
} from "../presentation/project.js";
import { randomUUID } from "node:crypto";
import { entityUpdateSchema } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { author } from "../context.js";
import { integer } from "../options.js";
import { textOption, readTextFields, commandInvocation } from "../command-kit.js";
import { receiptText } from "../presentation/common.js";

export function registerProject(program: Command, runtime: Runtime): void {
  // init — единственная операция, которой ещё не нужен открытый Workspace.
  const init = createCommand(program, {
    name: "init",
    description: "Создать конфиг и хранилище проекта",
    details:
      "Создаёт .relay/config.json и единое ID-хранилище рядом с конфигом: entities, relations и индексы. Существующие данные не заменяются.\n--storage сохраняется для совместимости конфигурации; новый формат не создаёт прежний каталог задач. --config задаёт путь конфигурации.\nПосле init подготовьте паспорт продукта: npx @oim-dev/relay-cli product create --help.",
    examples: [
      ["npx @oim-dev/relay-cli init", "Начать в текущем проекте"],
      [
        "npx @oim-dev/relay-cli init --config /work/project/.relay/config.json --storage tasks",
        "Подготовить общее хранилище для нескольких worktree",
      ],
    ],
    configure: (command) =>
      command.option(
        "--storage <path>",
        "Прежняя привязка storageDir/runtime относительно конфига",
        "tasks",
      ),
  });
  init.action(async () => {
    const globals = init.optsWithGlobals<GlobalOptions>();
    let config = globals.config ?? runtime.env.RELAY_CONFIG;
    const source = await cliConfiguration(runtime, globals).catch((error: unknown) => {
      if (
        error instanceof AppError &&
        ["CONFIG_NOT_FOUND", "NOT_FOUND"].includes(error.code) &&
        !globals.project
      )
        return undefined;
      throw error;
    });
    if (source && globals.project) {
      const selected = selectProject(source, globals.project);
      config = selected.configPath;
      invariant(config, "LOCAL_CONFIG_REQUIRED", "Для init нужен локальный путь проекта");
    }
    invariant(
      globals.local ||
        !(
          globals.serverUrl ??
          (source?.kind === "registry" ? undefined : runtime.env.RELAY_SERVER_URL)
        ),
      "LOCAL_ONLY",
      "Для инициализации локальной рабочей копии при настроенном HTTP укажите --local.",
    );
    const workspace = await initialize(
      runtime.cwd,
      init.opts<{ storage: string }>().storage,
      config,
    );
    runtime.output = outputOptions(runtime, globals, workspace.config.output);
    printResult(
      runtime.stdout,
      {
        data: { configPath: workspace.configPath, storageDir: workspace.dataRoot },
        text: (options) => initializedText(workspace.configPath, workspace.dataRoot, options),
      },
      runtime.output,
    );
  });

  const project = commandGroup(program, {
    name: "project",
    description: "Паспорт текущего проекта",
    details: "Единственная запись проекта PROJECT. Не управление регистрациями workspace.",
    examples: [["npx @oim-dev/relay-cli project get", "Прочитать проект"]],
  });
  registerCommand(project, runtime, {
    name: "get",
    description: "Прочитать проект и его ревизию",
    details: "Название и настройки выбранного проекта. Ревизия нужна для project update.",
    examples: [["npx @oim-dev/relay-cli project get", "Прочитать перед изменением"]],
    async run(context) {
      const data = await context.backend.entities.get({ ref: "PROJECT", kind: "project" });
      return {
        data,
        text: (options) =>
          projectText(data, options, commandInvocation(context, ["project", "update", "--help"])),
      };
    },
  });
  registerCommand<{ name?: string; ifRevision: number; requestId?: string }>(project, runtime, {
    name: "update",
    description: "Изменить название проекта",
    details:
      "Передайте новое имя и ревизию из project get. Описание не поддерживается контрактом проекта. Slug и регистрация workspace не меняются.",
    examples: [
      [
        "npx @oim-dev/relay-cli project update --actor human --name 'Мой проект' --if-revision 1",
        "Изменить имя по прочитанной ревизии",
      ],
    ],
    configure(command) {
      textOption(command, "name", "Название проекта");
      return command
        .requiredOption(
          "--if-revision <n>",
          "Прочитанная ревизия",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации");
    },
    async run(context, input) {
      const changes = await readTextFields(context, input.options, ["name"]);
      invariant(
        changes.name !== undefined,
        "INVALID_ARGUMENT",
        "Передайте --name или --name-file; справка: npx @oim-dev/relay-cli project update --help",
      );
      const command = parse(
        entityUpdateSchema,
        {
          ref: "PROJECT",
          changes: { kind: "project", ...changes },
          ifRevision: input.options.ifRevision,
          requestId: input.options.requestId ?? randomUUID(),
        },
        "изменение проекта",
      );
      const data = await context.backend.entities.update(command, author(context));
      return {
        data,
        text: (options) =>
          projectSavedText(
            data,
            commandInvocation(context, ["project", "get"]),
            options,
            changes.name,
          ),
      };
    },
  });
  const doctor =
    program.commands.find((command) => command.name() === "doctor") ??
    commandGroup(program, {
      name: "doctor",
      description: "Диагностика и явное исправление проекта",
      details:
        "Проверка ничего не исправляет автоматически. Перед ремонтом сохраните резервную копию.",
      examples: [["npx @oim-dev/relay-cli doctor check", "Проверить целостность"]],
    });
  registerCommand(doctor, runtime, {
    name: "check",
    description: "Проверить продукт, доски, задачи и связи",
    details:
      "Проверяет схемы и каталог действующих сущностей, связи задач и граф проекта.\nВыполняйте после ручного редактирования JSON и Git-слияния.\nОшибка целостности возвращает код завершения 5 и список нарушений.",
    examples: [
      ["npx @oim-dev/relay-cli doctor check", "Проверить проект"],
      [
        "npx @oim-dev/relay-cli doctor check --format json",
        "Получить диагностику для автоматизации",
      ],
    ],
    async run(context) {
      const data = await context.backend.validate();
      return {
        data,
        text: (options) =>
          receiptText(
            {
              title: "✓ Проверка целостности пройдена",
              fields: [
                ["Сущностей", data.entities],
                ["Досок", data.boards],
                ["Задач", data.tasks],
                [
                  "Изменения",
                  "Проверка не исправляет данные и не подтверждает выполнение требований.",
                ],
              ],
              commands: [
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
  const config = commandGroup(program, {
    name: "config",
    description: "Конфигурация подключения и пути проекта",
    details:
      "config get показывает актуальное представление конфигурации и пути. Предметное имя проекта меняется через project update, а не правкой проекции в конфиге. Совместимые статусы не задают фиксированные колонки досок.",
    examples: [
      ["npx @oim-dev/relay-cli config get", "Посмотреть настройки и пути"],
      ["npx @oim-dev/relay-cli config get --format json", "Прочитать конфигурацию программно"],
    ],
  });
  registerCommand(config, runtime, {
    name: "get",
    description: "Показать конфиг, совместимые статусы и пути",
    details:
      "Конфиг ищется вверх от текущего каталога; --config имеет приоритет. Совместимые поля статусов не изменяют колонки текущих задач.\nФормат CLI выбирается флагом --format; настройки output.format и output.maxBytes не применяются. Вывод CLI всегда бесцветный.",
    examples: [
      ["npx @oim-dev/relay-cli config get", "Показать настройки текущего проекта"],
      [
        "npx @oim-dev/relay-cli config get --config /work/project/.relay/config.json",
        "Посмотреть настройки общего хранилища",
      ],
    ],
    async run(context) {
      return {
        data: context.workspace.config,
        meta: { configPath: context.workspace.configPath, storagePath: context.workspace.root },
        text: (options) =>
          configText(
            context.workspace.config,
            context.workspace.configPath,
            context.workspace.root,
            options,
            context.backend.kind === "local"
              ? "Прямой Core (local)"
              : `HTTP: ${context.connection ?? context.globals.serverUrl ?? context.runtime.env.RELAY_SERVER_URL}`,
            commandInvocation(context, ["project", "get"]),
          ),
      };
    },
  });
}
