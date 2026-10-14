import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { EntityEngine } from "../src/application/entities/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { ProductRepository } from "../src/storage/product.js";
import { BoardRepository } from "../src/storage/boards.js";
import { GraphRepository } from "../src/storage/graph.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { readOwned, replaceOwnedRelations } from "../src/storage/entity-store/relations.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { fixture } from "./helpers/workspace.js";
import { treeHashes } from "./helpers/source-fixtures.js";

async function setup(t: TestContext, scenarioCount = 1) {
  const { root, workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Фича", summary: "", description: "  Текст\r\n\n" },
    },
    "agent",
  );
  const scenarios = [];
  for (let i = 0; i < scenarioCount; i++)
    scenarios.push(
      await engine.create(
        {
          requestId: `scenario-${i}`,
          data: {
            kind: "scenario",
            featureId: feature.key,
            name: `Сценарий ${i}`,
            description: "Поведение\n",
          },
        },
        "agent",
      ),
    );
  const implementations = [];
  for (const slug of ["alpha", "beta"]) {
    const application = await engine.create(
      {
        requestId: slug,
        data: {
          kind: "application",
          name: slug,
          slug,
          type: "backend",
          summary: "",
          description: "Приложение\n",
        },
      },
      "agent",
    );
    for (const target of [feature, ...scenarios])
      implementations.push(
        await engine.create(
          {
            requestId: `${slug}-${target.key}`,
            data: {
              kind: "implementation",
              application: application.key,
              target: target.key,
              title: target.key,
              description: "  Реализация\r\n\n",
            },
          },
          "agent",
        ),
      );
  }
  return { root, workspace, engine, implementations };
}

/** Считаются вызовы/обходы/декодирование, не системные вызовы файловой системы. */
async function measured(t: TestContext, service: StorageService) {
  const records = StorageSession.prototype.records;
  const get = StorageSession.prototype.get;
  const enumerations: Record<string, number> = {};
  const enumerated: Record<string, number> = {};
  const gets: Record<string, number> = {};
  let session: StorageSession | undefined;
  let metricsBefore: StorageSession["store"]["metrics"] | undefined;
  const recordsMock = t.mock.method(
    StorageSession.prototype,
    "records",
    async function (this: StorageSession, kind: string) {
      session = this;
      metricsBefore ??= { ...this.store.metrics };
      enumerations[kind] = (enumerations[kind] ?? 0) + 1;
      const value = await records.call(this, kind);
      enumerated[kind] = (enumerated[kind] ?? 0) + value.length;
      return value;
    },
  );
  const getMock = t.mock.method(
    StorageSession.prototype,
    "get",
    function (this: StorageSession, ...args: Parameters<typeof get>) {
      gets[args[0].kind] = (gets[args[0].kind] ?? 0) + 1;
      return get.apply(this, args);
    },
  );
  const implementationMock = t.mock.method(ProductRepository.prototype, "implementation");
  const boardsMock = t.mock.method(BoardRepository.prototype, "all");
  const publishMock = t.mock.method(StorageTransaction.prototype, "publish");
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  try {
    const result = await service.reconcileRelations({ requestId: "measured-reconcile" }, "agent");
    const measurement = {
      elapsedMs: performance.now() - started,
      heapDeltaBytes: process.memoryUsage().heapUsed - heap,
      enumerations,
      enumerated,
      gets,
      implementationCalls: implementationMock.mock.callCount(),
      boardsAllCalls: boardsMock.mock.callCount(),
      publications: publishMock.mock.callCount(),
      storeReads: {
        entity: session!.store.metrics.entityReads - metricsBefore!.entityReads,
        relation: session!.store.metrics.relationReads - metricsBefore!.relationReads,
      },
    };
    return { result, measurement };
  } finally {
    for (const mock of [recordsMock, getMock, implementationMock, boardsMock, publishMock])
      mock.mock.restore();
  }
}

for (const scenarioCount of [1, 15])
  test(`STR-07: no-op с K=${2 * (scenarioCount + 1)} — постоянное число перечислений и неизменные файлы`, async (t) => {
    const { root, workspace, implementations } = await setup(t, scenarioCount);
    const before = await treeHashes(root);
    const { result, measurement } = await measured(t, new StorageService(workspace));
    assert.deepEqual(result, { added: 0, updated: 0, removed: 0, requestId: "measured-reconcile" });
    assert.equal(measurement.implementationCalls, 0);
    assert.equal(measurement.boardsAllCalls, 1);
    // snapshot.all и snapshot.implementations; ни одного повторного списка на contract.
    assert.equal(measurement.enumerations.implementation, 2);
    assert.equal(measurement.enumerated.implementation, 2 * implementations.length);
    assert.equal(measurement.gets.implementation, 3 * implementations.length);
    assert.equal(measurement.enumerations.board, 2);
    assert.equal(measurement.enumerated.board, 8);
    assert.equal(measurement.gets.board, 12);
    assert.equal(measurement.gets.product, 2, "одна загрузка паспорта и одно согласование корня");
    assert.equal(measurement.publications, 0, "подтверждённый no-op не пишет WAL");
    assert.deepEqual(await treeHashes(root), before);
    t.diagnostic(JSON.stringify({ id: "STR-07", K: implementations.length, ...measurement }));
  });

test("STR-07: отказ до WAL, единая публикация ремонта, сохранность независимых рёбер/сущностей и повтор", async (t) => {
  const { root, workspace, implementations } = await setup(t);
  const [fi, si] = implementations;
  const graph = new GraphService(workspace);
  const initial = await graph.context({ root: si!.key });
  const independent = await graph.mutate(
    {
      requestId: "independent",
      ifVersion: initial.version,
      operations: [
        {
          action: "add",
          from: si!.ref,
          to: fi!.ref,
          type: "related",
          description: "  Независимая связь\r\n\n",
        },
      ],
    },
    "agent",
  );
  const original = await workspace.locked(
    async (owned) => (await new GraphRepository(workspace).open(owned)).index.entries,
  );
  const owned = await workspace.locked(() => readOwned(workspace.storageSession!, si!.ref));
  const parent = owned.entries.find(
    ({ slot, edge }) =>
      slot === "implementation-links" && edge.type === "part-of" && edge.to.id === fi!.ref.id,
  )!.edge;
  const kept = owned.entries.filter(
    ({ slot, edge }) => slot === "implementation-links" && edge.id !== parent.id && edge.active,
  );
  await workspace.locked(() =>
    replaceOwnedRelations(
      workspace.storageSession!,
      si!.ref,
      "implementation-links",
      [
        ...kept.map(({ edge: { id, type, from, to } }) => ({
          id,
          type,
          from,
          to,
          description: "Неверное пояснение",
        })),
        { from: si!.ref, to: fi!.ref, type: "related", description: "Лишняя управляемая связь" },
      ],
      "external",
    ),
  );
  const before = await treeHashes(root);
  const service = new StorageService(workspace);
  const indexSet = StorageSession.prototype.indexSet;
  let writes = 0;
  const fault = t.mock.method(
    StorageSession.prototype,
    "indexSet",
    function (this: StorageSession, ...args: Parameters<typeof indexSet>) {
      if (args[0] === "edges" && ++writes === 2)
        throw new Error("STR-07: отказ после первой связи");
      return indexSet.apply(this, args);
    },
  );
  await assert.rejects(
    service.reconcileRelations({ requestId: "fail-reconcile" }, "agent"),
    /отказ после первой связи/,
  );
  fault.mock.restore();
  assert.deepEqual(await treeHashes(root), before, "отказ не публикует частичный ремонт");
  const { result, measurement } = await measured(t, service);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.updated, kept.length);
  assert.equal(measurement.publications, 1);
  const after = await treeHashes(root);
  for (const [path, hash] of before)
    if (path.startsWith(".relay/entities/") || path.startsWith(".relay/keyspaces/"))
      assert.equal(after.get(path), hash, path);
  const current = await workspace.locked(
    async (lock) => (await new GraphRepository(workspace).open(lock)).index.entries,
  );
  const intentionallyChanged = new Set([parent.id, ...kept.map(({ edge }) => edge.id)]);
  for (const [id, edge] of original)
    if (!intentionallyChanged.has(id)) assert.deepEqual(current.get(id), edge, id);
  assert.deepEqual(current.get(independent.ids[0]!), original.get(independent.ids[0]!));
  assert.ok(
    [...current.values()].some(
      (edge) =>
        edge.active &&
        edge.type === "part-of" &&
        edge.from.id === si!.ref.id &&
        edge.to.id === fi!.ref.id,
    ),
  );
  const currentLinks = await workspace.locked(() => readOwned(workspace.storageSession!, si!.ref));
  for (const { edge } of kept) {
    const repaired = currentLinks.entries.find((entry) => entry.edge.id === edge.id)!.edge;
    assert.deepEqual(repaired.description, edge.description);
    assert.equal(repaired.revision, original.get(edge.id)!.revision + 2);
  }
  assert.deepEqual(await service.reconcileRelations({ requestId: "again" }, "agent"), {
    added: 0,
    updated: 0,
    removed: 0,
    requestId: "again",
  });
  assert.deepEqual(await treeHashes(root), after);
});

test("STR-07: прерванный WAL reconcile восстанавливается без изменения сущностей", async (t) => {
  const { root, workspace, implementations } = await setup(t);
  const si = implementations[1]!;
  await workspace.locked(() =>
    replaceOwnedRelations(
      workspace.storageSession!,
      si.ref,
      "implementation-links",
      [],
      "external",
    ),
  );
  const before = await treeHashes(root);
  const publish = StorageTransaction.prototype.publish;
  const fault = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    function (this: StorageTransaction, ...args: Parameters<typeof publish>) {
      const interrupted = new StorageTransaction(this.root, (stage, path) => {
        if (stage === "file" && path?.startsWith("relations/"))
          throw new Error("STR-07: обрыв WAL");
      });
      return publish.apply(interrupted, args);
    },
  );
  await assert.rejects(
    new StorageService(workspace).reconcileRelations({ requestId: "crash" }, "agent"),
    /обрыв WAL/,
  );
  fault.mock.restore();
  assert.ok((await treeHashes(root)).has(".relay/transactions/pending.json"));
  const reopened = await openWorkspace(root);
  const repaired = await new StorageService(reopened).reconcileRelations(
    { requestId: "after-recovery" },
    "agent",
  );
  assert.deepEqual(repaired, { added: 0, updated: 0, removed: 0, requestId: "after-recovery" });
  const after = await treeHashes(root);
  assert.ok(!after.has(".relay/transactions/pending.json"));
  for (const [path, hash] of before)
    if (path.startsWith(".relay/entities/")) assert.equal(after.get(path), hash, path);
  const links = await reopened.locked(() => readOwned(reopened.storageSession!, si.ref));
  assert.equal(links.entries.filter(({ edge }) => edge.active).length, 3);
  assert.equal((await new EntityEngine(reopened).get({ ref: si.key })).revision, si.revision);
});
