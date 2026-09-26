import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import type { EntityRecord } from "../src/storage/entity-store/registry.js";
import { markdownCodec } from "../src/storage/entity-store/codecs.js";
import { replaceOwnedRelations } from "../src/storage/entity-store/relations.js";

const at = "2026-09-26T10:00:00.000Z";
const registry = () => new EntityStorageRegistry(["note", "task", "work-plan", "release"].map((kind) => ({
  kind, collection: `${kind}s`, dataVersion: 1,
  schema: z.strictObject({ title: z.string(), body: z.string() }),
  ...markdownCodec([["body"]]),
  card: (record: EntityRecord) => ({ title: String(record.data.title), status: "", selectors: [] }),
})));
const ref = (id = "one", kind = "note") => ({ kind, id });
const record = (id = "one", kind = "note"): EntityRecord => ({
  schemaVersion: 2, dataVersion: 1, ...ref(id, kind), revision: 1,
  key: `${kind.toUpperCase()}-${id.toUpperCase()}`, aliases: [],
  createdAt: at, createdBy: "agent", updatedAt: at, updatedBy: "agent",
  data: { title: "Запись", body: "## Текст\r\n\n  пробелы  \n" },
});
const command = (requestId: string, request: unknown = requestId) => ({
  namespace: "test", actor: "agent", requestId, request: z.json().parse(request),
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-inline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await EntityStore.create(root, registry()) };
}
async function disk(root: string, id = "one", kind = "note") {
  return JSON.parse(await readFile(join(root, `entities/${kind}s/${id}.json`), "utf8"));
}
async function noJournal(root: string) {
  const names = await readdir(root);
  for (const name of ["history", "operations", "audit", "receipts"]) assert(!names.includes(name), name);
  assert(!(await readdir(join(root, "runtime"))).includes("history-writer.json"));
}

test("v3: create/update/delete сохраняют точные повторы в live/tombstone до разрешения адреса", async (t) => {
  const { root, store } = await fixture(t);
  const createResult = { id: "one", body: "\r\n  исходный результат  \n" };
  const create = command("create");
  await store.run(create, async (tx) => { await tx.put(record(), null); return createResult; });
  const update = command("update", { revision: 1, value: "новое" });
  await store.run(update, async (tx) => {
    await tx.put({ ...(await tx.get(ref())), revision: 2, data: { title: "Новое", body: "" } }, 1);
    return { revision: 2 };
  });
  assert.deepEqual(await store.run(update, async () => { throw new Error("Повтор не исполняется"); }), { revision: 2 });
  await assert.rejects(store.run(command("update", { revision: 2 }), async () => null), { code: "IDEMPOTENCY_CONFLICT" });
  const deletion = command("delete");
  await store.run(deletion, async (tx) => {
    const card = await tx.resolve("NOTE-ONE");
    await tx.remove(card.ref, 2, "agent");
    return { deleted: "one" };
  });
  assert.deepEqual(await store.run(deletion, async (tx) => { await tx.resolve("NOTE-ONE"); return null; }), { deleted: "one" });
  assert.deepEqual(await store.run(create, async () => null), createResult);
  const raw = await disk(root);
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.receipts.length, 3);
  assert.equal(raw.revision, 3);
  assert(raw.deleted);
  assert.equal(raw.data, undefined);
  await rm(join(root, ".indexes"), { recursive: true, force: true });
  await store.reindex();
  assert.deepEqual(await store.run(deletion, async () => null), { deleted: "one" });
  assert.deepEqual(await store.run(create, async () => null), createResult);
  assert.equal(JSON.parse(await readFile(join(root, "storage.json"), "utf8")).schemaVersion, 3);
  await noJournal(root);
});

test("v3: составная запись требует владельца, не выбирает проект или первый touched", async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.run(command("ambiguous"), async (tx) => {
    await tx.put(record("one"), null); await tx.put(record("two"), null); return null;
  }), { code: "STORAGE_COMMAND_OWNER_REQUIRED" });
  await assert.rejects(store.get(ref()), { code: "ENTITY_NOT_FOUND" });
  await store.run(command("explicit"), async (tx) => {
    tx.setCommandOwner(ref("two"));
    await tx.put(record("one"), null); await tx.put(record("two"), null); return { primary: "two" };
  });
  assert.equal((await disk(root, "one")).receipts.length, 0);
  assert.equal((await disk(root, "two")).receipts.length, 1);
  await assert.rejects(store.run(command("wrong-owner"), async (tx) => {
    tx.setCommandOwner(ref("one")); tx.setCommandOwner(ref("two")); return null;
  }), { code: "STORAGE_COMMAND_OWNER_CONFLICT" });
  await noJournal(root);
});

test("v3: комментарии inline продолжают пропуски, сохраняют Markdown и не меняют ревизию", async (t) => {
  const { root, store } = await fixture(t);
  const task = ref("one", "task");
  await store.run(command("task"), async (tx) => {
    await tx.put({ ...record("one", "task"), comments: [], commentSequence: 17 }, null); return null;
  });
  const description = "## Сообщение\r\n\n  значимые пробелы  \n";
  await store.run(command("comment"), async (tx) => {
    await tx.appendComment(task, {
      id: "18", sequence: 18, taskId: "one", at, actor: "agent", actorRole: "worker",
      action: "comment-publish", title: "Комментарий", description: description.split("\n"),
      operationId: tx.operationId, revision: 1, legacy: false, fields: [], changes: [],
    });
    return { commentId: "18" };
  });
  const raw = await disk(root, "one", "task");
  assert.equal(raw.revision, 1);
  assert.equal(raw.updatedAt, at);
  assert.equal(raw.commentSequence, 18);
  assert.equal(raw.comments[0].description.join("\n"), description);
  await store.run(command("task-update"), async (tx) => {
    // Адаптер, не знающий о собственных лентах, не должен их стереть.
    await tx.put({ ...record("one", "task"), revision: 2 }, 1); return null;
  });
  assert.deepEqual((await disk(root, "one", "task")).comments, raw.comments);
  await store.reindex();
  assert.deepEqual(await store.run(command("comment"), async () => null), { commentId: "18" });
  await noJournal(root);
});

test("v3: предметные planningEvents и текущие связи сохраняются без общего журнала", async (t) => {
  const { root, store } = await fixture(t);
  const plan = ref("one", "work-plan");
  await store.run(command("plan"), async (tx) => {
    tx.setCommandOwner(plan);
    await tx.put(record("one", "work-plan"), null);
    await tx.put(record("two"), null);
    await tx.appendPlanningEvent(plan, { revision: 1, actor: "agent", at, action: "create" });
    await replaceOwnedRelations(tx, plan, "diagnostic", [{ type: "references", from: plan, to: ref("two"), description: "" }], "agent");
    return { id: "one" };
  });
  assert.equal((await disk(root, "one", "work-plan")).planningEvents[0].action, "create");
  await store.reindex();
  assert.equal((await store.read((tx) => tx.postings("adjacency", "work-plan:one"))).length, 1);
  await noJournal(root);
});

test("v3: recovery публикует сущность и квитанцию вместе после сбоя WAL", async (t) => {
  const { root } = await fixture(t);
  const broken = await EntityStore.open(root, registry(), (stage) => {
    if (stage === "intent") throw new Error("Сбой после durable WAL");
  });
  await assert.rejects(broken.run(command("create"), async (tx) => {
    await tx.put(record(), null); return { id: "one" };
  }), /durable WAL/);
  const recovered = await EntityStore.open(root, registry());
  assert.deepEqual(await recovered.run(command("create"), async () => { throw new Error("Повтор"); }), { id: "one" });
  assert.equal((await disk(root)).receipts.length, 1);
  assert(!(await readdir(join(root, "transactions"))).includes("pending.json"));
  await noJournal(root);
});

test("v3: reindex не мигрирует v2 и не маскирует дублированные receipts", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("one"), async (tx) => { await tx.put(record(), null); return null; });
  const path = join(root, "entities/notes/one.json");
  const raw = await disk(root);
  raw.receipts.push(raw.receipts[0]);
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(store.reindex(), { code: "IDEMPOTENCY_CONFLICT" });
  await writeFile(join(root, "storage.json"), JSON.stringify({ format: "relay-entities", schemaVersion: 2 }));
  await assert.rejects(store.reindex(), { code: "STORAGE_MIGRATION_REQUIRED" });
  await assert.rejects(store.run(command("blocked"), async () => null), { code: "STORAGE_MIGRATION_REQUIRED" });
  await noJournal(root);
});

test("v3: конкурентный точный повтор выполняется однажды; чужой автор имеет собственный ключ", async (t) => {
  const { root, store } = await fixture(t);
  const second = await EntityStore.open(root, registry());
  let executions = 0;
  const execute = async (selected: EntityStore) => selected.run(command("concurrent"), async (tx) => {
    executions++;
    await tx.put(record(), null);
    return { id: "one" };
  });
  assert.deepEqual(await Promise.all([execute(store), execute(second)]), [{ id: "one" }, { id: "one" }]);
  assert.equal(executions, 1);
  await second.run({ ...command("concurrent"), actor: "other" }, async (tx) => {
    tx.setCommandOwner(ref());
    return { author: "other" };
  });
  assert.equal((await disk(root)).receipts.length, 2);
  await assert.rejects(store.run(command("journal"), async (tx) => {
    await tx.writeFile("history/forbidden.json", { value: true }); return null;
  }), { code: "STORAGE_LEGACY_WRITER" });
  await noJournal(root);
});

test("v3: конфликт внешней правки после WAL сохраняет намерение и не выдаёт повтор за успех", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("create"), async (tx) => { await tx.put(record(), null); return null; });
  const broken = await EntityStore.open(root, registry(), (stage) => {
    if (stage === "intent") throw new Error("Остановка");
  });
  await assert.rejects(broken.run(command("update"), async (tx) => {
    await tx.put({ ...(await tx.get(ref())), revision: 2 }, 1); return { revision: 2 };
  }), /Остановка/);
  const raw = await disk(root);
  raw.data.title = "Внешняя правка";
  await writeFile(join(root, "entities/notes/one.json"), JSON.stringify(raw));
  await assert.rejects(EntityStore.open(root, registry()), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert((await readdir(join(root, "transactions"))).includes("pending.json"));
  assert.equal((await disk(root)).receipts.length, 1);
  await noJournal(root);
});

test("v3: рост inline receipts не ограничен прежним бюджетом предметной записи", async (t) => {
  const { root, store } = await fixture(t);
  const result = "x".repeat(17 * 1024 * 1024);
  await store.run(command("large-result"), async (tx) => { await tx.put(record(), null); return result; });
  const reopened = await EntityStore.open(root, registry());
  assert.equal(await reopened.run(command("large-result"), async () => null), result);
  await reopened.reindex();
  assert.equal(await reopened.run(command("large-result"), async () => null), result);
  await noJournal(root);
});
