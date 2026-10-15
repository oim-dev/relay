import type {
  AgentRunSummary,
  WorkCheckpoint,
  WorkContext,
  WorkHistoryItem,
  WorkHistoryMutation,
  WorkHistoryPage,
  WorkHistoryQuery,
  WorkOpenIntentsPage,
  WorkOpenIntentsQuery,
  WorkSession,
  WorkSessionDetail,
  WorkSessionsPage,
  WorkSessionsQuery,
  WorkSessionSummary,
  WorkSessionCounts,
  WorkSessionAcceptance,
  WorkTreePage,
} from "@relay/contracts/work-history";
import { cardText, listText, receiptText, type OutputField, type OutputSection } from "./common.js";
import { renderMarkdown } from "./markdown.js";
import { safeText } from "./safe.js";
import type { TextOptions } from "./theme.js";

type Invoke = (tokens: string[]) => string;
const statusLabels = {
  pending: "Ожидает участия",
  open: "Открыта",
  paused: "Приостановлена",
  completed: "Завершена",
  cancelled: "Отменена",
};
const kindLabels = {
  intent: "Намерение",
  progress: "Промежуточный материал",
  result: "Результат",
  cancel: "Отмена намерения",
};
const eventLabels = {
  "session-created": "Создана ветка",
  "session-forked": "Ответвление",
  "session-closed": "Закрыта ветка",
  "run-started": "Начато участие",
  "run-ended": "Окончено участие",
  checkpoint: "Точка работы",
};
const endLabels = {
  completed: "Завершение",
  paused: "Пауза",
  transferred: "Передача",
  cancelled: "Отмена",
};
const sessionRef = (id: string) => `work-session:${id}`;
const checkpointRef = (id: string) => `work-checkpoint:${id}`;
const md = (title: string, body: string, options: TextOptions): OutputSection => ({
  title,
  body: renderMarkdown(body, options),
});
const sessionFields = (session: WorkSessionSummary): OutputField[] => [
  ["Состояние", `${statusLabels[session.status]} (${session.status})`],
  ["Ревизия ветки", session.revision],
  [
    "Родитель",
    session.parentSessionId ? sessionRef(session.parentSessionId) : "Корневая ветка",
    "opaque",
  ],
  [
    "Исходное намерение",
    session.originCheckpointId ? checkpointRef(session.originCheckpointId) : null,
    "opaque",
  ],
];
const assignmentSections = (session: WorkSession, options: TextOptions): OutputSection[] => [
  md("Поручение — полный Markdown", session.description, options),
  md(
    session.status === "cancelled" ? "Причина отмены — полный Markdown" : "Итог — полный Markdown",
    session.result,
    options,
  ),
];
const runFields = (run: AgentRunSummary): OutputField[] => [
  ["Участие", run.key, "opaque"],
  ["run.id для --run", run.id, "opaque"],
  ["Агент / автор участия", run.actor],
  ["Пользователь — имя", run.operator?.name ?? "не указан"],
  ["Пользователь — email", run.operator?.email ?? "не указан"],
  ["Источник атрибуции", run.operator?.source ?? "не указан"],
  ["Git-ветка клиента", run.git?.branch ?? "не указана", "opaque"],
  ["Git HEAD клиента", run.git?.commit ?? "не указан", "opaque"],
  ["Клиент", run.client],
  ["Внешняя сессия клиента", run.sourceSessionId, "opaque"],
  ["Начало (ISO, часовой пояс)", run.startedAt, "opaque"],
  ["Окончание (ISO, часовой пояс)", run.endedAt, "opaque"],
  ["Причина окончания", run.endReason ? endLabels[run.endReason] : null],
  ["Предыдущее run.id", run.predecessorRunId, "opaque"],
];
const sessionCommands = (session: WorkSessionSummary, invoke: Invoke) => [
  {
    label: "Все открытые намерения — включая старые",
    command: invoke(["session", "intents", session.key]),
  },
  {
    label: "Полные материалы последней страницы",
    command: invoke(["session", "context", session.key]),
  },
  { label: "Иерархия и полные итоги поддерева", command: invoke(["session", "tree", session.key]) },
  {
    label: "Хронология вместе с потомками",
    command: invoke(["session", "history", session.key, "--include-children"]),
  },
];

const countFields = (counts: WorkSessionCounts): OutputField[] => [
  ["Участий этой ветки (всего)", counts.runs],
  ["Точек этой ветки (всего)", counts.checkpoints],
  ["Открытых намерений", counts.openIntents],
  ["Прямых дочерних веток", counts.children],
  ["Незавершённых прямых детей", counts.unfinishedChildren],
];
function acceptanceFields(
  session: WorkSessionSummary,
  acceptance: WorkSessionAcceptance | null,
): OutputField[] {
  if (acceptance)
    return [
      ["Принятие результата", `Принят в ${acceptance.checkpointKey}`, "opaque"],
      ["Принят (ISO, часовой пояс)", acceptance.at, "opaque"],
    ];
  return session.parentSessionId && session.status === "completed"
    ? [["Принятие результата", "Ожидает принятия родителем"]]
    : [];
}
function latestRunFields(run: AgentRunSummary | null): OutputField[] {
  if (!run)
    return [
      ["Последнее участие", "Ещё не было"],
      ["Пользователь", "не указан"],
    ];
  return [
    ["Последнее участие", run.key, "opaque"],
    ["Агент", run.actor],
    [
      "Пользователь",
      run.operator
        ? [run.operator.name, run.operator.email].filter(Boolean).join(" · ") || "не указан"
        : "не указан",
    ],
    ["Git-ветка клиента", run.git?.branch, "opaque"],
    ["Git HEAD клиента", run.git?.commit, "opaque"],
  ];
}

export function sessionText(data: WorkSessionDetail, options: TextOptions, invoke: Invoke): string {
  const { session, counts, currentRun } = data;
  return cardText(
    {
      title: session.title,
      opaqueKey: session.key,
      fields: [
        ...sessionFields(session),
        ["ID ветки", session.id, "opaque"],
        ["Создана (ISO, часовой пояс)", session.createdAt, "opaque"],
        ["Изменена (ISO, часовой пояс)", session.updatedAt, "opaque"],
        ["Закрыта (ISO, часовой пояс)", session.closedAt, "opaque"],
        ...countFields(counts),
        ...acceptanceFields(session, data.acceptance),
      ],
      sections: [
        ...assignmentSections(session, options),
        {
          title: "Текущее участие — не проверка присутствия online",
          body: currentRun
            ? cardText(
                {
                  title: currentRun.actor,
                  opaqueKey: currentRun.key,
                  fields: runFields(currentRun),
                  sections: [md("Причина подключения", currentRun.reason, options)],
                },
                options,
              )
            : "Текущего участия нет.",
        },
        ...(!currentRun && data.latestRun
          ? [
              {
                title: "Последнее сохранённое участие — обзор, не текущее владение",
                body: cardText(
                  {
                    title: data.latestRun.actor,
                    opaqueKey: data.latestRun.key,
                    fields: runFields(data.latestRun),
                  },
                  options,
                ),
              },
            ]
          : []),
      ],
      commands: sessionCommands(session, invoke),
    },
    options,
  );
}

export function sessionListText(
  data: WorkSessionsPage,
  query: WorkSessionsQuery,
  options: TextOptions,
  invoke: Invoke,
): string {
  return listText(
    {
      title: "Ветки работы — обзор, не список подключённых агентов",
      filters: [
        ["Веток всего проекта (без фильтров)", data.projectTotals.sessions],
        ["Незавершённых веток проекта", data.projectTotals.unfinished],
        ["Участий всего проекта", data.projectTotals.runs],
        ["Точек всего проекта", data.projectTotals.checkpoints],
        ["Открытых намерений проекта", data.projectTotals.openIntents],
        [
          "Незавершённость",
          query.unfinished === undefined
            ? null
            : query.unfinished
              ? "pending/open/paused"
              : "completed/cancelled",
        ],
        ["Состояние", query.status ? statusLabels[query.status] : null],
        ["Родитель выборки", query.parent === null ? "Только корни" : query.parent, "opaque"],
        ["Автор участия (фильтр)", query.actor],
        ["Поиск", query.q],
      ],
      items: data.items.map((session) => ({
        key: session.key,
        keyMode: "opaque",
        title: session.title,
        fields: [
          ...sessionFields(session),
          ...countFields(session.counts),
          ...acceptanceFields(session, session.acceptance),
          ...latestRunFields(session.latestRun),
          ["Текущее run.id", session.currentRunId, "opaque"],
          ["Изменена (ISO, часовой пояс)", session.updatedAt, "opaque"],
        ],
      })),
      emptyMessage: "В этой выборке веток нет.",
      commands: data.items[0]
        ? [
            {
              label: "Полное поручение и итог — пример для первой ветки",
              command: invoke(["session", "get", data.items[0].key]),
            },
          ]
        : [{ label: "Как начать новую ветку", command: invoke(["session", "start", "--help"]) }],
    },
    options,
  );
}

export function sessionTreeText(data: WorkTreePage, options: TextOptions, invoke: Invoke): string {
  const visible = new Map(data.items.map(({ session }) => [session.id, session.key]));
  const totals = data.totals;
  return listText(
    {
      title: "Дерево работы — страница иерархии",
      filters: [
        [
          "Выбранный корень",
          visible.get(data.rootSessionId) ?? sessionRef(data.rootSessionId),
          "opaque",
        ],
        ["Всего веток поддерева", totals.sessions],
        ["Незавершённых веток", totals.unfinished],
        ["Всего участий поддерева", totals.runs],
        ["Всего точек поддерева", totals.checkpoints],
        ["Открытых намерений поддерева", totals.openIntents],
      ],
      items: data.items.map(({ session, depth, parentSessionId }) => ({
        key: `${"  ".repeat(Math.min(depth, 8))}${depth ? "↳ " : ""}${session.key}`,
        keyMode: "opaque",
        title: session.title,
        fields: [
          ["Состояние", `${statusLabels[session.status]} (${session.status})`],
          ["Глубина", depth],
          [
            "Родитель",
            parentSessionId ? (visible.get(parentSessionId) ?? sessionRef(parentSessionId)) : "Нет",
            "opaque",
          ],
          [
            "Расположение родителя",
            parentSessionId && !visible.has(parentSessionId)
              ? "Вне этой страницы / выбранного поддерева"
              : null,
          ],
          ["Ревизия ветки", session.revision],
          ["Текущее run.id", session.currentRunId, "opaque"],
          ...countFields(session.counts),
          ...acceptanceFields(session, session.acceptance),
          ...latestRunFields(session.latestRun),
        ],
      })),
      emptyMessage: "На этой странице узлов нет; ориентируйтесь на продолжение ниже.",
      commands: [
        {
          label: "Карточка выбранного корня",
          command: invoke(["session", "get", sessionRef(data.rootSessionId)]),
        },
      ],
    },
    options,
  );
}

export function intentsText(
  data: WorkOpenIntentsPage,
  query: WorkOpenIntentsQuery,
  options: TextOptions,
  invoke: Invoke,
): string {
  return listText(
    {
      title: "Открытые намерения — обзор выбранной страницы",
      filters: [
        ["Ветка", query.ref, "opaque"],
        ["Потомки", query.includeChildren ? "Включены" : "Не включены"],
      ],
      items: data.items.map((checkpoint) => ({
        key: checkpoint.key,
        keyMode: "opaque",
        title: checkpoint.title,
        fields: [
          ["Ветка", sessionRef(checkpoint.sessionId), "opaque"],
          ["Автор", checkpoint.createdBy],
          ["run.id", checkpoint.runId, "opaque"],
          ["Время (ISO, часовой пояс)", checkpoint.createdAt, "opaque"],
        ],
        details: checkpoint.summary ? [checkpoint.summary] : [],
      })),
      emptyMessage: "На этой странице открытых намерений нет.",
      commands: data.items[0]
        ? [
            {
              label: "Полный материал намерения — пример для первой точки",
              command: invoke(["checkpoint", "get", data.items[0].key]),
            },
          ]
        : [],
    },
    options,
  );
}

function checkpointFields(data: WorkCheckpoint): OutputField[] {
  return [
    ["Тип", `${kindLabels[data.kind]} (${data.kind})`],
    ["Ветка", sessionRef(data.sessionId), "opaque"],
    ["run.id автора", data.runId, "opaque"],
    ["Автор записи", data.createdBy],
    ["Время (ISO, часовой пояс)", data.createdAt, "opaque"],
    ["Номер в ветке", data.sequence],
    [
      "Исходное намерение",
      data.intentId ? checkpointRef(data.intentId) : "Эта точка открывает намерение",
      "opaque",
    ],
    ["Явно принятых результатов детей", data.acceptedSessionIds.length],
  ];
}
function checkpointSections(data: WorkCheckpoint, options: TextOptions): OutputSection[] {
  return [
    md("Аннотация", data.summary, options),
    md("Материал — полный Markdown", data.body, options),
    md("Сделано", data.done, options),
    md("Остаток и блокеры", data.remaining, options),
    md("Следующее действие", data.nextStep, options),
    md("Проверки и фактические результаты", data.checks, options),
    {
      title: "Сохранённые подписи ссылок — не снимки содержания целей",
      body: data.references.length
        ? data.references
            .map(
              ({ ref, key, title }) =>
                `${safeText(key ?? `${ref.kind}:${ref.id}`)} — ${safeText(title)}\n  ${safeText(`${ref.kind}:${ref.id}`)}`,
            )
            .join("\n")
        : "Ссылки не заданы.",
    },
    {
      title: "Явно принятые результаты дочерних веток",
      body: data.acceptedSessionIds.length
        ? data.acceptedSessionIds.map((id) => safeText(sessionRef(id))).join("\n")
        : "Эта точка не принимает результаты детей.",
    },
  ];
}

export function checkpointText(data: WorkCheckpoint, options: TextOptions, invoke: Invoke): string {
  return cardText(
    {
      title: data.title,
      opaqueKey: data.key,
      fields: checkpointFields(data),
      sections: checkpointSections(data, options),
      commands: [
        {
          label: "Карточка ветки и её актуальная ревизия",
          command: invoke(["session", "get", sessionRef(data.sessionId)]),
        },
        ...(data.intentId
          ? [
              {
                label: "Исходное намерение",
                command: invoke(["checkpoint", "get", checkpointRef(data.intentId)]),
              },
            ]
          : []),
        {
          label: "Хронология ветки — состояние намерения определяется последующими точками",
          command: invoke(["session", "history", sessionRef(data.sessionId), "--order", "asc"]),
        },
      ],
    },
    options,
  );
}

function eventText(item: WorkHistoryItem, options: TextOptions, full: boolean): string {
  const fields: OutputField[] =
    item.kind === "checkpoint"
      ? []
      : [
          ["Время (ISO, часовой пояс)", item.at, "opaque"],
          ["Ветка хронологии", sessionRef(item.sessionId), "opaque"],
          ["Номер в ветке", item.sequence],
        ];
  const sections: OutputSection[] = [];
  let title = eventLabels[item.kind];
  let opaqueKey: string | undefined;
  if (item.kind === "checkpoint") {
    const cp = item.checkpoint;
    opaqueKey = cp.key;
    title = `${kindLabels[cp.kind]} — ${cp.title}`;
    fields.push(...checkpointFields(cp));
    if (full) sections.push(...checkpointSections(cp, options));
    else if (cp.summary) sections.push(md("Аннотация", cp.summary, options));
  } else if (item.kind === "run-started" || item.kind === "run-ended") {
    fields.push(...runFields(item.run));
    if (full)
      sections.push(
        md("Причина подключения", item.run.reason, options),
        md("Материал окончания участия", item.run.endSummary ?? "", options),
      );
  } else if (item.kind === "session-forked") {
    opaqueKey = item.childSession.key;
    fields.push(
      ["Поручение дочерней ветки", item.childSession.title],
      ["run.id создателя", item.childSession.createdByRunId, "opaque"],
      [
        "Исходное намерение",
        item.childSession.originCheckpointId
          ? checkpointRef(item.childSession.originCheckpointId)
          : null,
        "opaque",
      ],
      ["Автор", "Не указан в этой точке; см. запись участия"],
      ["Текущее состояние ребёнка", statusLabels[item.childSession.status]],
    );
    if (full) sections.push(...assignmentSections(item.childSession, options));
  } else if (item.kind === "session-created" || item.kind === "session-closed") {
    opaqueKey = item.session.key;
    fields.push(
      ["Поручение ветки", item.session.title],
      ["Текущее состояние", statusLabels[item.session.status]],
      ["Автор / run", "Не указаны в этой точке; см. начало / окончание участия"],
    );
    if (full) sections.push(...assignmentSections(item.session, options));
  }
  return cardText(
    { title: `${title} (${item.kind})`, ...(opaqueKey ? { opaqueKey } : {}), fields, sections },
    options,
  );
}

export function historyText(
  data: WorkHistoryPage,
  query: WorkHistoryQuery,
  options: TextOptions,
  invoke: Invoke,
): string {
  const checkpoint = data.items.find((item) => item.kind === "checkpoint");
  return cardText(
    {
      title: "Хронология работы — обзор выбранной страницы",
      fields: [
        ["Область", query.ref ?? "Весь проект", "opaque"],
        [
          "Потомки",
          query.ref ? (query.includeChildren ? "Включены" : "Не включены") : "Весь проект",
        ],
        ["Порядок", query.order === "asc" ? "Сначала старые (asc)" : "Сначала новые (desc)"],
        ["Фильтр типа", query.kind],
      ],
      sections: [
        {
          title: "Сохранённые события; карточки веток отражают текущее состояние",
          body: data.items.length
            ? data.items.map((item) => eventText(item, options, false)).join("\n\n───\n\n")
            : "На этой странице событий нет.",
        },
      ],
      commands: [
        ...(query.ref
          ? [
              {
                label: "Полные материалы самой ветки страницами",
                command: invoke(["session", "context", query.ref]),
              },
            ]
          : []),
        ...(checkpoint?.kind === "checkpoint"
          ? [
              {
                label: "Полный материал — пример для одной точки страницы",
                command: invoke(["checkpoint", "get", checkpoint.checkpoint.key]),
              },
            ]
          : []),
      ],
    },
    options,
  );
}

export function sessionContextText(
  data: WorkContext,
  options: TextOptions,
  invoke: Invoke,
): string {
  return [
    sessionText(data, options, invoke),
    cardText(
      {
        title: "Полные материалы выбранной страницы — только эта ветка, desc, без потомков",
        sections: [
          {
            title: `На странице событий: ${data.history.items.length}; всего в истории ветки: ${data.history.total}`,
            body: data.history.items.length
              ? data.history.items.map((item) => eventText(item, options, true)).join("\n\n───\n\n")
              : "На этой странице событий нет.",
          },
        ],
      },
      options,
    ),
  ].join("\n\n───\n\n");
}

export function workSavedText(
  data: WorkHistoryMutation,
  action: string,
  options: TextOptions,
  invoke: Invoke,
): string {
  const commands = [
    { label: "Проверить сохранённую ветку", command: invoke(["session", "get", data.session.key]) },
    {
      label: "Проверить все открытые намерения этой ветки",
      command: invoke(["session", "intents", data.session.key]),
    },
    ...(data.checkpoint
      ? [
          {
            label: "Перечитать полный материал",
            command: invoke(["checkpoint", "get", data.checkpoint.key]),
          },
        ]
      : []),
    ...(data.childSession
      ? [
          {
            label: "Поручение дочерней ветки",
            command: invoke(["session", "get", data.childSession.key]),
          },
          {
            label: "Исполнителю: как подключиться (передайте собственный --actor)",
            command: invoke(["session", "attach", "--help"]),
          },
        ]
      : []),
  ];
  return receiptText(
    {
      title: `Сохранено: ${action}`,
      fields: [
        ["Ветка", data.session.key, "opaque"],
        ["Поручение", data.session.title],
        ...sessionFields(data.session),
        ["Участие операции", data.run?.key, "opaque"],
        ["run.id участия операции", data.run?.id, "opaque"],
        ["Автор участия", data.run?.actor],
        ["Текущий run.id для --run", data.session.currentRunId, "opaque"],
        [
          "Пользователь",
          data.run?.operator
            ? [data.run.operator.name, data.run.operator.email].filter(Boolean).join(" · ") ||
              "не указан"
            : "не указан",
        ],
        ["Git-ветка клиента", data.run?.git?.branch, "opaque"],
        ["Git HEAD клиента", data.run?.git?.commit, "opaque"],
        ["Новая точка", data.checkpoint?.key, "opaque"],
        ["Название точки", data.checkpoint?.title],
        ["Дочерняя ветка", data.childSession?.key, "opaque"],
        ["Поручение ребёнка", data.childSession?.title],
        ["session.id ребёнка для --accept", data.childSession?.id, "opaque"],
        ["Состояние ребёнка", data.childSession ? statusLabels[data.childSession.status] : null],
        ["Ревизия ребёнка", data.childSession?.revision],
      ],
      commands,
    },
    options,
  );
}
