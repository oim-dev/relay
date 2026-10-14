import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { validateWorkspace } from "../src/application/validate.js";
import { storageCardSchema, storedRecordSchema } from "@relay/contracts/storage";
import { fixture } from "./helpers/workspace.js";
import { treeHashes, tempDir } from "./helpers/migration-bases.js";
import { failWal } from "./helpers/wal.js";
import { openWorkspace } from "../src/storage/workspace.js";
import type { Workspace } from "../src/storage/workspace.js";
import { StorageSession, EntityStore } from "../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import type { EntityRecord } from "../src/storage/entity-store/registry.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { PlanningService } from "../src/application/planning/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { BoardsService } from "../src/application/boards/service.js";
import { exists } from "../src/storage/files.js";

const application = (slug = "client", prefix = "CLIENT") => ({
  kind: "application" as const,
  name: `Приложение ${slug}`,
  slug,
  prefix,
  type: "frontend" as const,
  summary: "Назначение",
  description: "## Обязанности\r\n\n  Точный текст  \n",
});

const persistent = (workspace: Workspace) =>
  treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime"));
const selectors = (workspace: Workspace) =>
  workspace.locked(() => workspace.storageSession!.indexEntries("selectors"));

async function doctor(workspace: Workspace) {
  forgetStorageSegments(workspace.dataRoot);
  const before = await persistent(workspace);
  assert.equal((await validateWorkspace(workspace)).valid, true);
  assert.deepEqual(
    await persistent(workspace),
    before,
    "Doctor остаётся полным read-only действием",
  );
  await workspace.locked(async () => {
    const session = workspace.storageSession!;
    for (const [, raw] of await session.indexEntries("selectors")) {
      for (const ref of z.array(z.object({ kind: z.string(), id: z.string() })).parse(raw)) {
        const stored = await session.get(ref);
        assert.equal(stored.id, ref.id, "Селектор не должен ссылаться на надгробие");
      }
    }
  });
}

async function setup(t: TestContext, rich = false) {
  const base = await fixture(t);
  const { workspace } = base;
  const engine = new EntityEngine(workspace);
  let sequence = 0;
  const create = (data: Parameters<EntityEngine["create"]>[0]["data"]) =>
    engine.create({ data, requestId: `seed-${sequence++}` }, "agent");
  const app = await create(application());
  const survivor = await create(application("other", "OTHER"));
  const board = await new BoardsService(workspace).get("client");
  const survivingSelectors = (await selectors(workspace)).filter(
    ([key]) => !['["application","client"]', '["board","client"]'].includes(key),
  );
  const tasks = new BoardTasksService(workspace);
  const deletedRefs = [app.ref, { kind: "board" as const, id: board.id }];
  if (rich) {
    const feature = await create({
      kind: "feature",
      name: "Фича",
      summary: "",
      description: "Общие требования",
    });
    const scenario = await create({
      kind: "scenario",
      featureId: feature.key,
      name: "Сценарий",
      description: "Шаги",
    });
    const fi = await create({
      kind: "implementation",
      application: app.key,
      target: feature.key,
      title: "FI",
      description: "Вклад",
    });
    const si = await create({
      kind: "implementation",
      application: app.key,
      target: scenario.key,
      title: "SI",
      description: "Вклад",
    });
    const task = await create({
      kind: "task",
      board: "client",
      title: "Работа",
      targets: [si.key],
    });
    const secondTask = await create({
      kind: "task",
      board: "client",
      title: "Вторая работа",
      targets: [fi.key],
    });
    deletedRefs.push(fi.ref, si.ref, task.ref, secondTask.ref);
    await engine.rename(
      { ref: task.key, key: "TASK-RENAMED", ifRevision: 1, requestId: "task-key" },
      "agent",
    );
    await tasks.publishComment(task.key, {
      title: "Содержание",
      description: "Точный комментарий\r\n\n  Текст  \n",
      actor: "agent",
      actorRole: "worker",
      requestId: "comment",
    });
    await create({
      kind: "task",
      board: "product",
      title: "Внешняя",
      related: [task.key],
      parent: task.key,
    });
    await create({ kind: "task", board: "product", title: "Зависимая", dependencies: [task.key] });
    await create({
      kind: "document",
      name: "Внешний документ",
      summary: "",
      body: "# Сохранить\r\n\n  Текст  \n",
      documentKind: "rules",
      targets: [si.key],
    });
    await engine.rename(
      { ref: app.key, key: "APP-RENAMED", ifRevision: 1, requestId: "app-key" },
      "agent",
    );
    await engine.rename(
      { ref: board.key!, key: "BOARD-RENAMED", ifRevision: 1, requestId: "board-key" },
      "agent",
    );
  }
  const records = await Promise.all(
    deletedRefs.map(async (ref) =>
      storedRecordSchema.parse(
        JSON.parse(
          await readFile(join(workspace.dataRoot, workspaceStorageRegistry().path(ref)), "utf8"),
        ),
      ),
    ),
  );
  await doctor(workspace);
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ kind: "application", ref: app.key });
  assert.deepEqual(
    new Set(preview.deleted.map(({ ref }) => `${ref.kind}:${ref.id}`)),
    new Set(deletedRefs.map((ref) => `${ref.kind}:${ref.id}`)),
  );
  const command = {
    kind: "application" as const,
    ref: app.key,
    ifVersion: preview.version,
    requestId: "delete",
  };
  return {
    ...base,
    engine,
    app,
    survivor,
    board,
    tasks,
    deletion,
    command,
    records,
    survivingSelectors,
  };
}

async function assertDeleted(state: Awaited<ReturnType<typeof setup>>) {
  // Новое открытие и холодный индекс исключают успешную проверку только памяти writer.
  const workspace = await openWorkspace(state.root, state.workspace.configPath);
  await doctor(workspace);
  assert.deepEqual(await selectors(workspace), state.survivingSelectors);
  const engine = new EntityEngine(workspace);
  const saved = await engine.get({ ref: state.survivor.key });
  assert.equal(saved.ref.id, state.survivor.ref.id);
  assert.equal((await new BoardsService(workspace).list()).total, 3);
  for (const before of state.records) {
    const path = join(workspace.dataRoot, workspaceStorageRegistry().path(before));
    const after = storedRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    assert.ok("deleted" in after);
    for (const field of [
      "kind",
      "id",
      "key",
      "aliases",
      "comments",
      "commentSequence",
      "reservedKeys",
    ] as const)
      assert.deepEqual(after[field], before[field], field);
    assert.equal(after.revision, before.revision + 1);
    for (const key of [before.id, before.key!, ...before.aliases])
      await assert.rejects(engine.get({ ref: key }), { code: "ENTITY_NOT_FOUND" });
  }
  await assert.rejects(state.deletion.delete(state.command, "agent"), { code: "ENTITY_NOT_FOUND" });
  // Адреса/алиасы удалённой сущности по-прежнему зарезервированы, а slug — не ключ.
  for (const before of state.records)
    for (const key of [before.key!, ...before.aliases])
      await assert.rejects(
        engine.rename(
          { ref: state.survivor.key, key, ifRevision: 1, requestId: `reuse-${key}` },
          "agent",
        ),
        { code: "ENTITY_KEY_CONFLICT" },
      );
}

test("удаление приложения: каноническая карточка без selectors не оставляет индекс slug; doctor green", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const app = await engine.create({ data: application(), requestId: "app" }, "agent");
  const deletion = new EntityDeletionService(workspace);
  assert.equal((await validateWorkspace(workspace)).valid, true);
  await workspace.locked(async () => {
    const session = workspace.storageSession!;
    const card = storageCardSchema.parse(
      await session.indexGet("cards", `application:${app.ref.id}`),
    );
    assert.deepEqual(card.selectors, []);
    assert.deepEqual(await session.indexGet("selectors", '["application","client"]'), [app.ref]);
  });
  const preview = await deletion.preview({ kind: "application", ref: app.key });
  assert.equal(preview.deleted.length, 2);
  await deletion.delete(
    { kind: "application", ref: app.key, ifVersion: preview.version, requestId: "delete" },
    "agent",
  );
  assert.equal((await validateWorkspace(workspace)).valid, true);
  await workspace.locked(async () => {
    assert.equal(
      await workspace.storageSession!.indexGet("selectors", '["application","client"]'),
      undefined,
    );
    assert.equal(
      await workspace.storageSession!.indexGet("selectors", '["board","client"]'),
      undefined,
    );
  });
});

test("удаление: app/board/tasks/FI/SI, aliases и комментарии сохраняются в надгробиях; все индексы и doctor согласованы", async (t) => {
  const state = await setup(t, true);
  const result = await state.deletion.delete(state.command, "agent");
  assert.equal(result.deleted, 6);
  await assertDeleted(state);
});

for (const outcome of ["commit", "rollback"] as const)
  test(`удаление: несколько dirty create/rename/delete в одной сессии, ${outcome}`, async (t) => {
    const state = await setup(t);
    const { workspace, engine, deletion } = state;
    const before = await persistent(workspace);
    const beforeSelectors = await selectors(workspace);
    const abort = new Error("Откат составной операции");
    const operation = () =>
      workspace.mutate("test", { requestId: "outer" }, "agent", async () => {
        const created = await engine.create(
          { data: application("temporary", "TEMP"), requestId: "create" },
          "agent",
        );
        for (const app of [state.app, created]) {
          await engine.rename(
            {
              ref: app.key,
              key: `${app.key}-RENAMED`,
              ifRevision: 1,
              requestId: `rename-${app.key}`,
            },
            "agent",
          );
          const preview = await deletion.preview({ ref: app.key, kind: "application" });
          await deletion.delete(
            {
              ref: app.key,
              kind: "application",
              ifVersion: preview.version,
              requestId: `delete-${app.key}`,
            },
            "agent",
          );
        }
        assert.deepEqual(await selectors(workspace), state.survivingSelectors);
        assert.deepEqual(
          await persistent(workspace),
          before,
          "Публикации до завершения общей сессии нет",
        );
        if (outcome === "rollback") throw abort;
        return null;
      });
    if (outcome === "rollback") {
      await assert.rejects(operation(), (error) => error === abort);
      assert.deepEqual(await persistent(workspace), before);
      assert.deepEqual(await selectors(workspace), beforeSelectors);
      assert.equal((await engine.get({ ref: state.app.key })).revision, 1);
    } else {
      await operation();
      assert.deepEqual(await selectors(workspace), state.survivingSelectors);
      await assert.rejects(engine.get({ ref: "TEMP-RENAMED" }), { code: "ENTITY_NOT_FOUND" });
      await assert.rejects(engine.get({ ref: state.app.key }), { code: "ENTITY_NOT_FOUND" });
    }
    await doctor(workspace);
  });

test("удаление: сбой после подготовки selectors до WAL откатывает всю операцию", async (t) => {
  const state = await setup(t, true);
  const before = await persistent(state.workspace);
  const original = StorageSession.prototype.indexRecord;
  const mocked = t.mock.method(
    StorageSession.prototype,
    "indexRecord",
    async function (this: StorageSession, ...args: Parameters<typeof original>) {
      await original.apply(this, args);
      if (args[0].kind === "application" && "deleted" in args[0]) {
        assert.equal(await this.indexGet("selectors", '["application","client"]'), undefined);
        throw new Error("Сбой индекса до WAL");
      }
    },
  );
  await assert.rejects(state.deletion.delete(state.command, "agent"), /Сбой индекса до WAL/);
  mocked.mock.restore();
  assert.deepEqual(await persistent(state.workspace), before);
  assert.equal(await exists(join(state.workspace.dataRoot, "transactions/pending.json")), false);
  await doctor(state.workspace);
});

for (const stop of ["intent", "entity", "indexes"] as const)
  test(`удаление: WAL ${stop} восстанавливает надгробия и selectors одной публикацией`, async (t) => {
    const state = await setup(t, true);
    const pending = join(state.workspace.dataRoot, "transactions/pending.json");
    failWal(t, (stage, path) => {
      if (
        (stop === "intent" && stage === "intent") ||
        (stop === "entity" && stage === "file" && path?.startsWith("entities/applications/")) ||
        (stop === "indexes" && stage === "file" && path === ".indexes/state.json")
      )
        throw new Error(`Сбой ${stop}`);
    });
    await assert.rejects(state.deletion.delete(state.command, "agent"), new RegExp(`Сбой ${stop}`));
    t.mock.restoreAll();
    assert.equal(await exists(pending), true);
    await assertDeleted(state);
    assert.equal(await exists(pending), false);
    const once = await persistent(state.workspace);
    await state.workspace.locked(async () => undefined);
    assert.deepEqual(
      await persistent(state.workspace),
      once,
      "Повторное открытие не перепубликует индексы",
    );
  });

test("удаление: конфликт индекса при recovery сохраняет внешний файл и исходный WAL", async (t) => {
  const state = await setup(t);
  failWal(t, (stage) => {
    if (stage === "intent") throw new Error("Сбой intent");
  });
  await assert.rejects(state.deletion.delete(state.command, "agent"), /Сбой intent/);
  t.mock.restoreAll();
  const statePath = join(state.workspace.dataRoot, ".indexes/state.json");
  const value = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...value, version: "external-change" }));
  const before = await persistent(state.workspace);
  await assert.rejects(
    state.workspace.locked(async () => undefined),
    { code: "STORAGE_RECOVERY_CONFLICT" },
  );
  assert.deepEqual(await persistent(state.workspace), before);
  assert.equal(await exists(join(state.workspace.dataRoot, "transactions/pending.json")), true);
});

test("удаление: комментарий меняет preview; stale не меняет данные или selectors", async (t) => {
  const state = await setup(t);
  const task = await state.tasks.create({ board: "client", requestId: "task" }, "agent");
  const preview = await state.deletion.preview({ ref: state.app.key, kind: "application" });
  await state.tasks.publishComment(task.id, {
    title: "Новое содержание",
    description: "Текст\r\n",
    actor: "agent",
    actorRole: "worker",
    requestId: "comment",
  });
  const before = await persistent(state.workspace);
  await assert.rejects(
    state.deletion.delete({ ...state.command, ifVersion: preview.version }, "agent"),
    { code: "REVISION_CONFLICT" },
  );
  assert.deepEqual(await persistent(state.workspace), before);
  assert.equal((await state.tasks.get(task.id)).revision, 1);
  await doctor(state.workspace);
});

for (const closed of [false, true])
  test(`удаление: ${closed ? "закрытый" : "открытый"} план блокирует каскад до изменения индексов`, async (t) => {
    const state = await setup(t);
    const task = await state.tasks.create({ board: "client", requestId: "task" }, "agent");
    const preview = await state.deletion.preview({ ref: state.app.key, kind: "application" });
    const plans = new PlanningService(state.workspace);
    const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
    const stage = await plans.changeStage(
      plan.id,
      { action: "create", fields: { title: "Этап" }, ifRevision: 1, requestId: "stage" },
      "agent",
    );
    const included = await plans.changeTasks(
      plan.id,
      { stage: stage.stageId!, add: [task.id], ifRevision: stage.revision, requestId: "include" },
      "agent",
    );
    if (closed)
      await plans.transition(
        plan.id,
        { action: "cancel", result: "Отмена", ifRevision: included.revision, requestId: "cancel" },
        "agent",
      );
    const before = await persistent(state.workspace);
    await assert.rejects(state.deletion.preview({ ref: state.app.key, kind: "application" }), {
      code: "PLANNING_REFERENCE_IN_USE",
    });
    await assert.rejects(
      state.deletion.delete({ ...state.command, ifVersion: preview.version }, "agent"),
      { code: "PLANNING_REFERENCE_IN_USE" },
    );
    assert.deepEqual(await persistent(state.workspace), before);
    await doctor(state.workspace);
  });

for (const outcome of ["commit", "rollback"] as const)
  test(`selectors: прежняя запись в dirty-сессии, коллизии владельцев и резервы ключей, ${outcome}`, async (t) => {
    const root = await tempDir(t, "relay-selector-store-");
    const registry = new EntityStorageRegistry(
      ["note", "other"].map((kind) => ({
        kind,
        collection: `${kind}s`,
        dataVersion: 1,
        schema: z.strictObject({ title: z.string(), slug: z.string() }),
        encode: (data) => z.record(z.string(), z.string()).parse(data),
        decode: (data) => data,
        card: (record) => ({
          title: String(record.data.title),
          status: "",
          selectors: [String(record.data.slug)],
        }),
      })),
    );
    const store = await EntityStore.create(root, registry);
    const record = (id: string, kind = "note"): EntityRecord => ({
      schemaVersion: 3,
      kind,
      id,
      key: kind === "note" ? "SHARED" : "OTHER",
      aliases: id === "a" ? ["OLD-A"] : [],
      dataVersion: 1,
      revision: 1,
      data: { title: id, slug: "same" },
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
      createdBy: "agent",
      updatedBy: "agent",
    });
    const command = (requestId: string) => ({
      namespace: "test",
      requestId,
      actor: "agent",
      request: {},
    });
    const canonicalize = async (tx: StorageSession, id: string) => {
      const address = `note:${id}`;
      const card = storageCardSchema.parse(await tx.indexGet("cards", address));
      tx.indexSet("cards", address, JSON.parse(JSON.stringify({ ...card, selectors: [] })));
    };
    await store.run(command("seed"), async (tx) => {
      // Слияние одинаковых ключей/селекторов: индекс обязан сохранить обоих владельцев.
      await tx.importRecord(record("a"));
      await tx.importRecord(record("b"));
      await tx.importRecord(record("c", "other"));
      await canonicalize(tx, "a");
      await canonicalize(tx, "b");
      return null;
    });
    const before = await treeHashes(root, (path) => path.startsWith("runtime"));
    const abort = new Error("Откат индекса");
    const operation = () =>
      store.run(command("dirty"), async (tx) => {
        for (const slug of ["next", "final"]) {
          const old = await tx.get({ kind: "note", id: "a" });
          await tx.put(
            { ...old, revision: old.revision + 1, data: { ...old.data, slug } },
            old.revision,
          );
          await canonicalize(tx, "a");
        }
        assert.equal(await tx.indexGet("selectors", '["note","next"]'), undefined);
        assert.deepEqual(await tx.indexGet("selectors", '["note","same"]'), [
          { kind: "note", id: "b" },
        ]);
        await tx.remove({ kind: "note", id: "a" }, 3, "agent");
        assert.equal(await tx.indexGet("selectors", '["note","final"]'), undefined);
        assert.deepEqual(await tx.indexGet("selectors", '["other","same"]'), [
          { kind: "other", id: "c" },
        ]);
        if (outcome === "rollback") throw abort;
        return null;
      });
    if (outcome === "rollback") {
      await assert.rejects(operation(), (error) => error === abort);
      assert.deepEqual(await treeHashes(root, (path) => path.startsWith("runtime")), before);
      await assert.rejects(store.resolve("same", "note"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
    } else {
      await operation();
      forgetStorageSegments(root);
      const reopened = await EntityStore.open(root, registry);
      assert.equal((await reopened.resolve("same", "note")).ref.id, "b");
      assert.equal((await reopened.resolve("same", "other")).ref.id, "c");
      for (const slug of ["next", "final"])
        await assert.rejects(reopened.resolve(slug, "note"), { code: "ENTITY_NOT_FOUND" });
      await assert.rejects(reopened.resolve("SHARED"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
      await assert.rejects(reopened.resolve("OLD-A"), { code: "ENTITY_DELETED" });
      await assert.rejects(
        reopened.run(command("reuse"), async (tx) => {
          await tx.put({ ...record("d"), key: "OLD-A" }, null);
          return null;
        }),
        { code: "ENTITY_KEY_CONFLICT" },
      );
      await assert.rejects(
        reopened.run(command("reuse-id"), async (tx) => {
          await tx.put(record("a"), null);
          return null;
        }),
        { code: "ENTITY_DELETED" },
      );
    }
  });
