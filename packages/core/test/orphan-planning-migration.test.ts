import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixture } from "./helpers/workspace.js";
import { failWal } from "./helpers/wal.js";
import { StorageService } from "../src/application/storage/service.js";
import type { StorageMigrationOptions } from "../src/application/storage/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { HashIndex, forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import { digest, jsonValue, stateSchema } from "../src/storage/entity-store/format.js";
import { readUnifiedMigrationSources } from "../src/storage/migration/unified-sources.js";
import { exists } from "../src/storage/files.js";
import { withStorageLock } from "../src/storage/lock.js";

const at = "2026-09-26T00:00:00.000Z";
const stream = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const historyPath = `history/${stream}/0000000000000001.json`;
const ref = (kind: "work-plan" | "plan-stage" | "release", id: string) => ({ kind, id });
async function put(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value));
}
async function snapshot(root: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [name, value] of await snapshot(root, path)) files.set(name, value);
    else if (entry.isFile()) files.set(path, await readFile(join(root, path), "utf8"));
  }
  return files;
}
async function updateHashes(root: string, changes: Map<string, ReturnType<typeof jsonValue>>) {
  const state = stateSchema.parse(JSON.parse(await readFile(join(root, ".indexes/state.json"), "utf8")));
  const index = new HashIndex(root);
  state.roots["file-hashes"] = await index.update(state.roots["file-hashes"] ?? null, changes);
  for (const change of index.changes(Object.values(state.roots))) await put(root, change.path, change.after);
  await put(root, ".indexes/state.json", state);
  forgetStorageSegments(root);
}
async function prepare(t: TestContext, liveOwner = false) {
  const base = await fixture(t);
  const root = dirname(base.workspace.configPath);
  const projectId = base.workspace.config.projectId!;
  const live = liveOwner ? await new PlanningService(base.workspace).create({ title: "Живой план", requestId: "live" }, "agent") : undefined;
  const a = ref("work-plan", live?.id ?? "OldPlan1");
  const b = ref("work-plan", "OldPlan2");
  const stage = ref("plan-stage", "OldStage");
  const release = ref("release", "OldRel01");
  const event = (owner: typeof a | typeof b | typeof stage | typeof release, action: string, revision: number) => {
    const value = { revision, action, actor: "operator", at, description: ["## Пояснение\r", "", "  текст  ", ""] };
    return { kind: "indexed", index: "record-audit", key: `${owner.kind}:${owner.id}:event:${digest(value)}`,
      value: { type: "event", value }, groups: [{ index: "record-audit-keys", key: `${owner.kind}:${owner.id}`, member: null }] };
  };
  const eventSets = [
    [event(a, "create", 1)],
    [event(stage, "create", 1), event(a, "stage-create", 2)],
    [event(stage, "tasks", 2), event(a, "tasks", 3)],
    [event(a, "complete", 4)],
    [event(b, "create", 1)],
    [event(release, "create", 1)],
    [event(release, "release", 2)],
  ];
  const entries = eventSets.map((events, index) => {
    const owner = index < 4 ? a : index === 4 ? b : release;
    const request = { action: `original-${index}`, description: "## Исходный запрос\r\n\n  пробелы  \n" };
    return { at, actor: "operator", namespace: index < 5 ? "planning" : "release", requestId: `old-${index}`,
      requestHash: digest(request), result: { id: owner.id, key: index < 5 ? `PLN-${index < 4 ? 1 : 2}` : "REL-1",
        revision: index + 1, action: request.action, requestId: `old-${index}`, metadata: [null, false, "\r\n  исходный результат  \n"] },
      refs: [...new Map(events.map((entry) => {
        const [kind, id] = entry.key.split(":");
        return [`${kind}:${id}`, { kind, id }];
      })).values()], events };
  });
  const hashes = new Map<string, ReturnType<typeof jsonValue>>();
  for (const [path, text] of await snapshot(join(root, "entities"))) {
    const record = JSON.parse(text);
    record.schemaVersion = 1;
    delete record.receipts;
    delete record.planningEvents;
    await put(root, `entities/${path}`, record);
    hashes.set(`entities/${path}`, digest(jsonValue(record)));
  }
  const segment = { schemaVersion: 1, first: 1, entries };
  await put(root, historyPath, segment);
  hashes.set(historyPath, digest(jsonValue(segment)));
  await updateHashes(root, hashes);
  await put(root, "storage.json", { format: "relay-entities", schemaVersion: 2, productId: projectId });
  const source = await withStorageLock(root, (owned) => readUnifiedMigrationSources(root, owned), join(root, "runtime"));
  const options: StorageMigrationOptions = { orphanPlanning: {
    projectId,
    events: source.operations.flatMap((operation) => operation.indexed.map((indexed) => {
      const [kind, id] = indexed.key.split(":");
      return { operationId: operation.id, owner: { kind: kind as "work-plan" | "plan-stage" | "release", id: id! }, key: indexed.key, eventHash: digest(jsonValue(indexed)) };
    })),
    receipts: source.operations.map((operation) => ({ operationId: operation.id, namespace: operation.namespace as "planning" | "release",
      actor: operation.actor, requestId: operation.requestId, requestHash: operation.requestHash, resultHash: digest(operation.result) })),
  } };
  return { ...base, storage: root, projectId, entries, options, source, owners: [a, b, stage, release] };
}

test("orphan planning: без разрешения отказ без публикации, точный allowlist исключает 9 событий и сохраняет 7 receipts", async (t) => {
  const state = await prepare(t);
  const service = new StorageService(state.workspace);
  const before = await snapshot(state.storage);
  await assert.rejects(service.migrate(), { code: "STORAGE_MIGRATION_CONFLICT" });
  assert.deepEqual(await snapshot(state.storage), before);
  await put(state.storage, "history/operator-notes.json", { untouched: true });
  const result = await service.migrate(state.options);
  assert.equal(result.migrated, true);
  assert("orphanPlanning" in result);
  assert.deepEqual(result.orphanPlanning, { projectId: state.projectId, discardedEvents: 9, preservedReceipts: 7 });
  assert.equal(await exists(join(state.storage, historyPath)), false);
  assert.deepEqual(JSON.parse(await readFile(join(state.storage, "history/operator-notes.json"), "utf8")), { untouched: true });
  const store = await EntityStore.open(state.storage, workspaceStorageRegistry());
  const project = await store.get({ kind: "project", id: state.projectId });
  assert.equal(project.receipts?.length, 7);
  assert.equal(project.planningEvents, undefined);
  for (const [index, original] of state.entries.entries()) {
    assert(project.receipts!.some((receipt) => JSON.stringify(receipt) === JSON.stringify({
      namespace: original.namespace, actor: original.actor, requestId: original.requestId, requestHash: original.requestHash, result: original.result,
    })));
    const command = { namespace: original.namespace, actor: original.actor, requestId: original.requestId,
      request: { action: `original-${index}`, description: "## Исходный запрос\r\n\n  пробелы  \n" } };
    assert.deepEqual(await store.run(command, async () => assert.fail("Повтор не создаёт план или релиз")), original.result);
    await assert.rejects(store.run({ ...command, request: null }, async () => null), { code: "IDEMPOTENCY_CONFLICT" });
  }
  const records = await store.read((tx) => tx.indexEntries("records"));
  assert(!records.some(([address]) => state.owners.some((owner) => address === `${owner.kind}:${owner.id}`)));
  await store.reindex();
  assert.deepEqual((await store.get({ kind: "project", id: state.projectId })).receipts, project.receipts);
  const replay = await service.migrate(state.options);
  assert.equal(replay.migrated, false);
  assert("orphanPlanning" in replay);
  assert.deepEqual(replay.orphanPlanning, { projectId: state.projectId, discardedEvents: 0, preservedReceipts: 7 });
});

for (const invalid of ["project", "hash", "receipt", "receipt-actor", "request-hash", "missing", "duplicate", "extra-event", "unknown-index", "receipt-as-event"] as const)
  test(`orphan planning: ${invalid} не расширяет разрешение`, async (t) => {
    const state = await prepare(t);
    const options = structuredClone(state.options);
    const approval = options.orphanPlanning!;
    if (invalid === "project") approval.projectId = "Another1";
    if (invalid === "hash") approval.events[0]!.eventHash = "0".repeat(64);
    if (invalid === "receipt") approval.receipts[0]!.resultHash = "0".repeat(64);
    if (invalid === "receipt-actor") approval.receipts[0]!.actor = "Другой автор";
    if (invalid === "request-hash") approval.receipts[0]!.requestHash = "different-request-hash";
    if (invalid === "missing") approval.events.pop();
    if (invalid === "duplicate") approval.events.push(approval.events[0]!);
    if (invalid === "extra-event" || invalid === "unknown-index" || invalid === "receipt-as-event") {
      const raw = JSON.parse(await readFile(join(state.storage, historyPath), "utf8"));
      if (invalid === "receipt-as-event") {
        raw.entries[0].events[0].value = { type: "receipt", key: "saved", value: { hash: "original", result: { id: "OldPlan1" } } };
        approval.events[0]!.eventHash = digest(jsonValue(raw.entries[0].events[0]));
      } else {
        const extra = structuredClone(raw.entries[0].events[0]);
        if (invalid === "extra-event") extra.key += "-unapproved";
        else extra.index = "future-audit";
        raw.entries[0].events.push(extra);
      }
      await put(state.storage, historyPath, raw);
      await updateHashes(state.storage, new Map([[historyPath, digest(jsonValue(raw))]]));
    }
    const before = await snapshot(state.storage);
    await assert.rejects(new StorageService(state.workspace).migrate(options), { code: "STORAGE_MIGRATION_CONFLICT" });
    assert.deepEqual(await snapshot(state.storage), before);
  });

test("orphan planning: разрешение не исключает события существующего плана", async (t) => {
  const state = await prepare(t, true);
  const before = await snapshot(state.storage);
  await assert.rejects(new StorageService(state.workspace).migrate(state.options), { code: "STORAGE_MIGRATION_CONFLICT" });
  assert.deepEqual(await snapshot(state.storage), before);
});

test("orphan planning: tombstone не считается отсутствующим владельцем", async (t) => {
  const state = await prepare(t, true);
  const path = `entities/work-plans/${state.owners[0]!.id}.json`;
  const record = JSON.parse(await readFile(join(state.storage, path), "utf8"));
  for (const field of ["data", "createdAt", "createdBy", "updatedAt", "updatedBy"]) delete record[field];
  record.deleted = { actor: "agent", at };
  await put(state.storage, path, record);
  await updateHashes(state.storage, new Map([[path, digest(jsonValue(record))]]));
  const before = await snapshot(state.storage);
  await assert.rejects(new StorageService(state.workspace).migrate(state.options), { code: "STORAGE_MIGRATION_CONFLICT" });
  assert.deepEqual(await snapshot(state.storage), before);
});

test("orphan planning: сохранившаяся связь без индексного указателя не разрешает исключение", async (t) => {
  const state = await prepare(t);
  const owner = { kind: "project", id: state.projectId };
  const path = `relations/projects/${state.projectId}.json`;
  const record = { schemaVersion: 1, owner, storage: "inline", entries: [{ slot: "diagnostic", edge: {
    id: "retained-edge", type: "references", from: owner, to: state.owners[0], active: false, revision: 1,
    description: ["Прежняя связь"], source: "graph", createdAt: at, updatedAt: at, createdBy: "agent", updatedBy: "agent",
  } }] };
  await put(state.storage, path, record);
  await updateHashes(state.storage, new Map([[path, digest(jsonValue(record))]]));
  const before = await snapshot(state.storage);
  await assert.rejects(new StorageService(state.workspace).migrate(state.options), { code: "STORAGE_MIGRATION_CONFLICT" });
  assert.deepEqual(await snapshot(state.storage), before);
});

test("orphan planning: оставшийся резерв адреса требует явного исправления, не скрытого сброса", async (t) => {
  const state = await prepare(t);
  const header = stateSchema.parse(JSON.parse(await readFile(join(state.storage, ".indexes/state.json"), "utf8")));
  const index = new HashIndex(state.storage);
  header.roots.addresses = await index.update(header.roots.addresses ?? null, new Map([[state.owners[0]!.id,
    jsonValue([{ ref: state.owners[0], matches: ["id"], deleted: true }])]]));
  for (const change of index.changes(Object.values(header.roots))) await put(state.storage, change.path, change.after);
  await put(state.storage, ".indexes/state.json", header);
  forgetStorageSegments(state.storage);
  const before = await snapshot(state.storage);
  await assert.rejects(new StorageService(state.workspace).migrate(state.options), { code: "STORAGE_MIGRATION_CONFLICT" });
  assert.deepEqual(await snapshot(state.storage), before);
});

for (const stage of ["intent", "project", "state", "published"] as const)
  test(`orphan planning: WAL ${stage} восстанавливает квитанции и переключение`, async (t) => {
    const state = await prepare(t);
    failWal(t, (phase, path) => {
      if (phase === stage || (phase === "file" && ((stage === "project" && path === `entities/projects/${state.projectId}.json`) || (stage === "state" && path === ".indexes/state.json"))))
        throw new Error("Остановка согласованного переноса");
    });
    await assert.rejects(new StorageService(state.workspace).migrate(state.options), /Остановка согласованного переноса/);
    assert(await exists(join(state.storage, "transactions/pending.json")));
    t.mock.restoreAll();
    const reopened = await openWorkspace(state.root);
    const result = await new StorageService(reopened).migrate(state.options);
    assert.equal(result.migrated, false);
    assert("orphanPlanning" in result);
    assert.deepEqual(result.orphanPlanning, { projectId: state.projectId, discardedEvents: 0, preservedReceipts: 7 });
    assert.equal(await exists(join(state.storage, historyPath)), false);
    assert.equal(await exists(join(state.storage, "transactions/pending.json")), false);
    await new StorageService(reopened).reindex();
    const project = JSON.parse(await readFile(join(state.storage, `entities/projects/${state.projectId}.json`), "utf8"));
    assert.equal(project.receipts.length, 7);
  });

test("orphan planning: появление владельца после WAL блокирует recovery и не удаляет чужой файл", async (t) => {
  const state = await prepare(t);
  failWal(t, (phase) => { if (phase === "intent") throw new Error("Остановка"); });
  await assert.rejects(new StorageService(state.workspace).migrate(state.options), /Остановка/);
  t.mock.restoreAll();
  const path = `entities/work-plans/${state.owners[0]!.id}.json`;
  const external = { external: "Не удалять появившийся файл" };
  await put(state.storage, path, external);
  await assert.rejects(openWorkspace(state.root), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert.deepEqual(JSON.parse(await readFile(join(state.storage, path), "utf8")), external);
  assert(await exists(join(state.storage, "transactions/pending.json")));
  assert(await exists(join(state.storage, historyPath)));
});
