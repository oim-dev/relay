import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { EntityEngine } from "@relay/core/application/entities/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { GraphService } from "@relay/core/application/graph/service";
import { readJson, atomicJson, exists } from "@relay/core/storage/files";
import { failWal } from "./helpers/wal.js";
import { fixture } from "./helpers/workspace.js";

/** Связанный продукт с внешними задачами и документом для проверки границ каскада. */
async function setup(t: TestContext) {
  const base = await fixture(t);
  const engine = new EntityEngine(base.workspace);
  const create = async (data: Parameters<EntityEngine["create"]>[0]["data"]) => {
    const saved = await engine.create({ data, requestId: crypto.randomUUID() }, "tester");
    return { ...saved, id: saved.ref.id };
  };
  const feature = await create({
    kind: "feature",
    name: "Фича",
    summary: "",
    description: "Требование",
  });
  const scenario = await create({
    kind: "scenario",
    name: "Сценарий",
    featureId: feature.key,
    description: "Шаги",
  });
  const application = await create({
    kind: "application",
    name: "Web",
    summary: "",
    description: "Клиент",
    slug: "web",
    prefix: "WEB",
    type: "frontend",
  });
  const implementation = await create({
    kind: "implementation",
    application: application.key,
    target: feature.key,
    title: "Вклад",
    description: "Вклад фичи",
  });
  const scenarioImplementation = await create({
    kind: "implementation",
    application: application.key,
    target: scenario.key,
    title: "Шаг",
    description: "Вклад сценария",
  });
  const task = await create({
    kind: "task",
    board: "BOARD-WEB",
    title: "Работа",
    targets: [implementation.key],
  });
  const external = await create({
    kind: "task",
    board: "BOARD-INFRA",
    title: "Внешняя",
    related: [task.key],
    parent: task.key,
  });
  await create({
    kind: "task",
    board: "BOARD-INFRA",
    title: "Зависимая",
    dependencies: [task.key],
  });
  const document = await create({
    kind: "document",
    name: "Документ",
    summary: "",
    body: "## Сохранить\n\nТекст  \n",
    documentKind: "rules",
    targets: [feature.key, scenarioImplementation.key],
  });
  const graph = new GraphService(base.workspace);
  const page = await graph.read({});
  await graph.mutate(
    {
      requestId: "graph",
      ifVersion: page.version,
      operations: [
        {
          action: "add",
          from: document.key,
          to: task.key,
          type: "describes",
          description: "Контекст",
        },
      ],
    },
    "tester",
  );
  return {
    ...base,
    engine,
    create,
    deletion: new EntityDeletionService(base.workspace),
    feature,
    scenario,
    application,
    implementation,
    scenarioImplementation,
    task,
    external,
    document,
    graph,
  };
}

for (const kind of [
  "feature",
  "scenario",
  "application",
  "implementation",
  "task",
  "document",
] as const) {
  test(`удаление ${kind}: каскад, внешние записи и отказ повторного удаления`, async (t) => {
    const state = await setup(t);
    const target = state[kind];
    const preview = await state.deletion.preview({ kind, ref: target.key });
    const expected = {
      feature: [
        state.feature.id,
        state.scenario.id,
        state.implementation.id,
        state.scenarioImplementation.id,
      ],
      scenario: [state.scenario.id, state.scenarioImplementation.id],
      application: [
        state.application.id,
        state.implementation.id,
        state.scenarioImplementation.id,
        state.task.id,
        (await state.engine.resolve({ ref: "BOARD-WEB" })).ref.id,
      ],
      implementation: [state.implementation.id, state.scenarioImplementation.id],
      task: [state.task.id],
      document: [state.document.id],
    };
    assert.deepEqual(
      new Set(preview.deleted.map((entry) => entry.ref.id)),
      new Set(expected[kind]),
    );
    const command = {
      kind,
      ref: target.key,
      ifVersion: preview.version,
      requestId: `delete-${kind}`,
    };
    const beforeGraph = await state.graph.read({ limit: 100 });
    assert.equal(beforeGraph.edges.length, beforeGraph.totalEdges);
    const removed = new Set(preview.deleted.map((entry) => `${entry.ref.kind}:${entry.ref.id}`));
    const removedEdges = beforeGraph.edges.filter(
      (edge) =>
        removed.has(`${edge.from.kind}:${edge.from.id}`) ||
        removed.has(`${edge.to.kind}:${edge.to.id}`),
    );
    const result = await state.deletion.delete(command, "tester");
    assert.equal(result.deleted, expected[kind].length);
    await assert.rejects(state.deletion.delete(command, "tester"), { code: "ENTITY_NOT_FOUND" });
    await assert.rejects(state.deletion.delete({ ...command, ifVersion: "changed" }, "tester"), {
      code: "ENTITY_NOT_FOUND",
    });
    for (const id of expected[kind])
      await assert.rejects(state.engine.get({ ref: id }), { code: "ENTITY_NOT_FOUND" });
    const remaining = await state.engine.list({ limit: 100 });
    assert.ok(remaining.items.some((entry) => entry.ref.id === state.external.id));
    if (kind !== "document") {
      const document = await state.engine.get({ ref: state.document.id });
      assert.equal(document.data.kind, "document");
      if (document.data.kind === "document")
        assert.equal(document.data.body, "## Сохранить\n\nТекст  \n");
    }
    if (kind === "application" || kind === "task") {
      const external = await state.engine.get({ ref: state.external.id });
      assert.equal(external.data.kind, "task");
      if (external.data.kind === "task") {
        assert.equal(external.data.parentId, null);
        assert.deepEqual(external.data.dependencies, []);
      }
    }
    const afterGraph = await state.graph.read({ limit: 100 });
    assert.equal(result.relations, removedEdges.length);
    assert.deepEqual(
      new Set(afterGraph.edges.map((edge) => edge.id)),
      new Set(
        beforeGraph.edges.filter((edge) => !removedEdges.includes(edge)).map((edge) => edge.id),
      ),
    );
  });
}

test("удаление: конкурентное изменение требует нового предпросмотра", async (t) => {
  const state = await setup(t);
  const preview = await state.deletion.preview({ kind: "feature", ref: state.feature.id });
  await state.create({
    kind: "scenario",
    featureId: state.feature.id,
    name: "Новый",
    description: "Новый сценарий",
  });
  await assert.rejects(
    state.deletion.delete(
      { kind: "feature", ref: state.feature.id, ifVersion: preview.version, requestId: "stale" },
      "tester",
    ),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal((await state.engine.get({ ref: state.feature.id })).ref.id, state.feature.id);
});

test("удаление: WAL восстанавливается до чтения после прерванной публикации", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-PRODUCT" }, requestId: "task" },
    "tester",
  );
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.key, kind: "task" });
  const command = {
    ref: task.key,
    kind: "task" as const,
    ifVersion: preview.version,
    requestId: "delete",
  };
  failWal(t, (stage) => {
    if (stage === "intent") throw new Error("Прерывание");
  });
  await assert.rejects(deletion.delete(command, "tester"), /Прерывание/);
  t.mock.restoreAll();
  const pending = join(workspace.root, "transactions/pending.json");
  assert(await exists(pending));
  await assert.rejects(engine.get({ ref: task.key }), { code: "ENTITY_NOT_FOUND" });
  assert.equal(await exists(pending), false);
  const record = (await readJson(
    join(workspace.root, "entities/tasks", `${task.ref.id}.json`),
  )) as { deleted: unknown; revision: number };
  assert(record.deleted);
  assert.equal(record.revision, 2);
  await assert.rejects(deletion.delete(command, "tester"), { code: "ENTITY_NOT_FOUND" });
});

test("удаление: внешнее изменение файла блокирует восстановление", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-PRODUCT" }, requestId: "task" },
    "tester",
  );
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.key, kind: "task" });
  failWal(t, (stage) => {
    if (stage === "intent") throw new Error("Прерывание");
  });
  await assert.rejects(
    deletion.delete(
      { ref: task.key, kind: "task", ifVersion: preview.version, requestId: "delete" },
      "tester",
    ),
    /Прерывание/,
  );
  t.mock.restoreAll();
  const path = join(workspace.root, "entities/tasks", `${task.ref.id}.json`);
  const record = (await readJson(path)) as { data: { title: string } };
  record.data.title = "Внешняя правка";
  await atomicJson(path, record, workspace.runtime);
  await assert.rejects(
    workspace.locked(async () => undefined),
    { code: "STORAGE_RECOVERY_CONFLICT" },
  );
  assert.deepEqual(await readJson(path), record);
  assert(await exists(join(workspace.root, "transactions/pending.json")));
});

test("удаление: прерванный каскад приложения завершается перед повтором, ключи не переиспользуются", async (t) => {
  const state = await setup(t);
  const preview = await state.deletion.preview({ kind: "application", ref: state.application.id });
  const command = {
    kind: "application" as const,
    ref: state.application.id,
    ifVersion: preview.version,
    requestId: "interrupted-cascade",
  };
  failWal(t, (stage, path) => {
    if (stage === "file" && path?.startsWith("entities/")) throw new Error("Прерван каскад");
  });
  await assert.rejects(state.deletion.delete(command, "tester"), /Прерван каскад/);
  assert(await exists(join(state.workspace.root, "transactions/pending.json")));
  t.mock.restoreAll();
  await assert.rejects(state.deletion.delete(command, "tester"), { code: "ENTITY_NOT_FOUND" });
  await assert.rejects(state.engine.get({ ref: state.task.id }), { code: "ENTITY_NOT_FOUND" });
  const external = await state.engine.get({ ref: state.external.id });
  if (external.data.kind === "task") assert.equal(external.data.parentId, null);
  assert.ok((await state.engine.get({ ref: state.document.id })).data);
  await state.graph.read({});

  const featurePreview = await state.deletion.preview({ kind: "feature", ref: state.feature.id });
  await state.deletion.delete(
    {
      kind: "feature",
      ref: state.feature.id,
      ifVersion: featurePreview.version,
      requestId: "feature-after-app",
    },
    "tester",
  );
  const next = await state.create({
    kind: "feature",
    name: "Следующая фича",
    summary: "",
    description: "Описание",
  });
  assert.notEqual(next.key, state.feature.key);
  await assert.rejects(
    state.engine.rename(
      { ref: next.key, key: state.feature.key, ifRevision: next.revision, requestId: "reuse" },
      "tester",
    ),
    { code: "ENTITY_KEY_CONFLICT" },
  );
});

test("удаление: чужой проект и неподдерживаемые виды не изменяются", async (t) => {
  const state = await setup(t);
  const other = await fixture(t);
  await assert.rejects(
    new EntityDeletionService(other.workspace).preview({ kind: "task", ref: state.task.id }),
    { code: "ENTITY_NOT_FOUND" },
  );
  await assert.rejects(state.deletion.preview({ kind: "application", ref: "BOARD-INFRA" }));
  assert.equal((await state.engine.get({ ref: state.task.id })).ref.id, state.task.id);
});
