import { z } from "zod";
import { entityReferenceSchema, text, timestampSchema } from "./primitives.js";
import {
  agentRunSchema,
  agentRunSummarySchema,
  workCheckpointKindSchema,
  workCheckpointSchema,
  workHistoryIdSchema,
  workSessionSchema,
  workSessionSummarySchema,
} from "./work-history.js";

export const WORK_HISTORY_GRAPH_CAPABILITY = "relay-work-history-graph-v2" as const;

export const workHistoryGraphNodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:(?:created|closed|started|ended|checkpoint)$/)
  .describe(
    "Производный ID точки: ID ветки:created/closed, ID участия:started/ended или ID checkpoint:checkpoint; отдельной записи события нет",
  );
export const workHistoryGraphPointKindSchema = z
  .enum(["session-created", "session-closed", "run-started", "run-ended", "checkpoint"])
  .describe("Вид графовой точки; fork представлен связью, а не дублирующей точкой session-forked");
export const workHistoryGraphIntentStateSchema = z
  .enum(["open", "completed", "cancelled"])
  .describe(
    "Вычисленное состояние intent по всему сохранённому набору: без terminal, с result или с cancel; не по видимой странице",
  );
const sequence = z
  .number()
  .int()
  .positive()
  .describe("Сохранённый номер точки в хронологии её ветки");
const pointIdentity = {
  id: workHistoryGraphNodeIdSchema,
  sessionId: workHistoryIdSchema.describe(
    "ID ветки, на линии которой находится точка; автор может принадлежать родительской ветке",
  ),
  sequence,
  at: timestampSchema.describe(
    "Сохранённое время точки; положение на timeline проекта, не время запроса",
  ),
};
const pointContent = {
  ...pointIdentity,
  title: text(1024).describe("Короткая подпись точки; полное название без тела Markdown"),
  summary: text(16 * 1024).describe(
    "Сохранённая краткая аннотация checkpoint либо краткая подпись жизненного цикла; не excerpt из description/result/reason/endSummary",
  ),
  predecessorRunId: workHistoryIdSchema
    .nullable()
    .describe(
      "ID непосредственного предшественника авторского run; null, если его нет; смена run не создаёт новую ветку",
    ),
};
export const workHistoryGraphPointSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        ...pointContent,
        kind: z.literal("checkpoint").describe("Содержательная точка намерения или исполнения"),
        checkpointId: workHistoryIdSchema.describe(
          "Постоянный ID checkpoint для адресного открытия полного материала",
        ),
        checkpointKind: workCheckpointKindSchema,
        runId: workHistoryIdSchema.describe(
          "Авторский run из сохранённого checkpoint.runId, не текущий run ветки",
        ),
        intentState: workHistoryGraphIntentStateSchema
          .nullable()
          .describe("Состояние только для checkpointKind=intent; у progress/result/cancel — null"),
      })
      .describe(
        "Компактный checkpoint без body/done/remaining/nextStep/checks и полных references",
      ),
    z
      .strictObject({
        ...pointContent,
        kind: z
          .enum(["session-created", "session-closed", "run-started", "run-ended"])
          .describe("Сохранённое создание/закрытие ветки или начало/окончание участия"),
        checkpointId: z.null().describe("У точки жизненного цикла нет checkpoint"),
        checkpointKind: z.null().describe("Жизненный цикл не подменяется видом checkpoint"),
        runId: workHistoryIdSchema
          .nullable()
          .describe(
            "Авторский run: при создании корня FIRST run, ребёнка — createdByRunId родителя; у run-маркера его run; при закрытии связанное участие либо null, если его нет",
          ),
        intentState: z.null().describe("Состояние намерения неприменимо к жизненному циклу"),
      })
      .describe("Компактный жизненный цикл без полного поручения, итога и причин участия"),
  ])
  .superRefine((point, context) => {
    if ((point.kind === "run-started" || point.kind === "run-ended") && point.runId === null)
      context.addIssue({
        code: "custom",
        path: ["runId"],
        message: "Маркер участия требует постоянный ID run",
      });
    const expected =
      point.kind === "checkpoint"
        ? `${point.checkpointId}:checkpoint`
        : point.kind === "session-created"
          ? `${point.sessionId}:created`
          : point.kind === "session-closed"
            ? `${point.sessionId}:closed`
            : `${point.runId}:${point.kind === "run-started" ? "started" : "ended"}`;
    if (point.id !== expected)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "ID точки не соответствует её виду и владельцу",
      });
    if (
      point.kind === "checkpoint" &&
      (point.checkpointKind === "intent") !== (point.intentState !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["intentState"],
        message: "Состояние обязательно только у intent",
      });
  })
  .describe(
    "Производная компактная точка графа с сохранённым авторством, без полнотекстовых Markdown-полей",
  );

export const workHistoryGraphBoundaryNodeSchema = z
  .strictObject({
    ...pointIdentity,
    kind: workHistoryGraphPointKindSchema,
    side: z
      .enum(["before", "after", "outside-scope"])
      .describe(
        "before/after — до/после страницы в запрошенном order; outside-scope — за областью ref/includeChildren, независимо от времени",
      ),
  })
  .describe(
    "Отсутствующий на странице конец связи; не самостоятельный корень или конец ветки и не полная точка",
  );
export const workHistoryGraphBranchSchema = workSessionSummarySchema
  .extend({
    contextOnly: z
      .boolean()
      .describe(
        "true, если в items нет точек этой ветки: она нужна openEnds, границам пересекающих окно связей, авторству или цепочке предков; false у ветки с видимой точкой",
      ),
  })
  .describe(
    "Компактная ветка и контекст владельца без description/result; не полный каталог проекта",
  );
export const workHistoryGraphEdgeSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z
          .literal("sequence")
          .describe("Соседние отображаемые реальные точки хронологии одной ветки"),
        from: workHistoryGraphNodeIdSchema.describe(
          "Исходная точка связи; всегда items или boundaryNodes",
        ),
        to: workHistoryGraphNodeIdSchema.describe(
          "Целевая точка связи; всегда items или boundaryNodes",
        ),
      })
      .describe(
        "Направленная связь хронологии; может пересекать окно между границами before/after",
      ),
    z
      .strictObject({
        kind: z
          .literal("fork")
          .describe(
            "Ответвление от линии родителя в момент создания ребёнка, не от прежней точки intent",
          ),
        fromSessionId: workHistoryIdSchema.describe(
          "ID настоящего родителя из parentSessionId ребёнка; его линия обязана присутствовать в branches",
        ),
        to: workHistoryGraphNodeIdSchema.describe(
          "Видимая точка session-created ребёнка; её сохранённое at задаёт время присоединения к линии родителя",
        ),
      })
      .describe(
        "Линия родителя → создание ребёнка на времени ребёнка; originCheckpointId остаётся контекстом, без нового события или фиктивного времени",
      ),
    z
      .strictObject({
        kind: z
          .literal("branch-end")
          .describe(
            "Визуальный возврат completed/cancelled ребёнка в линию родителя при закрытии, независимо от explicit acceptance",
          ),
        from: workHistoryGraphNodeIdSchema.describe(
          "Видимая точка session-closed ребёнка; её сохранённое at задаёт время возврата",
        ),
        toSessionId: workHistoryIdSchema.describe(
          "ID настоящего родителя из parentSessionId ребёнка; его линия обязана присутствовать в branches",
        ),
      })
      .describe(
        "Закрытие ребёнка → линия родителя на времени закрытия; не принятие результата и не виртуальный checkpoint родителя",
      ),
    z
      .strictObject({
        kind: z
          .literal("root-start")
          .describe(
            "Выход настоящего корня из оси timeline проекта; выбранный дочерний scope не становится корнем",
          ),
        from: z
          .null()
          .describe("Ось проекта на времени целевой точки; null не означает потерянную точку"),
        to: workHistoryGraphNodeIdSchema.describe("Точка session-created настоящего корня"),
      })
      .describe("Начало корневой работы на оси времени проекта"),
    z
      .strictObject({
        kind: z
          .literal("root-end")
          .describe(
            "Визуальный возврат completed/cancelled корня к оси проекта при закрытии; не принятие результата и не признак успешного выполнения отменённой работы",
          ),
        from: workHistoryGraphNodeIdSchema.describe(
          "Видимая точка session-closed completed/cancelled корня; её at задаёт время возврата к оси",
        ),
        to: z
          .null()
          .describe("Ось проекта на времени исходной точки; null не означает конец вне страницы"),
      })
      .describe("Завершение корневой работы на оси времени проекта"),
  ])
  .describe(
    "Sequence касается items либо пересекает окно между boundaryNodes before/after; fork/branch-end и связи с осью требуют видимой точки создания/закрытия. Узлы разрешаются через items/boundaryNodes, линии — через branches; direction не зависит от order",
  );

export const workHistoryGraphQuerySchema = z
  .strictObject({
    ref: entityReferenceSchema
      .optional()
      .describe(
        "Ключ S-token, ID или work-session:ID выбранной ветки; отсутствие — весь проект, не фильтр левого каталога",
      ),
    includeChildren: z
      .boolean()
      .default(true)
      .describe(
        "Включить всех потомков ref; по умолчанию true, без ref область уже охватывает проект",
      ),
    order: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe(
        "Порядок точек по (at, sessionId, sequence, id): asc или полностью обратный desc; по умолчанию desc",
      ),
    offset: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Смещение страницы графовых точек; по умолчанию 0"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe(
        "Количество точек items: по умолчанию 50, максимум 100; boundaryNodes и openEnds не входят в этот лимит",
      ),
    version: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Непрозрачная версия первой страницы; передавайте при продолжении, изменение требует нового чтения с VERSION_CONFLICT; не исторический снимок",
      ),
  })
  .describe(
    "Отдельное чтение графа выбранной ветки/дерева или проекта, без новых q/status и иных фильтров каталога",
  );
export const workHistoryGraphPointQuerySchema = z
  .strictObject({
    ref: z
      .union([workHistoryGraphNodeIdSchema, entityReferenceSchema])
      .describe(
        "Производный node ID либо существующий CP-key, raw checkpoint ID или work-checkpoint:ID для прежних deep links; адрес ветки сам по себе не выбирает точку",
      ),
  })
  .describe("Открыть полные материалы только выбранной точки графа");

export const workHistoryGraphPageSchema = z
  .strictObject({
    scopeRootId: workHistoryIdSchema
      .nullable()
      .describe(
        "Разрешённый постоянный ID ref; null у всего проекта; дочерний scope сохраняет настоящего родителя",
      ),
    items: z
      .array(workHistoryGraphPointSchema)
      .max(100)
      .describe("Компактные точки только выбранной страницы в запрошенном порядке"),
    openEnds: z
      .array(workHistoryGraphPointSchema)
      .describe(
        "Последняя отображаемая реальная точка по sequence каждой pending/open/paused ветки выбранной области, даже вне страницы; по sessionId уникальны, могут совпадать с items. Это компактные заголовки без Markdown, не новые события и не фиктивный now; at сохраняет время исходной точки. Не входят в limit/total и не требуют искусственного ребра; чрезмерный объём — ошибка Core, не успешное усечение",
      ),
    edges: z
      .array(workHistoryGraphEdgeSchema)
      .describe(
        "Sequence касается items или пересекает окно между boundaryNodes before/after. Fork/branch-end соединяют видимую точку создания/закрытия ребёнка с линией настоящего родителя на времени этой точки; root-start/root-end — с осью. Acceptance не является графовым ребром; связи вычисляет Core",
      ),
    boundaryNodes: z
      .array(workHistoryGraphBoundaryNodeSchema)
      .describe(
        "Все ненулевые концы edges вне items, без дублей; отсутствие страницы не скрывает родство или реальное продолжение",
      ),
    branches: z
      .array(workHistoryGraphBranchSchema)
      .describe(
        "Только владельцы items/openEnds/boundaryNodes, родительские линии fromSessionId/toSessionId, авторские run и необходимые предки; не полный dump веток проекта",
      ),
    runs: z
      .array(agentRunSummarySchema)
      .describe(
        "Только авторские runId точек items и openEnds и их непосредственные predecessorRunId; сохранённые operator/git для avatar и подсказки, без reason/endSummary",
      ),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Полное число графовых точек выбранной области до пагинации; boundaryNodes/openEnds не добавляют точек, дублирующие исключённые маркеры не считаются",
      ),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Смещение следующей страницы items либо null, если область прочитана полностью"),
    version: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "Версия согласованной проекции, включая связи, openEnds, состояния intent и авторские снимки; не исторический снимок",
      ),
  })
  .superRefine((page, context) => {
    const unique = (values: { id: string }[], field: string) => {
      const ids = new Set<string>();
      for (const value of values) {
        if (ids.has(value.id))
          context.addIssue({ code: "custom", path: [field], message: "Повтор ID в таблице графа" });
        ids.add(value.id);
      }
      return ids;
    };
    const visible = unique(page.items, "items");
    unique(page.openEnds, "openEnds");
    const boundary = unique(page.boundaryNodes, "boundaryNodes");
    const branches = unique(page.branches, "branches");
    const runs = unique(page.runs, "runs");
    const visiblePoints = new Map(page.items.map((point) => [point.id, point]));
    const boundaryPoints = new Map(page.boundaryNodes.map((point) => [point.id, point]));
    const branchById = new Map(page.branches.map((branch) => [branch.id, branch]));
    const latestKnown = new Map<string, number>();
    for (const point of [...page.items, ...page.boundaryNodes])
      latestKnown.set(
        point.sessionId,
        Math.max(latestKnown.get(point.sessionId) ?? 0, point.sequence),
      );
    for (const id of boundary)
      if (visible.has(id))
        context.addIssue({
          code: "custom",
          path: ["boundaryNodes"],
          message: "Видимая точка повторена как граница",
        });
    for (const edge of page.edges) {
      const nodeEnds =
        edge.kind === "sequence"
          ? [edge.from, edge.to]
          : edge.kind === "fork" || edge.kind === "root-start"
            ? [edge.to]
            : [edge.from];
      for (const end of nodeEnds)
        if (!visible.has(end) && !boundary.has(end))
          context.addIssue({
            code: "custom",
            path: ["edges"],
            message: "Конец связи отсутствует в items и boundaryNodes",
          });
      if (edge.kind === "sequence") {
        const touchesVisible = nodeEnds.some((id) => visible.has(id));
        const fromBoundary = boundaryPoints.get(edge.from);
        const toBoundary = boundaryPoints.get(edge.to);
        const spansWindow =
          (fromBoundary?.side === "before" && toBoundary?.side === "after") ||
          (fromBoundary?.side === "after" && toBoundary?.side === "before");
        if (!touchesVisible && !spansWindow)
          context.addIssue({
            code: "custom",
            path: ["edges"],
            message: "Sequence не касается items и не пересекает окно между границами before/after",
          });
      }
      if (edge.kind === "fork" || edge.kind === "branch-end") {
        const point = visiblePoints.get(edge.kind === "fork" ? edge.to : edge.from);
        const child = point && branchById.get(point.sessionId);
        const parentId = edge.kind === "fork" ? edge.fromSessionId : edge.toSessionId;
        if (!branchById.has(parentId))
          context.addIssue({
            code: "custom",
            path: ["branches"],
            message: "Родительская линия графового ребра отсутствует в branches",
          });
        if (
          !point ||
          !child ||
          child.parentSessionId !== parentId ||
          child.id === parentId ||
          (edge.kind === "fork"
            ? point.kind !== "session-created"
            : point.kind !== "session-closed" || !["completed", "cancelled"].includes(child.status))
        )
          context.addIssue({
            code: "custom",
            path: ["edges"],
            message:
              "Fork/branch-end требует видимого создания/закрытия ребёнка и линии его настоящего родителя; закрытие допустимо только для completed/cancelled",
          });
      }
      if (edge.kind === "root-start" || edge.kind === "root-end") {
        const point = visiblePoints.get(edge.kind === "root-start" ? edge.to : edge.from);
        const branch = point && branchById.get(point.sessionId);
        if (
          !point ||
          !branch ||
          branch.parentSessionId !== null ||
          (edge.kind === "root-start"
            ? point.kind !== "session-created"
            : point.kind !== "session-closed" ||
              !["completed", "cancelled"].includes(branch.status))
        )
          context.addIssue({
            code: "custom",
            path: ["edges"],
            message:
              "Связь с осью требует видимого создания настоящего корня либо закрытия completed/cancelled корня",
          });
      }
    }
    for (const point of [...page.items, ...page.openEnds, ...page.boundaryNodes])
      if (!branches.has(point.sessionId))
        context.addIssue({
          code: "custom",
          path: ["branches"],
          message: "Не передана ветка точки, openEnd или границы",
        });
    for (const point of [...page.items, ...page.openEnds])
      for (const id of [point.runId, point.predecessorRunId])
        if (id !== null && !runs.has(id))
          context.addIssue({
            code: "custom",
            path: ["runs"],
            message: "Не передан авторский run или его непосредственный предшественник",
          });
    const openSessions = new Set<string>();
    for (const [index, point] of page.openEnds.entries()) {
      const issue = (message: string) =>
        context.addIssue({ code: "custom", path: ["openEnds", index], message });
      if (openSessions.has(point.sessionId))
        issue("В openEnds допустима только одна последняя точка каждой ветки");
      openSessions.add(point.sessionId);
      const branch = branchById.get(point.sessionId);
      if (branch && !["pending", "open", "paused"].includes(branch.status))
        issue("OpenEnd допустим только у незавершённой ветки pending/open/paused");
      if (point.kind === "session-closed") issue("Закрытие ветки не является незавершённым концом");
      if (
        point.sequence < (latestKnown.get(point.sessionId) ?? 0) ||
        (branch && point.sequence > branch.sequence)
      )
        issue("Номер openEnd противоречит последней известной точке или счётчику ветки");
      const visiblePoint = visiblePoints.get(point.id);
      if (
        visiblePoint &&
        !(Object.keys(point) as (keyof typeof point)[]).every(
          (key) => point[key] === visiblePoint[key],
        )
      )
        issue("OpenEnd с ID из items должен совпадать с той же реальной точкой во всех полях");
      const boundaryPoint = boundaryPoints.get(point.id);
      if (
        boundaryPoint &&
        (["id", "sessionId", "sequence", "at", "kind"] as const).some(
          (key) => point[key] !== boundaryPoint[key],
        )
      )
        issue("Идентичность openEnd расходится с той же точкой в boundaryNodes");
      if (boundaryPoint?.side === "outside-scope")
        issue("OpenEnd выбранной области не может быть границей outside-scope");
    }
  })
  .describe(
    "Страница графа с явными границами, пересекающими окно связями и полным набором незавершённых концов; пагинация относится только к items, полные Markdown читаются отдельно через point",
  );

export const workHistoryGraphPointDetailSchema = z
  .strictObject({
    point: workHistoryGraphPointSchema.describe(
      "Та же компактная адресная точка, не новая запись события",
    ),
    session: workSessionSchema.describe(
      "Полная ветка выбранной точки с description/result; текущая сохранённая карточка, не историческая ревизия",
    ),
    run: agentRunSchema
      .nullable()
      .describe(
        "Полный авторский run выбранной точки с reason/endSummary, а не current/latest; null, если у точки нет связанного участия",
      ),
    previousRun: agentRunSummarySchema
      .nullable()
      .describe("Непосредственный предшественник авторского run без больших Markdown либо null"),
    checkpoint: workCheckpointSchema
      .nullable()
      .describe(
        "Полный неизменяемый checkpoint только у kind=checkpoint; у lifecycle null, описание берётся из session/run без мнимого checkpoint",
      ),
  })
  .superRefine((detail, context) => {
    if (detail.point.sessionId !== detail.session.id)
      context.addIssue({
        code: "custom",
        path: ["session"],
        message: "Ветка не принадлежит выбранной точке",
      });
    if (detail.point.runId !== (detail.run?.id ?? null))
      context.addIssue({
        code: "custom",
        path: ["run"],
        message: "Участие не соответствует сохранённому авторству точки",
      });
    if (detail.point.predecessorRunId !== (detail.previousRun?.id ?? null))
      context.addIssue({
        code: "custom",
        path: ["previousRun"],
        message: "Предшественник не соответствует авторскому участию",
      });
    if (detail.point.checkpointId !== (detail.checkpoint?.id ?? null))
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Полный checkpoint не соответствует выбранной точке",
      });
    if (
      detail.checkpoint &&
      (detail.checkpoint.sessionId !== detail.point.sessionId ||
        detail.checkpoint.runId !== detail.point.runId ||
        detail.checkpoint.kind !== detail.point.checkpointKind)
    )
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Ветка, автор или вид полного checkpoint расходятся с выбранной точкой",
      });
  })
  .describe(
    "Полные материалы одной выбранной точки для Modal; lifecycle не подменяется checkpoint",
  );

export const workHistoryGraphOperations = {
  graph: { input: workHistoryGraphQuerySchema, output: workHistoryGraphPageSchema },
  point: { input: workHistoryGraphPointQuerySchema, output: workHistoryGraphPointDetailSchema },
} as const;

export type WorkHistoryGraphNodeId = z.output<typeof workHistoryGraphNodeIdSchema>;
export type WorkHistoryGraphPointKind = z.output<typeof workHistoryGraphPointKindSchema>;
export type WorkHistoryGraphIntentState = z.output<typeof workHistoryGraphIntentStateSchema>;
export type WorkHistoryGraphPoint = z.output<typeof workHistoryGraphPointSchema>;
export type WorkHistoryGraphBoundaryNode = z.output<typeof workHistoryGraphBoundaryNodeSchema>;
export type WorkHistoryGraphBranch = z.output<typeof workHistoryGraphBranchSchema>;
export type WorkHistoryGraphEdge = z.output<typeof workHistoryGraphEdgeSchema>;
export type WorkHistoryGraphQuery = z.input<typeof workHistoryGraphQuerySchema>;
export type WorkHistoryGraphPointQuery = z.input<typeof workHistoryGraphPointQuerySchema>;
export type WorkHistoryGraphPage = z.output<typeof workHistoryGraphPageSchema>;
export type WorkHistoryGraphPointDetail = z.output<typeof workHistoryGraphPointDetailSchema>;

export interface WorkHistoryGraphServiceContract {
  graph(input: WorkHistoryGraphQuery): Promise<WorkHistoryGraphPage>;
  point(input: WorkHistoryGraphPointQuery): Promise<WorkHistoryGraphPointDetail>;
}
