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
const registry = () =>
  new EntityStorageRegistry(
    ["note", "task", "work-plan", "release"].map((kind) => ({
      kind,
      collection: `${kind}s`,
      dataVersion: 1,
      schema: z.strictObject({ title: z.string(), body: z.string() }),
      ...markdownCodec([["body"]]),
      card: (record: EntityRecord) => ({
        title: String(record.data.title),
        status: "",
        selectors: [],
      }),
    })),
  );
const ref = (id = "one", kind = "note") => ({ kind, id });
const record = (id = "one", kind = "note"): EntityRecord => ({
  schemaVersion: 3,
  dataVersion: 1,
  ...ref(id, kind),
  revision: 1,
  key: `${kind.toUpperCase()}-${id.toUpperCase()}`,
  aliases: [],
  createdAt: at,
  createdBy: "agent",
  updatedAt: at,
  updatedBy: "agent",
  data: { title: "Запись", body: "## Текст\r\n\n  пробелы  \n" },
});
const command = (requestId: string) => ({
  namespace: "test",
  actor: "agent",
  requestId,
  request: requestId,
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-current-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await EntityStore.create(root, registry()) };
}
async function disk(root: string, id = "one", kind = "note") {
  return JSON.parse(await readFile(join(root, `entities/${kind}s/${id}.json`), "utf8"));
}
async function jsonFiles(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory())
      for (const [key, value] of await jsonFiles(root, path)) result.set(key, value);
    else if (entry.name.endsWith(".json"))
      result.set(path, await readFile(join(root, path), "utf8"));
  }
  return result;
}
function noAudit(value: unknown): void {
  if (Array.isArray(value)) value.forEach(noAudit);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      assert(
        !["receipts", "requests", "events", "planningEvents", "history", "audit"].includes(key),
        key,
      );
      noAudit(item);
    }
}

test("v4: 100 изменений не накапливают поля, массивы, файлы или результаты команд", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("same"), async (tx) => {
    await tx.put(record(), null);
    return "x".repeat(1024 * 1024);
  });
  const baseline = await jsonFiles(root);
  for (let i = 0; i < 100; i++)
    await store.run(command("same"), async (tx) => {
      const previous = await tx.get(ref());
      await tx.put(
        {
          ...previous,
          revision: previous.revision + 1,
          data: { ...previous.data, title: i % 2 ? "Запись" : "Правка" },
        },
        previous.revision,
      );
      return { ignored: i, result: "x".repeat(10000) };
    });
  const after = await jsonFiles(root);
  assert.equal(after.size, baseline.size);
  assert.equal((await disk(root)).revision, 101);
  assert.deepEqual(
    Object.keys(await disk(root)),
    Object.keys(JSON.parse(baseline.get("entities/notes/one.json")!)),
  );
  const size = (files: Map<string, string>) =>
    [...files.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  assert(size(after) - size(baseline) <= 20, `${size(baseline)} → ${size(after)}`);
  for (const [path, value] of after) {
    assert(!/history|receipts|requests|pending/.test(path));
    noAudit(JSON.parse(value));
  }
  t.diagnostic(
    `100 операций: ${baseline.size} → ${after.size} JSON; ${size(baseline)} → ${size(after)} байт`,
  );
});

test("v4: повтор исполняется заново, CAS сохраняется после restart/reindex/delete", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("same"), async (tx) => {
    await tx.put(record(), null);
    return { id: "one" };
  });
  const update = async (selected: EntityStore) =>
    selected.run(command("same"), async (tx) => {
      await tx.put({ ...record(), revision: 2 }, 1);
      return { revision: 2 };
    });
  await update(store);
  const reopened = await EntityStore.open(root, registry());
  await reopened.reindex();
  await assert.rejects(update(reopened), { code: "REVISION_CONFLICT" });
  await reopened.run(command("same"), async (tx) => {
    await tx.remove(ref(), 2, "agent");
    return null;
  });
  await assert.rejects(update(reopened), { code: "ENTITY_DELETED" });
  const tombstone = await disk(root);
  noAudit(tombstone);
  assert.equal(tombstone.data, undefined);
  assert.equal(tombstone.revision, 3);
});

test("v4: составное действие сохраняет оба состояния и связи без владельца квитанции", async (t) => {
  const { store } = await fixture(t);
  const plan = ref("one", "work-plan");
  await store.run(command("compound"), async (tx) => {
    await tx.put(record("one", "work-plan"), null);
    await tx.put(record("two"), null);
    await replaceOwnedRelations(
      tx,
      plan,
      "diagnostic",
      [{ type: "references", from: plan, to: ref("two"), description: "" }],
      "agent",
    );
    return null;
  });
  await store.reindex();
  assert.equal((await store.read((tx) => tx.postings("adjacency", "work-plan:one"))).length, 1);
  noAudit(await store.get(plan));
});

test("v4: комментарии растут только при публикации, Markdown и пропуски сохраняются", async (t) => {
  const { root, store } = await fixture(t);
  const task = ref("one", "task");
  await store.run(command("task"), async (tx) => {
    await tx.put({ ...record("one", "task"), comments: [], commentSequence: 17 }, null);
    return null;
  });
  const description = "## Сообщение\r\n\n  значимые пробелы  \n";
  const publish = () =>
    store.run(command("comment"), async (tx) => {
      const sequence = (await tx.get(task)).commentSequence! + 1;
      await tx.appendComment(task, {
        id: String(sequence),
        sequence,
        taskId: "one",
        at,
        actor: "agent",
        actorRole: "worker",
        action: "comment-publish",
        title: "Комментарий",
        description: description.split("\n"),
        operationId: tx.operationId,
        revision: 1,
        legacy: false,
        fields: [],
        changes: [],
      });
      return null;
    });
  await publish();
  await publish();
  const raw = await disk(root, "one", "task");
  assert.equal(raw.revision, 1);
  assert.equal(raw.comments.length, 2);
  assert.equal(raw.comments[0].description.join("\n"), description);
  await store.run(command("update"), async (tx) => {
    await tx.put({ ...record("one", "task"), revision: 2 }, 1);
    return null;
  });
  await store.reindex();
  assert.deepEqual((await disk(root, "one", "task")).comments, raw.comments);
});

for (const point of ["intent", "file", "published"] as const)
  test(`v4: WAL ${point} восстанавливает состояние, но не результат команды`, async (t) => {
    const { root } = await fixture(t);
    const broken = await EntityStore.open(root, registry(), (stage) => {
      if (stage === point) throw new Error("Сбой");
    });
    await assert.rejects(
      broken.run(command("create"), async (tx) => {
        await tx.put(record(), null);
        return { id: "one" };
      }),
      /Сбой/,
    );
    const recovered = await EntityStore.open(root, registry());
    assert.equal((await recovered.get(ref())).revision, 1);
    assert.equal(
      await recovered.run(command("create"), async () => "новое исполнение"),
      "новое исполнение",
    );
    assert(!(await readdir(join(root, "transactions"))).includes("pending.json"));
    noAudit(await disk(root));
  });

test("v4: конкурентные изменения с одним requestId защищаются ревизией, а не дедупликацией", async (t) => {
  const { root, store } = await fixture(t);
  const second = await EntityStore.open(root, registry());
  const execute = (selected: EntityStore) =>
    selected.run(command("same"), async (tx) => {
      await tx.put(record(), null);
      return null;
    });
  const results = await Promise.allSettled([execute(store), execute(second)]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(
    (results.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason.code,
    "REVISION_CONFLICT",
  );
});

test("v4: recovery не затирает внешнюю правку; чтение старого формата требует миграции", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("create"), async (tx) => {
    await tx.put(record(), null);
    return null;
  });
  const broken = await EntityStore.open(root, registry(), (stage) => {
    if (stage === "intent") throw new Error("Сбой");
  });
  await assert.rejects(
    broken.run(command("update"), async (tx) => {
      await tx.put({ ...record(), revision: 2 }, 1);
      return null;
    }),
    /Сбой/,
  );
  const raw = await disk(root);
  raw.data.title = "Внешняя правка";
  await writeFile(join(root, "entities/notes/one.json"), JSON.stringify(raw));
  await assert.rejects(EntityStore.open(root, registry()), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert((await readdir(join(root, "transactions"))).includes("pending.json"));
});
