import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { EntityEngine } from "@relay/core/application/entities/service";
import { fixture } from "./helpers/server.js";

test("HTTP движка: ключи/ID, вложенные ссылки, граф, алиасы и общий backend", async (t) => {
  const { app, workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "f",
      data: { kind: "feature", name: "Фича", summary: "Кратко", description: "Полное описание" },
    },
    "agent",
  );
  const task = await engine.create(
    {
      requestId: "t",
      data: { kind: "task", board: "BOARD-PRODUCT", targets: [feature.key], title: "Работа" },
    },
    "agent",
  );
  const prefix = `/api/v1/projects/${workspace.config.projectId}/entities`;
  const byKey = await app.inject(`${prefix}/get?ref=${task.key}`);
  const byId = await app.inject(`${prefix}/get?ref=${task.ref.id}`);
  assert.equal(byKey.statusCode, 200, byKey.body);
  assert.deepEqual(byKey.json(), byId.json());
  assert.equal(
    byKey.json().data.references.find((entry: { key: string }) => entry.key === feature.key)?.ref
      .id,
    feature.ref.id,
  );
  const command = { ref: task.key, key: "TASK-WEB-23", ifRevision: 1, requestId: "rename" };
  const renamed = await app.inject({ method: "POST", url: `${prefix}/rename`, payload: command });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(
    (await app.inject({ method: "POST", url: `${prefix}/rename`, payload: command })).statusCode,
    409,
  );
  const context = await app.inject(`/api/v1/graph?root=${task.key}&depth=3&profile=context`);
  assert.equal(context.statusCode, 200, context.body);
  assert.ok(
    context.json().data.nodes.some((entry: { key: string }) => entry.key === "TASK-WEB-23"),
  );
  assert.equal(context.json().data.totalNodes, 5);
  assert.equal(context.json().data.totalEdges, 4);
  assert.ok(
    context
      .json()
      .data.edges.some(
        (edge: { type: string; to: { id: string } }) =>
          edge.type === "implements" && edge.to.id === feature.ref.id,
      ),
  );
  const full = await app.inject(`/api/v1/graph/context?root=${task.key}`);
  assert.equal(full.statusCode, 200, full.body);
  assert.equal(full.json().data.complete, true);
  assert.equal(full.json().data.edges.length, 4);
  const linked = await app.inject({
    method: "POST",
    url: "/api/v1/graph",
    payload: {
      ifVersion: context.json().data.version,
      requestId: "by-keys",
      operations: [{ action: "add", from: "TASK-WEB-23", to: feature.key, type: "references" }],
    },
  });
  assert.equal(linked.statusCode, 200, linked.body);
  const graph = (await app.inject(`/api/v1/graph?root=${task.ref.id}`)).json().data;
  assert.ok(graph.nodes.some((entry: { key: string }) => entry.key === feature.key));
  assert.ok(
    graph.edges.some(
      (edge: { source: string; from: { id: string }; to: { id: string } }) =>
        edge.source === "graph" && edge.from.id === task.ref.id && edge.to.id === feature.ref.id,
    ),
  );
  assert.equal((await app.inject(`${prefix}/get?ref=MISSING-8`)).statusCode, 404);
  assert.equal((await app.inject(`${prefix}?kind=feature&board=BOARD-PRODUCT`)).statusCode, 400);
  await app.listen(0, "127.0.0.1");
  const backend = await createHttpBackend(await app.getUrl());
  assert.deepEqual(
    await backend.entities.get({ ref: task.key }),
    await engine.get({ ref: task.ref.id }),
  );
  const types = await backend.entities.types();
  assert.equal(types.total, 11);
  assert(!types.items.some((entry) => String(entry.kind) === "plan-stage"));
  assert.equal((await backend.graph.context({ root: task.key })).complete, true);
});

test("HTTP предметных операций: product, entities и канбан сохраняют граф без второго клиентского запроса", async (t) => {
  const { app } = await fixture(t);
  await app.listen(0, "127.0.0.1");
  const backend = await createHttpBackend(await app.getUrl());
  const feature = await backend.product.mutate(
    {
      action: "create",
      requestId: "f-http",
      fields: { kind: "feature", name: "Поиск", summary: "", description: "Требования поиска" },
    },
    "agent",
  );
  const scenario = await backend.entities.create(
    {
      requestId: "s-http",
      data: {
        kind: "scenario",
        featureId: feature.id,
        name: "Найти товар",
        description: "Поведение",
      },
    },
    "agent",
  );
  const task = await backend.boardTasks.create(
    {
      board: "product",
      requestId: "t-http",
      title: "Реализовать",
      productLinks: [{ kind: "scenario", id: scenario.ref.id }],
    },
    "agent",
  );
  const document = await backend.entities.create(
    {
      requestId: "d-http",
      data: {
        kind: "document",
        name: "Правила",
        summary: "",
        body: "## Проверка\n",
        documentKind: "rules",
        relations: [
          { type: "references", target: { kind: "task", id: task.id }, description: "Прочитать" },
        ],
      },
    },
    "agent",
  );
  const context = await backend.graph.context({ root: feature.id });
  assert.equal(context.complete, true);
  assert.ok(
    context.edges.some(
      (edge) =>
        edge.type === "part-of" && edge.from.id === feature.id && edge.to.kind === "product",
    ),
  );
  assert.ok(
    context.edges.some(
      (edge) =>
        edge.type === "part-of" && edge.from.kind === "product" && edge.to.kind === "project",
    ),
  );
  for (const id of [feature.id, scenario.ref.id, task.id, document.ref.id])
    assert.ok(context.nodes.some((node) => node.ref.id === id));
  const savedLink = context.edges.find((edge) => edge.to.id === document.ref.id)!;
  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/graph",
    payload: {
      ifVersion: context.version,
      requestId: "direct-unlink",
      operations: [{ action: "remove", id: savedLink.id }],
    },
  });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(denied.json().error.code, "RELATION_MANAGED");
  const update = {
    ref: document.key,
    requestId: "detach-http",
    ifRevision: document.revision,
    changes: { kind: "document" as const, relations: [] },
  };
  const detached = await backend.entities.update(update, "agent");
  await assert.rejects(backend.entities.update(update, "agent"), { code: "REVISION_CONFLICT" });
  assert.equal((await backend.graph.context({ root: document.key })).edges.length, 0);
  const clearTask = { requestId: "clear-http", ifRevision: task.revision, productLinks: [] };
  await backend.boardTasks.update(task.key, clearTask, "agent");
  const remaining = await backend.graph.context({ root: feature.id });
  assert.ok(!remaining.nodes.some((node) => node.ref.id === task.id));
  assert.equal((await backend.entities.get({ ref: document.key })).revision, detached.revision);
});
