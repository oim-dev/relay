import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "../src/application/storage/service.js";
import { failWal } from "./helpers/wal.js";
import { exists } from "../src/storage/files.js";
import { test } from "node:test";
import { readFile, access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { ProductService } from "@relay/core/application/product/service";
import { BoardsService } from "@relay/core/application/boards/service";
import { fixture } from "./helpers/workspace.js";

test("подзадачи блокируют завершение родителя, отмена не готовность, повторное открытие пересчитывает блокеры", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const parent = await service.create(
    { board: "product", column: "ready", requestId: "parent" },
    "agent",
  );
  const child = await service.create(
    { board: "infrastructure", parentId: parent.id, requestId: "child" },
    "agent",
  );
  assert.deepEqual((await service.get(parent.id)).dependencies, []);
  assert.deepEqual((await service.get(parent.id)).blockers, [child.id]);
  assert.equal((await service.list({ readiness: "ready" })).total, 0);
  await assert.rejects(
    service.move(parent.id, { column: "done", ifRevision: 1, requestId: "blocked" }, "agent"),
    { code: "TASK_BLOCKED" },
  );
  await service.move(
    child.id,
    { column: "cancelled", ifRevision: 1, requestId: "cancel" },
    "agent",
  );
  assert.equal((await service.get(parent.id)).blocked, true);
  await service.move(
    child.id,
    { column: "done", ifRevision: 2, requestId: "finish-child" },
    "agent",
  );
  assert.equal((await service.get(parent.id)).ready, true);
  assert.equal((await service.get(parent.id)).column, "ready");
  await service.move(
    parent.id,
    { column: "done", ifRevision: 1, requestId: "finish-parent" },
    "agent",
  );
  await service.move(child.id, { column: "ready", ifRevision: 3, requestId: "reopen" }, "agent");
  const reopened = await service.get(parent.id);
  assert.equal(reopened.column, "done");
  assert.deepEqual(reopened.blockers, [child.id]);
});

test("привязка и создание подзадачи защищают готового родителя; удаление и смена родителя снимают блокер", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const finished = await service.create(
    { board: "product", column: "done", requestId: "finished" },
    "agent",
  );
  const parent = await service.create({ board: "product", requestId: "parent" }, "agent");
  const other = await service.create({ board: "product", requestId: "other" }, "agent");
  const child = await service.create({ board: "infrastructure", requestId: "child" }, "agent");
  await assert.rejects(
    service.create(
      { board: "product", parentId: finished.id, requestId: "invalid-create" },
      "agent",
    ),
    { code: "TASK_BLOCKED" },
  );
  await assert.rejects(
    service.link(
      child.id,
      { target: finished.id, relation: "parent", ifRevision: 1, requestId: "invalid-link" },
      "agent",
    ),
    { code: "TASK_BLOCKED" },
  );
  const command = {
    target: parent.id,
    relation: "parent" as const,
    ifRevision: 1,
    requestId: "link",
  };
  const saved = await service.link(child.id, command, "agent");
  assert.deepEqual(await service.link(child.id, command, "agent"), saved);
  assert.equal((await service.get(parent.id)).blocked, true);
  await assert.rejects(
    service.link(child.id, { ...command, target: other.id, requestId: "stale" }, "agent"),
    { code: "REVISION_CONFLICT" },
  );
  await service.link(
    child.id,
    { ...command, target: other.id, ifRevision: 2, requestId: "reparent" },
    "agent",
  );
  assert.equal((await service.get(parent.id)).blocked, false);
  assert.equal((await service.get(other.id)).blocked, true);
  await service.link(
    child.id,
    { ...command, target: other.id, remove: true, ifRevision: 3, requestId: "unlink" },
    "agent",
  );
  assert.equal((await service.get(other.id)).blocked, false);
  assert.equal((await service.get(child.id)).parentId, null);
  await service.create(
    { board: "product", parentId: finished.id, column: "done", requestId: "finished-child" },
    "agent",
  );
  assert.equal((await service.get(finished.id)).blocked, false);
});

test("смешанные циклы подзадач и зависимостей запрещены, один блокер не дублируется", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const parent = await service.create({ board: "product", requestId: "parent" }, "agent");
  const child = await service.create(
    { board: "infrastructure", parentId: parent.id, requestId: "child" },
    "agent",
  );
  await service.link(
    parent.id,
    { target: child.id, relation: "depends-on", ifRevision: 1, requestId: "duplicate-edge" },
    "agent",
  );
  assert.deepEqual((await service.get(parent.id)).blockers, [child.id]);
  await assert.rejects(
    service.link(
      child.id,
      { target: parent.id, relation: "depends-on", ifRevision: 1, requestId: "cycle" },
      "agent",
    ),
    { code: "DEPENDENCY_CYCLE" },
  );
  await assert.rejects(
    service.create(
      {
        board: "product",
        parentId: parent.id,
        dependencies: [parent.id],
        requestId: "create-cycle",
      },
      "agent",
    ),
    { code: "DEPENDENCY_CYCLE" },
  );
  const next = await service.create(
    { board: "product", dependencies: [parent.id], requestId: "next" },
    "agent",
  );
  await assert.rejects(
    service.link(
      next.id,
      { target: child.id, relation: "parent", ifRevision: 1, requestId: "long-cycle" },
      "agent",
    ),
    { code: "DEPENDENCY_CYCLE" },
  );
  assert.equal((await service.get(next.id)).parentId, null);
});

test("фильтр родителя применяется до пагинации, сохраняет готовых детей и разрешает прежний ключ", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const parent = await service.create({ board: "product", requestId: "parent" }, "agent");
  await service.create({ board: "product", requestId: "unrelated" }, "agent");
  const childIds = [];
  for (const column of ["inbox", "done", "cancelled"] as const) {
    const child = await service.create(
      { board: "infrastructure", parentId: parent.id, column, requestId: column },
      "agent",
    );
    childIds.push(child.id);
  }
  await service.move(
    parent.id,
    { board: "infrastructure", column: "inbox", ifRevision: 1, requestId: "move" },
    "agent",
  );
  const first = await service.list({ parentId: parent.key, limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.items.length, 2);
  const next = await service.list({
    parentId: parent.id,
    limit: 2,
    offset: first.nextOffset!,
    version: first.version,
  });
  assert.equal(next.nextOffset, null);
  assert.deepEqual(
    new Set([...first.items, ...next.items].map((task) => task.id)),
    new Set(childIds),
  );
  assert.equal((await service.list({ parentId: parent.id, completion: "unfinished" })).total, 1);
  await assert.rejects(service.list({ parentId: "Absent01" }), { code: "NOT_FOUND" });
  await service.create({ board: "product", parentId: parent.id, requestId: "new-child" }, "agent");
  await assert.rejects(service.list({ parentId: parent.id, version: first.version }), {
    code: "BOARD_CHANGED",
  });
});

test("старый смешанный цикл читается и исправляется без переписывания хранения", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const parent = await service.create({ board: "product", requestId: "parent" }, "agent");
  const child = await service.create(
    { board: "product", parentId: parent.id, requestId: "child" },
    "agent",
  );
  await writeLegacyMigrationFixture(workspace);
  const path = join(dirname(workspace.configPath), "boards/product/tasks", `${child.id}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.dependencies = [parent.id];
  await writeFile(path, JSON.stringify(stored));
  const before = await readFile(path, "utf8");
  assert.equal((await service.get(parent.id)).blocked, true);
  assert.equal((await service.get(child.id)).blocked, true);
  assert.equal(await readFile(path, "utf8"), before);
  await new StorageService(workspace).migrate();
  await service.link(
    child.id,
    { target: parent.id, relation: "depends-on", remove: true, ifRevision: 1, requestId: "repair" },
    "agent",
  );
  assert.equal((await service.get(child.id)).blocked, false);
});

test("конкурентные завершение родителя и привязка ребёнка не обходят блокировку", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const parent = await service.create({ board: "product", requestId: "parent" }, "agent");
  const child = await service.create({ board: "infrastructure", requestId: "child" }, "agent");
  const results = await Promise.allSettled([
    service.move(parent.id, { column: "done", ifRevision: 1, requestId: "done" }, "agent"),
    service.link(
      child.id,
      { target: parent.id, relation: "parent", ifRevision: 1, requestId: "link" },
      "agent",
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert.equal(failure?.reason.code, "TASK_BLOCKED");
  const fresh = await service.get(parent.id);
  assert.equal(fresh.column === "done" && fresh.blocked, false);
});

test("выбор связи исключает готовые и отменённые до пагинации и ищет ключ/название", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  for (const column of ["done", "cancelled", "ready", "in-progress"] as const)
    await service.create(
      {
        board: "product",
        column,
        title: `Кандидат ${column}`,
        description: "ТолькоВОписание",
        requestId: column,
      },
      "agent",
    );
  const query = {
    board: "product",
    completion: "unfinished" as const,
    searchIn: "title" as const,
    q: "Кандидат",
    limit: 1,
  };
  const first = await service.list(query);
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.ok(["ready", "in-progress"].includes(first.items[0]!.column));
  const next = await service.list({ ...query, offset: first.nextOffset!, version: first.version });
  assert.equal(next.total, 2);
  assert.equal(next.nextOffset, null);
  assert.notEqual(next.items[0]!.id, first.items[0]!.id);
  assert.equal((await service.list({ ...query, q: "ТолькоВОписание" })).total, 0);
  assert.equal((await service.list({ ...query, q: "ТолькоВОписание", searchIn: "all" })).total, 2);
  assert.equal((await service.list({ ...query, q: first.items[0]!.key })).total, 1);
  assert.equal((await service.list({ completion: "finished" })).total, 2);
});

test("продуктовые связи: постоянные цели, обратный список, ревизии и атомарная подзадача", async (t) => {
  const { workspace } = await fixture(t);
  const product = new ProductService(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Отзывы", summary: "", description: "## Требования\nТекст" },
    },
    "agent",
  );
  const service = new BoardTasksService(workspace);
  const links = [{ kind: "feature" as const, id: feature.id }];
  const created = await service.create(
    { board: "product", productLinks: links, requestId: "parent" },
    "agent",
  );
  const child = await service.create(
    { board: "infrastructure", parentId: created.id, requestId: "child" },
    "agent",
  );
  assert.equal("kind" in (await service.get(created.id)), false);
  assert.equal((await service.get(child.id)).parentId, created.id);
  assert.deepEqual((await service.get(child.id)).dependencies, []);
  assert.equal((await service.list({ productTarget: feature.id })).total, 1);
  await assert.rejects(
    service.update(
      created.id,
      { productLinks: [...links, ...links], ifRevision: 1, requestId: "duplicate" },
      "agent",
    ),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    service.update(
      created.id,
      {
        productLinks: [{ kind: "scenario", id: feature.id }],
        ifRevision: 1,
        requestId: "wrong-kind",
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  await assert.rejects(
    service.create(
      {
        board: "product",
        productLinks: [{ kind: "feature", id: "Absent01" }],
        requestId: "missing",
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  const command = { productLinks: [], ifRevision: 1, requestId: "clear" };
  const saved = await service.update(created.id, command, "agent");
  assert.deepEqual(await service.update(created.id, command, "agent"), saved);
  assert.equal((await service.list({ productTarget: feature.id })).total, 0);
  await assert.rejects(
    service.update(
      created.id,
      { title: "Другое название", ifRevision: 1, requestId: "stale" },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
});

test("legacy v1 читается без записи; storage migrate сохраняет Markdown и квитанции", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const command = { board: "product", description: "## Текст\n\n  код  \n", requestId: "old" };
  const created = await service.create(command, "agent");
  await writeLegacyMigrationFixture(workspace);
  const path = join(dirname(workspace.configPath), "boards/product/tasks", `${created.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.version = 1;
  delete legacy.kind;
  delete legacy.productLinks;
  await writeFile(path, JSON.stringify(legacy));
  const before = await readFile(path, "utf8");
  const task = await service.get(created.id);
  assert.equal("kind" in task, false);
  assert.deepEqual(task.productLinks, []);
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(service.create(command, "agent"), { code: "STORAGE_MIGRATION_REQUIRED" });
  await new StorageService(workspace).migrate();
  assert.deepEqual(await service.create(command, "agent"), created);
  await service.update(
    created.id,
    { title: "Новый заголовок", ifRevision: 1, requestId: "upgrade" },
    "agent",
  );
  const stored = JSON.parse(await readFile(join(dirname(workspace.configPath), "entities/tasks", `${created.id}.json`), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal((await service.get(created.id)).description, command.description);
  for (const [key, receipt] of Object.entries(legacy.requests))
    assert(stored.receipts.some((entry: { result: unknown }) => JSON.stringify(entry.result) === JSON.stringify({ key, value: receipt })));
});

test("канбан: короткие ID, конкурентные номера, Markdown и повтор после переноса", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const description = "## Цель\n\n  текст  \n";
  const command = { board: "product", title: "Первая", description, requestId: "create" };
  const first = await service.create(command, "agent");
  assert.match(first.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(first.key, "PRODUCT-1");
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      service.create(
        { board: "product", title: `Задача ${index}`, requestId: `parallel-${index}` },
        "agent",
      ),
    ),
  );
  assert.equal(new Set(results.map((entry) => entry.key)).size, 6);
  const moved = await service.move(
    first.id,
    { board: "infrastructure", column: "ready", ifRevision: 1, requestId: "move" },
    "agent",
  );
  assert.equal(moved.id, first.id);
  assert.equal(moved.key, "INFRA-1");
  assert.equal((await service.get("PRODUCT-1")).key, "INFRA-1");
  assert.deepEqual(await service.create(command, "agent"), first);
  await assert.rejects(service.create({ ...command, title: "Другой" }, "agent"), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const next = await service.create(
    { board: "product", title: "Следующая", requestId: "next" },
    "agent",
  );
  assert.equal(next.key, "PRODUCT-8");
  const path = join(
    dirname(workspace.configPath),
    "entities/tasks",
    `${first.id}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored.data.description, description.split("\n"));
  assert(stored.aliases.includes("PRODUCT-1"));
  assert.equal((await service.get(first.id)).description, description);
  await assert.rejects(
    access(join(dirname(workspace.configPath), "boards/product/tasks", `${first.id}.json`)),
  );
});

test("пустая задача создаётся одним запросом с готовым состоянием редактора", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const command = { board: "product", requestId: "empty", includeTask: true };
  const created = await service.create(command, "human");
  assert.equal(created.task?.title, "");
  assert.equal(created.task?.description, "");
  assert.equal(created.task?.key, "PRODUCT-1");
  assert.match(created.id, /[A-Za-z]/);
  assert.deepEqual(await service.create(command, "human"), created);
  await service.update(
    created.id,
    { title: "", description: "", ifRevision: 1, requestId: "save-empty" },
    "human",
  );
  assert.equal((await service.get(created.id)).revision, 2);
});

test("граф: междосочные блокеры, отмена, обратные связи, циклы, родительство и ревизии", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const a = await service.create(
    { board: "product", title: "Цель", column: "ready", requestId: "a" },
    "agent",
  );
  const b = await service.create(
    { board: "infrastructure", title: "Основа", requestId: "b" },
    "agent",
  );
  await service.link(
    a.id,
    { target: b.key, relation: "depends-on", ifRevision: 1, requestId: "link" },
    "agent",
  );
  assert.deepEqual((await service.get(a.id)).blockers, [b.id]);
  assert.equal((await service.list({ readiness: "ready" })).total, 0);
  assert.equal((await service.links(b.id)).items[0]?.relation, "blocks");
  await assert.rejects(
    service.link(
      b.id,
      { target: a.id, relation: "depends-on", ifRevision: 1, requestId: "cycle" },
      "agent",
    ),
    { code: "DEPENDENCY_CYCLE" },
  );
  await assert.rejects(
    service.move(a.id, { column: "done", ifRevision: 2, requestId: "blocked" }, "agent"),
    { code: "TASK_BLOCKED" },
  );
  await service.move(b.id, { column: "cancelled", ifRevision: 1, requestId: "cancel" }, "agent");
  assert.equal((await service.get(a.id)).blocked, true);
  await service.move(b.id, { column: "done", ifRevision: 2, requestId: "done" }, "agent");
  assert.equal((await service.list({ readiness: "ready" })).items[0]?.id, a.id);
  await service.link(
    b.id,
    { target: a.id, relation: "parent", ifRevision: 3, requestId: "parent" },
    "agent",
  );
  // Проверяем именно цикл, когда новый родитель не запрещён собственным статусом done.
  await service.move(b.id, { column: "ready", ifRevision: 4, requestId: "reopen-cycle" }, "agent");
  await assert.rejects(
    service.link(
      a.id,
      { target: b.id, relation: "parent", ifRevision: 2, requestId: "parent-cycle" },
      "agent",
    ),
    { code: "DEPENDENCY_CYCLE" },
  );
  await assert.rejects(
    service.update(a.id, { title: "Конфликт", ifRevision: 1, requestId: "stale" }, "agent"),
    { code: "REVISION_CONFLICT" },
  );
  const page = await service.list({ limit: 1 });
  await service.update(a.id, { title: "Новое", ifRevision: 2, requestId: "edit" }, "agent");
  await assert.rejects(service.list({ offset: 1, version: page.version }), {
    code: "BOARD_CHANGED",
  });
});

test("доска получает префикс при создании приложения; префиксы уникальны и неизменяемы", async (t) => {
  const { workspace } = await fixture(t);
  const service = new ProductService(workspace);
  const fields = {
    kind: "application",
    slug: "web",
    prefix: "WEB",
    name: "Веб",
    summary: "Интерфейс",
    description: "## Цель\nИнтерфейс",
    type: "frontend",
  } as const;
  const app = await service.mutate({ action: "create", fields, requestId: "app" }, "agent");
  assert.match(app.id, /^[A-Za-z0-9]{8}$/);
  const board = await new BoardsService(workspace).get("web");
  assert.equal(board.prefix, "WEB");
  assert.match(board.id, /^[A-Za-z0-9]{8}$/);
  assert.notEqual(board.id, app.id);
  await assert.rejects(
    service.mutate(
      { action: "create", fields: { ...fields, slug: "another" }, requestId: "duplicate" },
      "agent",
    ),
    { code: "ALREADY_EXISTS" },
  );
  await assert.rejects(
    service.mutate(
      {
        action: "update",
        id: app.id,
        ifRevision: 1,
        fields: { ...fields, prefix: "OTHER" },
        requestId: "change",
      },
      "agent",
    ),
    { code: "IMMUTABLE_FIELD" },
  );
});

test("прерванный перенос восстанавливается перед чтением; повтор не создаёт новый номер", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const task = await service.create(
    { board: "product", title: "Перенос", requestId: "create" },
    "agent",
  );
  const command = {
    board: "infrastructure",
    column: "ready",
    ifRevision: 1,
    requestId: "move",
  } as const;
  failWal(t, (stage) => { if (stage === "intent") throw new Error("Имитация остановки после долговечного намерения"); });
  await assert.rejects(service.move(task.id, command, "agent"), /долговечного намерения/);
  assert(await exists(join(dirname(workspace.configPath), "transactions/pending.json")));
  t.mock.restoreAll();
  assert.equal((await service.get(task.id)).key, "INFRA-1");
  assert.equal((await service.move(task.id, command, "agent")).key, "INFRA-1");
  assert.equal((await service.list()).total, 1);
  assert.equal(await exists(join(dirname(workspace.configPath), "transactions/pending.json")), false);
});
