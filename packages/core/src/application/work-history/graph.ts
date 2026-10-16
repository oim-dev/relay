import { createHash } from "node:crypto";
import * as contract from "@relay/contracts/work-history-graph";
import type {
  AgentRunSummary,
  WorkCheckpoint,
  WorkSessionSummary,
} from "@relay/contracts/work-history";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";
import { WorkHistoryRepository } from "../../storage/work-history.js";
import type { CheckpointCard } from "../../storage/work-history.js";
import { WorkHistoryReader } from "./read.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pointOrder = (a: contract.WorkHistoryGraphPoint, b: contract.WorkHistoryGraphPoint) =>
  compare(a.at, b.at) ||
  compare(a.sessionId, b.sessionId) ||
  a.sequence - b.sequence ||
  compare(a.id, b.id);
const OPEN_ENDS_LIMIT = 500;
const CONTEXT_ENTRIES_LIMIT = 5_000;
const PAGE_BYTES_LIMIT = 4 * 1024 * 1024;

/** Линия ветки — не point: для неё не создаются ложные boundaryNodes или события. */
function nodeEndpoints(edge: contract.WorkHistoryGraphEdge): string[] {
  switch (edge.kind) {
    case "sequence":
      return [edge.from, edge.to];
    case "fork":
    case "root-start":
      return [edge.to];
    case "branch-end":
    case "root-end":
      return [edge.from];
  }
}

function laneEndpoints(edge: contract.WorkHistoryGraphEdge): string[] {
  switch (edge.kind) {
    case "fork":
      return [edge.fromSessionId];
    case "branch-end":
      return [edge.toSessionId];
    default:
      return [];
  }
}

function edgeOrderKey(edge: contract.WorkHistoryGraphEdge) {
  return JSON.stringify([edge.kind, nodeEndpoints(edge), laneEndpoints(edge)]);
}

function budget(actual: number, limit: number, part: string) {
  invariant(
    actual <= limit,
    "CONTEXT_TOO_LARGE",
    "Граф истории превышает бюджет компактного ответа; данные не усечены",
    4,
    { context: "work-history-graph", part, actual, limit },
  );
}

/** Производная проекция: ни события, ни геометрия, ни новые записи хранения не создаются. */
class GraphProjection {
  readonly sessions: Map<string, WorkSessionSummary>;
  readonly runs: Map<string, AgentRunSummary>;
  readonly points = new Map<string, contract.WorkHistoryGraphPoint>();
  /** Скрытые дубли lifecycle остаются адресными для прежних derived-ID deep links. */
  readonly addressablePoints = new Map<string, contract.WorkHistoryGraphPoint>();
  readonly edges: contract.WorkHistoryGraphEdge[] = [];

  constructor(readonly reader: WorkHistoryReader) {
    this.sessions = new Map(reader.sessions.map((session) => [session.id, session]));
    this.runs = new Map(reader.runs.map((run) => [run.id, run]));
    const bySession = new Map<string, AgentRunSummary[]>();
    const successors = new Map<string, AgentRunSummary>();
    for (const run of reader.runs) {
      this.session(run.sessionId);
      const items = bySession.get(run.sessionId) ?? [];
      items.push(run);
      bySession.set(run.sessionId, items);
      if (run.predecessorRunId !== null) {
        const previous = this.run(run.predecessorRunId);
        invariant(
          previous.sessionId === run.sessionId && !successors.has(previous.id),
          "INVALID_DATA",
          "Цепочка участий графа разошлась",
          5,
        );
        successors.set(previous.id, run);
      }
    }
    for (const items of bySession.values())
      items.sort((a, b) => a.startedSequence - b.startedSequence || compare(a.id, b.id));
    const closingRuns = new Map<string, AgentRunSummary>();
    for (const session of reader.sessions) {
      const runs = bySession.get(session.id) ?? [];
      const author =
        session.parentSessionId === null ? (runs[0]?.id ?? null) : session.createdByRunId;
      if (session.parentSessionId !== null) {
        invariant(
          author !== null && this.run(author).sessionId === session.parentSessionId,
          "INVALID_DATA",
          "Создатель дочерней ветки не принадлежит родителю",
          5,
        );
      }
      this.add(
        this.lifecycle(
          session,
          "session-created",
          author,
          1,
          session.createdAt,
          session.title,
          session.parentSessionId === null ? "Начало корневой работы" : "Дочернее поручение",
        ),
      );
      if (session.parentSessionId === null)
        this.edges.push({ kind: "root-start", from: null, to: `${session.id}:created` });
      if (session.closedAt !== null) {
        const closing = runs.filter(
          (run) =>
            run.endedAt === session.closedAt &&
            run.endedSequence === session.sequence - 1 &&
            run.endReason === session.status,
        );
        invariant(
          closing.length <= 1,
          "INVALID_DATA",
          "Закрытие ветки связано с несколькими участиями",
          5,
        );
        if (closing[0]) closingRuns.set(session.id, closing[0]);
        this.add(
          this.lifecycle(
            session,
            "session-closed",
            closing[0]?.id ?? null,
            session.sequence,
            session.closedAt,
            session.status === "cancelled" ? "Работа отменена" : "Работа завершена",
            session.title,
          ),
        );
        invariant(
          session.status === "completed" || session.status === "cancelled",
          "INVALID_DATA",
          "Закрытая точка графа требует терминального статуса ветки",
          5,
        );
        if (session.parentSessionId === null)
          this.edges.push({ kind: "root-end", from: `${session.id}:closed`, to: null });
        else
          this.edges.push({
            kind: "branch-end",
            from: `${session.id}:closed`,
            toSessionId: session.parentSessionId,
          });
      }
    }
    for (const run of reader.runs) {
      const session = this.session(run.sessionId);
      const first = bySession.get(session.id)![0]!;
      const atomicRootStart =
        session.parentSessionId === null &&
        first.id === run.id &&
        run.predecessorRunId === null &&
        run.startedSequence === 2 &&
        run.startedAt === session.createdAt;
      const previous = run.predecessorRunId === null ? null : this.run(run.predecessorRunId);
      this.add(
        this.lifecycle(
          session,
          "run-started",
          run.id,
          run.startedSequence,
          run.startedAt,
          previous === null
            ? "Подключение агента"
            : previous.endReason === "transferred"
              ? "Передача работы"
              : "Возобновление работы",
          run.actor,
        ),
        !atomicRootStart,
      );
      if (run.endedAt !== null) {
        invariant(
          run.endedSequence !== null,
          "INVALID_DATA",
          "У окончания участия отсутствует sequence",
          5,
        );
        const next = successors.get(run.id);
        const atomicTransfer =
          run.endReason === "transferred" &&
          next?.startedAt === run.endedAt &&
          next.startedSequence === run.endedSequence + 1;
        const atomicClose = closingRuns.get(session.id)?.id === run.id;
        this.add(
          this.lifecycle(
            session,
            "run-ended",
            run.id,
            run.endedSequence,
            run.endedAt,
            run.endReason === "paused"
              ? "Работа приостановлена"
              : run.endReason === "transferred"
                ? "Участие передано"
                : run.endReason === "cancelled"
                  ? "Участие отменено"
                  : "Участие завершено",
            run.actor,
          ),
          !atomicTransfer && !atomicClose,
        );
      }
    }
    const terminals = new Map<string, CheckpointCard>();
    for (const checkpoint of reader.checkpoints)
      if (checkpoint.kind === "result" || checkpoint.kind === "cancel") {
        invariant(
          checkpoint.intentId !== null && !terminals.has(checkpoint.intentId),
          "INVALID_DATA",
          "У намерения несколько закрывающих точек графа",
          5,
        );
        terminals.set(checkpoint.intentId, checkpoint);
      }
    for (const checkpoint of reader.checkpoints) {
      const run = this.run(checkpoint.runId);
      invariant(
        run.sessionId === checkpoint.sessionId,
        "INVALID_DATA",
        "Автор точки графа принадлежит другой ветке",
        5,
      );
      this.session(checkpoint.sessionId);
      const terminal = terminals.get(checkpoint.id);
      this.add({
        id: `${checkpoint.id}:checkpoint`,
        kind: "checkpoint",
        sessionId: checkpoint.sessionId,
        sequence: checkpoint.sequence,
        at: checkpoint.createdAt,
        title: checkpoint.title,
        summary: "",
        checkpointId: checkpoint.id,
        checkpointKind: checkpoint.kind,
        runId: checkpoint.runId,
        predecessorRunId: run.predecessorRunId,
        intentState:
          checkpoint.kind !== "intent"
            ? null
            : terminal === undefined
              ? "open"
              : terminal.kind === "result"
                ? "completed"
                : "cancelled",
      });
    }
    const checkpointById = new Map(
      reader.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
    );
    for (const session of reader.sessions)
      if (session.parentSessionId !== null) {
        const origin = checkpointById.get(session.originCheckpointId ?? "");
        invariant(
          origin?.kind === "intent" && origin.sessionId === session.parentSessionId,
          "INVALID_DATA",
          "Ответвление графа потеряло намерение родителя",
          5,
        );
        this.edges.push({
          kind: "fork",
          fromSessionId: session.parentSessionId,
          to: `${session.id}:created`,
        });
      }
    const branches = new Map<string, contract.WorkHistoryGraphPoint[]>();
    for (const point of this.points.values()) {
      const items = branches.get(point.sessionId) ?? [];
      items.push(point);
      branches.set(point.sessionId, items);
    }
    for (const items of branches.values()) {
      items.sort((a, b) => a.sequence - b.sequence || compare(a.id, b.id));
      for (let index = 1; index < items.length; index++)
        this.edges.push({ kind: "sequence", from: items[index - 1]!.id, to: items[index]!.id });
    }
    for (const edge of this.edges) {
      for (const id of nodeEndpoints(edge)) {
        invariant(this.points.has(id), "INVALID_DATA", "Связь графа потеряла точку", 5, { edge });
      }
      for (const id of laneEndpoints(edge)) this.session(id);
    }
    this.edges.sort((a, b) => compare(edgeOrderKey(a), edgeOrderKey(b)));
  }

  session(id: string) {
    const session = this.sessions.get(id);
    invariant(session, "INVALID_DATA", "Ветка графа отсутствует", 5, { sessionId: id });
    return session;
  }

  run(id: string) {
    const run = this.runs.get(id);
    invariant(run, "INVALID_DATA", "Авторское участие графа отсутствует", 5, { runId: id });
    return run;
  }

  private lifecycle(
    session: WorkSessionSummary,
    kind: Exclude<contract.WorkHistoryGraphPointKind, "checkpoint">,
    runId: string | null,
    sequence: number,
    at: string,
    title: string,
    summary: string,
  ): contract.WorkHistoryGraphPoint {
    const suffix =
      kind === "session-created"
        ? "created"
        : kind === "session-closed"
          ? "closed"
          : kind === "run-started"
            ? "started"
            : "ended";
    return {
      id: `${kind.startsWith("session-") ? session.id : runId}:${suffix}`,
      kind,
      sessionId: session.id,
      sequence,
      at,
      title,
      summary,
      runId,
      predecessorRunId: runId === null ? null : this.run(runId).predecessorRunId,
      checkpointId: null,
      checkpointKind: null,
      intentState: null,
    };
  }

  private add(point: contract.WorkHistoryGraphPoint, displayed = true) {
    invariant(
      !this.addressablePoints.has(point.id),
      "INVALID_DATA",
      "Повтор идентичности точки графа",
      5,
    );
    this.addressablePoints.set(point.id, point);
    if (displayed) this.points.set(point.id, point);
  }

  tables(
    points: contract.WorkHistoryGraphPoint[],
    boundaries: contract.WorkHistoryGraphBoundaryNode[],
    openEnds: contract.WorkHistoryGraphPoint[],
    edges: contract.WorkHistoryGraphEdge[],
  ) {
    const runIds = new Set<string>();
    for (const point of [...points, ...openEnds])
      for (const id of [point.runId, point.predecessorRunId]) if (id !== null) runIds.add(id);
    const runs = [...runIds].sort(compare).map((id) => this.run(id));
    const visibleBranches = new Set(points.map((point) => point.sessionId));
    const needed = new Set([
      ...visibleBranches,
      ...openEnds.map((point) => point.sessionId),
      ...boundaries.map((point) => point.sessionId),
      ...runs.map((run) => run.sessionId),
      ...edges.flatMap(laneEndpoints),
    ]);
    const branches = new Map<string, contract.WorkHistoryGraphBranch>();
    for (const id of needed) {
      const path = new Set<string>();
      let current: string | null = id;
      while (current !== null && !branches.has(current)) {
        invariant(!path.has(current), "INVALID_DATA", "Цикл предков графа истории", 5);
        path.add(current);
        const session = this.session(current);
        current = session.parentSessionId;
      }
      for (const ancestor of path)
        branches.set(ancestor, {
          ...this.session(ancestor),
          contextOnly: !visibleBranches.has(ancestor),
        });
    }
    return { branches: [...branches.values()].sort((a, b) => compare(a.id, b.id)), runs };
  }
}

/** Отдельное read API графа; прежние 19 операций и их DTO не изменяются. */
export class WorkHistoryGraphService implements contract.WorkHistoryGraphServiceContract {
  constructor(readonly workspace: Workspace) {}

  private async read<T>(
    operation: (
      repository: WorkHistoryRepository,
      projection: GraphProjection,
      project: string,
    ) => Promise<T>,
  ) {
    return this.workspace.locked(async () => {
      const storage = this.workspace.storageSession;
      invariant(
        storage,
        "STORAGE_MIGRATION_REQUIRED",
        "Граф истории требует актуальный формат базы",
        4,
      );
      const repository = new WorkHistoryRepository(storage);
      const project = JSON.stringify([storage.store.root, this.workspace.config.projectId]);
      const reader = await WorkHistoryReader.open(repository, project);
      return operation(repository, new GraphProjection(reader), project);
    });
  }

  private async materialize(
    repository: WorkHistoryRepository,
    point: contract.WorkHistoryGraphPoint,
  ) {
    const checkpoint: WorkCheckpoint | null =
      point.kind === "checkpoint"
        ? await repository.get("work-checkpoint", point.checkpointId)
        : null;
    return {
      point:
        checkpoint === null
          ? point
          : { ...point, title: checkpoint.title, summary: checkpoint.summary },
      checkpoint,
    };
  }

  async graph(input: contract.WorkHistoryGraphQuery): Promise<contract.WorkHistoryGraphPage> {
    const query = parse(contract.workHistoryGraphQuerySchema, input, "граф истории работы");
    return this.read(async (repository, projection, project) => {
      const scopeRootId =
        query.ref === undefined ? null : await repository.resolve("work-session", query.ref);
      const selectedSessions = new Set(
        scopeRootId === null
          ? projection.sessions.keys()
          : query.includeChildren
            ? projection.reader.nodes(scopeRootId).map((node) => node.session.id)
            : [scopeRootId],
      );
      const selected = [...projection.points.values()]
        .filter((point) => selectedSessions.has(point.sessionId))
        .sort(pointOrder);
      if (query.order === "desc") selected.reverse();
      // file-hashes защищает и summary, отсутствующий в компактной карточке. Guard
      // консервативный: изменение других индексируемых данных тоже начинает новую страницу.
      const roots = Object.entries(await repository.storage.snapshotRoots()).sort(([a], [b]) =>
        compare(a, b),
      );
      const version = `work-graph-v2:${createHash("sha256")
        .update(JSON.stringify([project, scopeRootId, query.includeChildren, query.order, roots]))
        .digest("hex")}`;
      invariant(
        query.version === undefined || query.version === version,
        "VERSION_CONFLICT",
        "Граф или параметры чтения изменились; начните чтение заново",
        4,
      );
      const page = selected.slice(query.offset, query.offset + query.limit);
      const visible = new Set(page.map((point) => point.id));
      const positions = new Map(selected.map((point, index) => [point.id, index]));
      const edges = projection.edges.filter((edge) => {
        if (nodeEndpoints(edge).some((id) => visible.has(id))) return true;
        if (!page.length || edge.kind !== "sequence") return false;
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (from === undefined || to === undefined) return false;
        return (
          Math.min(from, to) < query.offset && Math.max(from, to) >= query.offset + page.length
        );
      });
      const boundary = new Map<string, contract.WorkHistoryGraphBoundaryNode>();
      for (const edge of edges)
        for (const id of nodeEndpoints(edge))
          if (!visible.has(id) && !boundary.has(id)) {
            const point = projection.points.get(id)!;
            const index = positions.get(id);
            boundary.set(id, {
              id,
              sessionId: point.sessionId,
              sequence: point.sequence,
              at: point.at,
              kind: point.kind,
              side:
                index === undefined ? "outside-scope" : index < query.offset ? "before" : "after",
            });
          }
      const boundaryNodes = [...boundary.values()].sort((a, b) => compare(a.id, b.id));
      const latest = new Map<string, contract.WorkHistoryGraphPoint>();
      for (const point of selected) {
        if (!["pending", "open", "paused"].includes(projection.session(point.sessionId).status))
          continue;
        if ((latest.get(point.sessionId)?.sequence ?? 0) < point.sequence)
          latest.set(point.sessionId, point);
      }
      budget(latest.size, OPEN_ENDS_LIMIT, "openEnds");
      const openHeaders = [...latest.values()].sort(pointOrder);
      const tables = projection.tables(page, boundaryNodes, openHeaders, edges);
      budget(
        page.length +
          openHeaders.length +
          edges.length +
          boundaryNodes.length +
          tables.branches.length +
          tables.runs.length,
        CONTEXT_ENTRIES_LIMIT,
        "entries",
      );
      // Summary находится в монолитном checkpoint JSON. Читается объединение
      // items ∪ openEnds по одному разу на ID; остальные материалы не открываются.
      const materialized = new Map<string, contract.WorkHistoryGraphPoint>();
      for (const point of [...page, ...openHeaders])
        if (!materialized.has(point.id)) {
          materialized.set(point.id, (await this.materialize(repository, point)).point);
        }
      const items = page.map((point) => materialized.get(point.id)!);
      const openEnds = openHeaders.map((point) => materialized.get(point.id)!);
      const result = {
        scopeRootId,
        items,
        openEnds,
        edges,
        boundaryNodes,
        ...tables,
        total: selected.length,
        nextOffset:
          query.offset + query.limit < selected.length ? query.offset + query.limit : null,
        version,
      };
      budget(Buffer.byteLength(JSON.stringify(result), "utf8"), PAGE_BYTES_LIMIT, "bytes");
      return parse(contract.workHistoryGraphPageSchema, result, "страница графа истории", true);
    });
  }

  async point(
    input: contract.WorkHistoryGraphPointQuery,
  ): Promise<contract.WorkHistoryGraphPointDetail> {
    const query = parse(contract.workHistoryGraphPointQuerySchema, input, "точка графа истории");
    return this.read(async (repository, projection) => {
      const derived =
        !query.ref.startsWith("work-checkpoint:") &&
        contract.workHistoryGraphNodeIdSchema.safeParse(query.ref).success;
      const id = derived
        ? query.ref
        : `${await repository.resolve("work-checkpoint", query.ref)}:checkpoint`;
      const selected = projection.addressablePoints.get(id);
      invariant(selected, "ENTITY_NOT_FOUND", "Точка истории не найдена в выбранном проекте", 3, {
        ref: query.ref,
      });
      const { point, checkpoint } = await this.materialize(repository, selected);
      return parse(
        contract.workHistoryGraphPointDetailSchema,
        {
          point,
          checkpoint,
          session: await repository.get("work-session", point.sessionId),
          run: point.runId === null ? null : await repository.get("agent-run", point.runId),
          previousRun:
            point.predecessorRunId === null ? null : projection.run(point.predecessorRunId),
        },
        "материалы точки графа истории",
        true,
      );
    });
  }
}
