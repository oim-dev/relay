import assert from "node:assert/strict";
import { test } from "node:test";
import { EntityEngine } from "@relay/core/application/entities/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { TaskContextService } from "@relay/core/application/board-tasks/context";
import { TASK_CONTEXT_CAPABILITY, taskContextSchema } from "@relay/contracts/task-context";
import { fixture } from "./helpers/server.js";

test("HTTP контекста задачи: local/scoped, равенство с Core, параметры и ошибки", async (t) => {
  const { app, workspace, tasks } = await fixture(t);
  const product = new ProductQueries(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "## Фича" },
    },
    "agent",
  );
  const task = await tasks.create(
    {
      board: "product",
      title: "Задача",
      description: "## Цель",
      productLinks: [{ kind: "feature", id: feature.id }],
      acceptanceCriteria: [{ title: "Проверено", summary: "", description: "## Как" }],
      requestId: "task",
    },
    "agent",
  );
  await new EntityEngine(workspace).create(
    {
      requestId: "doc",
      data: {
        kind: "document",
        name: "ТЗ",
        summary: "",
        body: "# ТЗ",
        documentKind: "specification",
        relations: [{ target: { kind: "task", id: task.id }, type: "references", description: "" }],
      },
    },
    "agent",
  );
  await new EntityEngine(workspace).create(
    {
      requestId: "feature-doc",
      data: {
        kind: "document",
        name: "Правила фичи",
        summary: "",
        body: "# Правила",
        documentKind: "rules",
        relations: [
          { target: { kind: "feature", id: feature.id }, type: "documents", description: "" },
        ],
      },
    },
    "agent",
  );
  const projectId = workspace.config.projectId;
  const context = await app.inject(`/api/v1/projects/${projectId}/context`);
  assert(context.json().data.capabilities.includes(TASK_CONTEXT_CAPABILITY));

  const expected = await new TaskContextService(workspace).read(task.id);
  for (const base of ["/api/v1", `/api/v1/projects/${projectId}`]) {
    const response = await app.inject(`${base}/board-tasks/${task.key}/context`);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(taskContextSchema.parse(body.data), expected);
    assert.equal(body.data.contractVersion, 1);
    assert.deepEqual(
      [body.data.targets.length, body.data.documents.length, body.data.task.criteria.length],
      [1, 1, 1],
    );
  }
  const withTargets = await app.inject(
    `/api/v1/projects/${projectId}/board-tasks/${task.id}/context?targetDocuments=true`,
  );
  assert.equal(withTargets.statusCode, 200, withTargets.body);
  assert.deepEqual(
    withTargets
      .json()
      .data.documents.map((item: { record: { title: string } }) => item.record.title),
    ["ТЗ", "Правила фичи"],
  );
  assert.deepEqual(
    taskContextSchema.parse(withTargets.json().data),
    await new TaskContextService(workspace).read(task.id, { targetDocuments: "true" }),
  );
  const invalid = await app.inject(
    `/api/v1/projects/${projectId}/board-tasks/${task.id}/context?targetDocuments=yes`,
  );
  assert.equal(invalid.statusCode, 400, invalid.body);
  const unknownParameter = await app.inject(
    `/api/v1/projects/${projectId}/board-tasks/${task.id}/context?depth=2`,
  );
  assert.equal(unknownParameter.statusCode, 400, unknownParameter.body);
  const missing = await app.inject(`/api/v1/projects/${projectId}/board-tasks/PRODUCT-404/context`);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().ok, false);

  // Прежнее чтение задачи не меняется.
  const plain = await app.inject(`/api/v1/projects/${projectId}/board-tasks/${task.id}`);
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.json().data.criteria, undefined);
  assert.deepEqual(plain.json().data, await tasks.get(task.id));
});

test("OpenAPI объявляет контекст задачи local и scoped", async (t) => {
  const { app } = await fixture(t);
  const spec = (await app.inject("/api/openapi.json")).json();
  const local = spec.paths["/api/v1/board-tasks/{reference}/context"]?.get;
  const scoped = spec.paths["/api/v1/projects/{project}/board-tasks/{reference}/context"]?.get;
  assert.equal(local?.operationId, "getBoardTaskContext");
  assert.equal(scoped?.operationId, "getBoardTaskContextForProject");
  assert(spec.components.schemas.TaskContext);
  assert(spec.components.schemas.TaskContextQuery);
});
