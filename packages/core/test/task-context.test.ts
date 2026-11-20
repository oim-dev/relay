import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { TaskContextService } from "@relay/core/application/board-tasks/context";
import { EntityEngine } from "@relay/core/application/entities/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { taskContextSchema, TASK_CONTEXT_CONTRACT_VERSION } from "@relay/contracts/task-context";
import { fixture } from "./helpers/workspace.js";

/** Продукт с фичей, сценарием, приложением WEB и его FI/SI, задачей и документами. */
async function contextFixture(t: TestContext) {
  const { workspace } = await fixture(t);
  const product = new ProductQueries(workspace);
  const engine = new EntityEngine(workspace);
  const tasks = new BoardTasksService(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "## Каталог\nПолно" },
    },
    "agent",
  );
  const scenario = await product.mutate(
    {
      action: "create",
      requestId: "scenario",
      fields: {
        kind: "scenario",
        featureId: feature.id,
        name: "Фильтр",
        description: "## Фильтр\nПолно",
      },
    },
    "agent",
  );
  const application = await product.mutate(
    {
      action: "create",
      requestId: "web",
      fields: {
        kind: "application",
        slug: "web",
        prefix: "WEB",
        name: "Web",
        summary: "",
        description: "## Приложение\nСайт",
        type: "frontend",
      },
    },
    "agent",
  );
  await product.mutate(
    {
      action: "create",
      requestId: "scope",
      ifVersion: (await product.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: feature.id,
            scenarioId: null,
            title: "Каталог Web",
            description: "## FI\nВклад каталога",
            status: "none",
          },
          {
            featureId: feature.id,
            scenarioId: scenario.id,
            title: "Фильтр Web",
            description: "## SI\nВклад фильтра",
            status: "none",
          },
        ],
      },
    },
    "agent",
  );
  const fi = await product.entity("WEB-FI-1");
  const si = await product.entity("WEB-SI-1");
  const dependency = await tasks.create(
    { board: "web", title: "Основа", requestId: "dependency" },
    "agent",
  );
  const task = await tasks.create(
    {
      board: "web",
      title: "Каталог с фильтром",
      description: "## Цель\nСделать каталог",
      productLinks: [
        { kind: "implementation", id: fi.id },
        { kind: "implementation", id: si.id },
      ],
      dependencies: [dependency.id],
      acceptanceCriteria: [
        { title: "Каталог открыт", summary: "", description: "## Проверка\nОткрыть" },
        { title: "Фильтр работает", summary: "кратко", description: "" },
      ],
      requestId: "task",
    },
    "agent",
  );
  const child = await tasks.create(
    { board: "web", title: "Подзадача", parentId: task.id, requestId: "child" },
    "agent",
  );
  const spec = await engine.create(
    {
      requestId: "spec",
      data: {
        kind: "document",
        name: "ТЗ",
        summary: "",
        body: "# ТЗ\nПолный текст",
        documentKind: "specification",
        relations: [{ target: { kind: "task", id: task.id }, type: "references", description: "" }],
      },
    },
    "agent",
  );
  const rules = await engine.create(
    {
      requestId: "rules",
      data: {
        kind: "document",
        name: "Правила FI",
        summary: "",
        body: "Правила реализации",
        documentKind: "rules",
        relations: [
          { target: { kind: "implementation", id: fi.id }, type: "documents", description: "" },
        ],
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "unrelated",
      data: { kind: "document", name: "Чужое", summary: "", body: "Нет", documentKind: "research" },
    },
    "agent",
  );
  return {
    workspace,
    product,
    tasks,
    feature,
    scenario,
    application,
    fi,
    si,
    task,
    dependency,
    child,
    spec,
    rules,
  };
}

test("контекст задачи: цели FI/SI, требования, приложение, паспорт, документы и критерии", async (t) => {
  const f = await contextFixture(t);
  const service = new TaskContextService(f.workspace);
  const context = await service.read(f.task.key);
  taskContextSchema.parse(context);
  assert.equal(context.contractVersion, TASK_CONTEXT_CONTRACT_VERSION);
  assert.equal(context.complete, true);
  assert.equal(context.task.id, f.task.id);
  assert.equal(context.task.description, "## Цель\nСделать каталог");
  assert.deepEqual(
    context.task.criteria.map((criterion) => [criterion.title, criterion.description]),
    [
      ["Каталог открыт", "## Проверка\nОткрыть"],
      ["Фильтр работает", ""],
    ],
  );
  // ID критериев совпадают с адресным чтением критерия.
  const page = await f.tasks.listCriteria(f.task.id);
  assert.deepEqual(
    context.task.criteria.map((criterion) => criterion.id),
    page.items.map((criterion) => criterion.id),
  );

  assert.deepEqual(
    context.targets.map(({ record, reasons }) => [record.key, reasons.map((r) => r.code)]),
    [
      ["WEB-FI-1", ["task-target"]],
      ["WEB-SI-1", ["task-target"]],
    ],
  );
  const fiRecord = context.targets[0]!.record;
  assert.equal(fiRecord.data.kind, "implementation");
  assert(
    fiRecord.data.kind === "implementation" && fiRecord.data.description.includes("Вклад каталога"),
  );
  assert.deepEqual(
    context.requirements.map(({ record, reasons }) => [
      record.ref.kind,
      record.ref.id,
      reasons.map((reason) => `${reason.code}<${reason.from?.id}`),
    ]),
    [
      ["feature", f.feature.id, [`target-feature<${f.fi.id}`, `target-feature<${f.si.id}`]],
      ["scenario", f.scenario.id, [`target-scenario<${f.si.id}`]],
    ],
  );
  const featureRecord = context.requirements[0]!.record;
  assert(
    featureRecord.data.kind === "feature" && featureRecord.data.description === "## Каталог\nПолно",
  );
  assert.deepEqual(
    context.applications.map(({ record }) => [record.ref.id, record.revision]),
    [[f.application.id, (await f.product.entity(f.application.id)).revision]],
  );
  assert.equal(context.product?.record.ref.kind, "product");
  assert.deepEqual(context.product?.reasons, [{ code: "product-passport", from: null }]);
  // По умолчанию только документы самой задачи; несвязанные не попадают.
  assert.deepEqual(
    context.documents.map(({ record, reasons }) => [record.ref.id, reasons]),
    [[f.spec.ref.id, [{ code: "task-document", from: null }]]],
  );
  const spec = context.documents[0]!.record;
  assert(spec.data.kind === "document" && spec.data.body === "# ТЗ\nПолный текст");
  assert.deepEqual(
    context.dependencies.map((task) => [task.id, task.column]),
    [[f.dependency.id, "inbox"]],
  );
  assert.deepEqual(
    context.children.map((task) => task.id),
    [f.child.id],
  );
  assert.equal("description" in context.dependencies[0]!, false);
  // Запись не повторяется между разделами.
  const all = [
    ...context.targets,
    ...context.requirements,
    ...context.applications,
    ...(context.product ? [context.product] : []),
    ...context.documents,
  ].map(({ record }) => `${record.ref.kind}:${record.ref.id}`);
  assert.equal(new Set(all).size, all.length);

  const withTargets = await service.read(f.task.id, { targetDocuments: "true" });
  assert.deepEqual(
    withTargets.documents.map(({ record, reasons }) => [record.ref.id, reasons]),
    [
      [f.spec.ref.id, [{ code: "task-document", from: null }]],
      [
        f.rules.ref.id,
        [{ code: "target-document", from: { kind: "implementation", id: f.fi.id } }],
      ],
    ],
  );
  assert.notEqual(withTargets.consistency, context.consistency);
});

test("контекст задачи: отпечаток меняется при правке цели и не меняется без изменений", async (t) => {
  const f = await contextFixture(t);
  const service = new TaskContextService(f.workspace);
  const before = await service.read(f.task.key);
  assert.equal((await service.read(f.task.id)).consistency, before.consistency);
  const fi = await f.product.entity("WEB-FI-1");
  await f.product.updateImplementation(
    {
      ref: "WEB-FI-1",
      ifRevision: fi.revision,
      description: "## FI\nНовый вклад",
      requestId: "edit",
    },
    "agent",
  );
  const after = await service.read(f.task.key);
  assert.notEqual(after.consistency, before.consistency);
  assert.equal(after.targets[0]!.record.revision, before.targets[0]!.record.revision + 1);
  const target = after.targets[0]!.record;
  assert(target.data.kind === "implementation" && target.data.description === "## FI\nНовый вклад");
});

test("контекст задачи: фича и сценарий как прямые цели, пустая задача и неизвестный адрес", async (t) => {
  const f = await contextFixture(t);
  const service = new TaskContextService(f.workspace);
  const direct = await f.tasks.create(
    {
      board: "product",
      productLinks: [
        { kind: "scenario", id: f.scenario.id },
        { kind: "feature", id: f.feature.id },
      ],
      requestId: "direct",
    },
    "agent",
  );
  const context = await service.read(direct.key);
  // Фича — сама цель; основание владельца сценария добавляется к той же записи.
  assert.deepEqual(
    context.targets.map(({ record, reasons }) => [record.ref.kind, reasons.map((r) => r.code)]),
    [
      ["scenario", ["task-target"]],
      ["feature", ["task-target", "target-feature"]],
    ],
  );
  assert.deepEqual(context.requirements, []);
  assert.deepEqual(context.applications, []);

  const empty = await f.tasks.create({ board: "web", requestId: "empty" }, "agent");
  const bare = await service.read(empty.id);
  assert.deepEqual(
    [bare.targets, bare.requirements, bare.applications, bare.documents, bare.task.criteria],
    [[], [], [], [], []],
  );
  assert.equal(bare.product?.record.ref.kind, "product");

  // Тот же отказ, что у прежнего чтения задачи.
  await assert.rejects(f.tasks.get("WEB-999"), { code: "NOT_FOUND" });
  await assert.rejects(service.read("WEB-999"), { code: "NOT_FOUND" });
  await assert.rejects(service.read(f.task.id, { targetDocuments: "yes" as "true" }), {
    code: "VALIDATION_ERROR",
  });
});
