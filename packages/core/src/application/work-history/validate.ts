import {
  agentRunSchema,
  workCheckpointSchema,
  workSessionSchema,
} from "@relay/contracts/work-history";
import type { AgentRun, WorkCheckpoint, WorkSession } from "@relay/contracts/work-history";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";

/** Полная read-only проверка смысла истории после merge; ничего не исправляет и не выбирает победителя. */
export async function validateWorkHistory(workspace: Workspace) {
  return workspace.locked(async () => {
    const storage = workspace.storageSession;
    invariant(storage, "STORAGE_SESSION_REQUIRED", "Проверке истории нужна сессия хранения", 5);
    const check = (
      condition: unknown,
      reason: string,
      message: string,
      kind: string,
      id: string,
      extra: Record<string, unknown> = {},
    ) => {
      invariant(condition, "WORK_HISTORY_INVALID", message, 5, {
        reason,
        ref: { kind, id },
        path: storage.store.registry.path({ kind, id }),
        ...extra,
      });
    };
    const sessions = new Map<string, WorkSession>();
    const runs = new Map<string, AgentRun>();
    const checkpoints = new Map<string, WorkCheckpoint>();
    for (const record of await storage.records("work-session")) {
      const session = parse(workSessionSchema, record.data, `work-session:${record.id}`, true);
      check(
        session.id === record.id && session.revision === record.revision,
        "envelope",
        "Оболочка ветки не соответствует содержанию",
        record.kind,
        record.id,
      );
      sessions.set(session.id, session);
    }
    for (const record of await storage.records("agent-run")) {
      const run = parse(agentRunSchema, record.data, `agent-run:${record.id}`, true);
      check(
        run.id === record.id,
        "envelope",
        "ID участия не соответствует оболочке",
        record.kind,
        record.id,
      );
      runs.set(run.id, run);
    }
    for (const record of await storage.records("work-checkpoint")) {
      const checkpoint = parse(
        workCheckpointSchema,
        record.data,
        `work-checkpoint:${record.id}`,
        true,
      );
      check(
        checkpoint.id === record.id,
        "envelope",
        "ID точки не соответствует оболочке",
        record.kind,
        record.id,
      );
      checkpoints.set(checkpoint.id, checkpoint);
    }
    const terminal = new Map<string, WorkCheckpoint>();
    for (const checkpoint of checkpoints.values())
      if (checkpoint.kind === "result" || checkpoint.kind === "cancel") {
        check(
          !terminal.has(checkpoint.intentId),
          "duplicate-terminal",
          "У намерения несколько закрывающих записей; требуется явный разбор расхождения",
          "work-checkpoint",
          checkpoint.id,
          { intentId: checkpoint.intentId, previousId: terminal.get(checkpoint.intentId)?.id },
        );
        terminal.set(checkpoint.intentId, checkpoint);
      }

    const sequences = new Map<string, Map<number, string>>();
    const addSequence = (
      sessionId: string,
      sequence: number,
      event: string,
      kind: string,
      id: string,
    ) => {
      const session = sessions.get(sessionId);
      check(session, "missing-session", "Владелец события истории отсутствует", kind, id, {
        sessionId,
      });
      const points = sequences.get(sessionId) ?? new Map<number, string>();
      check(
        !points.has(sequence),
        "duplicate-sequence",
        "Две точки занимают один sequence ветки; вероятно расхождение независимых копий",
        kind,
        id,
        { sessionId, sequence, previous: points.get(sequence) },
      );
      check(
        sequence <= session!.sequence,
        "sequence-ahead",
        "Номер события превышает счётчик ветки",
        kind,
        id,
        { sessionId, sequence },
      );
      points.set(sequence, event);
      sequences.set(sessionId, points);
    };
    const children = new Map<string, WorkSession[]>();
    for (const session of sessions.values()) {
      const closed = session.status === "completed" || session.status === "cancelled";
      check(
        closed
          ? session.closedAt !== null && session.result.trim().length > 0
          : session.closedAt === null && session.result === "",
        "session-closure",
        "Статус ветки не соответствует её закрытию и итогу",
        "work-session",
        session.id,
      );
      check(
        (session.status === "open") === (session.currentRunId !== null),
        "current-run-state",
        "Только open-ветка должна иметь текущее участие",
        "work-session",
        session.id,
      );
      addSequence(session.id, 1, "session-created", "work-session", session.id);
      if (closed)
        addSequence(session.id, session.sequence, "session-closed", "work-session", session.id);
      if (session.parentSessionId === null) {
        check(
          session.originCheckpointId === null &&
            session.createdByRunId === null &&
            session.parentSequence === null,
          "root-origin",
          "Корневая ветка содержит поля ответвления",
          "work-session",
          session.id,
        );
        continue;
      }
      const parent = sessions.get(session.parentSessionId);
      const intent =
        session.originCheckpointId === null
          ? undefined
          : checkpoints.get(session.originCheckpointId);
      const creator =
        session.createdByRunId === null ? undefined : runs.get(session.createdByRunId);
      check(
        parent && intent?.kind === "intent" && intent.sessionId === parent.id,
        "fork-intent",
        "Дочерняя ветка ссылается на чужое или отсутствующее намерение родителя",
        "work-session",
        session.id,
      );
      check(
        creator?.sessionId === parent?.id,
        "fork-creator",
        "Создавшее ответвление участие не принадлежит родителю",
        "work-session",
        session.id,
      );
      const sequence = session.parentSequence;
      check(
        sequence !== null &&
          sequence > intent!.sequence &&
          sequence > creator!.startedSequence &&
          (creator!.endedSequence === null || sequence < creator!.endedSequence) &&
          (!terminal.has(intent!.id) || sequence < terminal.get(intent!.id)!.sequence),
        "fork-sequence",
        "Ответвление создано вне открытого намерения или участия родителя",
        "work-session",
        session.id,
      );
      addSequence(parent!.id, sequence!, "session-forked", "work-session", session.id);
      const siblings = children.get(parent!.id) ?? [];
      siblings.push(session);
      children.set(parent!.id, siblings);
    }

    // Каждый узел посещается один раз; даже патологически глубокое дерево не использует рекурсию.
    const visited = new Set<string>();
    for (const session of sessions.values()) {
      const path = new Set<string>();
      let current: WorkSession | undefined = session;
      while (current && !visited.has(current.id)) {
        check(
          !path.has(current.id),
          "parent-cycle",
          "Обнаружен цикл родителей веток",
          "work-session",
          current.id,
        );
        path.add(current.id);
        current =
          current.parentSessionId === null ? undefined : sessions.get(current.parentSessionId);
      }
      for (const id of path) visited.add(id);
    }

    const sessionRuns = new Map<string, AgentRun[]>();
    for (const run of runs.values()) {
      check(
        sessions.has(run.sessionId),
        "run-session",
        "Участие относится к отсутствующей ветке",
        "agent-run",
        run.id,
      );
      const ended = run.endedAt !== null;
      check(
        ended
          ? run.endedSequence !== null &&
              run.endReason !== null &&
              run.endSummary !== null &&
              run.endSummary.trim().length > 0
          : run.endedSequence === null && run.endReason === null && run.endSummary === null,
        "run-ending",
        "Поля окончания участия не согласованы",
        "agent-run",
        run.id,
      );
      addSequence(run.sessionId, run.startedSequence, "run-started", "agent-run", run.id);
      if (run.endedSequence !== null) {
        check(
          run.endedSequence > run.startedSequence,
          "run-sequence",
          "Участие заканчивается до своего начала",
          "agent-run",
          run.id,
        );
        addSequence(run.sessionId, run.endedSequence, "run-ended", "agent-run", run.id);
      }
      const items = sessionRuns.get(run.sessionId) ?? [];
      items.push(run);
      sessionRuns.set(run.sessionId, items);
    }
    for (const session of sessions.values()) {
      const items = (sessionRuns.get(session.id) ?? []).sort(
        (a, b) => a.startedSequence - b.startedSequence,
      );
      const live = items.filter((run) => run.endedAt === null);
      check(
        live.length <= 1,
        "multiple-current-runs",
        "У ветки несколько незаконченных участий",
        "work-session",
        session.id,
      );
      check(
        session.status === "open"
          ? live.length === 1 && live[0]!.id === session.currentRunId
          : live.length === 0,
        "current-run-mismatch",
        "Текущее участие и статус ветки не согласованы",
        "work-session",
        session.id,
      );
      const last = items.at(-1);
      check(
        session.status !== "pending" || items.length === 0,
        "pending-run",
        "Pending-ветка уже содержит участие",
        "work-session",
        session.id,
      );
      if (session.status === "paused" || session.status === "completed")
        check(
          last?.endReason === session.status,
          "last-run-state",
          "Окончание последнего участия не соответствует ветке",
          "work-session",
          session.id,
        );
      if (session.status === "cancelled")
        check(
          !last || last.endReason === "cancelled" || last.endReason === "paused",
          "last-run-state",
          "Отменённая ветка имеет несовместимое окончание участия",
          "work-session",
          session.id,
        );
      for (let index = 0; index < items.length; index++) {
        const run = items[index]!;
        const previous = items[index - 1];
        check(
          previous
            ? run.predecessorRunId === previous.id &&
                previous.endedSequence !== null &&
                previous.endedSequence < run.startedSequence &&
                (previous.endReason === "paused" || previous.endReason === "transferred")
            : run.predecessorRunId === null,
          "run-chain",
          "Цепочка участий разошлась либо потеряла предшественника",
          "agent-run",
          run.id,
        );
      }
    }

    const acceptance = new Map<string, number>();
    for (const checkpoint of checkpoints.values()) {
      const run = runs.get(checkpoint.runId);
      check(
        run?.sessionId === checkpoint.sessionId && checkpoint.createdBy === run.actor,
        "checkpoint-run",
        "Точка принадлежит чужому участию или автору",
        "work-checkpoint",
        checkpoint.id,
      );
      check(
        checkpoint.sequence > run!.startedSequence &&
          (run!.endedSequence === null || checkpoint.sequence < run!.endedSequence),
        "checkpoint-ownership",
        "Точка записана вне периода владения участия",
        "work-checkpoint",
        checkpoint.id,
      );
      check(
        checkpoint.body.trim().length > 0,
        "empty-body",
        "Материал точки не может быть пустым",
        "work-checkpoint",
        checkpoint.id,
      );
      addSequence(
        checkpoint.sessionId,
        checkpoint.sequence,
        "checkpoint",
        "work-checkpoint",
        checkpoint.id,
      );
      if (checkpoint.kind !== "intent") {
        const intent = checkpoints.get(checkpoint.intentId);
        check(
          intent?.kind === "intent" &&
            intent.sessionId === checkpoint.sessionId &&
            intent.sequence < checkpoint.sequence,
          "checkpoint-intent",
          "Точка ссылается на чужое или более позднее намерение",
          "work-checkpoint",
          checkpoint.id,
        );
        const end = terminal.get(checkpoint.intentId);
        check(
          !end || checkpoint.sequence <= end.sequence,
          "checkpoint-after-terminal",
          "Материал записан после закрытия намерения",
          "work-checkpoint",
          checkpoint.id,
        );
      }
      check(
        new Set(checkpoint.acceptedSessionIds).size === checkpoint.acceptedSessionIds.length,
        "duplicate-acceptance",
        "Результат ребёнка указан дважды в одной точке",
        "work-checkpoint",
        checkpoint.id,
      );
      for (const id of checkpoint.acceptedSessionIds) {
        const child = sessions.get(id);
        check(
          child?.parentSessionId === checkpoint.sessionId &&
            child.originCheckpointId === checkpoint.intentId &&
            child.status === "completed",
          "invalid-acceptance",
          "Принят неготовый результат либо ребёнок другого намерения",
          "work-checkpoint",
          checkpoint.id,
          { childId: id },
        );
        acceptance.set(id, Math.min(acceptance.get(id) ?? Infinity, checkpoint.sequence));
      }
    }
    for (const intent of checkpoints.values())
      if (intent.kind === "intent") {
        const end = terminal.get(intent.id);
        if (!end) continue;
        for (const child of children.get(intent.sessionId) ?? [])
          if (child.originCheckpointId === intent.id) {
            check(
              child.status === "cancelled" || child.status === "completed",
              "intent-open-child",
              "Намерение закрыто с незакрытым ребёнком",
              "work-checkpoint",
              end.id,
              { childId: child.id },
            );
            check(
              child.status !== "completed" ||
                (acceptance.get(child.id) ?? Infinity) <= end.sequence,
              "intent-unaccepted-child",
              "Намерение закрыто до явного принятия готового ребёнка",
              "work-checkpoint",
              end.id,
              { childId: child.id },
            );
          }
      }
    const openOwners = new Set(
      [...checkpoints.values()]
        .filter((item) => item.kind === "intent" && !terminal.has(item.id))
        .map((item) => item.sessionId),
    );
    for (const session of sessions.values()) {
      let maximum = 0;
      for (const sequence of sequences.get(session.id)!.keys())
        maximum = Math.max(maximum, sequence);
      check(
        maximum === session.sequence,
        "sequence-tail",
        "Счётчик ветки не соответствует сохранённым точкам",
        "work-session",
        session.id,
      );
      if (session.status !== "completed" && session.status !== "cancelled") continue;
      check(
        !openOwners.has(session.id),
        "closed-session-intent",
        "Закрытая ветка имеет открытое намерение",
        "work-session",
        session.id,
      );
      for (const child of children.get(session.id) ?? [])
        check(
          child.status === "cancelled" ||
            (child.status === "completed" && acceptance.has(child.id)),
          "closed-session-child",
          "Закрытая ветка имеет незакрытого или непринятого ребёнка",
          "work-session",
          session.id,
          { childId: child.id },
        );
    }
    return { sessions: sessions.size, runs: runs.size, checkpoints: checkpoints.size };
  });
}
