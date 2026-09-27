import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  createBoardTaskSchema,
  updateBoardTaskSchema,
  moveBoardTaskSchema,
  linkBoardTaskSchema,
  changeCriterionSchema,
  criterionContentSchema,
} from "@relay/core/domain/board-task";
import type { BoardTasksQuery } from "@relay/core/domain/board-task";
import type { BoardsQuery } from "@relay/core/domain/board";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import { registerTaskActivity } from "./task-activity.js";
import {
  boardTaskText,
  boardTaskSavedText,
  boardTasksText,
  boardTaskLinksText,
  boardsText,
  criteriaText,
  criterionText,
} from "../presentation/board-tasks.js";

const paging = (command: Command) =>
  command
    .option("--offset <n>", "Смещение страницы", integer(0, Number.MAX_SAFE_INTEGER))
    .option("--limit <n>", "Размер страницы, максимум 100", integer(1, 100))
    .option("--version <version>", "Версия первой страницы для согласованного продолжения");
type WriteOptions = {
  requestId?: string;
  ifRevision?: number;
  board?: string;
  column?: string;
  title?: string;
  description?: string;
  beforeId?: string;
  ifVersion?: string;
  target?: string;
  relation?: string;
  remove?: boolean;
  feature?: string[];
  scenario?: string[];
  implementation?: string[];
  clearProductLinks?: boolean;
  parentId?: string;
  criteria?: string;
};

/** Разбирает критерии создания с предметной ошибкой ввода вместо транспортного сбоя. */
function parseCriteria(value: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new AppError(
      "INVALID_JSON",
      "Параметр --criteria должен содержать JSON-массив критериев",
    );
  }
  return parse(criterionContentSchema.array().max(100), raw, "критерии приёмки");
}

/** Предметные команды досок и задач канбана. */
export function registerBoardTasks(program: Command, runtime: Runtime): void {
  registerCommand<BoardsQuery>(program, runtime, {
    name: "boards",
    description: "Доски проекта и префиксы задач",
    details: "Постраничный каталог; slug или префикс используется в task create --board.",
    examples: [["relay-cli boards", "Выбрать доску"]],
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.boards.list(input.options);
      return { data, text: (options) => boardsText(data, options) };
    },
  });
  const group = commandGroup(program, {
    name: "task",
    description: "Канбан: задачи досок, порядок и междосочные связи",
    details:
      "ID задачи постоянный, ключ с префиксом меняется при переносе. Markdown передаётся напрямую. Запись требует автора; изменение — прочитанной ревизии. После потери ответа перечитайте состояние, комментарии и связи; request-id служит только корреляции и не гарантирует безопасный повтор.",
    examples: [["relay-cli task list --readiness ready", "Работа без блокеров для оркестратора"]],
  });
  registerTaskActivity(group, runtime);
  const criteria = commandGroup(group, {
    name: "criterion",
    description: "Критерии приёмки: условия завершения задачи",
    details:
      "Критерии не мешают началу работы, но обязательны для done. Запись требует ревизии задачи. После потери ответа перечитайте состояние; request-id не предотвращает повторную запись.",
    examples: [["relay-cli task criterion list PRODUCT-1", "Прочитать условия приёмки"]],
  });
  registerCommand<BoardTasksQuery>(criteria, runtime, {
    name: "list <reference>",
    description: "Список критериев без полного Markdown",
    details:
      "По умолчанию 20 записей, максимум 100; продолжение сохраняет версию. Полное описание доступно через criterion get.",
    examples: [
      ["relay-cli task criterion list PRODUCT-1 --limit 20", "Прочитать страницу критериев"],
    ],
    arguments: { reference: "ID или ключ задачи" },
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.boardTasks.listCriteria(input.argument(), input.options);
      return { data, text: (options) => criteriaText(data, input.argument(), options) };
    },
  });
  registerCommand(criteria, runtime, {
    name: "get <reference> <criterionId>",
    description: "Полное описание и состояние критерия",
    details:
      "Возвращает Markdown, отметку выполнения, автора и время, а также ревизию задачи для записи.",
    examples: [["relay-cli task criterion get PRODUCT-1 Abc12345", "Прочитать один критерий"]],
    arguments: { reference: "ID или ключ задачи", criterionId: "Постоянный ID критерия" },
    run: async (context, input) => {
      const data = await context.backend.boardTasks.getCriterion(
        input.argument(),
        input.argument(1),
      );
      return { data, text: (options) => criterionText(data, options) };
    },
  });
  for (const action of ["add", "update", "complete", "reopen", "remove"] as const) {
    registerCommand<WriteOptions & { summary?: string }>(criteria, runtime, {
      name: action === "add" ? "add <reference>" : `${action} <reference> <criterionId>`,
      description: {
        add: "Добавить критерий",
        update: "Изменить критерий и сбросить выполнение при изменении текста",
        complete: "Отметить критерий выполненным",
        reopen: "Снять отметку выполнения",
        remove: "Удалить критерий",
      }[action],
      arguments: {
        reference: "ID или ключ задачи",
        ...(action === "add" ? {} : { criterionId: "Постоянный ID критерия" }),
      },
      details:
        "Готовую задачу сначала верните из done. Результат для повтора не сохраняется. После потери ответа перечитайте состояние; request-id служит только корреляции.",
      examples: [
        [
          `relay-cli --actor human task criterion ${action} PRODUCT-1${action === "add" ? ' --title "Данные сохраняются"' : " Abc12345"} --if-revision 1`,
          "Изменить критерий приёмки",
        ],
      ],
      configure: (command) => {
        command
          .requiredOption(
            "--if-revision <n>",
            "Прочитанная ревизия задачи",
            integer(1, Number.MAX_SAFE_INTEGER),
          )
          .option(
            "--request-id <id>",
            "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
          );
        if (action === "add")
          command.requiredOption("--title <title>", "Обязательный однострочный заголовок");
        if (action === "update") command.option("--title <title>", "Новый однострочный заголовок");
        if (action === "add" || action === "update")
          command
            .option("--summary <text>", "Краткое описание обычным многострочным текстом")
            .option("--description <markdown>", "Полное описание в Markdown");
      },
      run: async (context, input) => {
        const command = parse(
          changeCriterionSchema,
          {
            ...input.options,
            action: action === "reopen" ? "complete" : action,
            ...(action === "add" ? {} : { criterionId: input.argument(1) }),
            ...(action === "complete" || action === "reopen"
              ? { completed: action === "complete" }
              : {}),
            requestId: input.options.requestId ?? randomUUID(),
          },
          "изменение критерия",
        );
        const data = await context.backend.boardTasks.changeCriterion(
          input.argument(),
          command,
          author(context),
        );
        return { data, text: boardTaskSavedText(data) };
      },
    });
  }
  registerCommand<BoardTasksQuery>(group, runtime, {
    name: "list",
    description: "Найти задачи и блокеры на всех или одной доске",
    details: "Возвращает страницу и nextOffset. Полный Markdown читается через task get.",
    examples: [["relay-cli task list --board web --readiness blocked", "Блокеры веб-приложения"]],
    configure: (command) =>
      paging(command)
        .option("--board <board>", "Slug, префикс или ID доски")
        .option("--column <column>", "Ключ колонки")
        .option(
          "--completion <state>",
          "unfinished — без готовых и отменённых; finished — только они",
        )
        .option(
          "--search-in <scope>",
          "title — ключи, ID и заголовок; all — также Markdown (по умолчанию)",
        )
        .option(
          "--product-target <id>",
          "Только задачи, явно реализующие продуктовую цель с этим ID",
        )
        .option("--q <text>", "Поиск по ключу, заголовку и Markdown")
        .option("--readiness <state>", "blocked — с блокерами, ready — готовые к выполнению"),
    run: async (context, input) => {
      const data = await context.backend.boardTasks.list(input.options);
      return { data, text: (options) => boardTasksText(data, input.options, options) };
    },
  });
  registerCommand(group, runtime, {
    name: "get <reference>",
    description: "Открыть задачу с полным Markdown и блокерами",
    arguments: { reference: "ID или текущий/прежний ключ задачи" },
    details: "Полученную ревизию передавайте при изменении.",
    examples: [["relay-cli task get PRODUCT-1", "Прочитать задачу"]],
    run: async (context, input) => {
      const data = await context.backend.boardTasks.get(input.argument());
      return { data, text: (options) => boardTaskText(data, options) };
    },
  });
  registerCommand<BoardTasksQuery>(group, runtime, {
    name: "links <reference>",
    description: "Зависимости, блокируемые задачи, родитель и подзадачи",
    arguments: { reference: "ID или ключ задачи" },
    details: "Состояния связанных задач вычисляются при чтении. Список имеет продолжение.",
    examples: [["relay-cli task links PRODUCT-1", "Понять порядок выполнения"]],
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.boardTasks.links(input.argument(), input.options);
      return { data, text: (options) => boardTaskLinksText(data, input.argument(), options) };
    },
  });
  for (const action of ["create", "update", "move", "link"] as const) {
    registerCommand<WriteOptions>(group, runtime, {
      name: action === "create" ? "create" : `${action} <reference>`,
      description: {
        create: "Создать задачу на доске",
        update: "Изменить содержание или продуктовые связи задачи",
        move: "Перенести задачу в колонку или на другую доску",
        link: "Добавить или удалить связь задач",
      }[action],
      ...(action !== "create" ? { arguments: { reference: "Постоянный ID или ключ задачи" } } : {}),
      details:
        "Общие предметные правила Core действуют в local и HTTP. После потери ответа перечитайте задачу и связи, затем решайте, нужно ли новое изменение; request-id не предотвращает повторную запись. В done нельзя переносить задачу с блокерами.",
      examples: [
        [
          {
            create:
              'relay-cli --actor orchestrator task create --board product --title "Подготовить аренду"',
            update:
              'relay-cli --actor orchestrator task update PRODUCT-1 --description "## Цель\nОписание" --if-revision 1',
            move: "relay-cli --actor orchestrator task move PRODUCT-1 --board web --column ready --if-revision 1",
            link: "relay-cli --actor orchestrator task link WEB-1 --target API-1 --relation depends-on --if-revision 1",
          }[action],
          "Выполнить действие",
        ],
      ],
      configure: (command) => {
        command.option(
          "--request-id <id>",
          "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
        );
        if (action !== "create")
          command.requiredOption(
            "--if-revision <n>",
            "Прочитанная ревизия задачи",
            integer(1, Number.MAX_SAFE_INTEGER),
          );
        if (action === "create")
          command
            .requiredOption("--board <board>", "Slug, префикс или ID доски")
            .option("--title <title>", "Однострочный заголовок; по умолчанию пустой");
        if (action === "update") command.option("--title <title>", "Новый однострочный заголовок");
        if (action === "create" || action === "update")
          command
            .option("--description <markdown>", "Полное описание Markdown напрямую")
            .option(
              "--feature <ids...>",
              "ID реализуемых общих фич; вместе с другими целями заменяет набор связей",
            )
            .option("--scenario <ids...>", "ID реализуемых общих сценариев")
            .option("--implementation <ids...>", "ID реализуемых контрактов приложений")
            .option(
              "--clear-product-links",
              "Удалить все продуктовые связи (не совмещать с целями)",
            );
        if (action === "create")
          command
            .option("--column <column>", "Колонка; по умолчанию inbox")
            .option(
              "--criteria <json>",
              "Массив критериев {title,summary,description} в JSON для атомарного создания; максимум 100",
            )
            .option("--parent-id <id>", "Постоянный ID родителя для атомарного создания подзадачи");
        if (action === "move")
          command
            .option("--board <board>", "Целевая доска; новый ключ, прежний ID")
            .requiredOption(
              "--column <column>",
              "inbox, ready, in-progress, review, done или cancelled",
            )
            .option(
              "--before-id <id>",
              "Вставить перед указанной задачей; по умолчанию конец колонки",
            )
            .option("--if-version <version>", "Версия порядка задач до перемещения");
        if (action === "link")
          command
            .requiredOption("--target <reference>", "ID или ключ второй задачи")
            .requiredOption("--relation <relation>", "depends-on, related или parent")
            .option("--remove", "Удалить указанную связь");
      },
      run: async (context, input) => {
        const { feature, scenario, implementation, clearProductLinks, criteria, ...options } =
          input.options;
        const links = [
          ...(feature ?? []).map((id) => ({ kind: "feature", id })),
          ...(scenario ?? []).map((id) => ({ kind: "scenario", id })),
          ...(implementation ?? []).map((id) => ({ kind: "implementation", id })),
        ];
        if (clearProductLinks && links.length > 0)
          throw new Error("Нельзя совместить удаление всех связей и новые цели");
        const values = {
          ...options,
          ...(criteria === undefined ? {} : { acceptanceCriteria: parseCriteria(criteria) }),
          ...(clearProductLinks || links.length > 0 ? { productLinks: links } : {}),
          requestId: input.options.requestId ?? randomUUID(),
        };
        const service = context.backend.boardTasks;
        const actor = author(context);
        const data =
          action === "create"
            ? await service.create(parse(createBoardTaskSchema, values, "создание задачи"), actor)
            : action === "update"
              ? await service.update(
                  input.argument(),
                  parse(updateBoardTaskSchema, values, "редактирование задачи"),
                  actor,
                )
              : action === "move"
                ? await service.move(
                    input.argument(),
                    parse(moveBoardTaskSchema, values, "перенос задачи"),
                    actor,
                  )
                : await service.link(
                    input.argument(),
                    parse(linkBoardTaskSchema, values, "связь задач"),
                    actor,
                  );
        return { data, text: boardTaskSavedText(data) };
      },
    });
  }
}
