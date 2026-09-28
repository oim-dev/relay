import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  entityCreateSchema,
  entityUpdateSchema,
  entityRenameSchema,
} from "@relay/contracts/entities";
import {
  changeCriterionSchema,
  criterionContentSchema,
  moveBoardTaskSchema,
} from "@relay/core/domain/board-task";
import type { BoardTasksQuery } from "@relay/core/domain/board-task";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import { paging, offsetQuery, pageResult, textOption, readTextFields } from "../command-kit.js";
import { registerTaskActivity } from "./task-activity.js";
import { registerEntityProgress } from "./progress.js";
import {
  boardTaskText,
  boardTaskSavedText,
  boardTasksText,
  boardTaskLinksText,
  boardsText,
  boardText,
  taskChildrenText,
  taskDependenciesText,
  criteriaText,
  criterionText,
  taskInvocation,
  columns,
} from "../presentation/board-tasks.js";

type PageOptions = { limit?: number; cursor?: string };
type WriteOptions = {
  requestId?: string;
  ifRevision?: number;
  board?: string;
  column?: string;
  title?: string;
  description?: string;
  summary?: string;
  before?: string;
  ifVersion?: string;
  parent?: string;
  dependencies?: string[];
  related?: string[];
  targets?: string[];
  clearTargets?: boolean;
  criterionTitle?: string[];
  criterionSummary?: string[];
  criterionDescription?: string[];
};
const writeOptions = (command: Command, revision = true) => {
  command.option("--request-id <id>", "Корреляция запроса, не защита от повторной записи");
  if (revision)
    command.requiredOption(
      "--if-revision <n>",
      "Прочитанная ревизия задачи",
      integer(1, Number.MAX_SAFE_INTEGER),
    );
  return command;
};
const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Метки объединяют поля независимо от порядка флагов; разделителем служит только первое '='. */
function creationCriteria(options: WriteOptions) {
  const criteria = new Map<string, Record<string, string>>();
  for (const [field, entries] of [
    ["title", options.criterionTitle],
    ["summary", options.criterionSummary],
    ["description", options.criterionDescription],
  ] as const) {
    for (const entry of entries ?? []) {
      const separator = entry.indexOf("=");
      const label = entry.slice(0, separator);
      if (separator < 1 || !/^[A-Za-z0-9_-]+$/.test(label))
        throw new AppError(
          "INVALID_ARGUMENT",
          "Критерий задаётся как метка=текст; метка содержит латинские буквы, цифры, _ или -",
        );
      const criterion = criteria.get(label) ?? {};
      if (criterion[field] !== undefined)
        throw new AppError("INVALID_ARGUMENT", `Поле ${field} критерия ${label} передано повторно`);
      criterion[field] = entry.slice(separator + 1);
      criteria.set(label, criterion);
    }
  }
  if (!criteria.size) return undefined;
  for (const [label, criterion] of criteria)
    if (criterion.title === undefined)
      throw new AppError(
        "INVALID_ARGUMENT",
        `Для критерия ${label} нужен --criterion-title ${label}=заголовок`,
      );
  return parse(criterionContentSchema.array().max(100), [...criteria.values()], "критерии приёмки");
}

/** Задачи используют предметные операции Backend, а не клиентскую синхронизацию графа. */
export function registerBoardTasks(program: Command, runtime: Runtime): void {
  const board = commandGroup(program, {
    name: "board",
    description: "Доски проекта",
    details: "Доски создаются вместе с проектом и приложениями.",
    examples: [["npx @oim-dev/relay-cli board list", "Выбрать доску"]],
  });
  registerCommand<PageOptions>(board, runtime, {
    name: "list",
    description: "Прочитать каталог досок",
    configure: paging,
    details: "Продолжение сохраняет снимок каталога. Ключ доски используется при создании задач.",
    examples: [["npx @oim-dev/relay-cli board list --limit 20", "Прочитать страницу"]],
    async run(context, input) {
      const command = ["board", "list"];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.boards.list(query);
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) => boardsText(data, options),
      };
    },
  });
  registerCommand(board, runtime, {
    name: "get <ref>",
    description: "Прочитать свойства доски",
    arguments: { ref: "Ключ или ID доски" },
    details: "Адрес разрешается как board; ответ содержит канонический ключ и ревизию.",
    examples: [["npx @oim-dev/relay-cli board get BOARD-PRODUCT", "Открыть доску"]],
    async run(context, input) {
      const data = await context.backend.entities.get({ ref: input.argument(), kind: "board" });
      return { data, text: (options) => boardText(data, options, taskInvocation(context)) };
    },
  });
  const group = commandGroup(program, {
    name: "task",
    description: "Задачи, подзадачи, зависимости и обсуждения",
    details:
      "Ключи и ID разрешаются в выбранном проекте. Запись требует автора, изменение — прочитанной ревизии. После потери ответа перечитайте состояние: автоматических повторов нет, request-id не предотвращает дубликаты.",
    examples: [
      ["npx @oim-dev/relay-cli task list --readiness ready", "Выбрать работу без блокеров"],
    ],
  });
  registerTaskActivity(group, runtime);
  registerCommand<BoardTasksQuery & PageOptions>(group, runtime, {
    name: "list",
    description: "Найти задачи и блокеры",
    details:
      "Полное описание читается через task get. Фильтры применяются до пагинации; для следующей страницы скопируйте команду продолжения. finished включает done/cancelled, но не доказывает фактическое выполнение; ready — колонка ready без блокеров.",
    examples: [
      ["npx @oim-dev/relay-cli task list --board product --limit 20", "Прочитать задачи доски"],
    ],
    configure: (command) =>
      paging(command)
        .option("--board <ref>", "Slug, префикс или ID доски")
        .option("--column <column>", "Колонка: inbox, ready, in-progress, review, done, cancelled")
        .option("--completion <state>", "unfinished — без done/cancelled; finished — только они")
        .option("--search-in <scope>", "title — ключ, ID, заголовок; all — также Markdown")
        .option("--product-target <ref>", "Ключ или ID продуктовой цели")
        .option("--q <text>", "Поиск по ключу, заголовку и Markdown")
        .option("--readiness <state>", "blocked — с блокерами; ready — готовые к выполнению"),
    async run(context, input) {
      const { limit: _limit, cursor: _cursor, ...filters } = input.options;
      const command = ["task", "list"];
      const query = offsetQuery(context, input.options, command, filters);
      const data = await context.backend.boardTasks.list({ ...filters, ...query });
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => boardTasksText(data, filters, options),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "get <task>",
    description: "Прочитать полную задачу",
    arguments: { task: "Текущий/прежний ключ или ID задачи" },
    details: "Перед изменением прочитайте содержание и используйте показанную ревизию.",
    examples: [["npx @oim-dev/relay-cli task get PRODUCT-1", "Прочитать содержание и ревизию"]],
    async run(context, input) {
      const data = await context.backend.boardTasks.get(input.argument());
      return { data, text: (options) => boardTaskText(data, options, taskInvocation(context)) };
    },
  });
  registerCommand<PageOptions>(group, runtime, {
    name: "children <task>",
    description: "Прочитать прямые подзадачи",
    arguments: { task: "Ключ или ID родителя" },
    details:
      "Фильтр родителя применяется Backend до пагинации; список содержит только прямых детей.",
    examples: [
      ["npx @oim-dev/relay-cli task children PRODUCT-1 --limit 20", "Прочитать подзадачи"],
    ],
    configure: paging,
    async run(context, input) {
      const command = ["task", "children", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.entities.list({
        kind: "task",
        parent: input.argument(),
        ...query,
      });
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) => taskChildrenText(data, options, input.argument()),
      };
    },
  });
  registerCommand<PageOptions>(group, runtime, {
    name: "links <task>",
    description: "Прочитать все предметные связи задачи",
    arguments: { task: "Ключ или ID задачи" },
    details:
      "Включает родителя, детей, зависимости, блокируемые и обычные связанные задачи. Страница не означает полный состав.",
    examples: [["npx @oim-dev/relay-cli task links PRODUCT-1", "Прочитать связи"]],
    configure: paging,
    async run(context, input) {
      const command = ["task", "links", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.boardTasks.links(input.argument(), query);
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) => boardTaskLinksText(data, input.argument(), options),
      };
    },
  });
  registerEntityProgress(group, runtime, "task");
  for (const action of ["create", "update"] as const) {
    registerCommand<WriteOptions>(group, runtime, {
      name: action === "create" ? "create" : "update <task>",
      description:
        action === "create"
          ? "Атомарно создать задачу с критериями и связями"
          : "Изменить только переданные поля задачи",
      ...(action === "update" ? { arguments: { task: "Ключ или ID задачи" } } : {}),
      details:
        action === "create"
          ? "Критерии: повторяйте --criterion-title метка=заголовок, --criterion-summary метка=текст и --criterion-description метка=Markdown. Метка: латиница, цифры, _ и -. Заголовок обязателен для каждой метки; остальные поля по умолчанию пусты. Порядок критериев — порядок --criterion-title. Метки не сохраняются. До 100 критериев, всё создаётся одной операцией."
          : "Отсутствующие поля сохраняются. --targets заменяет весь набор целей; --clear-targets очищает его и несовместим с --targets. Критерии и связи меняются отдельными командами.",
      examples: [
        [
          action === "create"
            ? "npx @oim-dev/relay-cli task create --actor agent --board BOARD-PRODUCT --title 'Сделать поиск' --criterion-title 'search=Находит документ' --criterion-summary 'search=По названию' --criterion-description 'search=## Проверка\nВведите название.'"
            : "npx @oim-dev/relay-cli task update PRODUCT-1 --actor agent --title 'Уточнённая задача' --if-revision 1",
          "Сохранить задачу",
        ],
      ],
      configure(command) {
        writeOptions(command, action === "update");
        command.option("--title <text>", "Однострочный заголовок");
        textOption(command, "description", "Полное описание задачи в Markdown");
        command
          .option("--targets <refs...>", "Полный набор продуктовых целей по ключам или ID")
          .option("--clear-targets", "Явно очистить цели; нельзя вместе с --targets");
        if (action === "create")
          command
            .requiredOption("--board <ref>", "Ключ или ID доски")
            .option("--column <column>", "Начальная колонка; по умолчанию inbox")
            .option("--parent <ref>", "Ключ или ID родителя")
            .option("--dependencies <refs...>", "Ключи или ID обязательных зависимостей")
            .option("--related <refs...>", "Ключи или ID связанных задач без блокировки")
            .option(
              "--criterion-title <метка=текст>",
              "Повторяемый заголовок критерия с уникальной меткой",
              collect,
            )
            .option(
              "--criterion-summary <метка=текст>",
              "Повторяемое краткое описание критерия с той же меткой",
              collect,
            )
            .option(
              "--criterion-description <метка=Markdown>",
              "Повторяемое полное описание критерия с той же меткой",
              collect,
            );
      },
      async run(context, input) {
        const options = input.options;
        if (options.clearTargets && options.targets !== undefined)
          throw new AppError("INVALID_ARGUMENT", "Нельзя совместить --clear-targets и --targets");
        const text = await readTextFields(context, options, ["description"]);
        const fields = {
          kind: "task",
          ...(options.title === undefined ? {} : { title: options.title }),
          ...text,
          ...(options.clearTargets
            ? { targets: [] }
            : options.targets === undefined
              ? {}
              : { targets: options.targets }),
        };
        const requestId = options.requestId ?? randomUUID();
        const data =
          action === "create"
            ? await context.backend.entities.create(
                parse(
                  entityCreateSchema,
                  {
                    data: {
                      ...fields,
                      board: options.board,
                      column: options.column,
                      parent: options.parent,
                      dependencies: options.dependencies,
                      related: options.related,
                      acceptanceCriteria: creationCriteria(options),
                    },
                    requestId,
                  },
                  "создание задачи",
                ),
                author(context),
              )
            : await context.backend.entities.update(
                parse(
                  entityUpdateSchema,
                  {
                    ref: input.argument(),
                    changes: fields,
                    ifRevision: options.ifRevision,
                    requestId,
                  },
                  "изменение задачи",
                ),
                author(context),
              );
        return {
          data,
          text: (format) =>
            boardTaskSavedText(
              data,
              taskInvocation(context),
              {
                title: action === "create" ? "Создана задача" : "Задача обновлена",
                taskTitle: options.title,
                fields: [
                  ["Доска", options.board],
                  [
                    "Колонка",
                    action === "create"
                      ? (columns[options.column ?? "inbox"] ?? options.column)
                      : undefined,
                  ],
                  ["Родитель", options.parent],
                  ["Зависимости", options.dependencies?.join(", ")],
                  ["Обычные связи", options.related?.join(", ")],
                  [
                    "Продуктовые цели",
                    options.clearTargets ? "очищены" : options.targets?.join(", "),
                  ],
                  ["Добавлено критериев", options.criterionTitle?.length],
                ],
                removed: Boolean(options.criterionTitle?.length),
                relations: Boolean(
                  options.parent || options.dependencies?.length || options.related?.length,
                ),
              },
              format,
            ),
        };
      },
    });
  }
  registerCommand<WriteOptions>(group, runtime, {
    name: "rename <task> <key>",
    description: "Изменить ключ задачи, сохранив ID и прежний адрес",
    details:
      "Меняется ключ, а не заголовок. Прежний ключ остаётся алиасом. Коллизии и устаревшая ревизия отклоняются.",
    arguments: { task: "Ключ или ID задачи", key: "Новый читаемый ключ, не заголовок" },
    examples: [
      [
        "npx @oim-dev/relay-cli task rename PRODUCT-1 TASK-1 --actor agent --if-revision 1",
        "Изменить ключ",
      ],
    ],
    configure: (command) => writeOptions(command),
    async run(context, input) {
      const target = await context.backend.entities.resolve({
        ref: input.argument(),
        kind: "task",
      });
      const data = await context.backend.entities.rename(
        parse(
          entityRenameSchema,
          {
            ref: `task:${target.ref.id}`,
            key: input.argument(1),
            ifRevision: input.options.ifRevision,
            requestId: input.options.requestId ?? randomUUID(),
          },
          "ключ задачи",
        ),
        author(context),
      );
      return {
        data,
        text: (format) =>
          boardTaskSavedText(
            data,
            taskInvocation(context),
            {
              title: "Ключ задачи изменён",
              taskTitle: target.title,
              fields: [["Прежний адрес (алиас)", target.key]],
            },
            format,
          ),
      };
    },
  });
  registerCommand<WriteOptions>(group, runtime, {
    name: "move <task>",
    description: "Переместить задачу в колонку или на другую доску",
    arguments: { task: "Ключ или ID задачи" },
    details:
      "Core проверяет блокеры. Перенос сохраняет ID; несовместимые цели предварительно снимите явно.",
    examples: [
      [
        "npx @oim-dev/relay-cli task move PRODUCT-1 --actor agent --column review --if-revision 1",
        "Передать на проверку",
      ],
    ],
    configure: (command) =>
      writeOptions(command)
        .requiredOption(
          "--column <column>",
          "inbox, ready, in-progress, review, done или cancelled",
        )
        .option("--board <ref>", "Ключ, slug, префикс или ID целевой доски")
        .option("--before <ref>", "Ключ или ID следующей задачи; без флага — конец колонки")
        .option("--if-version <version>", "Прочитанная версия порядка задач"),
    async run(context, input) {
      const { before, ...options } = input.options;
      const data = await context.backend.boardTasks.move(
        input.argument(),
        parse(
          moveBoardTaskSchema,
          {
            ...options,
            beforeId: before ?? null,
            requestId: options.requestId ?? randomUUID(),
          },
          "перемещение задачи",
        ),
        author(context),
      );
      return {
        data,
        text: (format) =>
          boardTaskSavedText(
            data,
            taskInvocation(context),
            {
              title: "Задача перемещена",
              fields: [
                ["Колонка", columns[options.column!] ?? options.column],
                ["Доска", options.board],
                ["Положение", before ? `перед ${before}` : "конец колонки"],
              ],
            },
            format,
          ),
      };
    },
  });
  const parent = commandGroup(group, {
    name: "parent",
    description: "Родитель задачи",
    details: "Родительство означает декомпозицию; снятие сохраняет обе задачи.",
    examples: [["npx @oim-dev/relay-cli task get PRODUCT-1", "Прочитать родителя"]],
  });
  const dependency = commandGroup(group, {
    name: "dependency",
    description: "Обязательные зависимости задачи",
    details: "Необходимые результаты других задач; циклы проверяет Core.",
    examples: [["npx @oim-dev/relay-cli task dependency list PRODUCT-1", "Прочитать зависимости"]],
  });
  registerCommand<PageOptions>(dependency, runtime, {
    name: "list <task>",
    description: "Прочитать прямые обязательные зависимости",
    arguments: { task: "Ключ или ID задачи" },
    details:
      "Используется отдельная страница dependencies предметного прогресса, а не фильтрация страницы всех связей. Выполнение вычисляется Core; ревизии соседей этот ответ не содержит. JSON сохраняет полный ответ прогресса.",
    examples: [
      ["npx @oim-dev/relay-cli task dependency list PRODUCT-1 --limit 20", "Прочитать зависимости"],
    ],
    configure: paging,
    async run(context, input) {
      const command = ["task", "dependency", "list", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.progress.task({ ref: input.argument(), ...query });
      return {
        data,
        page: pageResult(context, command, {}, query, {
          ...data.dependencies,
          version: data.version,
        }),
        text: (options) =>
          taskDependenciesText(
            data.dependencies,
            options,
            taskInvocation(context),
            input.argument(),
          ),
      };
    },
  });
  for (const [owner, name, relation, remove] of [
    [group, "link", "related", false],
    [group, "unlink", "related", true],
    [parent, "set", "parent", false],
    [parent, "clear", "parent", true],
    [dependency, "add", "depends-on", false],
    [dependency, "remove", "depends-on", true],
  ] as const) {
    const clear = relation === "parent" && remove;
    const targetName =
      relation === "parent" ? "parent" : relation === "depends-on" ? "dependency" : "target";
    registerCommand<WriteOptions>(owner, runtime, {
      name: `${name} <task>${clear ? "" : ` <${targetName}>`}`,
      description: `${remove ? "Снять" : "Установить"} ${relation === "parent" ? "родителя" : relation === "related" ? "обычную связь" : "зависимость"} задачи`,
      arguments: {
        task: "Ключ или ID задачи",
        ...(clear ? {} : { [targetName]: "Ключ или ID второй задачи (для parent — родитель)" }),
      },
      details:
        "Проверка ревизии обязательна. Снятие родительства сохраняет обе задачи. Автоматической подстановки новой ревизии нет.",
      examples: [
        [
          `npx @oim-dev/relay-cli task ${owner === group ? "" : relation === "parent" ? "parent " : "dependency "}${name} PRODUCT-1${clear ? "" : " PRODUCT-2"} --actor agent --if-revision 1`,
          "Изменить предметную связь",
        ],
      ],
      configure: (command) => writeOptions(command),
      async run(context, input) {
        const task = clear ? await context.backend.boardTasks.get(input.argument()) : undefined;
        if (task && task.revision !== input.options.ifRevision)
          throw new AppError(
            "REVISION_CONFLICT",
            "Задача изменена: перечитайте её и согласуйте снятие родителя заново",
          );
        if (task && !task.parentId)
          throw new AppError("INVALID_ARGUMENT", "У задачи нет родителя; снимать нечего");
        const data = await context.backend.entities.linkTask(
          {
            ref: input.argument(),
            target: task?.parentId ?? input.argument(1),
            relation,
            remove,
            ifRevision: input.options.ifRevision!,
            requestId: input.options.requestId ?? randomUUID(),
          },
          author(context),
        );
        return {
          data,
          text: (format) =>
            boardTaskSavedText(
              data,
              taskInvocation(context),
              {
                title:
                  relation === "parent"
                    ? remove
                      ? "Родитель снят"
                      : "Родитель назначен"
                    : relation === "depends-on"
                      ? remove
                        ? "Зависимость снята"
                        : "Зависимость добавлена"
                      : remove
                        ? "Обычная связь снята"
                        : "Обычная связь добавлена",
                taskTitle: task?.title,
                fields: [
                  [
                    relation === "parent"
                      ? "Родитель"
                      : relation === "depends-on"
                        ? "Зависит от"
                        : "Связана с",
                    task?.parentId ?? input.argument(1),
                  ],
                ],
                relations: true,
              },
              format,
            ),
        };
      },
    });
  }
  const criteria = commandGroup(group, {
    name: "criterion",
    description: "Критерии приёмки задачи",
    details: "Изменения требуют ревизии задачи. Для задачи в done сначала измените колонку.",
    examples: [["npx @oim-dev/relay-cli task criterion list PRODUCT-1", "Прочитать критерии"]],
  });
  registerCommand<PageOptions>(criteria, runtime, {
    name: "list <task>",
    description: "Прочитать критерии без полного Markdown",
    arguments: { task: "Ключ или ID задачи" },
    details:
      "Полное описание доступно через task criterion get. Для записи используйте ревизию задачи.",
    examples: [
      ["npx @oim-dev/relay-cli task criterion list PRODUCT-1", "Прочитать страницу критериев"],
    ],
    configure: paging,
    async run(context, input) {
      const command = ["task", "criterion", "list", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.boardTasks.listCriteria(input.argument(), query);
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) => criteriaText(data, input.argument(), options),
      };
    },
  });
  registerCommand(criteria, runtime, {
    name: "get <task> <criterion>",
    description: "Прочитать полный критерий и отметку выполнения",
    details: "Возвращает полное описание, автора и время выполнения, ревизию задачи.",
    arguments: { task: "Ключ или ID задачи", criterion: "Постоянный ID критерия" },
    examples: [
      ["npx @oim-dev/relay-cli task criterion get PRODUCT-1 Abc12345", "Прочитать критерий"],
    ],
    async run(context, input) {
      const data = await context.backend.boardTasks.getCriterion(
        input.argument(),
        input.argument(1),
      );
      return {
        data,
        text: (options) => criterionText(data, options, input.argument(), taskInvocation(context)),
      };
    },
  });
  for (const action of ["add", "update", "complete", "reopen", "remove"] as const) {
    registerCommand<WriteOptions>(criteria, runtime, {
      name: `${action} <task>${action === "add" ? "" : " <criterion>"}`,
      description: {
        add: "Добавить критерий",
        update: "Изменить переданные поля критерия",
        complete: "Отметить выполненным",
        reopen: "Снять отметку выполнения",
        remove: "Удалить критерий",
      }[action],
      arguments: {
        task: "Ключ или ID задачи",
        ...(action === "add" ? {} : { criterion: "Постоянный ID критерия" }),
      },
      details:
        "Изменение текста сбрасывает выполнение. Ревизия относится к задаче. После потери ответа перечитайте состояние, не повторяйте запись вслепую.",
      examples: [
        [
          `npx @oim-dev/relay-cli task criterion ${action} PRODUCT-1${action === "add" ? " --title 'Результат проверен'" : " Abc12345"} --actor agent --if-revision 1`,
          "Изменить критерий",
        ],
      ],
      configure(command) {
        writeOptions(command);
        if (action === "add")
          command.requiredOption("--title <text>", "Обязательный однострочный заголовок");
        if (action === "update") command.option("--title <text>", "Новый однострочный заголовок");
        if (action === "add" || action === "update") {
          textOption(command, "summary", "Краткое обычное описание");
          textOption(command, "description", "Полное описание в Markdown");
        }
      },
      async run(context, input) {
        const text =
          action === "add" || action === "update"
            ? await readTextFields(context, input.options, ["summary", "description"])
            : {};
        const data = await context.backend.boardTasks.changeCriterion(
          input.argument(),
          parse(
            changeCriterionSchema,
            {
              ...text,
              ...(input.options.title === undefined ? {} : { title: input.options.title }),
              ifRevision: input.options.ifRevision,
              requestId: input.options.requestId ?? randomUUID(),
              action: action === "reopen" ? "complete" : action,
              ...(action === "add" ? {} : { criterionId: input.argument(1) }),
              ...(action === "complete" || action === "reopen"
                ? { completed: action === "complete" }
                : {}),
            },
            "изменение критерия",
          ),
          author(context),
        );
        return {
          data,
          text: (format) =>
            boardTaskSavedText(
              data,
              taskInvocation(context),
              {
                title: {
                  add: "Критерий добавлен",
                  update: "Критерий обновлён",
                  complete: "Критерий выполнен",
                  reopen: "Отметка выполнения критерия снята",
                  remove: "Критерий удалён",
                }[action],
                criterion: action === "add" ? data.criterionId : input.argument(1),
                removed: action === "remove",
                fields: [["Заголовок критерия", input.options.title]],
              },
              format,
            ),
        };
      },
    });
  }
}
