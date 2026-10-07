import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import type { EntityRecord, EntityCodec } from "../src/storage/entity-store/registry.js";
import { markdownCodec, createEntityStorageRegistry } from "../src/storage/entity-store/codecs.js";
import { replaceOwnedRelations } from "../src/storage/entity-store/relations.js";
import { FullContextReader } from "../src/storage/entity-store/context.js";
import { forgetStorageSegments, HashIndex } from "../src/storage/entity-store/hash-index.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import type { TransactionProbe } from "../src/storage/entity-store/transaction.js";
import type { DesiredRelation } from "../src/storage/entity-store/relations.js";
import { withStorageLock } from "../src/storage/lock.js";

const at = "2026-09-22T10:00:00.000Z";
const codec = (kind: string): EntityCodec => ({
  kind,
  collection: `${kind}s`,
  dataVersion: 1,
  schema: z.strictObject({ title: z.string(), body: z.string(), links: z.array(z.string()) }),
  ...markdownCodec([["body"]]),
  card: (record) => ({ title: String(record.data.title), status: "", selectors: [] }),
});
const registry = () => new EntityStorageRegistry([codec("note"), codec("future")]);
const ref = (id: string) => ({ kind: "note", id });
const record = (id: string, key = `NOTE-${id.toUpperCase()}`, kind = "note"): EntityRecord => ({
  schemaVersion: 3,
  dataVersion: 1,
  kind,
  id,
  revision: 1,
  key,
  aliases: [],
  createdAt: at,
  createdBy: "agent",
  updatedAt: at,
  updatedBy: "agent",
  data: { title: `Запись ${id}`, body: "## Текст\n\n  отступ  \r\n\n", links: [] },
});
const command = (requestId: string, request: unknown = requestId) => ({
  namespace: "test",
  actor: "agent",
  requestId,
  request: z.json().parse(request),
});
const relation = (from: string, to: string): DesiredRelation => ({
  type: "references",
  from: ref(from),
  to: ref(to),
  description: "## Причина\n\n  пробелы  \r\n",
});

async function fixture(t: TestContext, probe?: TransactionProbe) {
  const directory = await mkdtemp(join(tmpdir(), "relay-entity-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, ".relay");
  const created = await EntityStore.create(root, registry());
  const store = probe ? await EntityStore.open(root, registry(), probe) : created;
  return { root, directory, store };
}

test("ID-хранилище: точный Markdown, алиасы, переносимые кодеки и адресное чтение", async (t) => {
  const { store, root } = await fixture(t);
  const original = record("legacy_id.with-dash");
  original.key = "API-1";
  await store.run(command("create"), async (tx) => {
    await tx.put(original, null);
    return { id: original.id };
  });
  const file = join(root, "entities/notes/legacy_id.with-dash.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(stored.data.body, ["## Текст", "", "  отступ  \r", "", ""]);
  assert.equal((await store.get(ref(original.id))).data.body, original.data.body);
  await store.run(command("rename"), async (tx) => {
    const previous = await tx.get(ref(original.id));
    await tx.put({ ...previous, key: "WEB-17", aliases: ["API-1"], revision: 2 }, 1);
    return { id: previous.id, revision: 2 };
  });
  for (const address of ["WEB-17", "API-1", original.id, `note:${original.id}`])
    assert.equal((await store.resolve(address)).ref.id, original.id);
  assert.equal((await readdir(join(root, "entities/notes"))).length, 1);
  assert.equal((await store.resolve("API-1")).revision, 2);
  assert.equal(store.metrics.directoryReads, 0);
  await assert.rejects(store.resolve("API-1", "future"), { code: "ENTITY_KIND_MISMATCH" });
  await assert.rejects(
    store.run(command("stale"), async (tx) => {
      await tx.put({ ...original, revision: 2 }, 1);
      return null;
    }),
    { code: "REVISION_CONFLICT" },
  );
});

test("добавление вида — только регистрация; встроенные виды имеют собственные коллекции", async (t) => {
  const { store } = await fixture(t);
  await store.run(command("future"), async (tx) => {
    await tx.put(record("new", "FUTURE-1", "future"), null);
    return null;
  });
  assert.deepEqual((await store.resolve("FUTURE-1")).ref, { kind: "future", id: "new" });
  const context = await new FullContextReader(store).read("FUTURE-1");
  assert.equal(context.complete, true);
  assert.equal(context.nodes.length, 1);
  assert.deepEqual(context.edges, []);
  const builtins = createEntityStorageRegistry();
  assert.equal(builtins.definitions().length, 11);
  assert.throws(() => builtins.definition("plan-stage"), { code: "UNKNOWN_ENTITY_KIND" });
  assert.equal(
    builtins.path({ kind: "implementation", id: "implementation_old" }),
    "entities/implementations/implementation_old.json",
  );
  assert.throws(() => builtins.path({ kind: "task", id: "../outside" }));
  assert.throws(() => new EntityStorageRegistry([codec("note"), codec("note")]), {
    code: "DUPLICATE_STORAGE_KIND",
  });
});

test("кодеки встроенных видов сохраняют Markdown и оставляют краткий текст строкой", () => {
  const builtin = createEntityStorageRegistry();
  const feature = {
    ...record("Feat0001", "FEATURE-1", "feature"),
    data: {
      name: "Название",
      summary: "Кратко\nв две строки",
      description: "## Требования\r\n\n  строка  \n",
    },
  };
  const stored = builtin.encode(feature);
  assert.equal(stored.data.summary, feature.data.summary);
  assert.deepEqual(stored.data.description, ["## Требования\r", "", "  строка  ", ""]);
  assert.deepEqual(builtin.decode(stored), feature);
  assert.throws(() =>
    builtin.encode({ ...feature, data: { ...feature.data, name: "Две\nстроки" } }),
  );
  const task = {
    ...record("Task0001", "TASK-1", "task"),
    data: {
      boardId: "Board001",
      title: "Задача",
      description: "Описание\n",
      productLinks: [],
      column: "inbox",
      rank: 1024,
      dependencies: [],
      related: [],
      parentId: null,
      acceptanceCriteria: [
        {
          id: "Crit0001",
          title: "Проверка",
          summary: "Кратко",
          description: "## Условие\n\nТекст\n",
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      ],
    },
  };
  const disk = builtin.encode(task);
  assert.deepEqual((disk.data.acceptanceCriteria as { description: string[] }[])[0]!.description, [
    "## Условие",
    "",
    "Текст",
    "",
  ]);
  assert.deepEqual(builtin.decode(disk), task);
});

test("переход версии данных выполняется явно и сохраняет ID, ревизию, даты и точный текст", () => {
  const prior = registry().encode(record("old", "NOTE-1"));
  const next = new EntityStorageRegistry([
    {
      ...codec("note"),
      dataVersion: 2,
      schema: z.strictObject({
        title: z.string(),
        body: z.string(),
        links: z.array(z.string()),
        summary: z.string(),
      }),
      migrations: { 1: (data) => ({ ...data, summary: "" }) },
    },
  ]);
  assert.throws(() => next.decode(prior), { code: "STORAGE_DATA_MIGRATION_REQUIRED" });
  const migrated = next.migrate(prior);
  assert.equal(migrated.dataVersion, 2);
  assert.deepEqual(next.decode(migrated), {
    ...record("old", "NOTE-1"),
    dataVersion: 2,
    data: { ...record("old", "NOTE-1").data, summary: "" },
  });
  assert.deepEqual(next.migrate(migrated), migrated);
  assert.equal(prior.dataVersion, 1);
});

test("чтение старой базы не маскируется пустым новым хранилищем", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-legacy-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "product"));
  await writeFile(join(directory, "product", "passport.json"), '{"legacy":true}');
  await assert.rejects(EntityStore.open(directory, registry()), {
    code: "STORAGE_MIGRATION_REQUIRED",
  });
  await assert.rejects(EntityStore.create(directory, registry()), {
    code: "STORAGE_MIGRATION_REQUIRED",
  });
  assert.equal(
    await readFile(join(directory, "product", "passport.json"), "utf8"),
    '{"legacy":true}',
  );
});

test("коллизия после merge: оба ID доступны, ключ неоднозначен, ремонт и удаление не передают адрес", async (t) => {
  const { store, root } = await fixture(t);
  await store.run(command("first"), async (tx) => {
    await tx.put(record("a", "WEB-17"), null);
    return null;
  });
  // Имитируем чистое файловое слияние второй независимой записи с тем же ключом.
  await writeFile(
    join(root, "entities/notes/b.json"),
    JSON.stringify(registry().encode(record("b", "WEB-17"))),
  );
  await store.reindex();
  await assert.rejects(store.resolve("WEB-17"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
  assert.equal((await store.resolve("note:a")).ref.id, "a");
  assert.equal((await store.resolve("note:b")).ref.id, "b");
  await store.run(command("repair"), async (tx) => {
    const previous = await tx.get(ref("b"));
    await tx.put({ ...previous, key: "WEB-18", aliases: ["WEB-17"], revision: 2 }, 1);
    return null;
  });
  assert.equal((await store.resolve("WEB-18")).ref.id, "b");
  await assert.rejects(store.resolve("WEB-17"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
  await store.run(command("delete"), async (tx) => {
    await tx.remove(ref("a"), 1, "agent");
    return null;
  });
  await store.reindex();
  await assert.rejects(store.resolve("note:a"), { code: "ENTITY_DELETED" });
  await assert.rejects(store.resolve("WEB-17"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
  await assert.rejects(
    store.run(command("reuse"), async (tx) => {
      await tx.put(record("c", "WEB-17"), null);
      return null;
    }),
    { code: "ENTITY_KEY_CONFLICT" },
  );
});

test("ключ, совпавший с ID, не выбирает первого кандидата; несколько совпадений одного ID объединяются", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("ids"), async (tx) => {
    await tx.put(record("SAME", "SAME"), null);
    return null;
  });
  assert.equal((await store.resolve("SAME")).ref.id, "SAME");
  await writeFile(
    join(root, "entities/notes/other.json"),
    JSON.stringify(registry().encode(record("other", "SAME"))),
  );
  await store.reindex();
  await assert.rejects(store.resolve("SAME"), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
  assert.equal((await store.resolve("note:SAME")).ref.id, "SAME");
});

test("выдача ключей учитывает другие виды, алиасы и надгробия без повторного сканирования", async (t) => {
  const { store } = await fixture(t);
  await store.run(command("space"), async (tx) => {
    await tx.put(record("board", "BOARD"), null);
    await tx.put({ ...record("foreign", "WEB-99", "future"), aliases: ["WEB-101"] }, null);
    await tx.saveKeySpace({
      schemaVersion: 1,
      id: "space",
      entityKind: "note",
      owner: ref("board"),
      prefix: "WEB",
      format: "{prefix}-{number}",
    });
    await tx.remove({ kind: "future", id: "foreign" }, 1, "agent");
    return null;
  });
  await store.reindex();
  const before = store.metrics.directoryReads;
  const result = await store.run(command("allocate"), async (tx) => {
    const key = await tx.nextKey("space");
    await tx.put(record("task", key), null);
    return { key };
  });
  assert.equal(result.key, "WEB-102");
  assert.equal(store.metrics.directoryReads, before);
});

test("продуктовая запись → явный Core: циклы, петли, параллельные рёбра, повтор и отзыв группы", async (t) => {
  const { store, root } = await fixture(t);
  await store.run(command("nodes"), async (tx) => {
    for (const id of ["a", "b", "c", "alone"]) await tx.put(record(id), null);
    return null;
  });
  const reader = new FullContextReader(store);
  assert.equal((await reader.read("NOTE-A")).edges.length, 0);
  const input = command("attach", { target: "b" });
  const saved = await store.run(input, async (tx) => {
    const document = await tx.get(ref("a"));
    await tx.put({ ...document, revision: 2, data: { ...document.data, links: ["b"] } }, 1);
    const ids = await replaceOwnedRelations(
      tx,
      ref("a"),
      "attachments",
      [relation("a", "b"), relation("a", "b")],
      "agent",
    );
    await replaceOwnedRelations(
      tx,
      ref("b"),
      "links",
      [relation("b", "c"), relation("c", "a"), relation("b", "b")],
      "agent",
    );
    await replaceOwnedRelations(tx, ref("a"), "independent", [relation("c", "a")], "agent");
    return { ids };
  });
  assert.equal(saved.ids.length, 2);
  assert.notEqual(saved.ids[0], saved.ids[1]);
  assert.equal(await store.run({ ...input, request: "другое" }, async () => null), null);
  const graph = await reader.read("NOTE-C");
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 6);
  assert.equal(graph.complete, true);
  assert.deepEqual((await store.get(ref("a"))).data.links, ["b"]);
  const owned = JSON.parse(await readFile(join(root, "relations/notes/a.json"), "utf8"));
  assert.equal(owned.entries.length, 3);
  assert.deepEqual(owned.entries[0].edge.description, ["## Причина", "", "  пробелы  \r", ""]);
  await store.run(command("same-links"), async (tx) => {
    assert.deepEqual(
      (
        await replaceOwnedRelations(
          tx,
          ref("a"),
          "attachments",
          [relation("a", "b"), relation("a", "b")],
          "agent",
        )
      ).sort(),
      [...saved.ids].sort(),
    );
    assert.equal("events" in tx, false);
    return null;
  });
  await store.run(command("detach"), async (tx) => {
    const document = await tx.get(ref("a"));
    await tx.put({ ...document, revision: 3, data: { ...document.data, links: [] } }, 2);
    await replaceOwnedRelations(tx, ref("a"), "attachments", [], "agent");
    return null;
  });
  assert.equal((await reader.read("NOTE-A")).edges.length, 4);
  assert.equal((await reader.read("NOTE-ALONE")).nodes.length, 1);
  await assert.rejects(reader.read("MISSING"), { code: "ENTITY_NOT_FOUND" });
  await assert.rejects(
    new FullContextReader(store, { nodes: 2, edges: 100, bytes: 1_000_000 }).read("NOTE-A"),
    { code: "CONTEXT_TOO_LARGE" },
  );
});

test("1000 прогретых контекстов не читают сущности, связи и историю; снимки и ответы изолированы", async (t) => {
  const { store } = await fixture(t);
  await store.run(command("create-graph"), async (tx) => {
    await tx.put(record("a"), null);
    await tx.put(record("b"), null);
    await replaceOwnedRelations(tx, ref("a"), "links", [relation("a", "b")], "agent");
    return null;
  });
  const reader = new FullContextReader(store);
  const first = await reader.read("NOTE-A");
  const metrics = { ...store.metrics };
  for (let i = 0; i < 1000; i++) {
    const graph = await reader.read(i % 2 ? "note:b" : "NOTE-A");
    assert.equal(graph.nodes.length, 2);
    graph.nodes[0]!.title = "Внешняя порча ответа";
    graph.edges.pop();
  }
  assert.deepEqual(store.metrics, metrics);
  await store.run(command("rename-title"), async (tx) => {
    const old = await tx.get(ref("b"));
    await tx.put({ ...old, revision: 2, data: { ...old.data, title: "Новое название" } }, 1);
    return null;
  });
  const updated = await reader.read("NOTE-A");
  assert.notEqual(updated.version, first.version);
  assert.equal(updated.nodes.find((node) => node.ref.id === "b")?.title, "Новое название");
  assert.equal(first.nodes.find((node) => node.ref.id === "b")?.title, "Запись b");
  assert.equal(updated.edges[0]!.revision, 1);
});

for (const stage of ["intent", "entity", "relation", "segment", "state", "published"])
  test(`WAL: прерывание на шаге ${stage} восстанавливает обе записи без квитанции`, async (t) => {
    const { root, store: initial } = await fixture(t);
    await initial.run(command("baseline"), async (tx) => {
      await tx.put(record("b"), null);
      return null;
    });
    const crashed = await EntityStore.open(root, registry(), (actual, path) => {
      const matches =
        actual === stage ||
        (actual === "file" &&
          ((stage === "entity" && path?.startsWith("entities/")) ||
            (stage === "relation" && path?.startsWith("relations/")) ||
            (stage === "segment" && path?.startsWith(".indexes/segments/")) ||
            (stage === "state" && path === ".indexes/state.json")));
      if (matches) throw new Error("Имитированное прерывание");
    });
    const input = command(`crash-${stage}`);
    await assert.rejects(
      crashed.run(input, async (tx) => {
        await tx.put({ ...record("a"), data: { ...record("a").data, links: ["b"] } }, null);
        const ids = await replaceOwnedRelations(
          tx,
          ref("a"),
          "links",
          [relation("a", "b")],
          "agent",
        );
        return { ids, revision: 1 };
      }),
      /Имитированное прерывание/,
    );
    const recovered = await EntityStore.open(root, registry());
    assert.deepEqual((await recovered.get(ref("a"))).data.links, ["b"]);
    const graph = await new FullContextReader(recovered).read("NOTE-A");
    assert.equal(graph.edges.length, 1);
    await assert.rejects(
      recovered.run(input, async (tx) => {
        await tx.put(record("a"), null);
        return null;
      }),
      { code: "REVISION_CONFLICT" },
    );
    await assert.rejects(readFile(join(root, "transactions/pending.json")), { code: "ENOENT" });
  });

test("recovery проверяет весь пакет до публикации и не затирает внешнюю правку", async (t) => {
  const { root } = await fixture(t);
  const crashed = await EntityStore.open(root, registry(), (stage) => {
    if (stage === "intent") throw new Error("Прерывание");
  });
  await assert.rejects(
    crashed.run(command("two"), async (tx) => {
      await tx.put(record("a"), null);
      await tx.put(record("b"), null);
      return null;
    }),
    /Прерывание/,
  );
  await mkdir(join(root, "entities/notes"), { recursive: true });
  const external = JSON.stringify(
    registry().encode({ ...record("b"), data: { ...record("b").data, title: "Внешняя правка" } }),
  );
  await writeFile(join(root, "entities/notes/b.json"), external);
  await assert.rejects(EntityStore.open(root, registry()), { code: "STORAGE_RECOVERY_CONFLICT" });
  await assert.rejects(readFile(join(root, "entities/notes/a.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "entities/notes/b.json"), "utf8"), external);
});

test("потеря/порча сегмента обнаруживается, reindex сохраняет состояние без квитанции", async (t) => {
  const { root, store } = await fixture(t);
  const input = command("keep-receipt");
  await store.run(input, async (tx) => {
    await tx.put(record("a"), null);
    return { id: "a", original: true };
  });
  const state = await store.state();
  const hash = state.roots.addresses!;
  const segment = join(root, ".indexes/segments", hash.slice(0, 2), `${hash}.json`);
  await rm(segment);
  forgetStorageSegments(store.root);
  await assert.rejects(store.resolve("NOTE-A"), { code: "STORAGE_INDEX_CORRUPT" });
  await store.reindex();
  assert.equal((await store.resolve("NOTE-A")).ref.id, "a");
  assert.equal(await store.run(input, async () => null), null);
  assert.equal("receipts" in (await store.get(ref("a"))), false);
  await writeFile(segment, '{"schemaVersion":1,"type":"leaf","entries":[]}');
  forgetStorageSegments(store.root);
  await assert.rejects(store.resolve("NOTE-A"), { code: "STORAGE_INDEX_CORRUPT" });
});

test("индекс делится, читает только ветвь и сохраняет неизменяемый прежний снимок", async (t) => {
  const { root } = await fixture(t);
  const index = new HashIndex(root);
  const original = await index.update(
    null,
    new Map(Array.from({ length: 10_000 }, (_, i) => [`KEY-${i}`, { value: i }])),
  );
  const files = index.changes([original]);
  assert.ok(files.length < 1000, `Создано ${files.length} файлов вместо сегментов`);
  await withStorageLock(
    root,
    async (owned) => {
      await new StorageTransaction(root).publish(files, owned);
    },
    join(root, "runtime"),
  );
  index.published();
  forgetStorageSegments(root);
  const cold = new HashIndex(root);
  assert.deepEqual(await cold.get(original, "KEY-5555"), { value: 5555 });
  assert.ok(cold.metrics.segmentReads <= 5);
  const next = await cold.update(original, new Map([["KEY-5555", { value: -1 }]]));
  assert.deepEqual(await cold.get(next, "KEY-5555"), { value: -1 });
  assert.deepEqual(await cold.get(original, "KEY-5555"), { value: 5555 });
  assert.ok(cold.changes([next]).length <= 5);
});

test("два экземпляра и symlink разделяют блокировку, worktree изолированы", async (t) => {
  const { store, root, directory } = await fixture(t);
  const alias = join(directory, "alias");
  await symlink(root, alias);
  const second = await EntityStore.open(alias, registry());
  assert.equal(second.root, store.root);
  const results = await Promise.allSettled(
    [store, second].map((client, index) =>
      client.run(command(`parallel-${index}`), async (tx) => {
        await tx.put(record("shared"), null);
        return index;
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "REVISION_CONFLICT");
  const separate = await EntityStore.create(join(directory, "worktree/.relay"), registry());
  await assert.rejects(separate.resolve("NOTE-SHARED"), { code: "ENTITY_NOT_FOUND" });
});

test("большой набор владельца сегментируется; reindex сохраняет ID и состояние отзыва", async (t) => {
  const { root, store } = await fixture(t);
  const saved = await store.run(command("large-owner"), async (tx) => {
    await tx.put(record("a"), null);
    await tx.put(record("b"), null);
    const ids = await replaceOwnedRelations(
      tx,
      ref("a"),
      "many",
      Array.from({ length: 300 }, () => relation("a", "b")),
      "agent",
    );
    return { ids };
  });
  const manifest = JSON.parse(await readFile(join(root, "relations/notes/a.json"), "utf8"));
  assert.equal(manifest.storage, "segments");
  assert.ok(Object.keys(manifest.segments).length <= 16);
  await store.run(command("revoke-one"), async (tx) => {
    await replaceOwnedRelations(
      tx,
      ref("a"),
      "many",
      saved.ids.slice(1).map((id) => ({ ...relation("a", "b"), id })),
      "agent",
    );
    return null;
  });
  const before = await new FullContextReader(store).read("NOTE-B");
  assert.equal(before.edges.length, 299);
  assert.equal("receipts" in (await store.get(ref("a"))), false);
  assert.equal("receipts" in (await store.get(ref("b"))), false);
  await store.reindex();
  const reopened = await EntityStore.open(root, registry());
  assert.deepEqual((await new FullContextReader(reopened).read("NOTE-A")).edges, before.edges);
  assert.equal("receipts" in (await reopened.get(ref("a"))), false);
  const stored = JSON.parse(await readFile(join(root, "entities/notes/a.json"), "utf8"));
  assert.equal(stored.events, undefined);
  assert.equal(stored.requests, undefined);
});

test("отказ сценария до WAL не публикует ни предметную запись, ни связи", async (t) => {
  const { store, root } = await fixture(t);
  await assert.rejects(
    store.run(command("abort"), async (tx) => {
      await tx.put(record("a"), null);
      await replaceOwnedRelations(tx, ref("a"), "missing", [relation("a", "missing")], "agent");
      return null;
    }),
    { code: "INVALID_REFERENCE" },
  );
  await assert.rejects(store.resolve("NOTE-A"), { code: "ENTITY_NOT_FOUND" });
  await assert.rejects(readFile(join(root, "entities/notes/a.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "transactions/pending.json")), { code: "ENOENT" });
});

test("внешнее изменение между чтением и записью обнаруживается до создания WAL", async (t) => {
  const { store, root } = await fixture(t);
  await store.run(command("first"), async (tx) => {
    await tx.put(record("a"), null);
    return null;
  });
  const path = join(root, "entities/notes/a.json");
  await assert.rejects(
    store.run(command("external"), async (tx) => {
      const old = await tx.get(ref("a"));
      await tx.put({ ...old, revision: 2 }, 1);
      await writeFile(
        path,
        JSON.stringify(
          registry().encode({ ...old, data: { ...old.data, title: "Изменено вручную" } }),
        ),
      );
      return null;
    }),
    { code: "STORAGE_WRITE_CONFLICT" },
  );
  assert.equal((await store.get(ref("a"))).data.title, "Изменено вручную");
  await assert.rejects(readFile(join(root, "transactions/pending.json")), { code: "ENOENT" });
});

test("блокировка и ревизия сохраняются между независимыми процессами Node.js", async (t) => {
  const { root, store } = await fixture(t);
  await store.run(command("initial"), async (tx) => {
    await tx.put(record("a"), null);
    return null;
  });
  const script = `
    import { EntityStore } from './src/storage/entity-store/store.ts';
    import { EntityStorageRegistry } from './src/storage/entity-store/registry.ts';
    import { markdownCodec } from './src/storage/entity-store/codecs.ts';
    import { z } from 'zod';
    const registry = new EntityStorageRegistry([{
      kind: 'note', collection: 'notes', dataVersion: 1,
      schema: z.object({ title: z.string(), body: z.string(), links: z.array(z.string()) }),
      ...markdownCodec([['body']]), card: (r) => ({ title: r.data.title, status: '', selectors: [] }),
    }]);
    const store = await EntityStore.open(process.argv[1], registry);
    try {
      await store.run({ namespace: 'child', actor: 'agent', requestId: process.argv[2], request: null }, async (tx) => {
        const record = await tx.get({ kind: 'note', id: 'a' });
        await tx.put({ ...record, revision: 2 }, 1);
        return null;
      });
      process.stdout.write(JSON.stringify({ success: true }));
    } catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
  `;
  const results = await Promise.all(
    ["one", "two"].map((id) =>
      promisify(execFile)(
        process.execPath,
        [
          "--conditions=tasks-source",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          root,
          id,
        ],
        { cwd: new URL("../", import.meta.url) },
      ).then(({ stdout }) => JSON.parse(stdout)),
    ),
  );
  assert.equal(results.filter((result) => result.success).length, 1);
  assert.equal(results.filter((result) => result.code === "REVISION_CONFLICT").length, 1);
  assert.equal((await store.get(ref("a"))).revision, 2);
});
