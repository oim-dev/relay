import { createHash } from "node:crypto";
import type {
  WorkHistoryItem,
  WorkHistoryPage,
  AgentRunSummary,
  WorkSessionAcceptance,
  WorkSessionCounts,
  WorkSessionOverview,
  WorkSessionSummary,
  WorkOpenIntentsPage,
  WorkTreeNode,
  WorkTreePage,
  WorkTreeTotals,
} from "@relay/contracts/work-history";
import type { z } from "zod";
import { OVERVIEW_SESSIONS_LIMIT } from "@relay/contracts/overview-sessions";
import type { OverviewSession, OverviewSessions } from "@relay/contracts/overview-sessions";
import type {
  workHistoryQuerySchema,
  workOpenIntentsQuerySchema,
  workSessionsQuerySchema,
  workTreeQuerySchema,
} from "@relay/contracts/work-history";
import { invariant } from "../../shared/errors.js";
import { WorkHistoryRepository } from "../../storage/work-history.js";
import type { CheckpointCard } from "../../storage/work-history.js";

export const unfinished = (session: Pick<WorkSessionSummary, "status">) =>
  !["completed", "cancelled"].includes(session.status);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Page = { offset: number; limit: number; version?: string | undefined };
type Event = {
  id: string;
  sessionId: string;
  sequence: number;
  at: string;
  kind: WorkHistoryItem["kind"];
  recordId: string;
};

/** Один заблокированный снимок компактных индексов; полные материалы читаются адресно. */
export class WorkHistoryReader {
  private readonly sessionMap = new Map<string, WorkSessionSummary>();
  private readonly countMap = new Map<string, WorkSessionCounts>();
  private readonly latestRuns = new Map<string, AgentRunSummary>();
  private readonly acceptances = new Map<string, WorkSessionAcceptance>();
  private readonly closedIntents = new Set<string>();

  private constructor(
    readonly repository: WorkHistoryRepository,
    readonly project: string,
    readonly sessions: WorkSessionSummary[],
    readonly runs: AgentRunSummary[],
    readonly checkpoints: CheckpointCard[],
  ) {
    for (const session of sessions) {
      this.sessionMap.set(session.id, session);
      this.countMap.set(session.id, {
        runs: 0,
        checkpoints: 0,
        openIntents: 0,
        children: 0,
        unfinishedChildren: 0,
      });
    }
    for (const session of sessions)
      if (session.parentSessionId !== null) {
        const counts = this.countMap.get(session.parentSessionId);
        if (counts) {
          counts.children++;
          if (unfinished(session)) counts.unfinishedChildren++;
        }
      }
    for (const run of runs) {
      this.counts(run.sessionId).runs++;
      if ((this.latestRuns.get(run.sessionId)?.startedSequence ?? 0) < run.startedSequence)
        this.latestRuns.set(run.sessionId, run);
    }
    for (const checkpoint of checkpoints)
      if (
        (checkpoint.kind === "result" || checkpoint.kind === "cancel") &&
        checkpoint.intentId !== null
      )
        this.closedIntents.add(checkpoint.intentId);
    const firstAcceptance = new Map<string, CheckpointCard>();
    for (const checkpoint of checkpoints) {
      const counts = this.counts(checkpoint.sessionId);
      counts.checkpoints++;
      if (checkpoint.kind === "intent" && !this.closedIntents.has(checkpoint.id))
        counts.openIntents++;
      for (const childId of checkpoint.acceptedSessionIds) {
        const child = this.sessionMap.get(childId);
        invariant(
          child?.parentSessionId === checkpoint.sessionId &&
            child.originCheckpointId === checkpoint.intentId &&
            child.status === "completed",
          "INVALID_DATA",
          "Принятие результата не соответствует дочерней ветке",
          5,
        );
        const previous = firstAcceptance.get(childId);
        if (!previous || checkpoint.sequence < previous.sequence)
          firstAcceptance.set(childId, checkpoint);
      }
    }
    for (const [id, checkpoint] of firstAcceptance)
      this.acceptances.set(id, {
        checkpointId: checkpoint.id,
        checkpointKey: checkpoint.key,
        sessionId: checkpoint.sessionId,
        runId: checkpoint.runId,
        at: checkpoint.createdAt,
      });
  }

  static async open(repository: WorkHistoryRepository, project: string) {
    return new WorkHistoryReader(
      repository,
      project,
      await repository.sessions(),
      await repository.runs(),
      await repository.checkpoints(),
    );
  }

  counts(id: string): WorkSessionCounts {
    const counts = this.countMap.get(id);
    invariant(counts, "STORAGE_INDEX_CORRUPT", "Владелец материала отсутствует в индексе веток", 5);
    return counts;
  }

  private metadata(id: string) {
    return {
      counts: this.counts(id),
      latestRun: this.latestRuns.get(id) ?? null,
      acceptance: this.acceptances.get(id) ?? null,
    };
  }

  private overview(session: WorkSessionSummary): WorkSessionOverview {
    return { ...session, ...this.metadata(session.id) };
  }

  private totals(sessions: WorkSessionSummary[]): WorkTreeTotals {
    const totals = {
      sessions: sessions.length,
      unfinished: 0,
      runs: 0,
      checkpoints: 0,
      openIntents: 0,
    };
    for (const session of sessions) {
      const counts = this.counts(session.id);
      if (unfinished(session)) totals.unfinished++;
      totals.runs += counts.runs;
      totals.checkpoints += counts.checkpoints;
      totals.openIntents += counts.openIntents;
    }
    return totals;
  }

  async detail(id: string) {
    const session = await this.repository.get("work-session", id);
    const currentRun = session.currentRunId
      ? await this.repository.get("agent-run", session.currentRunId)
      : null;
    invariant(
      currentRun === null
        ? session.status !== "open"
        : session.status === "open" && currentRun.sessionId === id && currentRun.endedAt === null,
      "INVALID_DATA",
      "Текущее участие не согласовано с веткой",
      5,
    );
    return { session, currentRun, ...this.metadata(id) };
  }

  page<T>(items: T[], query: Page, scope: unknown, guard: unknown = items) {
    const version = `work-v1:${createHash("sha256")
      .update(JSON.stringify([this.project, scope, guard]))
      .digest("hex")}`;
    invariant(
      !query.version || query.version === version,
      "VERSION_CONFLICT",
      "История или параметры выборки изменились; начните чтение заново",
      4,
    );
    return {
      items: items.slice(query.offset, query.offset + query.limit),
      total: items.length,
      nextOffset: query.offset + query.limit < items.length ? query.offset + query.limit : null,
      version,
    };
  }

  async list(query: z.output<typeof workSessionsQuerySchema>) {
    const parent =
      query.parent === undefined || query.parent === null
        ? query.parent
        : await this.repository.resolve("work-session", query.parent);
    const authored =
      query.actor === undefined
        ? null
        : new Set(this.runs.filter((run) => run.actor === query.actor).map((run) => run.sessionId));
    let items = this.sessions.filter(
      (item) =>
        (query.unfinished === undefined || unfinished(item) === query.unfinished) &&
        (!query.status || item.status === query.status) &&
        (parent === undefined || item.parentSessionId === parent) &&
        (authored === null || authored.has(item.id)),
    );
    if (query.q) {
      const search = query.q.toLocaleLowerCase();
      const matches: WorkSessionSummary[] = [];
      for (const item of items) {
        if (
          [item.key, item.title].some((text) => text.toLocaleLowerCase().includes(search)) ||
          (await this.repository.get("work-session", item.id)).description
            .toLocaleLowerCase()
            .includes(search)
        )
          matches.push(item);
      }
      items = matches;
    }
    items.sort((a, b) => compare(b.updatedAt, a.updatedAt) || compare(a.id, b.id));
    const overviews = items.map((session) => this.overview(session));
    const projectTotals = this.totals(this.sessions);
    return {
      ...this.page(
        overviews,
        query,
        {
          operation: "list",
          parent,
          unfinished: query.unfinished,
          status: query.status,
          actor: query.actor,
          q: query.q,
        },
        [overviews, projectTotals],
      ),
      projectTotals,
    };
  }

  nodes(root: string): WorkTreeNode[] {
    const children = new Map<string, WorkSessionSummary[]>();
    for (const item of this.sessions)
      if (item.parentSessionId) {
        const siblings = children.get(item.parentSessionId) ?? [];
        siblings.push(item);
        children.set(item.parentSessionId, siblings);
      }
    for (const siblings of children.values())
      siblings.sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
    const first = this.sessions.find((item) => item.id === root);
    invariant(first, "STORAGE_INDEX_CORRUPT", "Корень отсутствует в индексе веток", 5);
    const stack = [{ session: first, depth: 0 }];
    const visited = new Set<string>();
    const result: WorkTreeNode[] = [];
    while (stack.length) {
      const node = stack.pop()!;
      invariant(!visited.has(node.session.id), "INVALID_DATA", "Обнаружен цикл дерева истории", 5);
      visited.add(node.session.id);
      result.push({
        ...node,
        session: this.overview(node.session),
        parentSessionId: node.session.parentSessionId,
      });
      const siblings = children.get(node.session.id) ?? [];
      for (let i = siblings.length - 1; i >= 0; i--)
        stack.push({ session: siblings[i]!, depth: node.depth + 1 });
    }
    return result;
  }

  async tree(query: z.output<typeof workTreeQuerySchema>): Promise<WorkTreePage> {
    const root = await this.repository.resolve("work-session", query.ref);
    const nodes = this.nodes(root);
    const ids = new Set(nodes.map((node) => node.session.id));
    const runs = this.runs.filter((item) => ids.has(item.sessionId));
    const checkpoints = this.checkpoints.filter((item) => ids.has(item.sessionId));
    return {
      rootSessionId: root,
      ...this.page(nodes, query, ["tree", root], [nodes, runs, checkpoints]),
      totals: this.totals(nodes.map((node) => node.session)),
    };
  }

  async openIntents(
    query: z.output<typeof workOpenIntentsQuerySchema>,
  ): Promise<WorkOpenIntentsPage> {
    const root = await this.repository.resolve("work-session", query.ref);
    const sessions = query.includeChildren
      ? this.nodes(root).map((node) => node.session)
      : [this.sessionMap.get(root)!];
    const ids = new Set(sessions.map((session) => session.id));
    const selected = this.checkpoints
      .filter(
        (item) =>
          ids.has(item.sessionId) && item.kind === "intent" && !this.closedIntents.has(item.id),
      )
      .sort(
        (a, b) =>
          compare(a.createdAt, b.createdAt) ||
          compare(a.sessionId, b.sessionId) ||
          a.sequence - b.sequence ||
          compare(a.id, b.id),
      );
    const page = this.page(
      selected,
      query,
      ["open-intents", root, query.includeChildren],
      [selected, sessions],
    );
    const items: WorkOpenIntentsPage["items"] = [];
    for (const card of page.items) {
      const checkpoint = await this.repository.get("work-checkpoint", card.id);
      invariant(
        checkpoint.kind === "intent",
        "STORAGE_INDEX_STALE",
        "Открытое намерение не соответствует карточке",
        4,
      );
      items.push(checkpoint);
    }
    return { ...page, items };
  }

  async history(
    query: z.output<typeof workHistoryQuerySchema>,
    operation = "history",
  ): Promise<WorkHistoryPage> {
    const root = query.ref ? await this.repository.resolve("work-session", query.ref) : undefined;
    const ids = new Set(
      root === undefined
        ? this.sessions.map((item) => item.id)
        : query.includeChildren
          ? this.nodes(root).map((item) => item.session.id)
          : [root],
    );
    const selected = this.events(ids)
      .filter((event) => !query.kind || event.kind === query.kind)
      .sort(
        (a, b) =>
          compare(a.at, b.at) ||
          compare(a.sessionId, b.sessionId) ||
          a.sequence - b.sequence ||
          compare(a.id, b.id),
      );
    if (query.order === "desc") selected.reverse();
    return this.historyPage(selected, query, operation, root);
  }

  /** Общая хронология из компактных индексов, без чтения Markdown. */
  private events(ids: ReadonlySet<string>): Event[] {
    const events: Event[] = [];
    for (const session of this.sessions) {
      if (ids.has(session.id)) {
        events.push({
          id: `${session.id}:created`,
          kind: "session-created",
          sessionId: session.id,
          sequence: 1,
          at: session.createdAt,
          recordId: session.id,
        });
        if (session.closedAt)
          events.push({
            id: `${session.id}:closed`,
            kind: "session-closed",
            sessionId: session.id,
            sequence: session.sequence,
            at: session.closedAt,
            recordId: session.id,
          });
      }
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        invariant(session.parentSequence !== null, "INVALID_DATA", "Потерян номер ответвления", 5);
        events.push({
          id: `${session.id}:forked`,
          kind: "session-forked",
          sessionId: session.parentSessionId,
          sequence: session.parentSequence,
          at: session.createdAt,
          recordId: session.id,
        });
      }
    }
    for (const run of this.runs)
      if (ids.has(run.sessionId)) {
        events.push({
          id: `${run.id}:started`,
          kind: "run-started",
          sessionId: run.sessionId,
          sequence: run.startedSequence,
          at: run.startedAt,
          recordId: run.id,
        });
        if (run.endedAt) {
          invariant(
            run.endedSequence !== null,
            "INVALID_DATA",
            "Потерян номер окончания участия",
            5,
          );
          events.push({
            id: `${run.id}:ended`,
            kind: "run-ended",
            sessionId: run.sessionId,
            sequence: run.endedSequence,
            at: run.endedAt,
            recordId: run.id,
          });
        }
      }
    for (const checkpoint of this.checkpoints)
      if (ids.has(checkpoint.sessionId))
        events.push({
          id: `${checkpoint.id}:checkpoint`,
          kind: "checkpoint",
          sessionId: checkpoint.sessionId,
          sequence: checkpoint.sequence,
          at: checkpoint.createdAt,
          recordId: checkpoint.id,
        });
    return events;
  }

  /** Сводка проекта использует тот же набор событий, что и полная история. */
  projectOverview(): { snapshot: OverviewSessions; version: string } {
    const latest = new Map<string, Event>();
    for (const event of this.events(new Set(this.sessionMap.keys()))) {
      const previous = latest.get(event.sessionId);
      if (
        !previous ||
        compare(event.at, previous.at) > 0 ||
        (event.at === previous.at && event.sequence > previous.sequence)
      )
        latest.set(event.sessionId, event);
    }
    const entries: OverviewSession[] = this.sessions.map((session) => {
      const event = latest.get(session.id)!;
      const parent = session.parentSessionId ? this.sessionMap.get(session.parentSessionId) : null;
      invariant(
        parent !== undefined,
        "STORAGE_INDEX_CORRUPT",
        "Родитель сессии отсутствует в индексе",
        5,
      );
      return {
        id: session.id,
        key: session.key,
        title: session.title,
        status: session.status,
        parent: parent ? { id: parent.id, key: parent.key } : null,
        lastEvent: { kind: event.kind, at: event.at, sequence: event.sequence },
      };
    });
    entries.sort((a, b) => compare(b.lastEvent.at, a.lastEvent.at) || compare(b.id, a.id));
    const open = entries.filter(unfinished);
    const items = open.slice(0, OVERVIEW_SESSIONS_LIMIT);
    return {
      snapshot: {
        total: entries.length,
        latest: entries[0] ?? null,
        unfinished: {
          total: open.length,
          shown: items.length,
          hasMore: open.length > items.length,
          items,
        },
      },
      // Guard учитывает и невидимые ветки/материалы, а не только первую подборку.
      version: createHash("sha256")
        .update(JSON.stringify([this.sessions, this.runs, this.checkpoints]))
        .digest("hex"),
    };
  }

  private async historyPage(
    selected: Event[],
    query: z.output<typeof workHistoryQuerySchema>,
    operation: string,
    root: string | undefined,
  ): Promise<WorkHistoryPage> {
    // Событие start возвращает текущее участие, fork — текущую карточку ребёнка.
    // Guard поэтому учитывает именно возвращаемые владельцы, а не один список event ID.
    const sessions = new Map(this.sessions.map((item) => [item.id, item]));
    const runs = new Map(this.runs.map((item) => [item.id, item]));
    const checkpoints = new Map(this.checkpoints.map((item) => [item.id, item]));
    const page = this.page(
      selected,
      query,
      [operation, root, query.includeChildren, query.order, query.kind],
      [
        operation === "context" && root ? this.overview(this.sessionMap.get(root)!) : null,
        selected.map((event) => [
          event,
          event.kind === "checkpoint"
            ? checkpoints.get(event.recordId)
            : event.kind.startsWith("run-")
              ? runs.get(event.recordId)
              : sessions.get(event.recordId),
        ]),
      ],
    );
    const items: WorkHistoryItem[] = [];
    for (const { recordId, ...event } of page.items) {
      switch (event.kind) {
        case "session-created":
        case "session-closed":
          items.push({
            ...event,
            kind: event.kind,
            session: await this.repository.get("work-session", recordId),
          });
          break;
        case "session-forked":
          items.push({
            ...event,
            kind: event.kind,
            childSession: await this.repository.get("work-session", recordId),
          });
          break;
        case "run-started":
        case "run-ended":
          items.push({
            ...event,
            kind: event.kind,
            run: await this.repository.get("agent-run", recordId),
          });
          break;
        case "checkpoint":
          items.push({
            ...event,
            kind: event.kind,
            checkpoint: await this.repository.get("work-checkpoint", recordId),
          });
          break;
      }
    }
    return { ...page, items };
  }
}
