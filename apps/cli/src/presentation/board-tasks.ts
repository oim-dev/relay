import type { BoardTaskView, BoardTaskSaved, BoardTasksQuery } from "@relay/core/domain/board-task";
import type { BoardTasksService } from "@relay/core/application/board-tasks/service";
import type { BoardsService } from "@relay/core/application/boards/service";
import type { EntityDetail, EntitySaved, EntitiesPage } from "@relay/contracts/entities";
import type { TaskProgress } from "@relay/contracts/progress";
import type { CommandContext } from "../context.js";
import { commandInvocation } from "../command-kit.js";
import { actionsText, cardText, listText, receiptText, type OutputField } from "./common.js";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { AppError } from "@relay/core/shared/errors";
import { wrap } from "./layout.js";

export const columns: Record<string, string> = {
  inbox: "Входящие",
  ready: "К выполнению",
  "in-progress": "В работе",
  review: "На проверке",
  done: "Готово",
  cancelled: "Отменено",
};
const relations = {
  "depends-on": "Зависит от",
  blocks: "Блокирует",
  related: "Связана с",
  parent: "Родитель",
  child: "Подзадача",
};
const scopes: Record<string, string> = {
  product: "Продукт",
  infrastructure: "Инфраструктура",
  application: "Приложение",
};
export type TaskInvocation = (args: readonly string[]) => string;
export const taskInvocation =
  (context: CommandContext): TaskInvocation =>
  (args) =>
    commandInvocation(context, args);
const defaultInvocation: TaskInvocation = (args) =>
  `npx @oim-dev/relay-cli ${args.map((value) => (/^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)).join(" ")}`;

/** Backend остаётся единственным источником содержания и отношений. */
export function boardTaskText(
  task: BoardTaskView,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  return cardText(
    {
      title: `${task.key} · ${task.title}`,
      fields: [
        ["Ревизия", task.revision],
        ["Колонка", columns[task.column] ?? task.column],
        ["Доска", task.boardSlug],
        ["Родитель", task.parentId ? `task:${task.parentId}` : "не задан"],
        ["Блокировка", task.blocked ? `есть (${task.blockers.length})` : "нет"],
        [
          "Можно завершить",
          task.canComplete === undefined
            ? "сводка не предоставлена"
            : task.canComplete
              ? "да"
              : "нет",
        ],
        [
          "Критерии",
          task.acceptance
            ? `${task.acceptance.completed}/${task.acceptance.total} выполнено`
            : "сводка не предоставлена Backend",
        ],
        ["Прямые зависимости", task.dependencies.length],
        ["Обычные связи", `${task.related.length} исходящих`],
        [
          "Продуктовые цели",
          task.productLinks.map((link) => `${link.kind}:${link.id}`).join(", ") || "нет",
        ],
        ["Постоянный ID", task.id],
      ],
      sections: [
        {
          title: "Описание",
          body: renderMarkdown(task.description || "Описание пока не заполнено.", options),
        },
      ],
      commands: [
        {
          label: "Прогресс: критерии, дети, зависимости и причины",
          command: invoke(["task", "progress", task.key]),
        },
        {
          label: "Критерии и полные условия",
          command: invoke(["task", "criterion", "list", task.key]),
        },
        { label: "Комментарии", command: invoke(["task", "comment", "list", task.key]) },
        { label: "Связи между задачами", command: invoke(["task", "links", task.key]) },
        {
          label: "Материалы и прямое окружение",
          command: invoke(["inspect", "graph", "list", "--root", task.key, "--depth", "1"]),
        },
        { label: "Участие в планах", command: invoke(["plan", "task", "memberships", task.key]) },
        {
          label: "Полный предпросмотр удаления без записи",
          command: invoke(["task", "delete-preview", task.key]),
        },
      ],
    },
    options,
  );
}

export function boardTaskSavedText(
  saved: BoardTaskSaved | EntitySaved,
  invoke = defaultInvocation,
  receipt: {
    title?: string;
    taskTitle?: string | undefined;
    fields?: OutputField[];
    criterion?: string | undefined;
    removed?: boolean;
    relations?: boolean;
  } = {},
  options: TextOptions = defaultTextOptions,
): string {
  const criterion = receipt.criterion ?? ("criterionId" in saved ? saved.criterionId : undefined);
  const titles: Record<string, string> = {
    create: "Создана задача",
    update: "Задача обновлена",
    move: "Задача перемещена",
    rename: "Ключ задачи изменён",
  };
  const title = receipt.title ?? titles[saved.action] ?? "Задача изменена";
  return receiptText(
    {
      title: `${saved.key} · ${title}`,
      fields: [
        ["Ревизия", saved.revision],
        ["Заголовок", receipt.taskTitle ?? ("task" in saved ? saved.task?.title : undefined)],
        ...(receipt.fields ?? []),
        ...(criterion ? [["Критерий", criterion] as OutputField] : []),
      ],
      commands: [
        { label: "Читать задачу", command: invoke(["task", "get", saved.key]) },
        ...(criterion || receipt.removed
          ? [
              {
                label: "Критерии",
                command: invoke(
                  criterion && !receipt.removed
                    ? ["task", "criterion", "get", saved.key, criterion]
                    : ["task", "criterion", "list", saved.key],
                ),
              },
            ]
          : []),
        ...(receipt.relations
          ? [{ label: "Проверить связи", command: invoke(["task", "links", saved.key]) }]
          : []),
      ],
    },
    options,
  );
}

export function criteriaText(
  page: Awaited<ReturnType<BoardTasksService["listCriteria"]>>,
  reference: string,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  return listText(
    {
      title: `Критерии приёмки · ${reference}`,
      filters: [["Ревизия задачи", page.revision]],
      items: page.items.map((c) => ({
        key: c.id,
        title: c.title,
        details: [
          `${c.completed ? "Выполнен" : "Не выполнен"}${c.summary ? ` · ${c.summary}` : ""}`,
        ],
      })),
      emptyMessage: "На этой странице критериев нет.",
      commands: page.items[0]
        ? [
            {
              label: "Полный критерий — get с ID выбранной строки. Пример этой страницы:",
              command: invoke(["task", "criterion", "get", reference, page.items[0].id]),
            },
          ]
        : [],
    },
    options,
  );
}
export function criterionText(
  view: Awaited<ReturnType<BoardTasksService["getCriterion"]>>,
  options: TextOptions,
  reference?: string,
  invoke = defaultInvocation,
): string {
  const c = view.criterion;
  return cardText(
    {
      title: `${c.id} · ${c.title}`,
      fields: [
        ["Задача", reference],
        ["Ревизия задачи", view.revision],
        ["Состояние", c.completed ? "Выполнен" : "Не выполнен"],
        ["Краткое описание", c.summary],
        ["Выполнил", c.completed ? c.completedBy : undefined],
        ["Время выполнения", c.completed ? c.completedAt : undefined],
      ],
      sections: [
        {
          title: "Описание",
          body: renderMarkdown(c.description || "Полное описание не задано.", options),
        },
      ],
      commands: reference
        ? [{ label: "Критерии задачи", command: invoke(["task", "criterion", "list", reference]) }]
        : [],
    },
    options,
  );
}

export function boardTasksText(
  page: Awaited<ReturnType<BoardTasksService["list"]>>,
  query: BoardTasksQuery,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  return listText(
    {
      title: "Задачи",
      filters: [
        ["Доска", query.board ?? "все"],
        ["Колонка", query.column ? (columns[query.column] ?? query.column) : "все"],
        [
          "Завершённость",
          query.completion === "finished"
            ? "done/cancelled (не гарантия выполнения)"
            : query.completion === "unfinished"
              ? "без done/cancelled"
              : "все",
        ],
        [
          "Готовность",
          query.readiness === "ready"
            ? "к выполнению без блокеров"
            : query.readiness === "blocked"
              ? "с блокерами"
              : "все",
        ],
        ["Поиск", query.q],
        ["Область поиска", query.searchIn === "title" ? "ключ, ID и заголовок" : "также Markdown"],
        ["Продуктовая цель", query.productTarget],
      ],
      items: page.items.map((t) => ({
        key: t.key,
        title: t.title,
        details: [
          `${columns[t.column] ?? t.column} · Ревизия: ${t.revision} · ${t.blocked ? `Блокеры: ${t.blockers.length}` : "Нет блокеров"}`,
        ],
      })),
      emptyMessage: "На этой странице задач нет.",
      commands: taskReadExample(page.items[0]?.key, invoke),
    },
    options,
  );
}
export function boardTaskLinksText(
  page: Awaited<ReturnType<BoardTasksService["links"]>>,
  reference: string,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  return listText(
    {
      title: `Связи между задачами · ${reference}`,
      items: page.items.map(({ relation, task }) => ({
        key: task.key,
        title: task.title,
        details: [
          `${relations[relation]} · ${columns[task.column] ?? task.column} · Ревизия: ${task.revision}${task.blocked ? " · заблокирована" : ""}`,
        ],
      })),
      emptyMessage: "На этой странице связей нет.",
      commands: taskReadExample(page.items[0]?.task.key, invoke),
    },
    options,
  );
}
export function boardsText(
  page: Awaited<ReturnType<BoardsService["list"]>>,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  const first = page.items[0];
  return listText(
    {
      title: "Доски проекта",
      items: page.items.map((b) => ({
        key: b.key ?? b.slug,
        title: b.name,
        details: [
          `${scopes[b.kind] ?? b.kind} · Адрес: ${b.slug} · Префикс: ${b.prefix} · Ревизия: ${b.revision}`,
        ],
      })),
      emptyMessage: "На этой странице досок нет.",
      commands: first
        ? [
            {
              label: "Свойства — board get с ключом выбранной доски. Пример этой страницы:",
              command: invoke(["board", "get", first.key ?? first.slug]),
            },
            {
              label: "Работа по доскам и счётчики",
              command: invoke(["product", "overview", "--metric", "board-work"]),
            },
          ]
        : [],
    },
    options,
  );
}
export function boardText(
  entity: EntityDetail,
  options: TextOptions,
  invoke = defaultInvocation,
): string {
  const data = entity.data;
  if (data.kind !== "board") return "Backend не вернул свойства доски.";
  const owner = entity.references.find(
    (item) => item.ref.kind === "application" && item.ref.id === data.applicationId,
  );
  const application = owner?.key ?? data.applicationId;
  return cardText(
    {
      title: `${entity.key} · ${entity.title}`,
      fields: [
        ["Ревизия", entity.revision],
        ["Область", scopes[data.scope] ?? data.scope],
        ["Адрес", data.slug],
        ["Префикс", data.prefix ?? "не задан"],
        ["Приложение", application, "opaque"],
      ],
      commands: [
        { label: "Задачи доски", command: invoke(["task", "list", "--board", data.slug]) },
        ...(application
          ? [
              {
                label: "Приложение-владелец: содержание и жизненный цикл",
                command: invoke(["application", "get", application]),
              },
            ]
          : []),
      ],
    },
    options,
  );
}
export function taskChildrenText(
  page: EntitiesPage,
  options: TextOptions,
  reference?: string,
  invoke = defaultInvocation,
): string {
  return listText(
    {
      title: `Прямые подзадачи${reference ? ` · ${reference}` : ""}`,
      items: page.items.map((t) => ({
        key: t.key,
        title: t.title,
        details: [
          `${t.status ? (columns[t.status] ?? t.status) : "Состояние не предоставлено"} · Ревизия: ${t.revision}`,
        ],
      })),
      emptyMessage: "На этой странице подзадач нет.",
      commands: taskReadExample(page.items[0]?.key, invoke),
    },
    options,
  );
}
export function taskDependenciesText(
  page: TaskProgress["dependencies"],
  options: TextOptions,
  invoke = defaultInvocation,
  reference?: string,
): string {
  return listText(
    {
      title: `Обязательные зависимости${reference ? ` · ${reference}` : ""}`,
      filters: [["Ревизии", "не предоставлены; перед изменением прочитайте task get"]],
      items: page.items.map((t) => ({
        key: t.key ?? `${t.kind}:${t.id}`,
        title: t.title,
        details: [
          `${columns[t.column] ?? t.column} · Фактически выполнена: ${t.completed ? "да" : "нет"}`,
        ],
      })),
      emptyMessage: "На этой странице обязательных зависимостей нет.",
      commands: taskReadExample(page.items[0]?.key ?? page.items[0]?.id, invoke),
    },
    options,
  );
}

function taskReadExample(reference: string | undefined, invoke: TaskInvocation) {
  return reference
    ? [
        {
          label: "Полная задача — get с ключом выбранной строки. Пример этой страницы:",
          command: invoke(["task", "get", reference]),
        },
      ]
    : [];
}

type TaskFailure = {
  reference: string | undefined;
  action: string;
  group: string;
  invoke: TaskInvocation;
};
const taskFailures = new WeakMap<AppError, TaskFailure>();

export function rememberTaskFailure(error: unknown, context: TaskFailure): void {
  if (error instanceof AppError) taskFailures.set(error, context);
}

/** Только безопасное чтение; исходная ошибка, её details и JSON не изменяются. */
export function taskErrorRecovery(error: AppError, options: TextOptions): string | undefined {
  const context = taskFailures.get(error);
  if (!context) return;
  const { reference, action, group, invoke } = context;
  let prose: string;
  let args: string[];
  if (reference && ["TASK_BLOCKED", "TASK_ACCEPTANCE_INCOMPLETE"].includes(error.code)) {
    prose =
      "Изучите точные критерии и обязательства. Эта ошибка не разрешает принудительное завершение задачи.";
    args = ["task", "progress", reference];
  } else if (reference && /^(?:DEPENDENCY|PARENT|TASK)_CYCLE$/.test(error.code)) {
    prose =
      "Прочитайте связи и согласуйте направление обязательств. Автоматического снятия связей нет.";
    args = ["task", "links", reference];
  } else if (reference && error.code === "REVISION_CONFLICT") {
    prose =
      "Сравните сохранённое содержание со своим изменением; не подставляйте свежую ревизию автоматически.";
    args = ["task", "get", reference];
  } else if (error.code === "BOARD_CHANGED") {
    prose =
      "Перечитайте текущий порядок задач без старого курсора. Версия не открывает исторический снимок.";
    args = ["task", "list"];
  } else if (/NOT_FOUND$/.test(error.code)) {
    prose =
      "Проверьте адрес и выбранный проект. Найдите запись в списке; ничего не создавайте вместо отсутствующей записи автоматически.";
    args =
      reference && group === "criterion"
        ? ["task", "criterion", "list", reference]
        : reference && group === "comment"
          ? ["task", "comment", "list", reference]
          : ["task", "list"];
  } else if (
    ["SERVER_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(error.code) &&
    !["get", "list", "children", "links"].includes(action)
  ) {
    prose =
      "Ответ записи не получен: действие могло завершиться. Сначала перечитайте состояние, не повторяйте запись вслепую; request-id не защищает от дубликатов.";
    args =
      reference && group === "comment"
        ? ["task", "comment", "list", reference]
        : reference
          ? ["task", "get", reference]
          : ["task", "list"];
  } else return;
  return [
    wrap(`Следующий шаг: ${prose}`, options.width),
    actionsText(
      [{ label: "Безопасное чтение без записи", command: invoke(args), purpose: "recovery" }],
      options,
    ),
  ].join("\n\n");
}
