import { z } from "zod";
import {
  agentRunSchema,
  workCheckpointOpenSchema,
  workCheckpointSchema,
  workHistoryMutationSchema,
  workHistoryOperations,
  workSessionSchema,
  workSessionsQuerySchema,
  agentRunSummarySchema,
  workSessionOverviewSchema,
  workSessionSummarySchema,
  workSessionDetailSchema,
  workSessionsPageSchema,
  workOpenIntentsPageSchema,
  workOpenIntentsQuerySchema,
  type AgentRun,
  type WorkCheckpoint,
  type WorkSession,
  type WorkSessionStart,
  type WorkSessionsQuery,
} from "../src/work-history.js";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const markdown = "  # Поручение\r\n\r\n- проверить **текст**\n\n";
const session: WorkSession = {
  id: "session-1",
  key: "S-1",
  title: "Проверить историю",
  description: markdown,
  parentSessionId: null,
  originCheckpointId: null,
  createdByRunId: null,
  parentSequence: null,
  status: "open",
  currentRunId: "run-1",
  sequence: 3,
  result: "",
  createdAt: "2026-10-15T10:00:00Z",
  updatedAt: "2026-10-15T10:00:02Z",
  closedAt: null,
  revision: 2,
};
const run: AgentRun = {
  id: "run-1",
  key: "RUN-1",
  sessionId: session.id,
  actor: "agent",
  operator: null,
  git: null,
  client: null,
  sourceSessionId: null,
  startedAt: session.createdAt,
  endedAt: null,
  startedSequence: 2,
  endedSequence: null,
  endReason: null,
  predecessorRunId: null,
  reason: markdown,
  endSummary: null,
};
const checkpoint: WorkCheckpoint = {
  id: "checkpoint-1",
  key: "CP-1",
  sessionId: session.id,
  runId: run.id,
  sequence: 3,
  kind: "intent",
  intentId: null,
  title: "Сохранить материал",
  summary: "",
  body: markdown,
  done: "",
  remaining: "",
  nextStep: "",
  checks: "",
  references: [{ ref: { kind: "document", id: "doc-1" }, key: "DOC-1", title: "Прежнее название" }],
  acceptedSessionIds: [],
  createdAt: session.updatedAt,
  createdBy: run.actor,
};

check(workSessionSchema.parse(session).description === markdown, "Markdown поручения изменился");
check(agentRunSchema.parse(run).reason === markdown, "Markdown участия изменился");
check(
  agentRunSchema.safeParse({
    ...run,
    operator: { name: "Ирина", email: null, source: "git" },
    git: { branch: "topic", commit: null },
  }).success,
  "Снимок атрибуции отвергнут",
);
check(
  !agentRunSchema.safeParse({ ...run, operator: undefined }).success,
  "Выход подставляет неизвестную атрибуцию",
);
check(
  !agentRunSchema.safeParse({ ...run, git: { branch: null, commit: null, online: true } }).success,
  "Git-контекст нестрогий",
);
check(
  workSessionSchema.safeParse({ ...session, key: "S-aed9728e81464cfeaba8ebc72ad227ff" }).success,
  "Случайный адрес ветки отвергнут",
);
check(
  agentRunSchema.safeParse({ ...run, key: "RUN-aed9728e81464cfeaba8ebc72ad227ff" }).success,
  "Случайный адрес run отвергнут",
);
check(
  workCheckpointSchema.safeParse({ ...checkpoint, key: "CP-aed9728e81464cfeaba8ebc72ad227ff" })
    .success,
  "Случайный адрес точки отвергнут",
);
for (const key of ["S-", "S-../other", "S-небезопасный", "S-a b"])
  check(!workSessionSchema.safeParse({ ...session, key }).success, "Небезопасный адрес принят");
check(workCheckpointSchema.parse(checkpoint).body === markdown, "Markdown точки изменился");
check(
  workHistoryMutationSchema.safeParse({ session, run, checkpoint, childSession: null }).success,
  "Корректная мутация отвергнута",
);
check(
  !workSessionSchema.safeParse({ ...session, revision: "2" }).success,
  "Выходная ревизия подверглась coercion",
);
check(!workSessionSchema.safeParse({ ...session, unexpected: true }).success, "Выход нестрогий");
check(
  !workCheckpointSchema.safeParse({ ...checkpoint, body: undefined }).success,
  "Выход подставляет default",
);
check(
  !workCheckpointSchema.safeParse({ ...checkpoint, acceptedSessionIds: ["child-1"] }).success,
  "Intent принял результат ребёнка",
);
check(
  !workCheckpointSchema.safeParse({ ...checkpoint, kind: "progress", intentId: null }).success,
  "Материал без intent прошёл проверку",
);
check(
  !workCheckpointSchema.safeParse({
    ...checkpoint,
    references: [{ ...checkpoint.references[0], extra: true }],
  }).success,
  "Вложенная подпись нестрогая",
);

const start: WorkSessionStart = { requestId: "request-1", title: "Новое поручение" };
check(
  workHistoryOperations.start.input.parse(start).description === "",
  "Вход start не применяет defaults",
);
const query: WorkSessionsQuery = { limit: "2" };
check(workSessionsQuerySchema.parse(query).limit === 2, "Query не преобразует строковый limit");
check(!workSessionsQuerySchema.safeParse({ limit: 101 }).success, "Размер страницы не ограничен");
const opened = workCheckpointOpenSchema.parse({
  ref: "S-1",
  runId: "run-1",
  ifRevision: 2,
  requestId: "request-2",
  title: "Намерение",
  body: markdown,
});
check(
  opened.body === markdown && opened.references.length === 0,
  "Вход точки потерял текст или defaults",
);
check(
  !workCheckpointOpenSchema.safeParse({ ...opened, ifRevision: undefined }).success,
  "Мутация владельца не требует CAS ветки",
);
for (const body of [undefined, "", " \r\n\t "])
  check(
    !workCheckpointOpenSchema.safeParse({ ...opened, body }).success,
    "Отсутствующий или пустой Markdown принят вместо материала",
  );
for (const method of ["saveCheckpoint", "completeCheckpoint", "cancelCheckpoint"] as const) {
  const input = { ...opened, ref: "CP-1" };
  check(
    workHistoryOperations[method].input.parse(input).body === markdown,
    "Многострочный материал изменился",
  );
  check(
    !workHistoryOperations[method].input.safeParse({ ...input, body: undefined }).success,
    "Материал без body принят",
  );
}

for (const operation of Object.values(workHistoryOperations)) {
  const inputJson = z.toJSONSchema(operation.input, { io: "input" });
  const outputJson = z.toJSONSchema(operation.output, { io: "output" });
  check(
    typeof inputJson === "object" && typeof outputJson === "object",
    "Схема непереносима в JSON Schema",
  );
}

const { description: _description, result: _result, ...summary } = session;
const { reason: _reason, endSummary: _endSummary, ...latestRun } = run;
const counts = { runs: 1, checkpoints: 1, openIntents: 1, children: 0, unfinishedChildren: 0 };
check(agentRunSummarySchema.safeParse(latestRun).success, "Краткий run не соответствует контракту");
check(!agentRunSummarySchema.safeParse(run).success, "Краткий run принимает большие Markdown");
check(workSessionSummarySchema.safeParse(summary).success, "Storage summary изменился");
const overview = { ...summary, counts, latestRun, acceptance: null };
check(
  workSessionOverviewSchema.safeParse(overview).success,
  "Обзор ветки не соответствует контракту",
);
check(
  !workSessionOverviewSchema.safeParse(summary).success,
  "Обзор принимает storage summary без счётчиков",
);
check(
  workSessionDetailSchema.safeParse({
    session,
    currentRun: run,
    counts,
    latestRun,
    acceptance: null,
  }).success,
  "Полная карточка потеряла обзор",
);
const page = {
  items: [overview],
  total: 1,
  nextOffset: null,
  version: "v1",
  projectTotals: { sessions: 10, unfinished: 8, runs: 30, checkpoints: 50, openIntents: 20 },
};
check(
  workSessionsPageSchema.safeParse(page).success,
  "Глобальные счётчики ошибочно ограничены страницей",
);
check(
  !workSessionsPageSchema.safeParse({ ...page, projectTotals: undefined }).success,
  "Список не требует полных счётчиков проекта",
);
const openPage = { items: [checkpoint], total: 1, nextOffset: null, version: "v1" };
check(workOpenIntentsPageSchema.safeParse(openPage).success, "Открытое намерение отвергнуто");
check(
  !workOpenIntentsPageSchema.safeParse({
    ...openPage,
    items: [{ ...checkpoint, kind: "progress", intentId: "intent-1" }],
  }).success,
  "Страница открытых намерений принимает progress",
);
check(
  workOpenIntentsQuerySchema.parse({ ref: "S-1" }).includeChildren === false,
  "Неверный default области намерений",
);
check(
  Object.keys(workHistoryOperations).length === 19,
  "Не все предметные операции зарегистрированы",
);

// @ts-expect-error Намерение не может ссылаться на другое исходное намерение.
const invalidIntent: WorkCheckpoint = { ...checkpoint, kind: "intent", intentId: "other-intent" };
void invalidIntent;
