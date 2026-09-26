import type { Command } from "commander";
import { AppError, invariant } from "@relay/core/shared/errors";
import { selectProject } from "@relay/project-runtime/config";
import { cliConfiguration } from "../configuration.js";
import { initialize } from "@relay/core/storage/workspace";
import { outputOptions } from "../context.js";
import type { GlobalOptions, Runtime } from "../context.js";
import { printResult } from "../output.js";
import { createCommand, commandGroup, registerCommand } from "../command.js";
import { configText, initializedText } from "../presentation/project.js";
import { palette } from "../presentation/theme.js";

export function registerProject(program: Command, runtime: Runtime): void {
  // init — единственная операция, которой ещё не нужен открытый Workspace.
  const init = createCommand(program, {
    name: "init",
    description: "Создать конфиг и хранилище проекта",
    details:
      "Создаёт .relay/config.json и единое ID-хранилище рядом с конфигом: entities, relations и индексы. Существующие данные не заменяются.\n--storage сохраняется для совместимости конфигурации; новый формат не создаёт прежний каталог задач. --config задаёт путь конфигурации.\nПосле init задайте RELAY_ACTOR и создайте первую задачу.",
    examples: [
      ["relay-cli init", "Начать в текущем проекте"],
      [
        "relay-cli init --config /work/project/.relay/config.json --storage tasks",
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

  registerCommand(program, runtime, {
    name: "validate",
    description: "Проверить продукт, доски, задачи и связи",
    details:
      "Проверяет схемы и каталог действующих сущностей, связи задач и граф проекта.\nВыполняйте после ручного редактирования JSON и Git-слияния.\nОшибка целостности возвращает код завершения 5 и список нарушений.",
    examples: [
      ["relay-cli validate", "Проверить проект"],
      ["relay-cli validate --format json", "Получить диагностику для автоматизации"],
    ],
    async run(context) {
      const data = await context.backend.validate();
      return {
        data,
        text: (options) =>
          `${palette(options).green("✓ Хранилище корректно")}\nСущностей: ${data.entities} · Досок: ${data.boards} · Задач: ${data.tasks}`,
      };
    },
  });
  const config = commandGroup(program, {
    name: "config",
    description: "Настройки проекта и статусов",
    details:
      'Настройки хранятся в .relay/config.json. config get показывает путь и актуальные значения.\nЦвет статуса задаётся полем statuses.<имя>.color, например "blue".\nДоступны black, red, green, yellow, blue, magenta, cyan, white, gray и none.',
    examples: [
      ["relay-cli config get", "Посмотреть статусы, цвета и лимиты"],
      ["relay-cli config get --format json", "Прочитать конфигурацию программно"],
    ],
  });
  registerCommand(config, runtime, {
    name: "get",
    description: "Показать конфиг, статусы, цвета и пути",
    details:
      "Конфиг ищется вверх от текущего каталога; --config имеет приоритет.\nterminal определяет конечный статус, satisfiesDependencies — успешное завершение.\ncolor управляет только оформлением; --color never и JSON отключают ANSI.",
    examples: [
      ["relay-cli config get", "Показать настройки текущего проекта"],
      [
        "relay-cli config get --config /work/project/.relay/config.json",
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
          ),
      };
    },
  });
}
