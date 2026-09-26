import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GraphService } from "../src/application/graph/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import { readOwned } from "../src/storage/entity-store/relations.js";
import { currentPath, graphDigest, legacyGraphSchema } from "../src/storage/graph-format.js";
import { atomicJson, exists } from "../src/storage/files.js";
import { graphMutationSchema } from "../src/domain/entity-graph.js";
import type { GraphNode } from "../src/domain/entity-graph.js";
import { legacyFixture, seedLegacyTask } from "./helpers/workspace.js";
import { graphFixture } from "./helpers/graph-workspace.js";
import { failWal } from "./helpers/wal.js";
import { legacyGraphEvents } from "./helpers/legacy-graph.js";

const nodes: GraphNode[] = ["A", "B", "C"].map((id) => ({ ref: { kind: "any", id }, key: id, title: id, revision: 1, status: "" }));
const catalog = async () => ({ nodes });
const add = { action: "add" as const, type: "references", from: nodes[0]!.ref, to: nodes[1]!.ref, description: "## Контекст\n\nТекст\n" };

test("v3: сумма больше 16 МиБ; адресное чтение открывает только выбранный сегмент отношений", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, catalog);
  let version = (await graph.read()).version;
  for (let batch = 0; batch < 10; batch++) {
    const saved = await graph.mutate({ ifVersion: version, requestId: `batch-${batch}`,
      operations: Array.from({ length: 100 }, () => ({ ...add, description: "x".repeat(18 * 1024) })) }, "agent");
    version = saved.version;
  }
  const manifest = JSON.parse(await readFile(join(workspace.root, "relations/anys/A.json"), "utf8"));
  assert.equal(manifest.storage, "segments");
  let bytes = 0;
  for (const prefix of Object.keys(manifest.segments)) bytes += (await stat(join(workspace.root, "relations/anys/A", `${prefix}.json`))).size;
  assert(bytes > 16 * 1024 * 1024);
  await workspace.locked(async () => {
    const store = workspace.storageSession!.store;
    const before = { ...store.metrics };
    const beforeGraph = { ...graph.repository.metrics };
    const page = await graph.read({ root: "any:A", depth: 1, limit: 1 });
    assert.equal(page.totalEdges, 1000);
    assert.equal(page.edges.length, 1);
    assert.equal(page.edges[0]!.description.length, 18 * 1024);
    assert.equal(store.metrics.relationReads - before.relationReads, 2, "Манифест и один сегмент, не весь владелец");
    assert.equal(graph.repository.metrics.currentReads - beforeGraph.currentReads, 1);
    assert.equal(graph.repository.metrics.eventReads - beforeGraph.eventReads, 0);
    assert.equal(graph.repository.metrics.receiptReads - beforeGraph.receiptReads, 0);
  });
  for (const path of ["history", "operations", "relations/history"]) assert.equal(await exists(join(workspace.root, path)), false);
});

test("legacy graph v1: чтение без записи, storage migrate сохраняет отозванные ID и квитанции", async (t) => {
  const { workspace } = await legacyFixture(t);
  const a = await seedLegacyTask(workspace);
  const b = await seedLegacyTask(workspace, { id: "LegacyT2", key: "PRODUCT-2", keys: ["PRODUCT-2"], rank: 2 });
  const graph = new GraphService(workspace);
  const edge = { id: "Edge0001", type: "references", from: { kind: "task", id: a.id }, to: { kind: "task", id: b.id },
    description: ["## Описание", "", "  строка\r", ""], revision: 2, source: "graph", createdBy: "agent", createdAt: "2026-09-20T00:00:00.000Z" };
  const removed = { ...edge, id: "Edge0002" };
  const command = graphMutationSchema.parse({ operations: [{ ...add, from: edge.from, to: edge.to }], ifVersion: "old-version", requestId: "original" });
  const receipt = { ids: [edge.id], revision: 2, version: "original-version", requestId: "original" };
  const legacy = legacyGraphSchema.parse({ schemaVersion: 1, revision: 7, edges: [edge], events: [
    { action: "add", edge: { ...edge, revision: 1 }, actor: "agent", at: edge.createdAt, revision: 1 },
    { action: "update", edge, actor: "agent", at: edge.createdAt, revision: 2 },
    { action: "add", edge: { ...removed, revision: 1 }, actor: "agent", at: edge.createdAt, revision: 3 },
    { action: "remove", edge: removed, actor: "operator", at: edge.createdAt, revision: 7 },
  ], requests: { [graphDigest(["agent", command.requestId])]: { hash: graphDigest({ ...command, actor: "agent" }), result: receipt } } });
  const original = JSON.stringify(legacy);
  await writeFile(graph.repository.legacyPath, original);
  const before = await graph.read();
  assert.equal(before.edges[0]!.description, edge.description.join("\n"));
  assert.equal(await readFile(graph.repository.legacyPath, "utf8"), original);
  await assert.rejects(graph.mutate(command, "agent"), { code: "STORAGE_MIGRATION_REQUIRED" });
  await assert.rejects(graph.migrate(), { code: "STORAGE_MIGRATION_REQUIRED" });
  assert.equal(await readFile(graph.repository.legacyPath, "utf8"), original);
  await new StorageService(workspace).migrate();
  assert.equal(await exists(graph.repository.legacyPath), false);
  const after = await graph.read();
  assert.deepEqual(after.edges.filter((item) => item.id === edge.id), before.edges);
  assert.deepEqual(await graph.mutate(command, "agent"), receipt);
  const owned = await workspace.locked(() => readOwned(workspace.storageSession!, edge.from));
  const tombstone = owned.entries.find((entry) => entry.edge.id === removed.id)!;
  assert.equal(tombstone.edge.active, false);
  assert.equal(tombstone.edge.revision, 2);
  await new StorageService(workspace).reindex();
  assert.deepEqual(await graph.mutate(command, "agent"), receipt);
  for (const path of ["history", "operations", "relations/history"]) assert.equal(await exists(join(dirname(workspace.configPath), path)), false);
});

for (const stage of ["intent", "relations", "published"] as const)
  test(`v3 graph: восстановление после прерывания ${stage}`, async (t) => {
    const fixture = await graphFixture(t, nodes);
    const graph = new GraphService(fixture.workspace, catalog);
    const command = { ifVersion: (await graph.read()).version, requestId: `crash-${stage}`, operations: [add, { ...add, to: nodes[2]!.ref }] };
    failWal(t, (phase, path) => { if (phase === stage || (stage === "relations" && phase === "file" && path?.startsWith("relations/"))) throw new Error("Имитировано прерывание"); });
    await assert.rejects(graph.mutate(command, "agent"), /прерывание/);
    t.mock.restoreAll();
    const pending = join(fixture.storage, "transactions/pending.json");
    assert(await exists(pending));
    const restored = new GraphService(fixture.reopen(), catalog);
    const page = await restored.read();
    assert.equal(page.totalEdges, 2);
    const repeated = await restored.mutate(command, "agent");
    assert.equal(new Set(repeated.ids).size, 2);
    assert.equal(repeated.version, page.version);
    assert.deepEqual(await restored.mutate(command, "agent"), repeated);
    assert.equal(await exists(pending), false);
  });

test("v3 graph: внешняя правка во время восстановления не перезаписывается", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, catalog);
  const created = await graph.mutate({ ifVersion: (await graph.read()).version, requestId: "one", operations: [add] }, "agent");
  failWal(t, (stage) => { if (stage === "intent") throw new Error("Прерывание"); });
  await assert.rejects(graph.mutate({ ifVersion: created.version, requestId: "edit", operations: [{ action: "update", id: created.ids[0]!, description: "Новое содержание" }] }, "agent"), /Прерывание/);
  t.mock.restoreAll();
  const path = join(workspace.root, "relations/anys/A.json");
  const external = JSON.parse(await readFile(path, "utf8"));
  external.entries[0].edge.description = ["Правка оператора"];
  await writeFile(path, JSON.stringify(external));
  await assert.rejects(graph.read(), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), external);
  assert(await exists(join(workspace.root, "transactions/pending.json")));
});

test("v3 graph: потеря/порча индекса, внешняя правка и отсутствие постоянного файла различаются", async (t) => {
  const { workspace, store } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, catalog);
  const command = { ifVersion: (await graph.read()).version, requestId: "index", operations: [add] };
  const created = await graph.mutate(command, "agent");
  await rm(join(workspace.root, ".indexes"), { recursive: true });
  forgetStorageSegments(workspace.root);
  await assert.rejects(graph.read(), { code: "STORAGE_INDEX_CORRUPT" });
  await store.reindex();
  assert.equal((await graph.read()).version, created.version);
  const state = await store.state();
  const hash = state.roots.edges!;
  await writeFile(join(workspace.root, ".indexes/segments", hash.slice(0, 2), `${hash}.json`), "{}");
  forgetStorageSegments(workspace.root);
  await assert.rejects(graph.read(), { code: "STORAGE_INDEX_CORRUPT" });
  await store.reindex();
  const path = join(workspace.root, "relations/anys/A.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.entries[0].edge.description = ["Внешнее пояснение"];
  await writeFile(path, JSON.stringify(stored));
  await assert.rejects(graph.read(), { code: "STORAGE_INDEX_STALE" });
  // Добавление в тот же набор тоже не должно молча принять внешнюю правку.
  await assert.rejects(graph.mutate({ ifVersion: created.version, requestId: "dirty-add", operations: [add] }, "agent"), { code: "STORAGE_INDEX_STALE" });
  await store.reindex();
  assert.equal((await graph.read()).edges[0]!.description, "Внешнее пояснение");
  await assert.rejects(graph.read({ version: created.version }), { code: "GRAPH_CHANGED" });
  assert.deepEqual(await graph.mutate(command, "agent"), created);
  const preserved = await readFile(path, "utf8");
  await rm(path);
  await assert.rejects(store.reindex(), { code: "STORAGE_INDEX_CORRUPT" });
  await writeFile(path, preserved);
  await store.reindex();
  assert.equal((await graph.read()).totalEdges, 1);
});

test("legacy graph v1: только уже записанное намерение восстанавливается, изменённый исходник не теряется", async (t) => {
  const { workspace } = await legacyFixture(t);
  const graph = new GraphService(workspace, catalog);
  const edge = { id: "Edge0003", type: "any", from: nodes[0]!.ref, to: nodes[1]!.ref, description: ["Строка", ""],
    revision: 1, source: "graph", createdBy: "agent", createdAt: "2026-09-20T00:00:00.000Z" };
  const legacy = legacyGraphSchema.parse({ schemaVersion: 1, revision: 1, edges: [edge], events: [{ action: "add", edge, actor: "agent", at: edge.createdAt, revision: 1 }], requests: {} });
  await writeFile(graph.repository.legacyPath, JSON.stringify(legacy));
  const marker = join(graph.repository.root, "transactions/migration.json");
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, sourceHash: graphDigest(legacy) }));
  await atomicJson(join(graph.repository.root, currentPath(edge.id)), { schemaVersion: 2, active: true, historyCount: 1, edge: legacy.edges[0] }, workspace.runtime);
  assert.equal((await graph.read()).totalEdges, 1);
  assert.equal(await exists(marker), false);
  assert.equal((await legacyGraphEvents(graph)).items[0]!.edge.description, "Строка\n");
  await assert.rejects(graph.mutate({ ifVersion: (await graph.read()).version, requestId: "blocked", operations: [add] }, "agent"), { code: "STORAGE_MIGRATION_REQUIRED" });
  const second = await legacyFixture(t);
  const other = new GraphService(second.workspace, catalog);
  await writeFile(other.repository.legacyPath, JSON.stringify(legacy));
  const otherMarker = join(other.repository.root, "transactions/migration.json");
  await mkdir(dirname(otherMarker), { recursive: true });
  await writeFile(otherMarker, JSON.stringify({ schemaVersion: 1, sourceHash: graphDigest(legacy) }));
  const changed = structuredClone(legacy);
  changed.edges[0]!.description = ["Более новая запись оператора"];
  await writeFile(other.repository.legacyPath, JSON.stringify(changed));
  await assert.rejects(other.read(), { code: "GRAPH_RECOVERY_CONFLICT" });
  assert.deepEqual(JSON.parse(await readFile(other.repository.legacyPath, "utf8")), changed);
});

test("v3 graph: запись не переписывает чужого владельца, версия учитывает изменения каталога", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const mutableNodes = structuredClone(nodes);
  const graph = new GraphService(workspace, async () => ({ nodes: mutableNodes }));
  const saved = await graph.mutate({ ifVersion: (await graph.read()).version, requestId: "unchanged", operations: [add, { ...add, from: nodes[2]!.ref }] }, "agent");
  const paths = ["relations/anys/A.json", "entities/anys/A.json"];
  const stats = await Promise.all(paths.map((path) => stat(join(workspace.root, path), { bigint: true })));
  const next = await graph.mutate({ ifVersion: saved.version, requestId: "edit-neighbor", operations: [{ action: "update", id: saved.ids[1]!, description: "Обновлённое пояснение" }] }, "agent");
  for (const [index, path] of paths.entries()) {
    const actual = await stat(join(workspace.root, path), { bigint: true });
    assert.equal(actual.ino, stats[index]!.ino);
    assert.equal(actual.mtimeNs, stats[index]!.mtimeNs);
  }
  await workspace.locked(async () => {
    const tx = workspace.storageSession!;
    const record = await tx.get(nodes[0]!.ref);
    await tx.put({ ...record, revision: record.revision + 1 }, record.revision);
    mutableNodes[0]!.revision++;
  });
  await assert.rejects(graph.read({ version: next.version }), { code: "GRAPH_CHANGED" });
  assert.notEqual((await graph.read()).version, next.version);
  const context = await graph.read({ root: "any:A", depth: 1 });
  context.paths.find((entry) => entry.target.id === "B")!.target.id = "changed-by-caller";
  const reread = await graph.read({ root: "any:A", depth: 1 });
  assert(reread.nodes.some((node) => node.ref.id === "B"));
  assert(reread.paths.some((entry) => entry.target.id === "B"));
});
