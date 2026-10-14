import type { Command } from "commander";
import { AppError, invariant } from "@relay/core/shared/errors";
import { selectProject } from "@relay/project-runtime/config";
import { cliInitializationConfiguration } from "../configuration.js";
import { initialize } from "@relay/core/storage/workspace";
import { outputOptions } from "../context.js";
import type { GlobalOptions, Runtime } from "../context.js";
import { PresentedError, printResult } from "../output.js";
import { createCommand, commandGroup, registerCommand } from "../command.js";
import {
  configText,
  initializedText,
  initializationBlockedText,
  projectText,
  projectSavedText,
  projectSettingsSavedText,
} from "../presentation/project.js";
import { randomUUID } from "node:crypto";
import { entityUpdateSchema, entityRenameSchema } from "@relay/contracts/entities";
import { saveProjectSettingsSchema } from "@relay/contracts/entities/project-settings";
import { parse } from "@relay/core/domain/validation";
import { author } from "../context.js";
import { integer } from "../options.js";
import {
  textOption,
  readTextFields,
  commandInvocation,
  localInvocation,
  shellCommand,
} from "../command-kit.js";
import { receiptText } from "../presentation/common.js";
import { entitySavedText } from "../presentation/entities.js";

export function registerProject(program: Command, runtime: Runtime): void {
  // init — единственная операция, которой ещё не нужен открытый Workspace.
  const init = createCommand(program, {
    name: "init",
    description: "Создать конфиг и хранилище проекта",
    details:
      "Создаёт .relay/config.json и единое ID-хранилище рядом с конфигом: entities, relations и индексы. Существующие данные не заменяются; init не восстанавливает неполную базу или незавершённую запись.\n--storage сохраняется для совместимости конфигурации; новый формат не создаёт прежний каталог задач. --config задаёт путь конфигурации. Новое имя файла: латинские буквы, цифры, «_», «-», «.»; кроме «.», «..», служебных имён Relay и relay.workspace.json. Расширение .json необязательно. Unicode, пробелы и кавычки в каталоге разрешены.\nURL из --server-url, RELAY_SERVER_URL или найденного конфига требует --local: init не обращается к серверу. Выбранный проект workspace задаёт локальный путь регистрации; без выбора создаётся отдельная база в текущем каталоге, без регистрации.\nПосле init проверьте config get и подготовьте паспорт продукта: npx @oim-dev/relay-cli product create --help.",
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
    const source = await cliInitializationConfiguration(runtime, globals).catch(
      (error: unknown) => {
        if (
          error instanceof AppError &&
          ["CONFIG_NOT_FOUND", "NOT_FOUND"].includes(error.code) &&
          !globals.project
        )
          return undefined;
        throw error;
      },
    );
    if (source && globals.project) {
      const selected = selectProject(source, globals.project);
      config = selected.configPath;
      invariant(config, "LOCAL_CONFIG_REQUIRED", "Для init нужен локальный путь проекта");
    }
    // Init создаёт только локальную базу: явное HTTP-намерение одинаково для всех
    // источников URL. Один лишь порт workspace не запрещает новый проект в cwd.
    const serverUrl = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL ?? source?.value.server.url;
    invariant(
      globals.local || !serverUrl,
      "LOCAL_ONLY",
      "Для инициализации локальной рабочей копии при настроенном HTTP укажите --local.",
    );
    const workspace = await initialize(
      runtime.cwd,
      init.opts<{ storage: string }>().storage,
      config,
    ).catch((error: unknown) => {
      if (!(error instanceof AppError) || error.code !== "ALREADY_INITIALIZED") throw error;
      const details = error.details as
        { configPath?: unknown; dataRoot?: unknown; reason?: unknown; paths?: unknown } | undefined;
      // Только адрес Core: не извлекаем путь из message и не ищем другую базу.
      if (
        typeof details?.configPath !== "string" ||
        typeof details.dataRoot !== "string" ||
        !["config", "storage", "pending", "incomplete"].includes(String(details.reason))
      )
        throw error;
      const configPath = details.configPath;
      const dataRoot = details.dataRoot;
      const diagnostic = details.reason !== "config";
      const invocation = diagnostic
        ? localInvocation(runtime, { local: true, config: dataRoot }, dataRoot)
        : localInvocation(runtime, globals, configPath, source?.kind === "registry");
      throw new PresentedError(
        error.code,
        error.message,
        error.exitCode,
        error.details,
        (options) =>
          initializationBlockedText(
            error.message,
            configPath,
            dataRoot,
            shellCommand([
              ...invocation,
              ...(diagnostic ? ["storage", "status"] : ["config", "get"]),
            ]),
            options,
            diagnostic,
            Array.isArray(details.paths)
              ? details.paths.filter((path): path is string => typeof path === "string")
              : [],
          ),
      );
    });
    const invocation = localInvocation(
      runtime,
      globals,
      workspace.configPath,
      source?.kind === "registry",
    );
    runtime.output = outputOptions(runtime, globals, workspace.config.output);
    printResult(
      runtime.stdout,
      {
        data: { configPath: workspace.configPath, storageDir: workspace.dataRoot },
        text: (options) =>
          initializedText(
            workspace.configPath,
            workspace.dataRoot,
            options,
            shellCommand([...invocation, "product", "create", "--help"]),
            shellCommand([...invocation, "config", "get"]),
          ),
      },
      runtime.output,
    );
  });

  const project = commandGroup(program, {
    name: "project",
    description: "Паспорт текущего проекта",
    details:
      "Единственная запись проекта: get не принимает ref, в том числе после смены ключа. update меняет отображаемое имя и slug Web-адреса; rename — публичный ключ (изначально PROJECT). ID и регистрация workspace не меняются.\nПрикреплённые документы: document list --target PROJECT. Полный контекст связей: inspect graph context PROJECT. Старый ключ PROJECT сохраняется как алиас.",
    examples: [["npx @oim-dev/relay-cli project get", "Прочитать проект"]],
  });
  registerCommand(project, runtime, {
    name: "get",
    description: "Прочитать проект и его ревизию",
    details:
      "Название, slug, ключ, ID и ревизия выбранного проекта. Text показывает число разделов; полный список с порядком — document section list. JSON сохраняет полную карточку, включая разделы.\nРевизия нужна для project update и project rename. Прикреплённые документы: document list --target PROJECT; полный контекст: inspect graph context PROJECT.",
    examples: [["npx @oim-dev/relay-cli project get", "Прочитать перед изменением"]],
    async run(context) {
      const data = await context.backend.entities.get({ ref: "PROJECT", kind: "project" });
      return {
        data,
        text: (options) =>
          projectText(data, options, [
            {
              label: "Прочитать разделы и их порядок",
              command: commandInvocation(context, ["document", "section", "list"]),
            },
            {
              label: "Изменить имя или slug по прочитанной ревизии: справка",
              command: commandInvocation(context, ["project", "update", "--help"]),
            },
          ]),
      };
    },
  });
  registerCommand<{ name?: string; slug?: string; ifRevision: number; requestId?: string }>(
    project,
    runtime,
    {
      name: "update",
      description: "Изменить имя или slug проекта",
      details:
        "Передайте имя (--name/--name-file) и/или --slug и исходную ревизию из project get. Slug — адресный идентификатор, не текстовое содержание: 2–64 строчные латинские буквы/цифры с одиночными дефисами между частями; --slug-file нет.\nБез --slug сохраняется только имя, JSON — квитанция сущности. С --slug возвращаются настройки ProjectSettings (name, slug, revision, documentSections при наличии), не EntitySaved; --request-id в этом режиме не поддерживается. Непереданное имя и разделы сохраняются. Старый slug не становится алиасом.\nОписание не поддерживается. Публичный ключ меняется через project rename; ID и регистрация workspace неизменны. После конфликта или потери ответа перечитайте project get; скрытых повторов нет.",
      examples: [
        [
          "npx @oim-dev/relay-cli project update --actor human --name 'Мой проект' --if-revision 1",
          "Изменить имя по прочитанной ревизии",
        ],
        [
          "npx @oim-dev/relay-cli project update --actor human --slug my-project --if-revision 1",
          "Изменить slug, сохранив непереданное имя",
        ],
      ],
      configure(command) {
        textOption(command, "name", "Название проекта");
        return command
          .option("--slug <slug>", "Канонический Web-адрес проекта, не публичный ключ")
          .requiredOption(
            "--if-revision <n>",
            "Прочитанная ревизия",
            integer(0, Number.MAX_SAFE_INTEGER),
          )
          .option("--request-id <id>", "Корреляция изменения имени без --slug, не дедупликация");
      },
      async run(context, input) {
        const changes = await readTextFields(context, input.options, ["name"]);
        invariant(
          changes.name !== undefined || input.options.slug !== undefined,
          "INVALID_ARGUMENT",
          "Передайте --name, --name-file или --slug; справка: npx @oim-dev/relay-cli project update --help",
        );
        if (input.options.slug !== undefined) {
          invariant(
            input.options.requestId === undefined,
            "INVALID_ARGUMENT",
            "--request-id поддерживается только при изменении имени без --slug",
          );
          // Проверяем весь пользовательский ввод до чтения недостающего имени и записи.
          const supplied = parse(
            saveProjectSettingsSchema.partial({ name: true }),
            { ...changes, slug: input.options.slug, ifRevision: input.options.ifRevision },
            "настройки проекта",
          );
          author(context);
          const name = supplied.name ?? (await context.backend.projectSettings.get()).name;
          const data = await context.backend.projectSettings.save({ ...supplied, name });
          // Прежний slug больше не селектор: квитанция ведёт к той же базе по её ID.
          const readContext =
            context.backend.kind === "http" &&
            context.globals.project === context.workspace.config.projectSettings?.slug &&
            context.workspace.config.projectId
              ? {
                  ...context,
                  globals: { ...context.globals, project: context.workspace.config.projectId },
                }
              : context;
          return {
            data,
            text: (options) =>
              projectSettingsSavedText(
                data,
                commandInvocation(readContext, ["project", "get"]),
                options,
              ),
          };
        }
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
              command.changes.kind === "project" ? command.changes.name : undefined,
            ),
        };
      },
    },
  );
  registerCommand<{ ifRevision: number; requestId?: string }>(project, runtime, {
    name: "rename <key>",
    arguments: { key: "Новый публичный ключ проекта, не имя и не slug" },
    description: "Изменить публичный ключ с сохранением ID и алиасов",
    details:
      "Передайте ревизию из project get. Имя, slug, разделы и регистрация workspace сохраняются. Прежние ключи остаются алиасами; коллизия отклоняется. project get по-прежнему вызывается без ref.\nКлючи и алиасы: inspect keys PROJECT. Имя и slug меняются через project update.",
    examples: [
      [
        "npx @oim-dev/relay-cli project rename PROJECT-TEAM --actor human --if-revision 1",
        "Сменить ключ по прочитанной ревизии",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption(
          "--if-revision <n>",
          "Прочитанная ревизия",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
    async run(context, input) {
      const command = parse(
        entityRenameSchema,
        {
          ref: "PROJECT",
          key: input.argument(),
          ifRevision: input.options.ifRevision,
          requestId: input.options.requestId ?? randomUUID(),
        },
        "изменение ключа проекта",
      );
      const data = await context.backend.entities.rename(command, author(context));
      return {
        data,
        text: (options) =>
          entitySavedText(data, commandInvocation(context, ["project", "get"]), options),
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
