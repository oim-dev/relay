import type { z } from "zod";
import * as contract from "@relay/contracts/work-history";
import { actorSchema } from "@relay/contracts/primitives";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import { Workspace } from "../../storage/workspace.js";
import { WorkHistoryRepository } from "../../storage/work-history.js";
import type { CheckpointCard } from "../../storage/work-history.js";
import { resolveEntityCard } from "../entities/indexed-catalog.js";
import { WorkHistoryReader, unfinished } from "./read.js";

type Mutation = { requestId: string; actor?: string | undefined };
type BranchMutation = Mutation & { ref: string; ifRevision: number };
type Connection = {
  client?: string | undefined;
  sourceSessionId?: string | undefined;
  reason: string;
  operator?: contract.AgentRun["operator"] | undefined;
  git?: contract.AgentRun["git"] | undefined;
};
type CheckpointInput = z.output<typeof contract.workCheckpointSaveSchema>;

/** Логическая работа, участия и неизменяемые материалы; не автоматический аудит операций. */
export class WorkHistoryService implements contract.WorkHistoryServiceContract {
  constructor(readonly workspace: Workspace) {}

  private repository() {
    const session = this.workspace.storageSession;
    invariant(
      session,
      "STORAGE_MIGRATION_REQUIRED",
      "Для истории работы требуется актуальный формат базы",
      4,
    );
    return new WorkHistoryRepository(session);
  }

  private reader(repository: WorkHistoryRepository) {
    return WorkHistoryReader.open(
      repository,
      JSON.stringify([repository.storage.store.root, this.workspace.config.projectId]),
    );
  }

  private async read<T>(operation: (repository: WorkHistoryRepository) => Promise<T>) {
    return this.workspace.locked(() => operation(this.repository()));
  }

  async list(input: contract.WorkSessionsQuery) {
    const query = parse(contract.workSessionsQuerySchema, input, "поиск веток работы");
    return this.read(async (repository) => (await this.reader(repository)).list(query));
  }

  async get(input: contract.WorkSessionQuery) {
    const query = parse(contract.workSessionQuerySchema, input, "ветка работы");
    return this.read(async (repository) =>
      (await this.reader(repository)).detail(await repository.resolve("work-session", query.ref)),
    );
  }

  async tree(input: contract.WorkTreeQuery) {
    const query = parse(contract.workTreeQuerySchema, input, "дерево работы");
    return this.read(async (repository) => (await this.reader(repository)).tree(query));
  }

  async history(input: contract.WorkHistoryQuery) {
    const query = parse(contract.workHistoryQuerySchema, input, "история работы");
    return this.read(async (repository) => (await this.reader(repository)).history(query));
  }

  async context(input: contract.WorkContextQuery) {
    const query = parse(contract.workContextQuerySchema, input, "контекст работы");
    return this.read(async (repository) => {
      const reader = await this.reader(repository);
      const id = await repository.resolve("work-session", query.ref);
      return {
        ...(await reader.detail(id)),
        history: await reader.history(
          { ...query, ref: id, includeChildren: false, order: "desc" },
          "context",
        ),
      };
    });
  }

  async checkpoint(input: contract.WorkCheckpointQuery) {
    const query = parse(contract.workCheckpointQuerySchema, input, "точка работы");
    return this.read(async (repository) =>
      repository.get("work-checkpoint", await repository.resolve("work-checkpoint", query.ref)),
    );
  }

  async openIntents(input: contract.WorkOpenIntentsQuery) {
    const query = parse(contract.workOpenIntentsQuerySchema, input, "открытые намерения");
    return this.read(async (repository) => (await this.reader(repository)).openIntents(query));
  }

  private async mutate<T extends Mutation>(
    schema: z.ZodType<T>,
    input: unknown,
    defaultActor: string,
    operation: (
      repository: WorkHistoryRepository,
      command: T,
      actor: string,
      at: string,
    ) => Promise<contract.WorkHistoryMutation>,
  ) {
    const command = parse(schema, input, "изменение истории работы");
    const actor = parse(actorSchema, command.actor ?? defaultActor, "автор истории работы");
    return this.workspace.mutate("work-history", command, actor, async () => {
      const result = await operation(this.repository(), command, actor, new Date().toISOString());
      return parse(contract.workHistoryMutationSchema, result, "результат истории работы", true);
    });
  }

  private async branch(repository: WorkHistoryRepository, command: BranchMutation, id?: string) {
    const session = await repository.get(
      "work-session",
      id ?? (await repository.resolve("work-session", command.ref)),
    );
    invariant(
      session.revision === command.ifRevision,
      "REVISION_CONFLICT",
      "Ветка изменилась; прочитайте её актуальную ревизию",
      4,
      { sessionId: session.id, expected: command.ifRevision, actual: session.revision },
    );
    invariant(
      unfinished(session),
      "WORK_SESSION_CLOSED",
      "Завершённая или отменённая ветка неизменяема",
      4,
    );
    return session;
  }

  private async owner(
    repository: WorkHistoryRepository,
    session: contract.WorkSession,
    runId: string | undefined,
  ) {
    invariant(
      session.status === "open" && runId !== undefined && session.currentRunId === runId,
      "WORK_RUN_NOT_CURRENT",
      "Писать может только явно указанное текущее участие open-ветки; перечитайте ветку",
      4,
    );
    const run = await repository.get("agent-run", runId);
    invariant(
      run.sessionId === session.id && run.endedAt === null,
      "WORK_RUN_NOT_CURRENT",
      "Участие уже завершено или относится к другой ветке",
      4,
    );
    return run;
  }

  private touch(session: contract.WorkSession, at: string) {
    session.revision++;
    session.updatedAt = at;
  }

  private async newRun(
    repository: WorkHistoryRepository,
    session: contract.WorkSession,
    command: Connection,
    actor: string,
    at: string,
    predecessorRunId: string | null,
  ): Promise<contract.AgentRun> {
    const run: contract.AgentRun = {
      ...(await repository.identity("agent-run")),
      sessionId: session.id,
      actor,
      operator: command.operator ?? null,
      git: command.git ?? null,
      client: command.client ?? null,
      sourceSessionId: command.sourceSessionId ?? null,
      startedAt: at,
      startedSequence: ++session.sequence,
      endedAt: null,
      endedSequence: null,
      endReason: null,
      endSummary: null,
      predecessorRunId,
      reason: command.reason,
    };
    session.currentRunId = run.id;
    session.status = "open";
    await repository.put("agent-run", run, actor);
    return run;
  }

  private async endRun(
    repository: WorkHistoryRepository,
    session: contract.WorkSession,
    run: contract.AgentRun,
    reason: contract.AgentRunEndReason,
    summary: string,
    actor: string,
    at: string,
  ) {
    run.endedAt = at;
    run.endedSequence = ++session.sequence;
    run.endReason = reason;
    run.endSummary = summary;
    session.currentRunId = null;
    await repository.update("agent-run", run, actor);
  }

  private result(
    session: contract.WorkSession,
    run: contract.AgentRun | null,
    checkpoint: contract.WorkCheckpoint | null = null,
    childSession: contract.WorkSession | null = null,
  ): contract.WorkHistoryMutation {
    return { session, run, checkpoint, childSession };
  }

  start(input: contract.WorkSessionStart, defaultActor: string) {
    return this.mutate(
      contract.workSessionStartSchema,
      input,
      defaultActor,
      async (repository, command, actor, at) => {
        const session: contract.WorkSession = {
          ...(await repository.identity("work-session")),
          title: command.title,
          description: command.description,
          parentSessionId: null,
          originCheckpointId: null,
          createdByRunId: null,
          parentSequence: null,
          status: "open",
          currentRunId: null,
          sequence: 1,
          result: "",
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          revision: 1,
        };
        const run = await this.newRun(repository, session, command, actor, at, null);
        await repository.put("work-session", session, actor);
        return this.result(session, run);
      },
    );
  }

  private async intent(repository: WorkHistoryRepository, ref: string) {
    const checkpoint = await repository.get(
      "work-checkpoint",
      await repository.resolve("work-checkpoint", ref),
    );
    invariant(
      checkpoint.kind === "intent",
      "WORK_INTENT_REQUIRED",
      "Укажите исходную точку intent, а не progress/result/cancel",
      4,
    );
    const checkpoints = await repository.checkpoints();
    invariant(
      !checkpoints.some(
        (item) =>
          item.intentId === checkpoint.id && (item.kind === "result" || item.kind === "cancel"),
      ),
      "WORK_INTENT_CLOSED",
      "Намерение уже закрыто; новое поручение требует нового intent",
      4,
    );
    return { checkpoint, checkpoints };
  }

  fork(input: contract.WorkSessionFork, defaultActor: string) {
    return this.mutate(
      contract.workSessionForkSchema,
      input,
      defaultActor,
      async (repository, command, actor, at) => {
        const { checkpoint } = await this.intent(repository, command.ref);
        const session = await this.branch(repository, command, checkpoint.sessionId);
        const run = await this.owner(repository, session, command.runId);
        const child: contract.WorkSession = {
          ...(await repository.identity("work-session")),
          title: command.title,
          description: command.description,
          parentSessionId: session.id,
          originCheckpointId: checkpoint.id,
          createdByRunId: run.id,
          parentSequence: ++session.sequence,
          status: "pending",
          currentRunId: null,
          sequence: 1,
          result: "",
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          revision: 1,
        };
        this.touch(session, at);
        await repository.put("work-session", child, actor);
        await repository.update("work-session", session, actor);
        return this.result(session, run, null, child);
      },
    );
  }

  private connect<T extends BranchMutation & Connection>(
    schema: z.ZodType<T>,
    input: unknown,
    defaultActor: string,
    mode: "attach" | "resume" | "takeover",
  ) {
    return this.mutate(schema, input, defaultActor, async (repository, command, actor, at) => {
      const session = await this.branch(repository, command);
      const status = mode === "attach" ? "pending" : mode === "resume" ? "paused" : "open";
      invariant(
        session.status === status,
        "WORK_SESSION_STATE",
        `Для ${mode} ветка должна иметь состояние ${status}`,
        4,
      );
      let predecessor: string | null = null;
      if (mode === "takeover") {
        const old = await this.owner(repository, session, session.currentRunId ?? undefined);
        predecessor = old.id;
        await this.endRun(repository, session, old, "transferred", command.reason, actor, at);
      } else if (mode === "resume") {
        const runs = (await repository.runs())
          .filter((run) => run.sessionId === session.id)
          .sort((a, b) => b.startedSequence - a.startedSequence);
        const last = runs[0];
        invariant(
          last?.endReason === "paused",
          "INVALID_DATA",
          "Приостановленная ветка потеряла предыдущее участие",
          5,
        );
        predecessor = last.id;
      }
      let connection: Connection = command;
      if (mode === "attach" && command.operator === undefined && session.createdByRunId !== null) {
        const creator = await repository.get("agent-run", session.createdByRunId);
        connection = {
          ...command,
          operator: creator.operator === null ? null : { ...creator.operator, source: "inherited" },
        };
      }
      const run = await this.newRun(repository, session, connection, actor, at, predecessor);
      this.touch(session, at);
      await repository.update("work-session", session, actor);
      return this.result(session, run);
    });
  }

  attach(input: contract.WorkSessionAttach, defaultActor: string) {
    return this.connect(contract.workSessionAttachSchema, input, defaultActor, "attach");
  }
  resume(input: contract.WorkSessionResume, defaultActor: string) {
    return this.connect(contract.workSessionResumeSchema, input, defaultActor, "resume");
  }
  takeover(input: contract.WorkSessionTakeover, defaultActor: string) {
    return this.connect(contract.workSessionTakeoverSchema, input, defaultActor, "takeover");
  }

  pause(input: contract.WorkSessionPause, defaultActor: string) {
    return this.mutate(
      contract.workSessionPauseSchema,
      input,
      defaultActor,
      async (repository, command, actor, at) => {
        const session = await this.branch(repository, command);
        const run = await this.owner(repository, session, command.runId);
        await this.endRun(repository, session, run, "paused", command.reason, actor, at);
        session.status = "paused";
        this.touch(session, at);
        await repository.update("work-session", session, actor);
        return this.result(session, run);
      },
    );
  }

  private async children(
    repository: WorkHistoryRepository,
    sessionId: string,
    checkpoints: CheckpointCard[],
    intentId?: string,
    accepting: string[] = [],
  ) {
    const children = (await repository.sessions()).filter(
      (child) =>
        child.parentSessionId === sessionId &&
        (intentId === undefined || child.originCheckpointId === intentId),
    );
    invariant(
      !children.some(unfinished),
      "WORK_CHILDREN_OPEN",
      "Сначала явно завершите или отмените незакрытые дочерние ветки",
      4,
      { sessionIds: children.filter(unfinished).map((child) => child.id) },
    );
    const accepted = new Set([
      ...accepting,
      ...checkpoints
        .filter(
          (item) =>
            item.sessionId === sessionId && (intentId === undefined || item.intentId === intentId),
        )
        .flatMap((item) => item.acceptedSessionIds),
    ]);
    const unaccepted = children.filter(
      (child) => child.status === "completed" && !accepted.has(child.id),
    );
    invariant(
      !unaccepted.length,
      "WORK_CHILDREN_UNACCEPTED",
      "Готовый результат ребёнка ещё не принят; сохраните явное принятие в точке родителя",
      4,
      { sessionIds: unaccepted.map((child) => child.id) },
    );
  }

  private close<T extends BranchMutation & { runId?: string | undefined; result: string }>(
    schema: z.ZodType<T>,
    input: unknown,
    defaultActor: string,
    status: "completed" | "cancelled",
  ) {
    return this.mutate(schema, input, defaultActor, async (repository, command, actor, at) => {
      const session = await this.branch(repository, command);
      const run =
        status === "completed" || session.status === "open"
          ? await this.owner(repository, session, command.runId)
          : null;
      invariant(
        run !== null || command.runId === undefined,
        "WORK_RUN_NOT_CURRENT",
        "У pending/paused-ветки нет текущего участия",
        4,
      );
      const checkpoints = await repository.checkpoints();
      const closed = new Set(
        checkpoints
          .filter((item) => item.kind === "result" || item.kind === "cancel")
          .map((item) => item.intentId),
      );
      invariant(
        !checkpoints.some(
          (item) => item.sessionId === session.id && item.kind === "intent" && !closed.has(item.id),
        ),
        "WORK_INTENTS_OPEN",
        "Сначала явно завершите или отмените открытые намерения ветки",
        4,
      );
      await this.children(repository, session.id, checkpoints);
      if (run) await this.endRun(repository, session, run, status, command.result, actor, at);
      session.status = status;
      session.currentRunId = null;
      session.closedAt = at;
      session.result = command.result;
      session.sequence++;
      this.touch(session, at);
      await repository.update("work-session", session, actor);
      return this.result(session, run);
    });
  }

  complete(input: contract.WorkSessionComplete, defaultActor: string) {
    return this.close(contract.workSessionCompleteSchema, input, defaultActor, "completed");
  }
  cancel(input: contract.WorkSessionCancel, defaultActor: string) {
    return this.close(contract.workSessionCancelSchema, input, defaultActor, "cancelled");
  }

  private async content(
    repository: WorkHistoryRepository,
    command: z.output<typeof contract.workCheckpointOpenSchema>,
  ) {
    const references: contract.WorkHistoryReference[] = [];
    for (const ref of command.references) {
      const card = await resolveEntityCard(repository.storage, ref);
      invariant(
        card.revision > 0,
        "ENTITY_NOT_FOUND",
        "Нельзя ссылаться на ещё не созданную сущность",
        3,
      );
      references.push({ ref: card.ref, key: card.key, title: card.title });
    }
    return {
      title: command.title,
      summary: command.summary,
      body: command.body,
      done: command.done,
      remaining: command.remaining,
      nextStep: command.nextStep,
      checks: command.checks,
      references,
    };
  }

  openCheckpoint(input: contract.WorkCheckpointOpen, defaultActor: string) {
    return this.mutate(
      contract.workCheckpointOpenSchema,
      input,
      defaultActor,
      async (repository, command, actor, at) => {
        const session = await this.branch(repository, command);
        const run = await this.owner(repository, session, command.runId);
        const checkpoint: contract.WorkCheckpoint = {
          ...(await repository.identity("work-checkpoint")),
          ...(await this.content(repository, command)),
          sessionId: session.id,
          runId: run.id,
          sequence: ++session.sequence,
          kind: "intent",
          intentId: null,
          acceptedSessionIds: [],
          createdAt: at,
          createdBy: run.actor,
        };
        this.touch(session, at);
        await repository.put("work-checkpoint", checkpoint, actor);
        await repository.update("work-session", session, actor);
        return this.result(session, run, checkpoint);
      },
    );
  }

  private checkpointMutation(
    schema: z.ZodType<CheckpointInput>,
    input: unknown,
    defaultActor: string,
    kind: "progress" | "result" | "cancel",
  ) {
    return this.mutate(schema, input, defaultActor, async (repository, command, actor, at) => {
      const { checkpoint: intent, checkpoints } = await this.intent(repository, command.ref);
      const session = await this.branch(repository, command, intent.sessionId);
      const run = await this.owner(repository, session, command.runId);
      invariant(
        new Set(command.acceptedSessionIds).size === command.acceptedSessionIds.length,
        "WORK_ACCEPTANCE_DUPLICATE",
        "Один результат ребёнка нельзя указать дважды в одной точке",
        4,
      );
      for (const id of command.acceptedSessionIds) {
        const child = await repository.get("work-session", id);
        invariant(
          child.parentSessionId === session.id && child.originCheckpointId === intent.id,
          "WORK_CHILD_MISMATCH",
          "Принять можно только прямого ребёнка данного намерения",
          4,
        );
        invariant(
          child.status === "completed",
          "WORK_CHILD_NOT_COMPLETED",
          "Принимаются только результаты completed-веток",
          4,
        );
      }
      if (kind !== "progress")
        await this.children(
          repository,
          session.id,
          checkpoints,
          intent.id,
          command.acceptedSessionIds,
        );
      const checkpoint: contract.WorkCheckpoint = {
        ...(await repository.identity("work-checkpoint")),
        ...(await this.content(repository, command)),
        sessionId: session.id,
        runId: run.id,
        sequence: ++session.sequence,
        kind,
        intentId: intent.id,
        acceptedSessionIds: command.acceptedSessionIds,
        createdAt: at,
        createdBy: run.actor,
      };
      this.touch(session, at);
      await repository.put("work-checkpoint", checkpoint, actor);
      await repository.update("work-session", session, actor);
      return this.result(session, run, checkpoint);
    });
  }

  saveCheckpoint(input: contract.WorkCheckpointSave, defaultActor: string) {
    return this.checkpointMutation(
      contract.workCheckpointSaveSchema,
      input,
      defaultActor,
      "progress",
    );
  }
  completeCheckpoint(input: contract.WorkCheckpointComplete, defaultActor: string) {
    return this.checkpointMutation(
      contract.workCheckpointCompleteSchema,
      input,
      defaultActor,
      "result",
    );
  }
  cancelCheckpoint(input: contract.WorkCheckpointCancel, defaultActor: string) {
    return this.checkpointMutation(
      contract.workCheckpointCancelSchema,
      input,
      defaultActor,
      "cancel",
    );
  }
}
