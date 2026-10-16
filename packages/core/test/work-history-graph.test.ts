import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import * as graphContract from "@relay/contracts/work-history-graph";
import type { WorkHistoryMutation } from "@relay/contracts/work-history";
import { WorkHistoryGraphService } from "../src/application/work-history/graph.js";
import { WorkHistoryService } from "../src/application/work-history/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { initialize } from "../src/storage/workspace.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { stateSchema } from "../src/storage/entity-store/format.js";
import { persistent, treeHashes } from "./helpers/migration-bases.js";

const markdown = "\n# Полный материал 🧪\r\n\n  Отступ\t  \n```ts\nconst value = 1;\n```\n\n";
const material = {
  title: "Намерение",
  summary: "Краткая аннотация\r\n  с пробелами  ",
  body: markdown,
};
const alice = { name: "Алиса", email: "alice@example.test", source: "explicit" as const };
const bob = { name: "Борис", email: "bob@example.test", source: "explicit" as const };
const owner = (state: WorkHistoryMutation) => ({
  ref: state.session.id,
  runId: state.run!.id,
  ifRevision: state.session.revision,
  requestId: "operation",
});
const cpId = (id: string) => `${id}:checkpoint`;
const created = (id: string) => `${id}:created`;
const closed = (id: string) => `${id}:closed`;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-work-history-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  return {
    root,
    workspace,
    service: new WorkHistoryService(workspace),
    graph: new WorkHistoryGraphService(workspace),
  };
}
function page(value: unknown) {
  return graphContract.workHistoryGraphPageSchema.parse(value);
}
function detail(value: unknown) {
  return graphContract.workHistoryGraphPointDetailSchema.parse(value);
}
function edge(
  result: graphContract.WorkHistoryGraphPage,
  expected: graphContract.WorkHistoryGraphEdge,
) {
  assert(
    result.edges.some((edge) => isDeepStrictEqual(edge, expected)),
    `Нет связи ${JSON.stringify(expected)}`,
  );
}
function point(result: graphContract.WorkHistoryGraphPage, id: string) {
  const point = result.items.find((point) => point.id === id);
  assert(point, `Нет точки ${id}`);
  return point;
}

test("Граф: root/child/grandchild возвращаются при закрытии, не меняя явное принятие результатов", async (t) => {
  const { service, graph, workspace } = await fixture(t);
  let root = await service.start(
    {
      title: "Корень",
      description: markdown,
      reason: markdown,
      operator: alice,
      requestId: "root",
    },
    "lead",
  );
  const original = root.run!;
  root = await service.openCheckpoint({ ...owner(root), ...material }, "lead");
  const rootIntent = root.checkpoint!;
  root = await service.fork(
    { ...owner(root), ref: rootIntent.key, title: "Дочернее поручение", description: markdown },
    "lead",
  );
  const childSession = root.childSession!;
  root = await service.takeover(
    {
      ref: root.session.id,
      ifRevision: root.session.revision,
      requestId: "transfer",
      reason: "Передача",
      operator: bob,
    },
    "new-lead",
  );
  let child = await service.attach(
    { ref: childSession.id, ifRevision: 1, requestId: "attach", operator: bob },
    "child-executor",
  );
  child = await service.openCheckpoint({ ...owner(child), ...material }, "child-executor");
  const childIntent = child.checkpoint!;
  child = await service.fork(
    { ...owner(child), ref: childIntent.id, title: "Внук" },
    "child-executor",
  );
  let grandchild = await service.attach(
    { ref: child.childSession!.id, ifRevision: 1, requestId: "attach" },
    "grandchild",
  );
  grandchild = await service.openCheckpoint({ ...owner(grandchild), ...material }, "grandchild");
  const grandIntent = grandchild.checkpoint!;
  grandchild = await service.completeCheckpoint(
    { ...owner(grandchild), ref: grandIntent.id, ...material, title: "Готово" },
    "grandchild",
  );
  grandchild = await service.complete({ ...owner(grandchild), result: markdown }, "grandchild");
  const beforeAcceptance = page(await graph.graph({ order: "asc", limit: 100 }));
  assert.equal(beforeAcceptance.total, 11);
  edge(beforeAcceptance, { kind: "root-start", from: null, to: created(root.session.id) });
  edge(beforeAcceptance, {
    kind: "fork",
    fromSessionId: root.session.id,
    to: created(child.session.id),
  });
  edge(beforeAcceptance, {
    kind: "fork",
    fromSessionId: child.session.id,
    to: created(grandchild.session.id),
  });
  edge(beforeAcceptance, {
    kind: "branch-end",
    from: closed(grandchild.session.id),
    toSessionId: child.session.id,
  });
  assert.deepEqual(
    beforeAcceptance.openEnds.map((point) => point.sessionId).sort(),
    [root.session.id, child.session.id].sort(),
  );
  assert(!beforeAcceptance.edges.some((edge) => edge.kind === "root-end"));
  assert.equal((await service.get({ ref: grandchild.session.id })).acceptance, null);
  assert.equal((await service.get({ ref: child.session.id })).session.status, "open");
  await assert.rejects(
    service.completeCheckpoint(
      { ...owner(child), ref: childIntent.id, ...material },
      "child-executor",
    ),
    { code: "WORK_CHILDREN_UNACCEPTED" },
  );
  assert.equal(point(beforeAcceptance, created(root.session.id)).runId, original.id);
  assert.equal(point(beforeAcceptance, created(child.session.id)).runId, original.id);
  assert.equal(point(beforeAcceptance, `${child.run!.id}:started`).runId, child.run!.id);
  assert.equal(point(beforeAcceptance, created(grandchild.session.id)).runId, child.run!.id);
  assert.equal(point(beforeAcceptance, cpId(grandIntent.id)).intentState, "completed");
  assert.equal(point(beforeAcceptance, cpId(rootIntent.id)).intentState, "open");
  assert(
    !beforeAcceptance.items.some(
      (point) =>
        point.id === `${original.id}:started` ||
        point.id === `${original.id}:ended` ||
        point.id === `${grandchild.run!.id}:ended`,
    ),
  );
  assert.equal(point(beforeAcceptance, `${root.run!.id}:started`).predecessorRunId, original.id);
  assert.deepEqual(beforeAcceptance.runs.find((run) => run.id === original.id)!.operator, alice);

  child = await service.saveCheckpoint(
    {
      ...owner(child),
      ref: childIntent.id,
      ...material,
      acceptedSessionIds: [grandchild.session.id],
    },
    "child-executor",
  );
  const grandAcceptance = child.checkpoint!;
  child = await service.completeCheckpoint(
    { ...owner(child), ref: childIntent.id, ...material },
    "child-executor",
  );
  child = await service.complete({ ...owner(child), result: markdown }, "child-executor");
  const childBefore = page(
    await graph.graph({ ref: child.session.id, includeChildren: false, order: "desc", limit: 1 }),
  );
  assert.equal(childBefore.items[0]!.id, closed(child.session.id));
  edge(childBefore, {
    kind: "branch-end",
    from: closed(child.session.id),
    toSessionId: root.session.id,
  });
  assert.equal((await service.get({ ref: child.session.id })).acceptance, null);
  assert(childBefore.branches.find((branch) => branch.id === root.session.id)!.contextOnly);
  assert.equal(childBefore.items[0]!.at, child.session.closedAt);
  root = await service.saveCheckpoint(
    { ...owner(root), ref: rootIntent.id, ...material, acceptedSessionIds: [child.session.id] },
    "new-lead",
  );
  const childAcceptance = root.checkpoint!;
  await assert.rejects(
    graph.graph({
      ref: child.session.id,
      includeChildren: false,
      order: "desc",
      version: childBefore.version,
    }),
    { code: "VERSION_CONFLICT" },
  );
  const acceptedPage = page(
    await graph.graph({ ref: child.session.id, includeChildren: false, order: "desc", limit: 1 }),
  );
  edge(acceptedPage, {
    kind: "branch-end",
    from: closed(child.session.id),
    toSessionId: root.session.id,
  });
  assert.deepEqual(acceptedPage.edges, childBefore.edges);
  assert(!acceptedPage.boundaryNodes.some((point) => point.id === cpId(childAcceptance.id)));
  assert.equal(
    (await service.get({ ref: child.session.id })).acceptance!.checkpointId,
    childAcceptance.id,
  );
  assert.equal(
    (await service.get({ ref: grandchild.session.id })).acceptance!.checkpointId,
    grandAcceptance.id,
  );
  root = await service.completeCheckpoint(
    { ...owner(root), ref: rootIntent.id, ...material, acceptedSessionIds: [child.session.id] },
    "new-lead",
  );
  root = await service.complete({ ...owner(root), result: markdown }, "new-lead");
  const beforeRead = await treeHashes(workspace.dataRoot, persistent);
  const result = page(await graph.graph({ order: "asc", limit: 100 }));
  edge(result, {
    kind: "branch-end",
    from: closed(grandchild.session.id),
    toSessionId: child.session.id,
  });
  edge(result, {
    kind: "branch-end",
    from: closed(child.session.id),
    toSessionId: root.session.id,
  });
  edge(result, { kind: "root-end", from: closed(root.session.id), to: null });
  assert.equal(
    result.edges.filter(
      (edge) => edge.kind === "branch-end" && edge.from === closed(child.session.id),
    ).length,
    1,
  );
  assert(!JSON.stringify(result.edges).includes('"kind":"acceptance"'));
  assert.deepEqual(result.openEnds, []);
  assert.equal(point(result, closed(root.session.id)).runId, root.run!.id);
  const historyIds = new Set(
    (await service.history({ ref: root.session.id, includeChildren: true, limit: 100 })).items.map(
      (point) => point.id,
    ),
  );
  assert(result.items.every((point) => historyIds.has(point.id)));
  const startDetail = detail(await graph.point({ ref: created(root.session.id) }));
  assert.equal(startDetail.run!.id, original.id);
  assert.equal(startDetail.run!.reason, markdown);
  assert.equal(startDetail.session.result, markdown);
  const childCreated = detail(await graph.point({ ref: created(child.session.id) }));
  assert.equal(childCreated.session.id, child.session.id);
  assert.equal(childCreated.run!.id, original.id);
  assert.equal(childCreated.run!.sessionId, root.session.id);
  assert.deepEqual(childCreated.run!.operator, alice);
  assert.equal(childCreated.checkpoint, null);
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), beforeRead);
});

test("Граф: limit=1, полные границы страницы/scope, настоящие корни и только необходимые таблицы", async (t) => {
  const { service, graph } = await fixture(t);
  let root = await service.start({ title: "Корень", requestId: "root" }, "lead");
  root = await service.openCheckpoint({ ...owner(root), ...material }, "lead");
  const intent = root.checkpoint!;
  root = await service.fork({ ...owner(root), ref: intent.id, title: "Ребёнок" }, "lead");
  let child = await service.attach(
    { ref: root.childSession!.id, ifRevision: 1, requestId: "attach" },
    "child",
  );
  child = await service.openCheckpoint({ ...owner(child), ...material }, "child");
  const childIntent = child.checkpoint!;
  child = await service.fork(
    { ...owner(child), ref: childIntent.id, title: "Внук ожидает" },
    "child",
  );
  const grandchild = child.childSession!;
  root = await service.saveCheckpoint({ ...owner(root), ref: intent.id, ...material }, "lead");
  const progress = root.checkpoint!;
  const unrelated = await service.start(
    { title: "Посторонний корень", requestId: "unrelated" },
    "other",
  );
  const scope = page(
    await graph.graph({ ref: grandchild.id, includeChildren: false, order: "asc", limit: 1 }),
  );
  assert.equal(scope.scopeRootId, grandchild.id);
  assert.equal(scope.total, 1);
  edge(scope, { kind: "fork", fromSessionId: child.session.id, to: created(grandchild.id) });
  assert.deepEqual(scope.boundaryNodes, []);
  assert(!scope.edges.some((edge) => edge.kind === "root-start" || edge.kind === "root-end"));
  assert.deepEqual(
    scope.branches.map((branch) => branch.id).sort(),
    [root.session.id, child.session.id, grandchild.id].sort(),
  );
  assert.equal(scope.branches.find((branch) => branch.id === grandchild.id)!.contextOnly, false);
  assert(
    scope.branches
      .filter((branch) => branch.id !== grandchild.id)
      .every((branch) => branch.contextOnly),
  );
  assert.deepEqual(
    scope.runs.map((run) => run.id),
    [child.run!.id],
  );

  for (const order of ["asc", "desc"] as const) {
    const full = page(
      await graph.graph({ ref: root.session.id, includeChildren: false, order, limit: 100 }),
    );
    const offset = full.items.findIndex((point) => point.id === cpId(intent.id));
    const one = page(
      await graph.graph({
        ref: root.session.key,
        includeChildren: false,
        order,
        offset,
        limit: 1,
        version: full.version,
      }),
    );
    edge(one, { kind: "sequence", from: created(root.session.id), to: cpId(intent.id) });
    edge(one, { kind: "sequence", from: cpId(intent.id), to: cpId(progress.id) });
    assert(!one.edges.some((edge) => edge.kind === "fork" || edge.kind === "branch-end"));
    assert.equal(
      one.boundaryNodes.find((point) => point.id === created(root.session.id))!.side,
      order === "asc" ? "before" : "after",
    );
    assert.equal(
      one.boundaryNodes.find((point) => point.id === cpId(progress.id))!.side,
      order === "asc" ? "after" : "before",
    );
    assert(!one.boundaryNodes.some((point) => point.id === created(child.session.id)));
    assert(
      !one.branches.some(
        (branch) => branch.id === grandchild.id || branch.id === unrelated.session.id,
      ),
    );
  }
  const all = page(await graph.graph({ order: "asc", limit: 100 }));
  const gathered: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const next = page(await graph.graph({ order: "asc", offset, limit: 1, version: all.version }));
    assert.equal(next.total, all.total);
    gathered.push(...next.items.map((point) => point.id));
    for (const branch of next.branches)
      assert.equal(branch.contextOnly, !next.items.some((point) => point.sessionId === branch.id));
    offset = next.nextOffset;
  }
  assert.deepEqual(
    gathered,
    all.items.map((point) => point.id),
  );
  assert.equal(new Set(gathered).size, gathered.length);
  const reverse = page(await graph.graph({ order: "desc", limit: 100 }));
  assert.deepEqual(
    reverse.items.map((point) => point.id),
    gathered.toReversed(),
  );
  assert.deepEqual(reverse.edges, all.edges);
  assert.deepEqual(await graph.graph({ order: "asc", limit: 100 }), all);
  const beyond = page(
    await graph.graph({ order: "asc", offset: all.total + 1, limit: 1, version: all.version }),
  );
  assert.deepEqual([beyond.items, beyond.edges, beyond.boundaryNodes], [[], [], []]);
  assert.equal(beyond.openEnds.length, 4);
  assert(beyond.branches.every((branch) => branch.contextOnly));
  assert.equal(beyond.nextOffset, null);
});

test("Граф компактен: большие Markdown только в point, состояние intent учитывает невидимый terminal", async (t) => {
  const { service, graph, workspace } = await fixture(t);
  const large = `${markdown}${"MD_PRIVATE_SECTION ".repeat(9_000)}\n`;
  let state = await service.start(
    { title: "Крупный материал", description: large, reason: large, requestId: "start" },
    "agent",
  );
  state = await service.openCheckpoint(
    {
      ...owner(state),
      ...material,
      body: large,
      done: large,
      remaining: large,
      nextStep: large,
      checks: large,
    },
    "agent",
  );
  const intent = state.checkpoint!;
  state = await service.completeCheckpoint(
    { ...owner(state), ref: intent.id, ...material, title: "Результат" },
    "agent",
  );
  const before = await treeHashes(workspace.dataRoot, persistent);
  const get = t.mock.method(StorageSession.prototype, "get");
  const start = page(await graph.graph({ order: "asc", limit: 1 }));
  assert.deepEqual(
    get.mock.calls.map((call) => call.arguments[0]),
    [{ kind: "work-checkpoint", id: state.checkpoint!.id }],
  );
  get.mock.resetCalls();
  const selected = page(
    await graph.graph({ order: "asc", offset: 1, limit: 1, version: start.version }),
  );
  assert.equal(selected.items[0]!.id, cpId(intent.id));
  assert.equal(selected.items[0]!.intentState, "completed");
  assert.equal(selected.items[0]!.summary, material.summary);
  assert.deepEqual(
    get.mock.calls.map((call) => call.arguments[0]),
    [
      { kind: "work-checkpoint", id: intent.id },
      { kind: "work-checkpoint", id: state.checkpoint!.id },
    ],
  );
  const encoded = JSON.stringify(selected);
  assert(!encoded.includes("MD_PRIVATE_SECTION"));
  for (const field of [
    "body",
    "done",
    "remaining",
    "nextStep",
    "checks",
    "reason",
    "endSummary",
    "description",
    "result",
    "references",
  ])
    assert(!encoded.includes(`"${field}":`), `Полное поле ${field} попало в graph`);
  assert(encoded.length < 10_000);
  get.mock.resetCalls();
  const full = detail(await graph.point({ ref: cpId(intent.id) }));
  assert.deepEqual(full.point, selected.items[0]);
  assert.deepEqual(full.checkpoint, intent);
  assert.equal(full.session.description, large);
  assert.equal(full.run!.reason, large);
  assert.deepEqual(
    get.mock.calls.map((call) => call.arguments[0].kind),
    ["work-checkpoint", "work-session", "agent-run"],
  );
  get.mock.restore();
  for (const ref of [intent.key, intent.id, `work-checkpoint:${intent.id}`])
    assert.deepEqual(await graph.point({ ref }), full);
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);

  // У summary нет собственного компактного поля: guard обязан учитывать file-hashes.
  const path = join(workspace.dataRoot, "entities/work-checkpoints", `${intent.id}.json`);
  const disk = JSON.parse(await readFile(path, "utf8"));
  disk.data.summary = "Изменённая аннотация внешней копии";
  await writeFile(path, JSON.stringify(disk));
  await new StorageService(workspace).reindex();
  await assert.rejects(graph.graph({ order: "asc", offset: 1, version: start.version }), {
    code: "VERSION_CONFLICT",
  });
  assert.equal(
    (await graph.graph({ order: "asc", offset: 1, limit: 1 })).items[0]!.summary,
    disk.data.summary,
  );
});

test("Lifecycle: attach/resume/takeover/pause различимы, отмена без closing run не угадывает автора", async (t) => {
  const { service, graph } = await fixture(t);
  let state = await service.start(
    { title: "Жизненный цикл", requestId: "start", operator: alice },
    "first",
  );
  const first = state.run!;
  state = await service.pause({ ...owner(state), reason: markdown }, "first");
  let result = page(await graph.graph({ ref: state.session.id, limit: 100 }));
  assert.equal(result.total, 2);
  assert.equal(point(result, `${first.id}:ended`).title, "Работа приостановлена");
  state = await service.resume(
    {
      ref: state.session.id,
      ifRevision: state.session.revision,
      requestId: "resume",
      reason: markdown,
      operator: bob,
    },
    "second",
  );
  const resumed = state.run!;
  const resumedDetail = detail(await graph.point({ ref: `${resumed.id}:started` }));
  assert.equal(resumedDetail.point.title, "Возобновление работы");
  assert.equal(resumedDetail.previousRun!.id, first.id);
  assert.equal(resumedDetail.run!.reason, markdown);
  state = await service.takeover(
    {
      ref: state.session.id,
      ifRevision: state.session.revision,
      requestId: "takeover",
      reason: markdown,
    },
    "third",
  );
  const third = state.run!;
  state = await service.cancel({ ...owner(state), result: markdown }, "third");
  result = page(await graph.graph({ ref: state.session.id, order: "asc", limit: 100 }));
  assert.equal(result.total, 5);
  assert.equal(point(result, `${third.id}:started`).title, "Передача работы");
  assert(
    !result.items.some(
      (point) => point.id === `${resumed.id}:ended` || point.id === `${third.id}:ended`,
    ),
  );
  assert.equal(point(result, closed(state.session.id)).runId, third.id);
  assert.equal(result.branches[0]!.status, "cancelled");
  edge(result, { kind: "root-end", from: closed(state.session.id), to: null });
  assert.deepEqual(result.openEnds, []);
  const hidden = detail(await graph.point({ ref: `${first.id}:started` }));
  assert.equal(hidden.run!.id, first.id);
  assert.equal(hidden.point.kind, "run-started");

  let paused = await service.start(
    { title: "Чужое последнее участие", requestId: "paused", operator: alice },
    "prior",
  );
  paused = await service.pause({ ...owner(paused), reason: "Пауза" }, "prior");
  paused = await service.cancel(
    {
      ref: paused.session.id,
      ifRevision: paused.session.revision,
      requestId: "cancel",
      result: "Решение другого человека",
    },
    "other",
  );
  const cancelled = page(await graph.graph({ ref: paused.session.id, order: "desc", limit: 1 }));
  assert.equal(cancelled.items[0]!.runId, null);
  assert.equal(cancelled.items[0]!.predecessorRunId, null);
  assert.deepEqual(cancelled.runs, []);
  const cancelledDetail = detail(await graph.point({ ref: closed(paused.session.id) }));
  assert.equal(cancelledDetail.run, null);
  assert.equal(cancelledDetail.previousRun, null);
  edge(cancelled, { kind: "root-end", from: closed(paused.session.id), to: null });
  assert.deepEqual(cancelled.openEnds, []);

  let parent = await service.start(
    { title: "Отмена pending ребёнка", requestId: "parent" },
    "lead",
  );
  parent = await service.openCheckpoint({ ...owner(parent), ...material }, "lead");
  parent = await service.fork(
    { ...owner(parent), ref: parent.checkpoint!.id, title: "Не запущен" },
    "lead",
  );
  const pending = await service.cancel(
    {
      ref: parent.childSession!.id,
      ifRevision: 1,
      requestId: "pending-cancel",
      result: "Запуск не нужен",
    },
    "other",
  );
  const child = page(await graph.graph({ ref: pending.session.id, order: "desc", limit: 1 }));
  assert.equal(child.items[0]!.runId, null);
  assert(!child.edges.some((edge) => edge.kind === "root-end"));
  edge(child, {
    kind: "branch-end",
    from: closed(pending.session.id),
    toSessionId: parent.session.id,
  });
  assert.deepEqual(child.openEnds, []);
  assert(child.branches.find((branch) => branch.id === parent.session.id)!.contextOnly);
});

test("Граф: проект/параметры версий, неизвестные и повреждённые point refs, пустой проект", async (t) => {
  const { service, graph } = await fixture(t);
  const empty = page(await graph.graph({}));
  assert.equal(empty.total, 0);
  assert.equal(empty.scopeRootId, null);
  assert.deepEqual(
    [empty.items, empty.edges, empty.boundaryNodes, empty.branches, empty.runs],
    [[], [], [], [], []],
  );
  let state = await service.start({ title: "Изоляция", requestId: "start" }, "agent");
  state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
  const result = page(await graph.graph({}));
  await assert.rejects(
    graph.graph({ version: result.version.replace("work-graph-v2:", "work-graph-v1:") }),
    { code: "VERSION_CONFLICT" },
  );
  await assert.rejects(graph.graph({ version: empty.version }), { code: "VERSION_CONFLICT" });
  await assert.rejects(graph.graph({ order: "asc", version: result.version }), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(graph.graph({ ref: state.session.id, version: result.version }), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(graph.graph({ includeChildren: false, version: result.version }), {
    code: "VERSION_CONFLICT",
  });
  const other = await fixture(t);
  await assert.rejects(other.graph.graph({ version: result.version }), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(other.graph.graph({ ref: state.session.key }), { code: "ENTITY_NOT_FOUND" });
  await assert.rejects(other.graph.point({ ref: cpId(state.checkpoint!.id) }), {
    code: "ENTITY_NOT_FOUND",
  });
  for (const ref of ["", "плохая ссылка", "bad ref", "../escape"])
    await assert.rejects(graph.point({ ref }), { code: "VALIDATION_ERROR" });
  await assert.rejects(graph.point({ ref: "one:two:three" }), { code: "INVALID_REFERENCE" });
  await assert.rejects(graph.point({ ref: `work-session:${state.session.id}` }), {
    code: "ENTITY_KIND_MISMATCH",
  });
  for (const ref of [
    "CP-missing",
    "missing",
    "work-checkpoint:missing",
    "missing:checkpoint",
    closed(state.session.id),
    state.session.key,
    state.session.id,
  ])
    await assert.rejects(graph.point({ ref }), { code: "ENTITY_NOT_FOUND" });
});

test("Граф и point используют guards полноты индексов, не маскируя потерю terminal", async (t) => {
  const { root, workspace, service, graph } = await fixture(t);
  let state = await service.start({ title: "Guard графа", requestId: "start" }, "agent");
  state = await service.openCheckpoint({ ...owner(state), ...material }, "agent");
  const intent = state.checkpoint!;
  const path = join(workspace.dataRoot, ".indexes/state.json");
  const prior = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  await cp(join(workspace.dataRoot, ".indexes/segments"), join(root, "prior-segments"), {
    recursive: true,
  });
  state = await service.completeCheckpoint(
    { ...owner(state), ref: intent.id, ...material },
    "agent",
  );
  const current = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  current.roots["work-history-checkpoints"] = prior.roots["work-history-checkpoints"]!;
  await cp(join(root, "prior-segments"), join(workspace.dataRoot, ".indexes/segments"), {
    recursive: true,
  });
  await writeFile(path, JSON.stringify(current));
  const before = await treeHashes(workspace.dataRoot, persistent);
  await assert.rejects(graph.graph({}), { code: "STORAGE_INDEX_CORRUPT" });
  await assert.rejects(graph.point({ ref: intent.key }), { code: "STORAGE_INDEX_CORRUPT" });
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
  await new StorageService(workspace).reindex();
  assert.equal((await graph.point({ ref: cpId(intent.id) })).point.intentState, "completed");
  const repaired = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  delete repaired.roots["work-history-addresses"];
  await writeFile(path, JSON.stringify(repaired));
  await assert.rejects(graph.graph({}), { code: "STORAGE_INDEX_CORRUPT" });
  await assert.rejects(graph.point({ ref: cpId(intent.id) }), { code: "STORAGE_INDEX_CORRUPT" });
});

test("Project timeline: старые open/pending/paused не исчезают за сотней новых точек", async (t) => {
  const { service, graph, workspace } = await fixture(t);
  const oldBody = `${markdown}${"PRIVATE_OLD_MARKDOWN ".repeat(8_000)}`;
  let old = await service.start(
    {
      title: "Старая незавершённая работа",
      description: oldBody,
      operator: alice,
      requestId: "old",
    },
    "old-agent",
  );
  old = await service.openCheckpoint(
    { ...owner(old), ...material, title: "Старое открытое намерение", body: oldBody },
    "old-agent",
  );
  const oldIntent = old.checkpoint!;
  old = await service.fork(
    { ...owner(old), ref: oldIntent.id, title: "Ожидающий ребёнок" },
    "old-agent",
  );
  const pending = old.childSession!;
  let paused = await service.start({ title: "Пауза", requestId: "paused" }, "paused-agent");
  paused = await service.pause({ ...owner(paused), reason: markdown }, "paused-agent");
  let recent = await service.start(
    { title: "Новая плотная работа", requestId: "recent", operator: bob },
    "recent-agent",
  );
  recent = await service.openCheckpoint({ ...owner(recent), ...material }, "recent-agent");
  const recentIntent = recent.checkpoint!;
  await workspace.mutate("graph-fixture", { requestId: "dense" }, "recent-agent", async () => {
    for (let index = 0; index < 100; index++)
      recent = await service.saveCheckpoint(
        { ...owner(recent), ref: recentIntent.id, ...material, title: `Новая точка ${index}` },
        "recent-agent",
      );
    return {};
  });
  const before = await treeHashes(workspace.dataRoot, persistent);
  const get = t.mock.method(StorageSession.prototype, "get");
  const result = page(await graph.graph({ limit: 1 }));
  assert.equal(result.items[0]!.id, cpId(recent.checkpoint!.id));
  assert.equal(result.total, 107);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.openEnds.length, 4);
  const end = result.openEnds.find((point) => point.sessionId === old.session.id)!;
  assert.equal(end.id, cpId(oldIntent.id));
  assert.equal(end.at, oldIntent.createdAt);
  assert.equal(end.sequence, oldIntent.sequence);
  assert(end.sequence < old.session.sequence, "Последний fork не выдумывает точку parentSequence");
  assert.equal(end.summary, oldIntent.summary);
  assert.equal(end.title, oldIntent.title);
  assert.equal(end.intentState, "open");
  assert.equal(
    result.openEnds.find((point) => point.sessionId === pending.id)!.id,
    created(pending.id),
  );
  assert.equal(
    result.openEnds.find((point) => point.sessionId === paused.session.id)!.id,
    `${paused.run!.id}:ended`,
  );
  assert.deepEqual(
    result.openEnds.find((point) => point.sessionId === recent.session.id),
    result.items[0],
  );
  assert.equal(result.branches.find((branch) => branch.id === old.session.id)!.contextOnly, true);
  assert.deepEqual(result.runs.find((run) => run.id === old.run!.id)!.operator, alice);
  assert.deepEqual(
    get.mock.calls.map((call) => call.arguments[0]),
    [
      { kind: "work-checkpoint", id: recent.checkpoint!.id },
      { kind: "work-checkpoint", id: oldIntent.id },
    ],
  );
  assert(!JSON.stringify(result).includes("PRIVATE_OLD_MARKDOWN"));
  get.mock.restore();
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
  const second = page(await graph.graph({ offset: 1, limit: 1, version: result.version }));
  assert.deepEqual(
    second.openEnds.map((point) => point.id),
    result.openEnds.map((point) => point.id),
  );
  assert.deepEqual(second.openEnds, result.openEnds);
  const expanded = page(await graph.graph({ order: "asc", limit: 100 }));
  assert.deepEqual(point(expanded, cpId(oldIntent.id)), end);
  assert.deepEqual((await graph.point({ ref: oldIntent.key })).point, end);
});

test("Project timeline: линия завершённой работы пересекает страницу другой ветки между before/after", async (t) => {
  const { service, graph } = await fixture(t);
  let long = await service.start({ title: "Долгая ветка", requestId: "long" }, "long-agent");
  let busy = await service.start({ title: "Плотная ветка", requestId: "busy" }, "busy-agent");
  busy = await service.openCheckpoint({ ...owner(busy), ...material }, "busy-agent");
  const intent = busy.checkpoint!;
  const middle = await service.saveCheckpoint(
    { ...owner(busy), ref: intent.id, ...material, title: "Середина окна" },
    "busy-agent",
  );
  busy = await service.saveCheckpoint(
    { ...owner(middle), ref: intent.id, ...material, title: "После середины" },
    "busy-agent",
  );
  long = await service.complete({ ...owner(long), result: markdown }, "long-agent");
  for (const order of ["asc", "desc"] as const) {
    const all = page(await graph.graph({ order, limit: 100 }));
    const offset = all.items.findIndex((point) => point.id === cpId(middle.checkpoint!.id));
    const get = t.mock.method(StorageSession.prototype, "get");
    const window = page(await graph.graph({ order, offset, limit: 1, version: all.version }));
    assert.equal(window.items[0]!.sessionId, busy.session.id);
    edge(window, { kind: "sequence", from: created(long.session.id), to: closed(long.session.id) });
    const start = window.boundaryNodes.find((point) => point.id === created(long.session.id))!;
    const end = window.boundaryNodes.find((point) => point.id === closed(long.session.id))!;
    assert.equal(start.side, order === "asc" ? "before" : "after");
    assert.equal(end.side, order === "asc" ? "after" : "before");
    assert.equal(
      window.branches.find((branch) => branch.id === long.session.id)!.contextOnly,
      true,
    );
    assert(!window.openEnds.some((point) => point.sessionId === long.session.id));
    assert(!window.edges.some((edge) => edge.kind === "root-start" || edge.kind === "root-end"));
    assert.deepEqual(
      window.runs.map((run) => run.id),
      [busy.run!.id],
    );
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments[0]),
      [
        { kind: "work-checkpoint", id: middle.checkpoint!.id },
        { kind: "work-checkpoint", id: busy.checkpoint!.id },
      ],
    );
    get.mock.restore();
  }
});

test("Отложенные fork одного старого intent выходят из parent lane на createdAt, без старого CP в boundary", async (t) => {
  const { service, graph, workspace } = await fixture(t);
  let parent = await service.start(
    { title: "Родитель 12 октября", requestId: "parent", operator: alice },
    "parent",
  );
  parent = await service.openCheckpoint({ ...owner(parent), ...material }, "parent");
  const intent = parent.checkpoint!;
  let middle = await service.start(
    { title: "Другая работа 13 октября", requestId: "middle" },
    "middle",
  );
  middle = await service.openCheckpoint({ ...owner(middle), ...material }, "middle");
  parent = await service.fork(
    { ...owner(parent), ref: intent.id, title: "Первый запуск 15 октября" },
    "parent",
  );
  const first = parent.childSession!;
  parent = await service.fork(
    { ...owner(parent), ref: intent.id, title: "Второй запуск 15 октября" },
    "parent",
  );
  const second = parent.childSession!;
  // Только выделенная тестовая база: моделируем длинную паузу без ожидания часов и без demo.
  const date = async (collection: string, id: string, at: string, updatedAt = at) => {
    const path = join(workspace.dataRoot, "entities", collection, `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.createdAt = at;
    record.updatedAt = updatedAt;
    if (collection === "agent-runs") record.data.startedAt = at;
    else record.data.createdAt = at;
    if (collection === "work-sessions") record.data.updatedAt = updatedAt;
    await writeFile(path, JSON.stringify(record));
  };
  const firstAt = "2026-10-15T03:00:00.000Z";
  const secondAt = "2026-10-15T04:00:00.000Z";
  await date("work-sessions", parent.session.id, "2026-10-12T12:00:00.000Z", secondAt);
  await date("agent-runs", parent.run!.id, "2026-10-12T12:00:00.000Z");
  await date("work-checkpoints", intent.id, "2026-10-12T12:05:00.000Z");
  await date(
    "work-sessions",
    middle.session.id,
    "2026-10-13T12:00:00.000Z",
    "2026-10-13T12:05:00.000Z",
  );
  await date("agent-runs", middle.run!.id, "2026-10-13T12:00:00.000Z");
  await date("work-checkpoints", middle.checkpoint!.id, "2026-10-13T12:05:00.000Z");
  await date("work-sessions", first.id, firstAt);
  await date("work-sessions", second.id, secondAt);
  await new StorageService(workspace).reindex();
  const before = await treeHashes(workspace.dataRoot, persistent);
  const all = page(await graph.graph({ order: "asc", limit: 100 }));
  assert.equal(all.total, 6);
  assert.equal(all.openEnds.length, 4);
  for (const [child, at] of [
    [first, firstAt],
    [second, secondAt],
  ] as const) {
    edge(all, { kind: "fork", fromSessionId: parent.session.id, to: created(child.id) });
    assert.equal(point(all, created(child.id)).at, at);
    const get = t.mock.method(StorageSession.prototype, "get");
    const selected = page(await graph.graph({ ref: child.id, includeChildren: false, limit: 1 }));
    assert.deepEqual(selected.edges, [
      { kind: "fork", fromSessionId: parent.session.id, to: created(child.id) },
    ]);
    assert.deepEqual(selected.boundaryNodes, []);
    assert.equal(get.mock.callCount(), 0);
    get.mock.restore();
    assert.equal(
      selected.branches.find((branch) => branch.id === child.id)!.originCheckpointId,
      intent.id,
    );
    assert.equal(
      selected.branches.find((branch) => branch.id === parent.session.id)!.contextOnly,
      true,
    );
    assert.equal(selected.items[0]!.runId, parent.run!.id);
  }
  for (const order of ["asc", "desc"] as const) {
    const whole = page(await graph.graph({ order, limit: 100 }));
    const offset = whole.items.findIndex((point) => point.id === cpId(middle.checkpoint!.id));
    const window = page(await graph.graph({ order, offset, limit: 1, version: whole.version }));
    assert(!window.edges.some((edge) => edge.kind === "fork" || edge.kind === "branch-end"));
    assert(
      !window.boundaryNodes.some((point) =>
        [cpId(intent.id), created(first.id), created(second.id)].includes(point.id),
      ),
    );
    assert.equal(
      window.openEnds.find((point) => point.sessionId === parent.session.id)!.id,
      cpId(intent.id),
    );
  }
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
});

test("Граф: чрезмерное число openEnds даёт ошибку бюджета, не успешное усечение", async (t) => {
  const { service, graph, workspace } = await fixture(t);
  await workspace.mutate("graph-fixture", { requestId: "many-open" }, "agent", async () => {
    for (let index = 0; index < 501; index++)
      await service.start({ title: `Ветка ${index}`, requestId: `branch-${index}` }, "agent");
    return {};
  });
  const before = await treeHashes(workspace.dataRoot, persistent);
  const get = t.mock.method(StorageSession.prototype, "get");
  await assert.rejects(graph.graph({ limit: 1 }), (error: unknown) => {
    const failure = error as {
      code: string;
      details: { part: string; actual: number; limit: number };
    };
    assert.equal(failure.code, "CONTEXT_TOO_LARGE");
    assert.deepEqual(failure.details, {
      context: "work-history-graph",
      part: "openEnds",
      actual: 501,
      limit: 500,
    });
    return true;
  });
  assert.equal(get.mock.callCount(), 0);
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
});
