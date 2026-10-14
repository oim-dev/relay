import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EntityDeletionQuery, EntityDeletionPreview } from "@relay/contracts/entities";
import type { Backend } from "../../src/backend/types.js";

export async function persistentFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "runtime") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory())
      for (const [child, value] of Object.entries(await persistentFiles(path)))
        files[join(entry.name, child)] = value;
    else files[entry.name] = (await readFile(path)).toString("base64");
  }
  return files;
}

/** Один связанный набор для проверки адаптеров, без обхода предметных операций. */
export async function deletionFixture(backend: Backend) {
  const create = (data: Parameters<Backend["entities"]["create"]>[0]["data"]) =>
    backend.entities.create({ data, requestId: crypto.randomUUID() }, "fixture");
  const feature = await create({
    kind: "feature",
    name: "Общая фича",
    summary: "",
    description: "Требование",
  });
  const scenario = await create({
    kind: "scenario",
    featureId: feature.key,
    name: "Общий сценарий",
    description: "Шаги",
  });
  const application = await create({
    kind: "application",
    name: "Приложение 東京 🧪",
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
    title: "FI",
    description: "Вклад фичи",
  });
  const si = await create({
    kind: "implementation",
    application: application.key,
    target: scenario.key,
    title: "SI",
    description: "Вклад сценария",
  });
  const task = await create({
    kind: "task",
    board: "BOARD-WEB",
    title: "Работа FI",
    targets: [implementation.key],
  });
  const second = await create({
    kind: "task",
    board: "BOARD-WEB",
    title: "Работа SI",
    targets: [si.key],
  });
  const external = await create({
    kind: "task",
    board: "BOARD-INFRA",
    title: "Внешняя",
    parent: task.key,
    related: [task.key],
  });
  const dependent = await create({
    kind: "task",
    board: "BOARD-INFRA",
    title: "Зависимая",
    dependencies: [second.key],
  });
  const body = "## Сохранить 東京 🧪\n\nТекст  \n";
  const document = await create({
    kind: "document",
    name: "Общий документ",
    summary: "",
    body,
    documentKind: "rules",
    pinned: true,
    targets: [feature.key, si.key],
    relations: [
      { target: application.ref, type: "documents", description: "Приложение" },
      { target: task.ref, type: "references", description: "Задача" },
    ],
  });
  const board = await backend.entities.resolve({ ref: "BOARD-WEB" });
  return {
    feature,
    scenario,
    application,
    implementation,
    si,
    task,
    second,
    external,
    dependent,
    document,
    board,
    body,
  };
}

export async function assertDeletion(
  backend: Backend,
  fixture: Awaited<ReturnType<typeof deletionFixture>>,
  kind: EntityDeletionQuery["kind"],
  actor = "delete-author",
  override = false,
) {
  const target = fixture[kind];
  const query = { kind, ref: target.key };
  const preview: EntityDeletionPreview = await backend.deletion.preview(query);
  const expected = {
    feature: [fixture.feature, fixture.scenario, fixture.implementation, fixture.si],
    scenario: [fixture.scenario, fixture.si],
    application: [
      fixture.application,
      fixture.board,
      fixture.implementation,
      fixture.si,
      fixture.task,
      fixture.second,
    ],
    implementation: [fixture.implementation, fixture.si],
    task: [fixture.task],
    document: [fixture.document],
  }[kind];
  assert.deepEqual(
    new Set(preview.deleted.map((entry) => entry.ref.id)),
    new Set(expected.map((entry) => entry.ref.id)),
  );
  const graph = await backend.graph.read({ limit: 100 });
  assert.equal(graph.edges.length, graph.totalEdges);
  const removed = new Set(expected.map((entry) => entry.ref.id));
  const removedEdges = graph.edges.filter(
    (edge) => removed.has(edge.from.id) || removed.has(edge.to.id),
  );
  assert.equal(preview.relations, removedEdges.length);
  const detached = new Set(
    removedEdges.flatMap((edge) => [edge.from.id, edge.to.id]).filter((id) => !removed.has(id)),
  );
  assert.deepEqual(new Set(preview.detached.map((entry) => entry.ref.id)), detached);
  if (kind === "application") {
    assert.deepEqual(
      detached,
      new Set(
        [
          fixture.feature,
          fixture.scenario,
          fixture.external,
          fixture.dependent,
          fixture.document,
        ].map((entry) => entry.ref.id),
      ),
    );
    assert.equal(
      preview.detached.find((entry) => entry.ref.id === fixture.document.ref.id)?.document?.pinned,
      true,
    );
  }
  const receipt = await backend.deletion.delete(
    {
      ...query,
      ifVersion: preview.version,
      requestId: `delete-${kind}`,
      ...(override ? { actor } : {}),
    },
    override ? "unused-author" : actor,
  );
  assert.deepEqual(receipt, {
    action: "delete",
    ref: target.ref,
    requestId: `delete-${kind}`,
    deleted: expected.length,
    detached: detached.size,
    relations: removedEdges.length,
  });
  for (const entry of expected)
    await assert.rejects(backend.entities.get({ ref: entry.key }), { code: "ENTITY_NOT_FOUND" });
  const afterGraph = await backend.graph.read({ limit: 100 });
  assert.deepEqual(
    new Set(afterGraph.edges.map((edge) => edge.id)),
    new Set(graph.edges.filter((edge) => !removedEdges.includes(edge)).map((edge) => edge.id)),
  );
  if (kind === "application") {
    for (const entry of [fixture.feature, fixture.scenario])
      assert.equal((await backend.entities.get({ ref: entry.key })).ref.id, entry.ref.id);
    for (const entry of [fixture.external, fixture.dependent]) {
      const task = await backend.boardTasks.get(entry.key);
      assert.equal(task.parentId, null);
      assert.deepEqual(task.dependencies, []);
      assert.deepEqual(task.related, []);
      assert.equal(task.updatedBy, actor);
    }
  }
  if (kind !== "document") {
    const document = await backend.entities.get({ ref: fixture.document.key });
    assert.equal(document.data.kind, "document");
    if (document.data.kind === "document") {
      assert.equal(document.data.body, fixture.body);
      if (kind === "application") {
        assert.deepEqual(document.data.relations, []);
        assert.deepEqual(document.data.links, [{ kind: "feature", id: fixture.feature.ref.id }]);
      }
    }
  }
  return { preview, receipt };
}
