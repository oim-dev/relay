import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EntityEngine } from "@relay/core/application/entities/service";
import { entityKinds } from "@relay/contracts/entities";
import { fixture } from "./helpers/workspace.js";
import { resolveAddress } from "@relay/core/application/entities/resolver";

test("резолвер: уточнённый постоянный ID разрешает коллизию с читаемым ключом", () => {
  const entries = [
    { ref: { kind: "task", id: "ABCDEFGH" }, key: "TASK-1" },
    { ref: { kind: "task", id: "IJKLMNOP" }, key: "ABCDEFGH" },
  ];
  assert.throws(() => resolveAddress(entries, "ABCDEFGH"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
  assert.equal(resolveAddress(entries, "task:ABCDEFGH").key, "TASK-1");
  assert.equal(resolveAddress(entries, { kind: "task", id: "ABCDEFGH" }).key, "TASK-1");
});

async function productFixture(t: TestContext) {
  const base = await fixture(t);
  const engine = new EntityEngine(base.workspace);
  const product = await engine.create(
    {
      requestId: "product",
      data: {
        kind: "product",
        name: "Аренда",
        summary: "Сервис\nаренды",
        description: "## Назначение\n\nОписание  \n",
      },
    },
    "agent",
  );
  const feature = await engine.create(
    {
      requestId: "feature",
      data: {
        kind: "feature",
        name: "Бронирование",
        summary: "Оформление",
        description: "Правила бронирования",
      },
    },
    "agent",
  );
  const scenario = await engine.create(
    {
      requestId: "scenario",
      data: {
        kind: "scenario",
        featureId: feature.key,
        name: "Подтверждение",
        description: "Пользователь подтверждает заказ",
      },
    },
    "agent",
  );
  const application = await engine.create(
    {
      requestId: "application",
      data: {
        kind: "application",
        name: "Web",
        summary: "Клиент",
        description: "Браузерное приложение",
        slug: "web",
        prefix: "WEB",
        type: "frontend",
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "implementation-feature",
      data: {
        kind: "implementation",
        application: application.key,
        target: feature.key,
        title: "Общий вклад",
        description: "Общий интерфейс бронирования",
      },
    },
    "agent",
  );
  const implementation = await engine.create(
    {
      requestId: "implementation-scenario",
      data: {
        kind: "implementation",
        application: application.key,
        target: scenario.key,
        title: "Форма подтверждения",
        description: "Описание формы",
      },
    },
    "agent",
  );
  const document = await engine.create(
    {
      requestId: "document",
      data: {
        kind: "document",
        name: "Правила",
        summary: "Ограничения",
        body: "## Правила\n\n  Точный текст\n",
        documentKind: "rules",
        targets: [feature.key, implementation.key],
      },
    },
    "agent",
  );
  const dependency = await engine.create(
    {
      requestId: "dependency",
      data: { kind: "task", board: "BOARD-INFRA", title: "Подготовить стенд" },
    },
    "agent",
  );
  const task = await engine.create(
    {
      requestId: "task",
      data: {
        kind: "task",
        board: "BOARD-WEB",
        title: "Сделать форму",
        targets: [implementation.key],
        dependencies: [dependency.key],
        description: "## Работа\n\nСохранить Markdown  \n",
      },
    },
    "agent",
  );
  return {
    ...base,
    engine,
    product,
    feature,
    scenario,
    application,
    implementation,
    document,
    dependency,
    task,
  };
}

test("движок: определения и типизированные схемы из общего источника", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const types = await engine.types();
  assert.deepEqual(new Set(types.items.map((item) => item.kind)), new Set(entityKinds));
  for (const kind of entityKinds) {
    const definition = await engine.describe({ kind });
    assert.ok(definition.description);
    assert.equal(definition.schema.type, "object");
    if (["work-plan", "release"].includes(kind)) {
      assert.equal(definition.createSchema, null);
      assert.ok(definition.actions.includes(kind === "release" ? "releases" : "planning"));
    } else assert.ok(definition.actions.includes("rename"));
  }
  const task = await engine.describe({ kind: "task" });
  assert.ok(task.filters.includes("board"));
  assert.ok(task.createSchema);
  const emptyProduct = await engine.get({ ref: "PRODUCT" });
  assert.equal(emptyProduct.status, "uninitialized");
  assert.equal(emptyProduct.ref.id, "passport");
});

test("движок: все виды, вложенные ссылки ключ/ID, данные, фильтры и страницы одного снимка", async (t) => {
  const app = await productFixture(t);
  const { engine } = app;
  const all = await engine.list();
  assert.deepEqual(
    new Set(all.items.map((entry) => entry.ref.kind)),
    new Set(entityKinds.filter((kind) => !["work-plan", "release"].includes(kind))),
  );
  for (const item of all.items) {
    assert.deepEqual(await engine.get({ ref: item.key }), await engine.get({ ref: item.ref.id }));
    assert.deepEqual(await engine.resolve({ ref: `${item.ref.kind}:${item.ref.id}` }), item);
  }
  const task = await engine.get({ ref: app.task.key });
  assert.equal(task.data.kind, "task");
  if (task.data.kind !== "task") return;
  assert.equal(task.data.dependencies[0], app.dependency.ref.id);
  assert.equal(task.data.productLinks[0]?.id, app.implementation.ref.id);
  assert.equal(
    (await engine.list({ kind: "task", board: "BOARD-WEB", target: app.implementation.key })).total,
    1,
  );
  const board = await engine.resolve({ ref: "BOARD-WEB" });
  assert.deepEqual(
    await engine.list({ kind: "task", board: board.ref.id }),
    await engine.list({ kind: "task", board: board.key }),
  );
  await assert.rejects(engine.list({ kind: "feature", board: board.key }), {
    code: "UNSUPPORTED_ENTITY_FILTER",
  });
  await assert.rejects(engine.get({ ref: app.feature.key, kind: "task" }), {
    code: "ENTITY_KIND_MISMATCH",
  });
  const first = await engine.list({ limit: 2 });
  const second = await engine.list({ limit: 2, offset: first.nextOffset!, version: first.version });
  assert.notDeepEqual(first.items, second.items);
  assert.ok(!JSON.stringify(first.items).includes("Правила бронирования"));
  await engine.update(
    {
      ref: app.feature.key,
      ifRevision: app.feature.revision,
      requestId: "change-feature",
      changes: { kind: "feature", summary: "Другая сводка" },
    },
    "agent",
  );
  await assert.rejects(engine.list({ offset: 2, limit: 2, version: first.version }), {
    code: "ENTITIES_CHANGED",
  });
  const disk = JSON.parse(
    await readFile(
      join(app.root, ".relay", "entities", "tasks", `${task.ref.id}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(disk.data.description, ["## Работа", "", "Сохранить Markdown  ", ""]);
  assert.equal(disk.schemaVersion, 2);
});

test("движок: смена формата ключей всех видов, алиасы, точный повтор и сохранность ссылок", async (t) => {
  const { engine, task, implementation } = await productFixture(t);
  const all = await engine.list();
  for (const kind of new Set(all.items.map((entry) => entry.ref.kind))) {
    const entry = all.items.find((item) => item.ref.kind === kind)!;
    const command = {
      ref: entry.key,
      key: `NEW-${kind.toUpperCase()}-23`,
      ifRevision: entry.revision,
      requestId: `rename-${kind}`,
    };
    const saved = await engine.rename(command, "agent");
    assert.equal(saved.ref.id, entry.ref.id);
    assert.deepEqual(await engine.rename(command, "agent"), saved);
    assert.equal((await engine.get({ ref: entry.key })).key, command.key);
    assert.equal((await engine.get({ ref: entry.ref.id })).key, command.key);
    assert.deepEqual(
      (await engine.keys({ ref: command.key })).items.map((item) => item.key),
      [command.key, entry.key],
    );
  }
  const data = (await engine.get({ ref: task.ref.id })).data;
  assert.equal(data.kind, "task");
  if (data.kind === "task") assert.equal(data.productLinks[0]?.id, implementation.ref.id);
  const entry = await engine.get({ ref: task.ref.id });
  await assert.rejects(
    engine.rename(
      { ref: task.ref.id, key: "FEATURE-1", ifRevision: entry.revision, requestId: "steal-alias" },
      "agent",
    ),
    { code: "ENTITY_KEY_CONFLICT" },
  );
});

test("движок: атомарное создание связанной задачи, конкуренция и изоляция", async (t) => {
  const { engine, task, dependency } = await productFixture(t);
  const before = (await engine.list({ kind: "task" })).total;
  await assert.rejects(
    engine.create(
      {
        requestId: "invalid",
        data: { kind: "task", board: "BOARD-WEB", title: "Отказ", dependencies: ["MISSING-42"] },
      },
      "agent",
    ),
    { code: "ENTITY_NOT_FOUND" },
  );
  assert.equal((await engine.list({ kind: "task" })).total, before);
  await assert.rejects(
    engine.moveTask(
      { ref: task.key, column: "done", ifRevision: task.revision, requestId: "blocked" },
      "agent",
    ),
    { code: "TASK_BLOCKED" },
  );
  await engine.moveTask(
    { ref: dependency.key, column: "done", ifRevision: dependency.revision, requestId: "unblock" },
    "agent",
  );
  const attempts = await Promise.allSettled(
    ["a", "b"].map((requestId) =>
      engine.update(
        {
          ref: task.key,
          ifRevision: task.revision,
          requestId,
          changes: { kind: "task", title: requestId },
        },
        "agent",
      ),
    ),
  );
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  const updated = (await engine.get({ ref: task.key })).data;
  assert.ok(
    updated.kind === "task" && updated.productLinks.length === 1,
    "Изменение заголовка сохраняет цели реализации",
  );
  const other = new EntityEngine((await fixture(t)).workspace);
  await assert.rejects(other.get({ ref: task.key }), { code: "ENTITY_NOT_FOUND" });
  assert.equal(
    (await engine.keySpaces({ kind: "task" })).items.find((item) => item.prefix === "WEB")?.pattern,
    "WEB-<номер>",
  );
});

test("движок: назначение номера учитывает ключи и алиасы других видов", async (t) => {
  const { engine, task, document } = await productFixture(t);
  await engine.rename(
    { ref: document.key, key: "PRODUCT-9", ifRevision: 1, requestId: "reserve-task-key" },
    "agent",
  );
  const createdTask = await engine.create(
    { requestId: "skip-reserved-task-key", data: { kind: "task", board: "BOARD-PRODUCT" } },
    "agent",
  );
  assert.equal(createdTask.key, "PRODUCT-10");
  await engine.rename(
    { ref: task.key, key: "FEATURE-99", ifRevision: 1, requestId: "reserve-feature-key" },
    "agent",
  );
  assert.equal((await engine.resolve({ ref: "FEATURE-99" })).ref.kind, "task");
  const feature = await engine.create(
    {
      requestId: "skip-reserved-feature-key",
      data: { kind: "feature", name: "Следующая фича", summary: "", description: "Описание" },
    },
    "agent",
  );
  assert.equal(feature.key, "FEATURE-100");
});
