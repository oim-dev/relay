import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import { markdownCodec } from "../src/storage/entity-store/codecs.js";
import { digest, jsonValue } from "../src/storage/entity-store/format.js";
import { withStorageLock } from "../src/storage/lock.js";

const at = "2026-09-26T00:00:00.000Z";
const stream = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const body = "# Текст\r\n\n  пробелы  \r\n";
const registry = () =>
  new EntityStorageRegistry(
    ["project", "task", "work-plan", "note"].map((kind) => ({
      kind,
      collection: `${kind}s`,
      dataVersion: 1,
      schema: z.strictObject({ title: z.string(), body: z.string() }),
      ...markdownCodec([["body"]]),
      card: () => ({ title: "Тест", status: "", selectors: [] }),
    })),
  );
const ref = (kind: string, id: string) => ({ kind, id });
const entity = (kind: string, id: string) => ({
  schemaVersion: 1,
  dataVersion: 1,
  kind,
  id,
  revision: 3,
  key: `${kind.toUpperCase()}-1`,
  aliases: [],
  createdAt: at,
  updatedAt: at,
  createdBy: "agent",
  updatedBy: "agent",
  data: { title: "Тест", body: body.split("\n") },
});
const indexed = (index: string, key: string, value: unknown) => ({
  kind: "indexed",
  index,
  key,
  value,
  groups: [],
});
const request = { action: "create", text: body };
async function put(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value));
}
async function fixture(t: TestContext, version: 1 | 2 | 3) {
  const root = await mkdtemp(join(tmpdir(), "relay-v3-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = {
    "entities/projects/project.json": entity("project", "project"),
    "entities/tasks/task.json": entity("task", "task"),
    "entities/work-plans/plan.json": entity("work-plan", "plan"),
    "entities/notes/gone.json": {
      schemaVersion: 1,
      dataVersion: 1,
      kind: "note",
      id: "gone",
      revision: 4,
      key: "NOTE-GONE",
      aliases: ["OLD-GONE"],
      deleted: { actor: "agent", at },
    },
  };
  // Пользовательский кодек этого теста использует отдельную коллекцию work-plans.
  const definitions = registry()
    .definitions()
    .map((codec) => (codec.kind === "work-plan" ? { ...codec, collection: "work-plans" } : codec));
  const selected = new EntityStorageRegistry(definitions);
  const comment = {
    id: "2",
    taskId: "task",
    sequence: 2,
    at,
    actor: "agent",
    actorRole: "worker",
    action: "comment-publish",
    title: "Обсуждение",
    operationId: "original",
    revision: 1,
    legacy: false,
    fields: [],
    changes: [],
    description: body.split("\n"),
  };
  const entries = [
    {
      at,
      actor: "agent",
      namespace: "test",
      requestId: "create",
      requestHash: digest(request),
      result: { id: "gone", text: body },
      refs: [ref("note", "gone")],
      events: [
        indexed("task-activity-event", "task:0000000000000002", comment),
        indexed("task-activity-event", "task:0000000000000009", {
          taskId: "task",
          sequence: 9,
          action: "update",
        }),
        indexed("record-audit", "work-plan:plan:event:event", {
          type: "event",
          value: {
            revision: 3,
            actor: "agent",
            at,
            action: "stage-add",
            description: body.split("\n"),
          },
        }),
        indexed("record-audit", "task:task:receipt:old", {
          type: "receipt",
          key: "old",
          value: { hash: "unchanged", result: { id: "task" } },
        }),
        indexed("reserved-key", "RESERVED-99", { key: "RESERVED-99" }),
      ],
    },
    {
      at,
      actor: "agent",
      namespace: "test",
      requestId: "ambiguous",
      requestHash: digest(null),
      result: null,
      refs: [ref("task", "task"), ref("work-plan", "plan")],
      events: [],
    },
  ];
  const sources: Record<string, unknown> = { ...records };
  const sourcePaths: string[] = [];
  if (version === 1)
    entries.forEach((entry, index) => {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`;
      const path = `operations/${id}.json`;
      sources[path] = { ...entry, id, schemaVersion: 1, changes: [] };
      sourcePaths.push(path);
    });
  else if (version === 2) {
    const path = `history/${stream}/0000000000000001.json`;
    sources[path] = { schemaVersion: 1, first: 1, entries };
    sourcePaths.push(path);
  }
  if (version === 3)
    for (const [path, value] of Object.entries(records)) {
      sources[path] = {
        ...value,
        schemaVersion: 2,
        receipts: [
          {
            namespace: "old",
            actor: "agent",
            requestId: "old",
            requestHash: "old",
            result: { previous: "delete me" },
          },
        ],
        ...("data" in value
          ? {
              data: {
                ...value.data,
                requests: { old: { result: "old" } },
                events: [{ action: "update" }],
              },
            }
          : {}),
        ...(value.kind === "task" ? { comments: [comment], commentSequence: 9 } : {}),
        ...(value.kind === "work-plan"
          ? { planningEvents: [{ revision: 3, actor: "agent", at, action: "create" }] }
          : {}),
        ...(value.kind === "project" ? { reservedKeys: ["RESERVED-99"] } : {}),
      };
    }
  for (const [path, value] of Object.entries(sources)) await put(root, path, value);
  const leaf = jsonValue({
    schemaVersion: 1,
    type: "leaf",
    entries: Object.entries(sources).map(([path, value]) => [path, digest(jsonValue(value))]),
  });
  const hash = digest(leaf);
  await put(root, `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`, leaf);
  await put(root, ".indexes/state.json", {
    schemaVersion: 1,
    version: "old",
    roots: { "file-hashes": hash },
  });
  await put(root, "storage.json", { format: "relay-entities", schemaVersion: version });
  if (version !== 3)
    await put(root, version === 1 ? "operations/notes.json" : `history/${stream}/notes.json`, {
      keep: true,
    });
  return { root, selected, sourcePaths, comment };
}

for (const version of [1, 2, 3] as const)
  test(`v${version}→v4: прямой перенос комментариев и текущего состояния без квитанций`, async (t) => {
    const { root, selected, sourcePaths, comment } = await fixture(t, version);
    const store = await EntityStore.open(root, selected);
    await assert.rejects(
      store.read(async () => null),
      { code: "STORAGE_MIGRATION_REQUIRED" },
    );
    const result = await withStorageLock(
      root,
      (owned) => store.migrateFormat(owned),
      join(root, "runtime"),
    );
    assert.equal(result.schemaVersion, 4);
    for (const path of sourcePaths)
      await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
    if (version !== 3)
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(root, version === 1 ? "operations/notes.json" : `history/${stream}/notes.json`),
            "utf8",
          ),
        ),
        { keep: true },
      );
    const task = await store.get(ref("task", "task"));
    assert.equal(task.revision, 3);
    assert.equal(task.commentSequence, 9);
    assert.deepEqual(task.comments, [comment]);
    assert.equal((await store.get(ref("work-plan", "plan"))).data.body, body);
    assert.equal("receipts" in (await store.get(ref("project", "project"))), false);
    const command = { namespace: "test", actor: "agent", requestId: "create", request };
    await assert.rejects(
      store.run(command, async (tx) => {
        await tx.resolve("NOTE-GONE");
        return null;
      }),
      { code: "ENTITY_DELETED" },
    );
    assert.equal(await store.run({ ...command, request: null }, async () => null), null);
    await rm(join(root, ".indexes"), { recursive: true, force: true });
    await store.reindex();
    assert.equal(await store.run(command, async () => null), null);
    assert.equal(await store.read((tx) => tx.indexGet("reserved-key", "RESERVED-99")), true);
    assert(!(await readdir(join(root, "runtime"))).includes("history-writer.json"));
  });

test("v2→v4: прерывание durable WAL восстанавливает всё переключение без промежуточного журнала", async (t) => {
  const { root, selected, sourcePaths } = await fixture(t, 2);
  const store = await EntityStore.open(root, selected, (stage) => {
    if (stage === "intent") throw new Error("Прерывание переноса");
  });
  await assert.rejects(
    withStorageLock(root, (owned) => store.migrateFormat(owned), join(root, "runtime")),
    /Прерывание переноса/,
  );
  const recovered = await EntityStore.open(root, selected);
  assert.equal(recovered.formatVersion, 4);
  assert.equal((await recovered.get(ref("task", "task"))).commentSequence, 9);
  for (const path of sourcePaths)
    await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
  assert(!(await readdir(join(root, "transactions"))).includes("pending.json"));
});
