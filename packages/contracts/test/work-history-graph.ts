import { z } from "zod";
import {
  WORK_HISTORY_GRAPH_CAPABILITY,
  workHistoryGraphBoundaryNodeSchema,
  workHistoryGraphEdgeSchema,
  workHistoryGraphOperations,
  workHistoryGraphPageSchema,
  workHistoryGraphPointDetailSchema,
  workHistoryGraphPointQuerySchema,
  workHistoryGraphPointSchema,
  workHistoryGraphQuerySchema,
  type WorkHistoryGraphPage,
  type WorkHistoryGraphPoint,
  type WorkHistoryGraphQuery,
} from "../src/work-history-graph.js";
import {
  WORK_HISTORY_CAPABILITY,
  workHistoryOperations,
  type AgentRun,
  type WorkCheckpoint,
  type WorkSession,
} from "../src/work-history.js";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const graphCapability: "relay-work-history-graph-v2" = WORK_HISTORY_GRAPH_CAPABILITY;
check(
  graphCapability === "relay-work-history-graph-v2",
  "Несовместимый wire-формат не получил graph capability v2",
);
check(
  WORK_HISTORY_CAPABILITY === "relay-work-history-v1",
  "Основная capability истории изменилась вместе с графом",
);
const at = "2026-10-15T10:00:00Z";
const markdown = "  # Полный материал\r\n\r\n- Сохранить **пробелы** 🧪  \n\n";
const parent: WorkSession = {
  id: "parent",
  key: "S-parent",
  title: "Родитель",
  description: markdown,
  parentSessionId: null,
  originCheckpointId: null,
  createdByRunId: null,
  parentSequence: null,
  status: "open",
  currentRunId: "run-latest",
  sequence: 7,
  result: "",
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  revision: 4,
};
const child: WorkSession = {
  ...parent,
  id: "child",
  key: "S-child",
  title: "Ребёнок",
  parentSessionId: parent.id,
  originCheckpointId: "intent",
  createdByRunId: "run-first",
  parentSequence: 4,
  status: "pending",
  currentRunId: null,
  sequence: 1,
  revision: 1,
};
const firstRun: AgentRun = {
  id: "run-first",
  key: "RUN-first",
  sessionId: parent.id,
  actor: "agent-1",
  operator: { name: "Ирина", email: "operator@example.test", source: "git" },
  git: { branch: "feature/history", commit: "a".repeat(40) },
  client: "cli",
  sourceSessionId: null,
  startedAt: at,
  endedAt: at,
  startedSequence: 2,
  endedSequence: 5,
  endReason: "transferred",
  predecessorRunId: null,
  reason: markdown,
  endSummary: markdown,
};
const checkpoint: WorkCheckpoint = {
  id: "intent",
  key: "CP-intent",
  sessionId: parent.id,
  runId: firstRun.id,
  sequence: 3,
  kind: "intent",
  intentId: null,
  title: "Намерение",
  summary: "Проверить граф",
  body: markdown,
  done: markdown,
  remaining: markdown,
  nextStep: markdown,
  checks: markdown,
  references: [],
  acceptedSessionIds: [],
  createdAt: at,
  createdBy: firstRun.actor,
};
const created: WorkHistoryGraphPoint = {
  id: "child:created",
  kind: "session-created",
  sessionId: child.id,
  sequence: 1,
  at,
  title: child.title,
  summary: "",
  checkpointId: null,
  checkpointKind: null,
  runId: firstRun.id,
  predecessorRunId: null,
  intentState: null,
};
const intent: WorkHistoryGraphPoint = {
  id: "intent:checkpoint",
  kind: "checkpoint",
  sessionId: parent.id,
  sequence: 3,
  at,
  title: checkpoint.title,
  summary: checkpoint.summary,
  checkpointId: checkpoint.id,
  checkpointKind: "intent",
  runId: firstRun.id,
  predecessorRunId: null,
  intentState: "completed",
};
const { description: _parentDescription, result: _parentResult, ...parentSummary } = parent;
const { description: _childDescription, result: _childResult, ...childSummary } = child;
const { reason: _reason, endSummary: _endSummary, ...firstRunSummary } = firstRun;
const page: WorkHistoryGraphPage = {
  scopeRootId: child.id,
  items: [created],
  openEnds: [created],
  edges: [{ kind: "fork", fromSessionId: parent.id, to: created.id }],
  boundaryNodes: [],
  branches: [
    { ...childSummary, contextOnly: false },
    { ...parentSummary, contextOnly: true },
  ],
  runs: [firstRunSummary],
  total: 1,
  nextOffset: null,
  version: "work-graph-v2:test-snapshot",
};

const query: WorkHistoryGraphQuery = { limit: "2" };
check(workHistoryGraphQuerySchema.parse(query).limit === 2, "Ввод не допускает HTTP-число строкой");
const defaults = workHistoryGraphQuerySchema.parse({});
check(
  defaults.limit === 50 &&
    defaults.offset === 0 &&
    defaults.includeChildren &&
    defaults.order === "desc",
  "Неверные defaults графового чтения",
);
for (const value of [{ q: "поиск" }, { status: "open" }, { limit: 101 }, { limit: 0 }])
  check(
    !workHistoryGraphQuerySchema.safeParse(value).success,
    "Ввод расширил фильтры или потерял границы страницы",
  );
for (const ref of [
  "intent:checkpoint",
  "child:created",
  "parent:closed",
  "run-first:started",
  "run-first:ended",
  "CP-intent",
  "intent",
  "work-checkpoint:intent",
])
  check(
    workHistoryGraphPointQuerySchema.safeParse({ ref }).success,
    "Допустимый deep link отвергнут",
  );

check(
  workHistoryGraphPageSchema.safeParse(page).success,
  "Создание ребёнка от линии родителя без точки старого intent отвергнуто",
);
check(
  !workHistoryGraphEdgeSchema.safeParse({ kind: "fork", from: intent.id, to: created.id }).success,
  "Прежнее длинное fork-ребро от intent принято",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    edges: [{ kind: "fork", fromSessionId: child.id, to: created.id }],
  }).success,
  "Fork выходит не из настоящего родителя",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    edges: [{ kind: "fork", fromSessionId: "missing-parent", to: created.id }],
  }).success,
  "Fork ссылается на отсутствующую родительскую линию",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    items: [],
    boundaryNodes: [
      {
        id: created.id,
        sessionId: created.sessionId,
        sequence: created.sequence,
        at: created.at,
        kind: created.kind,
        side: "before",
      },
    ],
  }).success,
  "Fork принят без видимого создания ребёнка",
);
check(
  !workHistoryGraphEdgeSchema.safeParse({ ...page.edges[0], at: "2026-10-12T00:00:00Z" }).success,
  "Fork получил отдельное фиктивное время вместо child.created.at",
);
check(
  page.runs[0]!.id !== parent.currentRunId,
  "Фикстура не различает сохранённое и текущее авторство",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, openEnds: undefined }).success,
  "OpenEnds подставлен по умолчанию вместо обязательной полноты",
);
const openOnly: WorkHistoryGraphPage = {
  ...page,
  items: [],
  edges: [],
  boundaryNodes: [],
  branches: page.branches.map((branch) => ({ ...branch, contextOnly: true })),
};
check(
  workHistoryGraphPageSchema.safeParse(openOnly).success,
  "Незавершённая ветка вне страницы требует фиктивного ребра или now",
);
check(
  workHistoryGraphPageSchema.parse(openOnly).openEnds[0]!.at === at && openOnly.total === 1,
  "OpenEnd изменил время источника или счётчик точек",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...openOnly, runs: [] }).success,
  "OpenEnd без авторского run принят",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...openOnly, branches: [] }).success,
  "OpenEnd без ветки принят",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...openOnly,
    openEnds: [{ ...created, predecessorRunId: "missing-run" }],
  }).success,
  "OpenEnd без предшественника принят",
);
for (const status of ["completed", "cancelled"] as const)
  check(
    !workHistoryGraphPageSchema.safeParse({
      ...openOnly,
      branches: openOnly.branches.map((branch) =>
        branch.id === child.id ? { ...branch, status, closedAt: at } : branch,
      ),
    }).success,
    "Терминальная ветка получила openEnd",
  );
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    openEnds: [{ ...created, at: "2026-10-16T00:00:00Z" }],
  }).success,
  "OpenEnd подменил время той же точки в items",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    openEnds: [{ ...created, title: "Чужая подпись" }],
  }).success,
  "OpenEnd расходится с той же точкой в items",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    openEnds: [created, { ...created, id: "run-first:started", kind: "run-started" }],
  }).success,
  "У одной ветки два openEnd",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...openOnly, openEnds: [{ ...created, body: markdown }] })
    .success,
  "OpenEnd передал полный Markdown",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...openOnly,
    openEnds: [{ ...created, id: "child:closed", kind: "session-closed" }],
  }).success,
  "Закрытие ветки выдано за незавершённый конец",
);
const manyOpenEnds: WorkHistoryGraphPage = {
  ...openOnly,
  scopeRootId: null,
  total: 101,
  openEnds: Array.from({ length: 101 }, (_, index) => ({
    ...created,
    id: `old-${index}:created`,
    sessionId: `old-${index}`,
  })),
  branches: [
    { ...parentSummary, contextOnly: true },
    ...Array.from({ length: 101 }, (_, index) => ({
      ...childSummary,
      id: `old-${index}`,
      key: `S-old-${index}`,
      contextOnly: true,
    })),
  ],
};
check(
  workHistoryGraphPageSchema.safeParse(manyOpenEnds).success,
  "OpenEnds ошибочно ограничен limit страницы вместо явного бюджета Core",
);

const latestRunSummary = {
  ...firstRunSummary,
  id: "run-latest",
  key: "RUN-latest",
  startedSequence: 6,
  endedAt: null,
  endedSequence: null,
  endReason: null,
  predecessorRunId: firstRun.id,
};
const lastParentPoint: WorkHistoryGraphPoint = {
  ...created,
  id: "run-latest:started",
  sessionId: parent.id,
  sequence: 6,
  kind: "run-started",
  runId: latestRunSummary.id,
  predecessorRunId: firstRun.id,
};
const spanning: WorkHistoryGraphPage = {
  ...page,
  scopeRootId: null,
  total: 8,
  openEnds: [created, lastParentPoint],
  edges: [{ kind: "sequence", from: intent.id, to: lastParentPoint.id }],
  boundaryNodes: [
    { id: intent.id, sessionId: parent.id, at, sequence: 3, kind: "checkpoint", side: "after" },
    {
      id: lastParentPoint.id,
      sessionId: parent.id,
      at,
      sequence: 6,
      kind: "run-started",
      side: "before",
    },
  ],
  runs: [firstRunSummary, latestRunSummary],
};
check(
  workHistoryGraphPageSchema.safeParse(spanning).success,
  "Связь между противоположными границами окна отвергнута",
);
for (const side of ["before", "after", "outside-scope"] as const)
  check(
    !workHistoryGraphPageSchema.safeParse({
      ...spanning,
      boundaryNodes: spanning.boundaryNodes.map((point) => ({ ...point, side })),
    }).success,
    "Две одноимённые границы ошибочно признаны пересечением окна",
  );
check(
  !workHistoryGraphPageSchema.safeParse({
    ...spanning,
    boundaryNodes: spanning.boundaryNodes.slice(0, 1),
  }).success,
  "Spanning edge потерял конец",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...spanning,
    openEnds: [created, { ...lastParentPoint, at: "2026-10-16T00:00:00Z" }],
  }).success,
  "OpenEnd расходится с собственной boundary-точкой",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...spanning, openEnds: [created, intent] }).success,
  "OpenEnd старее известной отображаемой точки ветки",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...spanning,
    edges: [{ kind: "root-start", from: null, to: lastParentPoint.id }],
  }).success,
  "Связь с осью разрешена только через невидимую границу",
);
const closedRoot: WorkHistoryGraphPage = {
  ...page,
  scopeRootId: null,
  total: 1,
  openEnds: [],
  boundaryNodes: [],
  items: [
    { ...created, id: "parent:closed", sessionId: parent.id, sequence: 8, kind: "session-closed" },
  ],
  branches: [
    {
      ...parentSummary,
      status: "completed",
      currentRunId: null,
      closedAt: at,
      sequence: 8,
      contextOnly: false,
    },
  ],
  edges: [{ kind: "root-end", from: "parent:closed", to: null }],
};
check(
  workHistoryGraphPageSchema.safeParse(closedRoot).success,
  "Completed-корень не возвращается к оси",
);
check(
  workHistoryGraphPageSchema.safeParse({
    ...closedRoot,
    branches: closedRoot.branches.map((branch) => ({ ...branch, status: "cancelled" })),
  }).success,
  "Cancelled-корень не получил визуальный возврат к оси",
);
const closedChild: WorkHistoryGraphPage = {
  ...page,
  openEnds: [],
  items: [{ ...created, id: "child:closed", kind: "session-closed", sequence: 8 }],
  branches: [
    { ...childSummary, status: "completed", sequence: 8, closedAt: at, contextOnly: false },
    { ...parentSummary, contextOnly: true },
  ],
  edges: [{ kind: "branch-end", from: "child:closed", toSessionId: parent.id }],
};
for (const status of ["completed", "cancelled"] as const) {
  const parsed = workHistoryGraphPageSchema.parse({
    ...closedChild,
    branches: closedChild.branches.map((branch) =>
      branch.id === child.id ? { ...branch, status } : branch,
    ),
  });
  check(
    parsed.items[0]!.at === at && parsed.boundaryNodes.length === 0,
    "Возврат ребёнка требует acceptance или виртуальную точку родителя",
  );
}
check(
  !workHistoryGraphPageSchema.safeParse({
    ...closedChild,
    edges: [{ kind: "branch-end", from: "child:closed", toSessionId: child.id }],
  }).success,
  "Ребёнок возвращается не в настоящую родительскую линию",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...closedChild,
    branches: closedChild.branches.slice(0, 1),
  }).success,
  "Возврат принят без родительской линии в branches",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...closedChild,
    items: [],
    boundaryNodes: [
      {
        id: "child:closed",
        sessionId: child.id,
        sequence: 8,
        at,
        kind: "session-closed",
        side: "after",
      },
    ],
  }).success,
  "Branch-end принят без видимого закрытия ребёнка",
);
for (const status of ["pending", "open", "paused"] as const) {
  check(
    !workHistoryGraphPageSchema.safeParse({
      ...closedChild,
      branches: closedChild.branches.map((branch) =>
        branch.id === child.id ? { ...branch, status } : branch,
      ),
    }).success,
    "Незакрытый ребёнок получил branch-end",
  );
  check(
    !workHistoryGraphPageSchema.safeParse({
      ...closedRoot,
      branches: closedRoot.branches.map((branch) => ({ ...branch, status })),
    }).success,
    "Незакрытый корень получил root-end",
  );
}
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    edges: [{ kind: "sequence", from: "missing:checkpoint", to: created.id }],
  }).success,
  "Потерянный конец связи принят",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, runs: [] }).success,
  "Отсутствующий снимок автора принят",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, branches: page.branches.slice(0, 1) }).success,
  "Потерян контекст родителя",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, items: [created, created] }).success,
  "Повтор ID принят",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, total: "1" }).success,
  "Выход применил coercion",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, version: undefined }).success,
  "Выход применил default",
);
check(
  !workHistoryGraphPageSchema.safeParse({ ...page, runs: [firstRun] }).success,
  "Граф передал полные причины участия",
);
check(
  !workHistoryGraphPageSchema.safeParse({
    ...page,
    branches: [{ ...child, contextOnly: false }, page.branches[1]],
  }).success,
  "Граф передал полное поручение ветки",
);
check(
  !workHistoryGraphPointSchema.safeParse({ ...created, body: markdown }).success,
  "Точка передала полный Markdown до click",
);
check(
  workHistoryGraphPointSchema.safeParse(intent).success,
  "Состояние intent из всего набора отвергнуто без terminal на странице",
);
check(
  !workHistoryGraphPointSchema.safeParse({ ...intent, intentState: null }).success,
  "Intent без вычисленного состояния принят",
);
check(
  !workHistoryGraphPointSchema.safeParse({ ...intent, id: "other:checkpoint" }).success,
  "Чужой ID checkpoint принят",
);
check(
  !workHistoryGraphPointSchema.safeParse({ ...created, kind: "session-forked" }).success,
  "Дублирующий fork-node принят",
);
check(
  !workHistoryGraphPointSchema.safeParse({
    ...created,
    id: "null:started",
    kind: "run-started",
    runId: null,
  }).success,
  "Run-маркер без участия принят",
);
check(
  !workHistoryGraphBoundaryNodeSchema.safeParse({ ...spanning.boundaryNodes[0], body: markdown })
    .success,
  "Граница содержит полное тело",
);

check(
  workHistoryGraphEdgeSchema.safeParse({ kind: "root-start", from: null, to: "parent:created" })
    .success,
  "Ось начала корня отвергнута",
);
check(
  workHistoryGraphEdgeSchema.safeParse({ kind: "root-end", from: "parent:closed", to: null })
    .success,
  "Возврат корня к оси отвергнут",
);
check(
  !workHistoryGraphEdgeSchema.safeParse({
    kind: "acceptance",
    from: "child:closed",
    to: "accepted:checkpoint",
  }).success,
  "Acceptance осталось графовым ребром вместо независимого checkpoint workflow",
);
check(
  workHistoryGraphEdgeSchema.safeParse({ kind: "fork", fromSessionId: parent.id, to: created.id })
    .success,
  "Fork от родительской линии отвергнут",
);
check(
  workHistoryGraphEdgeSchema.safeParse({
    kind: "branch-end",
    from: "child:closed",
    toSessionId: parent.id,
  }).success,
  "Возврат в родительскую линию отвергнут",
);
for (const kind of ["sequence", "fork", "branch-end", "acceptance"])
  check(
    !workHistoryGraphEdgeSchema.safeParse({ kind, from: null, to: created.id }).success,
    "Потерянная точка подменена осью",
  );

const lifecycleDetail = {
  point: created,
  session: child,
  run: firstRun,
  previousRun: null,
  checkpoint: null,
};
const parsedLifecycle = workHistoryGraphPointDetailSchema.parse(lifecycleDetail);
check(
  parsedLifecycle.session.description === markdown && parsedLifecycle.run?.reason === markdown,
  "Lifecycle detail потерял Markdown",
);
check(parsedLifecycle.checkpoint === null, "Lifecycle получил мнимый checkpoint");
check(
  !workHistoryGraphPointDetailSchema.safeParse({ ...lifecycleDetail, run: null }).success,
  "Detail потерял авторский run",
);
const checkpointDetail = workHistoryGraphPointDetailSchema.parse({
  point: intent,
  session: parent,
  run: firstRun,
  previousRun: null,
  checkpoint,
});
check(checkpointDetail.checkpoint?.body === markdown, "Detail checkpoint изменил Markdown");
check(
  !workHistoryGraphPointDetailSchema.safeParse({ ...lifecycleDetail, checkpoint }).success,
  "Lifecycle detail подменён checkpoint",
);

for (const operation of Object.values(workHistoryGraphOperations)) {
  check(
    typeof z.toJSONSchema(operation.input, { io: "input" }) === "object",
    "Непереносимый input JSON Schema",
  );
  check(
    typeof z.toJSONSchema(operation.output, { io: "output" }) === "object",
    "Непереносимый output JSON Schema",
  );
}
check(
  Object.keys(workHistoryOperations).length === 19,
  "Прежние 19 операций истории расширены графовыми чтениями",
);
check(
  Object.keys(workHistoryGraphOperations).length === 2,
  "Граф не имеет отдельной границы из двух чтений",
);
