import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { constants } from "node:fs";
import { copyFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contract from "@relay/contracts/work-history";
import { WorkHistoryService } from "../src/application/work-history/service.js";
import { WorkHistoryReader } from "../src/application/work-history/read.js";
import { validateWorkHistory } from "../src/application/work-history/validate.js";
import { WorkHistoryRepository } from "../src/storage/work-history.js";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { PlanningService } from "../src/application/planning/service.js";
import { validateWorkspace } from "../src/application/validate.js";
import { StorageService } from "../src/application/storage/service.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { failWal } from "./helpers/wal.js";

const markdown = "\n# Полный материал 🧪\r\n\n  Пробелы\t  \n```ts\nconst x = 1\n```\n\n";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-work-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  return { root, workspace, service: new WorkHistoryService(workspace) };
}
const owner = (state: contract.WorkHistoryMutation) => ({
  ref: state.session.id,
  ifRevision: state.session.revision,
  runId: state.run!.id,
  requestId: "operation",
});
const material = { title: "Материал", body: markdown };
const code = (code: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, code);
  return true;
};

test("История: root → child → grandchild; готовность ребёнка не принимает его результат", async (t) => {
  const { service, workspace } = await fixture(t);
  let root = await service.start(
    { title: "Корень", description: markdown, requestId: "root" },
    "lead",
  );
  assert.match(root.session.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(root.session.key, `S-${root.session.id}`);
  assert.equal(root.run?.key, `RUN-${root.run!.id}`);
  root = await service.openCheckpoint({ ...owner(root), ...material }, "lead");
  const rootIntent = root.checkpoint!;
  root = await service.fork({ ...owner(root), ref: rootIntent.key, title: "Ребёнок" }, "lead");
  assert.equal(root.childSession?.status, "pending");
  assert.equal(root.childSession?.currentRunId, null);
  assert.equal(root.childSession?.createdByRunId, root.run!.id);
  assert.equal(root.childSession?.parentSequence, root.session.sequence);
  assert.equal((await service.get({ ref: root.childSession!.id })).counts.runs, 0);
  await assert.rejects(
    service.completeCheckpoint({ ...owner(root), ref: rootIntent.key, ...material }, "lead"),
    code("WORK_CHILDREN_OPEN"),
  );
  let child = await service.attach(
    { ref: root.childSession!.key, ifRevision: 1, requestId: "attach", client: "subagent" },
    "child",
  );
  child = await service.openCheckpoint({ ...owner(child), ...material }, "child");
  const childIntent = child.checkpoint!;
  child = await service.fork({ ...owner(child), ref: childIntent.id, title: "Внук" }, "child");
  let grandchild = await service.attach(
    { ref: child.childSession!.id, ifRevision: 1, requestId: "attach" },
    "grandchild",
  );
  grandchild = await service.openCheckpoint({ ...owner(grandchild), ...material }, "grandchild");
  const tree = contract.workTreePageSchema.parse(
    await service.tree({ ref: root.session.id, limit: 2 }),
  );
  assert.equal(tree.total, 3);
  assert.equal(tree.nextOffset, 2);
  assert.deepEqual(tree.totals, {
    sessions: 3,
    unfinished: 3,
    runs: 3,
    checkpoints: 3,
    openIntents: 3,
  });
  const last = await service.tree({
    ref: root.session.id,
    offset: 2,
    limit: 2,
    version: tree.version,
  });
  assert.equal(last.items[0]!.depth, 2);
  assert.equal(last.items[0]!.parentSessionId, child.session.id);
  assert.equal(last.nextOffset, null);
  grandchild = await service.completeCheckpoint(
    { ...owner(grandchild), ref: grandchild.checkpoint!.id, ...material },
    "grandchild",
  );
  grandchild = await service.complete({ ...owner(grandchild), result: markdown }, "grandchild");
  await assert.rejects(
    service.completeCheckpoint({ ...owner(child), ref: childIntent.key, ...material }, "child"),
    code("WORK_CHILDREN_UNACCEPTED"),
  );
  await assert.rejects(
    service.cancelCheckpoint({ ...owner(child), ref: childIntent.key, ...material }, "child"),
    code("WORK_CHILDREN_UNACCEPTED"),
  );
  await assert.rejects(
    service.saveCheckpoint(
      {
        ...owner(root),
        ref: rootIntent.id,
        ...material,
        acceptedSessionIds: [grandchild.session.id],
      },
      "lead",
    ),
    code("WORK_CHILD_MISMATCH"),
  );
  child = await service.saveCheckpoint(
    {
      ...owner(child),
      ref: childIntent.id,
      ...material,
      acceptedSessionIds: [grandchild.session.id],
    },
    "child",
  );
  assert.equal((await service.get({ ref: child.session.id })).counts.openIntents, 1);
  child = await service.completeCheckpoint(
    { ...owner(child), ref: childIntent.id, ...material },
    "child",
  );
  child = await service.complete({ ...owner(child), result: "Проверено" }, "child");
  await assert.rejects(
    service.completeCheckpoint({ ...owner(root), ref: rootIntent.id, ...material }, "lead"),
    code("WORK_CHILDREN_UNACCEPTED"),
  );
  root = await service.completeCheckpoint(
    { ...owner(root), ref: rootIntent.id, ...material, acceptedSessionIds: [child.session.id] },
    "lead",
  );
  root = await service.complete({ ...owner(root), result: markdown }, "lead");
  assert.equal(root.run!.endReason, "completed");
  assert.equal(root.session.currentRunId, null);
  assert.equal((await service.tree({ ref: root.session.key })).totals.unfinished, 0);
  assert.deepEqual(await service.checkpoint({ ref: rootIntent.id }), rootIntent);
  await assert.rejects(
    service.openCheckpoint({ ...owner(root), ...material }, "lead"),
    code("WORK_SESSION_CLOSED"),
  );
  await assert.rejects(
    service.cancel({ ...owner(root), result: "Отмена" }, "lead"),
    code("WORK_SESSION_CLOSED"),
  );
  await assert.rejects(
    service.tree({ ref: root.session.id, version: tree.version }),
    code("VERSION_CONFLICT"),
  );
  assert.equal((await validateWorkspace(workspace)).valid, true);
});

test("Передача: гонка CAS, запрет старому run с новой ревизией, reason/endSummary и пауза", async (t) => {
  const { service, root } = await fixture(t);
  let state = await service.start(
    { title: "Передача", requestId: "start", reason: markdown },
    "first",
  );
  const firstRun = state.run!;
  state = await service.openCheckpoint({ ...owner(state), ...material }, "first");
  const intent = state.checkpoint!;
  const other = new WorkHistoryService(await openWorkspace(root));
  const contenders = await Promise.allSettled([
    service.takeover(
      {
        ref: state.session.id,
        ifRevision: state.session.revision,
        requestId: "takeover",
        reason: "Передача",
      },
      "second",
    ),
    other.takeover(
      {
        ref: state.session.id,
        ifRevision: state.session.revision,
        requestId: "other",
        reason: "Другое подключение",
      },
      "third",
    ),
  ]);
  assert.equal(contenders.filter((item) => item.status === "fulfilled").length, 1);
  const failed = contenders.find((item) => item.status === "rejected") as PromiseRejectedResult;
  assert.equal(failed.reason.code, "REVISION_CONFLICT");
  state = (
    contenders.find(
      (item) => item.status === "fulfilled",
    ) as PromiseFulfilledResult<contract.WorkHistoryMutation>
  ).value;
  await assert.rejects(
    service.saveCheckpoint(
      { ...owner(state), runId: firstRun.id, ref: intent.id, ...material },
      "first",
    ),
    code("WORK_RUN_NOT_CURRENT"),
  );
  await assert.rejects(
    service.pause({ ...owner(state), runId: state.run!.key, reason: "Пауза" }, "second"),
    code("WORK_RUN_NOT_CURRENT"),
  );
  const ended = (await service.history({ ref: state.session.id, kind: "run-ended" })).items[0]!;
  assert(ended.kind === "run-ended");
  assert.equal(ended.run.reason, markdown);
  assert.equal(ended.run.endReason, "transferred");
  assert.equal(ended.run.endSummary, state.run!.reason);
  assert.equal(state.run!.predecessorRunId, firstRun.id);
  const transferred = state.run!;
  state = await service.pause({ ...owner(state), reason: markdown }, "second");
  assert.equal(state.session.status, "paused");
  assert.equal(state.run!.reason, transferred.reason);
  assert.equal(state.run!.endSummary, markdown);
  assert.equal((await service.get({ ref: state.session.id })).counts.openIntents, 1);
  await assert.rejects(
    service.attach(
      { ref: state.session.id, ifRevision: state.session.revision, requestId: "wrong" },
      "second",
    ),
    code("WORK_SESSION_STATE"),
  );
  state = await service.resume(
    {
      ref: state.session.id,
      ifRevision: state.session.revision,
      requestId: "resume",
      reason: markdown,
    },
    "resumed",
  );
  assert.equal(state.run!.predecessorRunId, transferred.id);
  state = await service.cancelCheckpoint(
    { ...owner(state), ref: intent.id, ...material },
    "resumed",
  );
  assert.equal(state.checkpoint!.createdBy, "resumed");
  assert.equal(state.checkpoint!.kind, "cancel");
  await assert.rejects(
    service.completeCheckpoint({ ...owner(state), ref: intent.id, ...material }, "resumed"),
    code("WORK_INTENT_CLOSED"),
  );
  state = await service.cancel({ ...owner(state), result: markdown }, "resumed");
  assert.equal(state.session.status, "cancelled");
  assert.equal(state.run!.endReason, "cancelled");
});

test("Точный Markdown, сохранённые подписи ссылок и отсутствие изменения task/plan", async (t) => {
  const { workspace, service, root } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Прежнее имя", summary: "", description: "Требование" },
    },
    "author",
  );
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA", title: "Задача" } },
    "author",
  );
  const planning = new PlanningService(workspace);
  const plan = await planning.create(
    { requestId: "plan", title: "План", summary: "", goal: "Цель" },
    "author",
  );
  const files = [
    join(workspace.dataRoot, "entities/tasks", `${task.ref.id}.json`),
    join(workspace.dataRoot, "entities/work-plans", `${plan.id}.json`),
  ];
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
  let state = await service.start(
    { requestId: "start", title: "Содержание", description: markdown, reason: markdown },
    "author",
  );
  state = await service.openCheckpoint(
    {
      ...owner(state),
      ...material,
      summary: "  Кратко\r\n",
      done: markdown,
      remaining: markdown,
      nextStep: markdown,
      checks: markdown,
      references: [feature.key, task.key],
    },
    "author",
  );
  const intent = state.checkpoint!;
  const priorRevision = state.session.revision;
  await assert.rejects(
    service.saveCheckpoint(
      { ...owner(state), ref: intent.id, ...material, references: ["FEATURE-999"] },
      "author",
    ),
    code("ENTITY_NOT_FOUND"),
  );
  assert.equal((await service.get({ ref: state.session.id })).session.revision, priorRevision);
  await engine.update(
    {
      ref: feature.key,
      ifRevision: 1,
      requestId: "rename",
      changes: { kind: "feature", name: "Новое имя" },
    },
    "author",
  );
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ kind: "feature", ref: feature.key });
  await deletion.delete(
    { kind: "feature", ref: feature.key, requestId: "delete", ifVersion: preview.version },
    "author",
  );
  const reopened = new WorkHistoryService(await openWorkspace(root));
  const saved = contract.workCheckpointSchema.parse(
    await reopened.checkpoint({ ref: `work-checkpoint:${intent.id}` }),
  );
  assert.deepEqual(saved, intent);
  assert.equal(saved.references[0]!.title, "Прежнее имя");
  for (const field of ["body", "done", "remaining", "nextStep", "checks"] as const)
    assert.equal(saved[field], markdown);
  assert.equal(
    (await reopened.get({ ref: `work-session:${state.session.id}` })).session.description,
    markdown,
  );
  state = await reopened.completeCheckpoint(
    { ...owner(state), ref: intent.key, ...material },
    "author",
  );
  state = await reopened.complete({ ...owner(state), result: markdown }, "author");
  assert.equal((await reopened.get({ ref: state.session.key })).session.result, markdown);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);
  const disk = JSON.parse(
    await readFile(
      join(workspace.dataRoot, "entities/work-checkpoints", `${intent.id}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(disk.data.body, markdown.split("\n"));
  assert.equal(disk.key, null);
});

test("Ссылки, ревизии, явная отмена, обязательное содержание и отсутствие скрытого каскада", async (t) => {
  const { service, workspace } = await fixture(t);
  let first = await service.start({ title: "Первый", requestId: "start" }, "first");
  let second = await service.start({ title: "Второй", requestId: "start" }, "second");
  first = await service.openCheckpoint({ ...owner(first), ...material }, "first");
  const intent = first.checkpoint!;
  second = await service.openCheckpoint({ ...owner(second), ...material }, "second");
  await assert.rejects(
    service.saveCheckpoint({ ...owner(second), ref: intent.id, ...material }, "second"),
    code("WORK_RUN_NOT_CURRENT"),
  );
  await assert.rejects(
    service.openCheckpoint({ ...owner(first), ifRevision: 1, ...material }, "first"),
    code("REVISION_CONFLICT"),
  );
  await assert.rejects(service.checkpoint({ ref: first.session.key }), code("ENTITY_NOT_FOUND"));
  await assert.rejects(
    service.get({ ref: `work-checkpoint:${intent.id}` }),
    code("ENTITY_KIND_MISMATCH"),
  );
  await assert.rejects(
    service.openCheckpoint({ ...owner(first), title: "Пусто", body: "\n \t" }, "first"),
    code("VALIDATION_ERROR"),
  );
  await assert.rejects(
    service.complete({ ...owner(first), result: markdown }, "first"),
    code("WORK_INTENTS_OPEN"),
  );
  first = await service.fork({ ...owner(first), ref: intent.id, title: "Отменить явно" }, "first");
  const child = first.childSession!;
  await assert.rejects(
    service.saveCheckpoint(
      { ...owner(first), ref: intent.id, ...material, acceptedSessionIds: [child.id] },
      "first",
    ),
    code("WORK_CHILD_NOT_COMPLETED"),
  );
  await assert.rejects(
    service.cancelCheckpoint({ ...owner(first), ref: intent.id, ...material }, "first"),
    code("WORK_CHILDREN_OPEN"),
  );
  const cancelled = await service.cancel(
    { ref: child.id, ifRevision: 1, requestId: "cancel", result: "Агент не запущен" },
    "first",
  );
  assert.equal(cancelled.run, null);
  assert.equal((await service.get({ ref: child.id })).counts.runs, 0);
  first = await service.cancelCheckpoint({ ...owner(first), ref: intent.id, ...material }, "first");
  first = await service.pause({ ...owner(first), reason: "Остановить" }, "first");
  const cancelledParent = await service.cancel(
    {
      ref: first.session.id,
      ifRevision: first.session.revision,
      requestId: "cancel",
      result: markdown,
    },
    "first",
  );
  assert.equal(cancelledParent.run, null);
  assert.equal(cancelledParent.session.status, "cancelled");
  assert.equal((await service.get({ ref: second.session.id })).session.status, "open");
  assert.equal((await validateWorkspace(workspace)).valid, true);
});

test("Страницы, полные totals, фильтры/project/order guard и стабильная производная хронология", async (t) => {
  const { service } = await fixture(t);
  let state = await service.start(
    { title: "Корень", description: "Искомое поручение", requestId: "root" },
    "one",
  );
  state = await service.openCheckpoint({ ...owner(state), ...material }, "one");
  const intent = state.checkpoint!;
  state = await service.fork({ ...owner(state), ref: intent.id, title: "Потомок" }, "one");
  const child = state.childSession!;
  const oldEvents = await service.history({ ref: state.session.id, order: "asc" });
  const fork = oldEvents.items.find((item) => item.kind === "session-forked")!;
  const started = oldEvents.items.find((item) => item.kind === "run-started")!;
  state = await service.saveCheckpoint({ ...owner(state), ref: intent.id, ...material }, "one");
  await service.attach({ ref: child.id, ifRevision: 1, requestId: "attach" }, "two");
  const history = contract.workHistoryPageSchema.parse(
    await service.history({ ref: state.session.id, includeChildren: true, order: "asc", limit: 2 }),
  );
  assert.equal(history.total, 7);
  const all = [...history.items];
  let next = history.nextOffset;
  while (next !== null) {
    const page = await service.history({
      ref: state.session.id,
      includeChildren: true,
      order: "asc",
      limit: 2,
      offset: next,
      version: history.version,
    });
    assert.equal(page.total, 7);
    all.push(...page.items);
    next = page.nextOffset;
  }
  assert.equal(new Set(all.map((item) => item.id)).size, 7);
  const currentFork = all.find((item) => item.kind === "session-forked")!;
  assert.deepEqual(
    [currentFork.id, currentFork.sequence, currentFork.at],
    [fork.id, fork.sequence, fork.at],
  );
  const currentStart = all.find((item) => item.id === started.id)!;
  assert.deepEqual([currentStart.sequence, currentStart.at], [started.sequence, started.at]);
  const desc = await service.history({
    ref: state.session.id,
    includeChildren: true,
    order: "desc",
    limit: 100,
  });
  assert.deepEqual(
    desc.items.map((item) => item.id),
    all.map((item) => item.id).reverse(),
  );
  await assert.rejects(
    service.history({
      ref: state.session.id,
      includeChildren: true,
      order: "desc",
      version: history.version,
    }),
    code("VERSION_CONFLICT"),
  );
  await assert.rejects(
    service.history({
      ref: state.session.id,
      includeChildren: false,
      order: "asc",
      version: history.version,
    }),
    code("VERSION_CONFLICT"),
  );
  const context = contract.workContextSchema.parse(
    await service.context({ ref: state.session.id, limit: 1 }),
  );
  assert.equal(context.history.total, 5);
  assert.equal(context.history.nextOffset, 1);
  assert.deepEqual(context.counts, {
    runs: 1,
    checkpoints: 2,
    openIntents: 1,
    children: 1,
    unfinishedChildren: 1,
  });
  assert.equal(
    (
      await service.context({
        ref: state.session.id,
        offset: 1,
        limit: 1,
        version: context.history.version,
      })
    ).history.items.length,
    1,
  );
  const list = contract.workSessionsPageSchema.parse(await service.list({ limit: 1 }));
  assert.equal(list.total, 2);
  assert.equal(list.nextOffset, 1);
  assert.equal((await service.list({ q: "Искомое" })).items[0]!.id, state.session.id);
  assert.equal(
    (
      await service.list({
        parent: state.session.key,
        actor: "two",
        status: "open",
        unfinished: true,
      })
    ).total,
    1,
  );
  assert.equal((await service.list({ unfinished: false })).total, 0);
  await assert.rejects(
    service.list({ parent: null, version: list.version }),
    code("VERSION_CONFLICT"),
  );
  const other = await fixture(t);
  await assert.rejects(other.service.list({ version: list.version }), code("VERSION_CONFLICT"));
  state = await service.saveCheckpoint({ ...owner(state), ref: intent.id, ...material }, "one");
  await assert.rejects(
    service.list({ offset: 1, version: list.version }),
    code("VERSION_CONFLICT"),
  );
  await assert.rejects(
    service.context({ ref: state.session.id, offset: 1, version: context.history.version }),
    code("VERSION_CONFLICT"),
  );
});

test("Чтения индексов не открывают чужие Markdown, context читает только страницу", async (t) => {
  const { service } = await fixture(t);
  let state = await service.start({ title: "Чтение", requestId: "start" }, "agent");
  state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
  const intent = state.checkpoint!;
  for (let i = 0; i < 5; i++)
    state = await service.saveCheckpoint({ ...owner(state), ref: intent.id, ...material }, "agent");
  const get = t.mock.method(StorageSession.prototype, "get");
  await service.list({ limit: 1 });
  await service.tree({ ref: state.session.id, limit: 1 });
  assert.equal(get.mock.callCount(), 0);
  await service.history({ ref: state.session.id, kind: "checkpoint", limit: 1 });
  assert.equal(get.mock.callCount(), 1);
  assert.equal(get.mock.calls[0]!.arguments[0].kind, "work-checkpoint");
  get.mock.resetCalls();
  await service.context({ ref: state.session.id, limit: 1 });
  assert.deepEqual(get.mock.calls.map((call) => call.arguments[0].kind).sort(), [
    "agent-run",
    "work-checkpoint",
    "work-session",
  ]);
});

test("WAL: сбой между записями, recovery и потеря ответа без повторной мутации", async (t) => {
  const { root, service, workspace } = await fixture(t);
  const start = {
    title: "Сохранено несмотря на потерю ответа",
    requestId: "same-request",
    reason: markdown,
  };
  failWal(t, (stage, path) => {
    if (stage === "file" && path?.startsWith("entities/")) throw new Error("Сбой публикации");
  });
  await assert.rejects(service.start(start, "agent"), /Сбой публикации/);
  t.mock.restoreAll();
  const reopened = new WorkHistoryService(await openWorkspace(root));
  const list = await reopened.list({});
  assert.equal(list.total, 1);
  const detail = await reopened.get({ ref: list.items[0]!.id });
  assert.equal(detail.currentRun!.reason, markdown);
  assert.equal(detail.counts.runs, 1);
  assert.deepEqual(await readdir(join(workspace.dataRoot, "transactions")), [".gitignore"]);
  const repeated = await reopened.start(start, "agent");
  assert.notEqual(repeated.session.key, detail.session.key);
  assert.notEqual(repeated.run!.key, detail.currentRun!.key);
  assert.notEqual(repeated.session.id, detail.session.id);
  const publish = t.mock.method(StorageTransaction.prototype, "publish");
  await reopened.get({ ref: repeated.session.id });
  assert.equal(publish.mock.callCount(), 0);
});

test("Обход дерева глубже стека вызовов — итеративный, без ограничения глубины", async () => {
  const repository = {
    sessions: async () =>
      Array.from({ length: 20_000 }, (_, index) => ({
        id: `node-${index}`,
        key: `S-${index + 1}`,
        title: "Ветка",
        parentSessionId: index ? `node-${index - 1}` : null,
        originCheckpointId: index ? `intent-${index - 1}` : null,
        createdByRunId: null,
        parentSequence: index ? 3 : null,
        status: "pending" as const,
        currentRunId: null,
        sequence: 1,
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
        closedAt: null,
        revision: 1,
      })),
    runs: async () => [],
    checkpoints: async () => [],
  } as unknown as WorkHistoryRepository;
  const reader = await WorkHistoryReader.open(repository, "deep-project");
  const nodes = reader.nodes("node-0");
  assert.equal(nodes.length, 20_000);
  assert.equal(nodes.at(-1)!.depth, 19_999);
});

test("Атрибуция человека: snapshot подключения, наследование creator, takeover и unknown resume", async (t) => {
  const { service } = await fixture(t);
  const alice = { name: "Алиса", email: "alice@example.test", source: "explicit" as const };
  const bob = { name: "Борис", email: "bob@example.test", source: "git" as const };
  const git = { branch: "feature/alice", commit: "a".repeat(40) };
  let parent = await service.start(
    { title: "Человек и агент", requestId: "start", operator: alice, git },
    "agent-a",
  );
  assert.deepEqual(parent.run!.operator, alice);
  assert.deepEqual(parent.run!.git, git);
  const creator = parent.run!.id;
  parent = await service.openCheckpoint({ ...owner(parent), ...material }, "agent-a");
  const intent = parent.checkpoint!.id;
  parent = await service.fork({ ...owner(parent), ref: intent, title: "Наследование" }, "agent-a");
  const inheritedId = parent.childSession!.id;
  parent = await service.fork(
    { ...owner(parent), ref: intent, title: "Явно неизвестен" },
    "agent-a",
  );
  const unknownId = parent.childSession!.id;
  parent = await service.takeover(
    {
      ref: parent.session.id,
      ifRevision: parent.session.revision,
      requestId: "takeover",
      reason: "Передача",
      operator: bob,
      git: { branch: "feature/bob", commit: null },
    },
    "agent-b",
  );
  const inherited = await service.attach(
    { ref: inheritedId, ifRevision: 1, requestId: "attach" },
    "child-agent",
  );
  assert.deepEqual(inherited.run!.operator, { ...alice, source: "inherited" });
  assert.equal(inherited.run!.git, null);
  assert.equal(inherited.session.createdByRunId, creator);
  const unknown = await service.attach(
    { ref: unknownId, ifRevision: 1, requestId: "attach", operator: null },
    "child-agent",
  );
  assert.equal(unknown.run!.operator, null);
  const original = (await service.history({ ref: parent.session.id, kind: "run-ended" })).items[0]!;
  assert(original.kind === "run-ended");
  assert.deepEqual(original.run.operator, alice);
  assert.deepEqual(original.run.git, git);
  parent = await service.pause({ ...owner(parent), reason: "Пауза" }, "agent-b");
  const resumed = await service.resume(
    { ref: parent.session.id, ifRevision: parent.session.revision, requestId: "resume" },
    "agent-c",
  );
  assert.equal(resumed.run!.operator, null);
  assert.equal(resumed.run!.git, null);
});

test("Независимые копии: случайные адреса, объединение файлов, явный reindex и doctor без потерь", async (t) => {
  const { workspace, root, service } = await fixture(t);
  const copy = await mkdtemp(join(tmpdir(), "relay-work-history-copy-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(join(root, ".relay"), join(copy, ".relay"), { recursive: true });
  const otherWorkspace = await openWorkspace(copy);
  const other = new WorkHistoryService(otherWorkspace);
  const initial = { title: "Одинаковое поручение", description: markdown, requestId: "same" };
  let left = await service.start(initial, "agent");
  let right = await other.start(initial, "agent");
  left = await service.openCheckpoint({ ...owner(left), ...material }, "agent");
  right = await other.openCheckpoint({ ...owner(right), ...material }, "agent");
  for (const [a, b] of [
    [left.session, right.session],
    [left.run!, right.run!],
    [left.checkpoint!, right.checkpoint!],
  ]) {
    assert.match(a!.id, /^[A-Za-z0-9]{8}$/);
    assert.match(b!.id, /^[A-Za-z0-9]{8}$/);
    assert.notEqual(a!.id, b!.id);
    assert.notEqual(a!.key, b!.key);
  }
  for (const collection of ["work-sessions", "agent-runs", "work-checkpoints"]) {
    for (const file of await readdir(join(otherWorkspace.dataRoot, "entities", collection))) {
      await copyFile(
        join(otherWorkspace.dataRoot, "entities", collection, file),
        join(workspace.dataRoot, "entities", collection, file),
        constants.COPYFILE_EXCL,
      );
    }
  }
  await new StorageService(workspace).reindex();
  assert.equal((await validateWorkspace(workspace)).valid, true);
  const merged = new WorkHistoryService(await openWorkspace(root));
  assert.equal((await merged.list({})).total, 2);
  assert.equal((await merged.history({ kind: "checkpoint" })).total, 2);
  for (const state of [left, right]) {
    assert.deepEqual(await merged.checkpoint({ ref: state.checkpoint!.key }), state.checkpoint);
    assert.deepEqual((await merged.get({ ref: state.session.key })).session, state.session);
  }
});

test("Прежние длинные адреса истории сохраняются рядом с новыми короткими ID", async (t) => {
  const { workspace, root, service } = await fixture(t);
  let sequence = 0;
  const legacyIdentity = t.mock.method(
    WorkHistoryRepository.prototype,
    "identity",
    async (kind: Parameters<WorkHistoryRepository["identity"]>[0]) => {
      const id = (++sequence).toString(16).padStart(32, "0");
      const prefix = kind === "work-session" ? "S" : kind === "agent-run" ? "RUN" : "CP";
      return { id, key: `${prefix}-${id}` };
    },
  );
  let state = await service.start(
    { title: "Прежняя ветка", description: markdown, requestId: "legacy" },
    "first",
  );
  state = await service.openCheckpoint({ ...owner(state), ...material }, "first");
  legacyIdentity.mock.restore();
  const oldSession = state.session;
  const oldRun = state.run!;
  const oldIntent = state.checkpoint!;
  const oldPath = join(workspace.dataRoot, "entities/work-checkpoints", `${oldIntent.id}.json`);
  const oldBytes = await readFile(oldPath, "utf8");

  state = await service.takeover(
    {
      ref: oldSession.key,
      ifRevision: oldSession.revision,
      reason: "Продолжить",
      requestId: "new",
    },
    "second",
  );
  assert.match(state.run!.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(state.run!.predecessorRunId, oldRun.id);
  assert.equal(state.run!.sessionId, oldSession.id);
  state = await service.fork(
    { ...owner(state), ref: oldIntent.key, title: "Новый ребёнок" },
    "second",
  );
  assert.match(state.childSession!.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(state.childSession!.parentSessionId, oldSession.id);
  assert.equal(state.childSession!.originCheckpointId, oldIntent.id);
  assert.equal(state.childSession!.createdByRunId, state.run!.id);
  state = await service.saveCheckpoint(
    { ...owner(state), ref: oldIntent.id, ...material },
    "second",
  );
  assert.match(state.checkpoint!.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(state.checkpoint!.intentId, oldIntent.id);
  assert.equal(state.checkpoint!.sessionId, oldSession.id);
  assert.equal(state.checkpoint!.runId, state.run!.id);

  await new StorageService(workspace).reindex();
  const reopened = new WorkHistoryService(await openWorkspace(root));
  assert.deepEqual(await reopened.checkpoint({ ref: oldIntent.key }), oldIntent);
  assert.deepEqual(await reopened.checkpoint({ ref: state.checkpoint!.key }), state.checkpoint);
  assert.deepEqual((await reopened.get({ ref: oldSession.id })).session, state.session);
  assert.equal(state.session.id, oldSession.id);
  assert.equal(state.session.key, oldSession.key);
  assert.equal(await readFile(oldPath, "utf8"), oldBytes);
  assert.equal((await validateWorkspace(workspace)).valid, true);
});

test("Короткий адрес истории обходит занятый ID и ключ; число попыток ограничено", async (t) => {
  const { workspace } = await fixture(t);
  await workspace.locked(async () => {
    const storage = workspace.storageSession!;
    const repository = new WorkHistoryRepository(storage);
    const indexGet = storage.indexGet.bind(storage);
    for (const [kind, index, prefix] of [
      ["work-session", "records", "S"],
      ["agent-run", "work-history-runs", "RUN"],
      ["work-checkpoint", "work-history-addresses", "CP"],
    ] as const) {
      let rejected: string | undefined;
      const occupied = t.mock.method(storage, "indexGet", async (name: string, key: string) => {
        if (name === index && rejected === undefined) {
          rejected = key;
          return true;
        }
        return indexGet(name, key);
      });
      const identity = await repository.identity(kind);
      occupied.mock.restore();
      assert.match(identity.id, /^[A-Za-z0-9]{8}$/);
      assert.equal(identity.key, `${prefix}-${identity.id}`);
      assert.ok(rejected);
      assert.ok(
        ![identity.id, `${kind}:${identity.id}`, `${kind}:${identity.key}`].includes(rejected),
      );
    }
    const exhausted = t.mock.method(storage, "indexGet", async () => true);
    await assert.rejects(repository.identity("work-session"), code("WORK_HISTORY_KEY_CONFLICT"));
    assert.equal(exhausted.mock.callCount(), 100);
    exhausted.mock.restore();
  });
});

test("Отказ до WAL не оставляет ребёнка; потерянный индекс не выдаётся за пустую историю", async (t) => {
  const { workspace, service } = await fixture(t);
  let state = await service.start({ title: "Атомарность", requestId: "start" }, "agent");
  state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
  const intent = state.checkpoint!;
  const put = StorageSession.prototype.put;
  const interception = t.mock.method(
    StorageSession.prototype,
    "put",
    async function (this: StorageSession, ...args: Parameters<typeof put>) {
      if (args[0].kind === "work-session" && args[0].id === state.session.id)
        throw new Error("Отказ родительской записи");
      return put.apply(this, args);
    },
  );
  await assert.rejects(
    service.fork({ ...owner(state), ref: intent.id, title: "Не опубликован" }, "agent"),
    /Отказ родительской записи/,
  );
  interception.mock.restore();
  assert.equal((await service.tree({ ref: state.session.id })).total, 1);
  assert.equal(
    (await service.get({ ref: state.session.id })).session.revision,
    state.session.revision,
  );
  assert.equal((await readdir(join(workspace.dataRoot, "entities/work-sessions"))).length, 1);
  const path = join(workspace.dataRoot, ".indexes/state.json");
  const index = JSON.parse(await readFile(path, "utf8"));
  delete index.roots["work-history-checkpoints"];
  await writeFile(path, JSON.stringify(index));
  await assert.rejects(service.get({ ref: state.session.id }), code("STORAGE_INDEX_CORRUPT"));
});

test("Открытые намерения: старые материалы не теряются за закрытыми; обзор и projectTotals индексные", async (t) => {
  const { service } = await fixture(t);
  let state = await service.start({ title: "Много намерений", requestId: "start" }, "agent");
  const old: contract.WorkCheckpoint[] = [];
  for (let index = 0; index < 3; index++) {
    state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
    old.push(state.checkpoint!);
  }
  state = await service.fork({ ...owner(state), ref: old[0]!.id, title: "Ребёнок" }, "agent");
  let child = await service.attach(
    { ref: state.childSession!.id, ifRevision: 1, requestId: "attach" },
    "child",
  );
  child = await service.openCheckpoint({ ...owner(child), ...material }, "child");
  for (let index = 0; index < 30; index++) {
    state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
    state = await service.completeCheckpoint(
      { ...owner(state), ref: state.checkpoint!.id, ...material },
      "agent",
    );
  }
  const get = t.mock.method(StorageSession.prototype, "get");
  const filtered = contract.workSessionsPageSchema.parse(
    await service.list({ parent: null, limit: 1 }),
  );
  assert.equal(get.mock.callCount(), 0);
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.projectTotals, {
    sessions: 2,
    unfinished: 2,
    runs: 2,
    checkpoints: 64,
    openIntents: 4,
  });
  assert.equal(filtered.items[0]!.counts.openIntents, 3);
  assert.equal(filtered.items[0]!.latestRun!.id, state.run!.id);
  assert.equal(filtered.items[0]!.acceptance, null);
  const first = contract.workOpenIntentsPageSchema.parse(
    await service.openIntents({ ref: state.session.key, limit: 2 }),
  );
  assert.equal(get.mock.callCount(), 2);
  assert.equal(first.total, 3);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(
    first.items.map((item) => item.id),
    old.slice(0, 2).map((item) => item.id),
  );
  const second = await service.openIntents({
    ref: state.session.id,
    offset: 2,
    limit: 2,
    version: first.version,
  });
  assert.deepEqual(second.items, [old[2]]);
  assert.equal(second.nextOffset, null);
  const nested = await service.openIntents({ ref: state.session.id, includeChildren: true });
  assert.equal(nested.total, 4);
  assert(nested.items.some((item) => item.id === child.checkpoint!.id));
  await assert.rejects(
    service.openIntents({ ref: state.session.id, includeChildren: true, version: first.version }),
    code("VERSION_CONFLICT"),
  );
  get.mock.restore();
  state = await service.cancelCheckpoint(
    { ...owner(state), ref: old[2]!.id, ...material },
    "agent",
  );
  await assert.rejects(
    service.openIntents({ ref: state.session.id, offset: 2, version: first.version }),
    code("VERSION_CONFLICT"),
  );
  state = await service.pause({ ...owner(state), reason: "Пауза" }, "agent");
  const detail = contract.workSessionDetailSchema.parse(
    await service.get({ ref: state.session.id }),
  );
  assert.equal(detail.currentRun, null);
  assert.equal(detail.latestRun!.endReason, "paused");
  assert.equal("reason" in detail.latestRun!, false);
  assert.equal("endSummary" in detail.latestRun!, false);
});

test("Первое принятие видно у завершённого ребёнка без изменения его записи и читается индексно", async (t) => {
  const { service, workspace } = await fixture(t);
  let parent = await service.start({ title: "Родитель", requestId: "start" }, "lead");
  parent = await service.openCheckpoint({ ...owner(parent), ...material }, "lead");
  const intent = parent.checkpoint!;
  parent = await service.fork({ ...owner(parent), ref: intent.id, title: "Ребёнок" }, "lead");
  let child = await service.attach(
    { ref: parent.childSession!.id, ifRevision: 1, requestId: "attach" },
    "child",
  );
  child = await service.complete({ ...owner(child), result: markdown }, "child");
  const path = join(workspace.dataRoot, "entities/work-sessions", `${child.session.id}.json`);
  const before = await readFile(path, "utf8");
  const context = await service.context({ ref: child.session.id, limit: 1 });
  assert.equal(context.acceptance, null);
  assert.equal(context.latestRun!.endReason, "completed");
  parent = await service.saveCheckpoint(
    { ...owner(parent), ref: intent.id, ...material, acceptedSessionIds: [child.session.id] },
    "lead",
  );
  const accepting = parent.checkpoint!;
  parent = await service.completeCheckpoint(
    { ...owner(parent), ref: intent.id, ...material, acceptedSessionIds: [child.session.id] },
    "lead",
  );
  const get = t.mock.method(StorageSession.prototype, "get");
  const overview = (await service.list({ status: "completed" })).items[0]!;
  const tree = await service.tree({ ref: child.session.id });
  assert.equal(get.mock.callCount(), 0);
  assert.deepEqual(overview.acceptance, {
    checkpointId: accepting.id,
    checkpointKey: accepting.key,
    sessionId: parent.session.id,
    runId: parent.run!.id,
    at: accepting.createdAt,
  });
  assert.deepEqual(tree.items[0]!.session.acceptance, overview.acceptance);
  assert.equal(overview.counts.runs, 1);
  assert.equal(overview.latestRun!.id, child.run!.id);
  assert.deepEqual((await service.get({ ref: child.session.id })).acceptance, overview.acceptance);
  await assert.rejects(
    service.context({ ref: child.session.id, offset: 1, version: context.history.version }),
    code("VERSION_CONFLICT"),
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("Doctor: merge двух неизменяемых result выявляет смысловой конфликт и не меняет файлы", async (t) => {
  const { service, workspace } = await fixture(t);
  let state = await service.start({ title: "Расхождение", requestId: "start" }, "agent");
  state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
  state = await service.completeCheckpoint(
    { ...owner(state), ref: state.checkpoint!.id, ...material },
    "agent",
  );
  const directory = join(workspace.dataRoot, "entities/work-checkpoints");
  const original = JSON.parse(
    await readFile(join(directory, `${state.checkpoint!.id}.json`), "utf8"),
  );
  const divergent = structuredClone(original);
  divergent.id = "independent-copy-result";
  divergent.data.id = divergent.id;
  divergent.data.key = `CP-${divergent.id}`;
  divergent.data.body = ["Результат другой независимой копии"];
  await writeFile(join(directory, `${divergent.id}.json`), JSON.stringify(divergent));
  await new StorageService(workspace).reindex();
  const paths = [
    join(workspace.dataRoot, ".indexes/state.json"),
    ...(await Promise.all(
      ["work-sessions", "agent-runs", "work-checkpoints"].map(async (collection) =>
        (await readdir(join(workspace.dataRoot, "entities", collection))).map((file) =>
          join(workspace.dataRoot, "entities", collection, file),
        ),
      ),
    ).then((groups) => groups.flat())),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  await assert.rejects(validateWorkspace(workspace), (error: unknown) => {
    const failure = error as {
      code: string;
      details: { code: string; details: { reason?: string }; checks: string[] }[];
    };
    assert.equal(failure.code, "VALIDATION_FAILED");
    assert(
      failure.details.some(
        (item) =>
          item.code === "WORK_HISTORY_INVALID" &&
          item.details.reason === "duplicate-terminal" &&
          item.checks.includes("work-history"),
      ),
    );
    return true;
  });
  await assert.rejects(validateWorkHistory(workspace), code("WORK_HISTORY_INVALID"));
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
});

test("Смысловая проверка обнаруживает несовместимые участия, родительство, sequence и принятие", async (t) => {
  for (const reason of [
    "multiple-current-runs",
    "current-run-mismatch",
    "parent-cycle",
    "fork-creator",
    "checkpoint-run",
    "checkpoint-intent",
    "duplicate-sequence",
    "invalid-acceptance",
  ] as const) {
    await t.test(reason, async (t) => {
      const { workspace, service } = await fixture(t);
      let left = await service.start({ title: "Левая", requestId: "left" }, "left");
      left = await service.openCheckpoint({ ...owner(left), ...material }, "left");
      let right = await service.start({ title: "Правая", requestId: "right" }, "right");
      right = await service.openCheckpoint({ ...owner(right), ...material }, "right");
      const edit = async (
        collection: string,
        id: string,
        change: (record: { id: string; data: Record<string, unknown> }) => void,
      ) => {
        const path = join(workspace.dataRoot, "entities", collection, `${id}.json`);
        const record = JSON.parse(await readFile(path, "utf8"));
        change(record);
        await writeFile(path, JSON.stringify(record));
      };
      if (reason === "multiple-current-runs") {
        const path = join(workspace.dataRoot, "entities/agent-runs", `${left.run!.id}.json`);
        const run = JSON.parse(await readFile(path, "utf8"));
        run.id = "independent-run";
        Object.assign(run.data, {
          id: run.id,
          key: `RUN-${run.id}`,
          startedSequence: left.session.sequence + 1,
          predecessorRunId: left.run!.id,
        });
        await writeFile(
          join(workspace.dataRoot, "entities/agent-runs", `${run.id}.json`),
          JSON.stringify(run),
        );
        await edit("work-sessions", left.session.id, (record) => {
          record.data.sequence = left.session.sequence + 1;
        });
      } else if (reason === "current-run-mismatch") {
        await edit("work-sessions", left.session.id, (record) => {
          record.data.currentRunId = right.run!.id;
        });
      } else if (reason === "parent-cycle") {
        for (const [child, parent] of [
          [left, right],
          [right, left],
        ] as const) {
          await edit("work-sessions", child.session.id, (record) => {
            Object.assign(record.data, {
              parentSessionId: parent.session.id,
              originCheckpointId: parent.checkpoint!.id,
              createdByRunId: parent.run!.id,
              parentSequence: 4,
              sequence: 4,
            });
          });
        }
      } else if (reason === "fork-creator") {
        const fork = await service.fork(
          { ...owner(left), ref: left.checkpoint!.id, title: "Ребёнок" },
          "left",
        );
        await edit("work-sessions", fork.childSession!.id, (record) => {
          record.data.createdByRunId = right.run!.id;
        });
      } else if (reason === "checkpoint-run") {
        await edit("work-checkpoints", left.checkpoint!.id, (record) => {
          record.data.runId = right.run!.id;
        });
      } else if (reason === "duplicate-sequence") {
        const next = await service.openCheckpoint({ ...owner(left), ...material }, "left");
        await edit("work-checkpoints", next.checkpoint!.id, (record) => {
          record.data.sequence = left.checkpoint!.sequence;
        });
      } else {
        const progress = await service.saveCheckpoint(
          { ...owner(left), ref: left.checkpoint!.id, ...material },
          "left",
        );
        await edit("work-checkpoints", progress.checkpoint!.id, (record) => {
          if (reason === "checkpoint-intent") record.data.intentId = right.checkpoint!.id;
          else record.data.acceptedSessionIds = [right.session.id];
        });
      }
      if (reason === "current-run-mismatch") {
        await assert.rejects(
          new StorageService(workspace).reindex(),
          code("STORAGE_REFERENCE_BROKEN"),
        );
      } else await new StorageService(workspace).reindex();
      await assert.rejects(validateWorkHistory(workspace), (error: unknown) => {
        const failure = error as { code: string; details: { reason: string } };
        assert.equal(failure.code, "WORK_HISTORY_INVALID");
        assert.equal(failure.details.reason, reason);
        return true;
      });
    });
  }
});
