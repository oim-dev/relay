import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fixture } from "./helpers/workspace.js";
import { EntityEngine } from "@relay/core/application/entities/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { GraphService } from "@relay/core/application/graph/service";
import { StorageService } from "@relay/core/application/storage/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { StorageSession } from "@relay/core/storage/entity-store/store";
import { StorageTransaction } from "@relay/core/storage/entity-store/transaction";
import { readOwned, replaceOwnedRelations } from "@relay/core/storage/entity-store/relations";
import { openWorkspace } from "@relay/core/storage/workspace";
import type { FullContext, EntityRef } from "@relay/contracts/entities/graph";
import { migrationBackupDir } from "./helpers/migration-bases.js";

test("фича → пустой паспорт → проект: связи записаны до чтения контекста и сохраняются при заполнении", async (t) => {
  const { workspace } = await fixture(t);
  await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() });
  const engine = new EntityEngine(workspace);
  const graph = new GraphService(workspace);
  // Ранее инициализированная единая база ещё не имела корневой связи продукта.
  await workspace.locked(() =>
    replaceOwnedRelations(
      workspace.storageSession!,
      { kind: "product", id: "passport" },
      "product-links",
      [],
      "agent",
    ),
  );
  const input = {
    requestId: "feature-root",
    data: {
      kind: "feature" as const,
      name: "Фича продукта",
      summary: "",
      description: "Требования",
    },
  };
  const feature = await engine.create(input, "agent");
  assert.equal((await engine.get({ ref: feature.key })).ref.id, feature.ref.id);
  const product = await engine.get({ ref: "PRODUCT" });
  const project = await engine.get({ ref: "PROJECT" });
  assert.equal(product.status, "uninitialized");
  assert.equal(product.revision, 0);
  const productLinks = await workspace.locked(async () => {
    const featureLinks = await readOwned(workspace.storageSession!, feature.ref);
    assert.ok(
      featureLinks.entries.some(
        ({ slot, edge }) =>
          slot === "feature-links" &&
          edge.active &&
          edge.type === "part-of" &&
          edge.to.id === product.ref.id,
      ),
    );
    return readOwned(workspace.storageSession!, product.ref);
  });
  const rootLink = productLinks.entries.find(
    ({ slot, edge }) =>
      slot === "product-links" &&
      edge.active &&
      edge.type === "part-of" &&
      edge.to.id === project.ref.id,
  )!;
  assert.ok(rootLink);
  assert.ok(
    (await engine.get({ ref: feature.key })).references.some(
      (ref) => ref.ref.id === product.ref.id,
    ),
  );
  assert.ok(product.references.some((ref) => ref.ref.id === project.ref.id));
  const context = await graph.context({ root: feature.key });
  assert.equal(context.nodes.length, 3);
  assert.equal(context.edges.length, 2);
  assert.ok(hasEdge(context, feature.ref, "part-of", product.ref));
  assert.ok(hasEdge(context, product.ref, "part-of", project.ref));
  assert.deepEqual((await graph.context({ root: project.key })).edges, context.edges);
  const filled = await engine.create(
    {
      requestId: "fill-passport",
      data: {
        kind: "product",
        name: "Продукт",
        summary: "",
        description: "Назначение продукта",
      },
    },
    "agent",
  );
  assert.equal(filled.revision, 1);
  const renamed = await engine.rename(
    { ref: feature.key, key: "FEATURE-ROOT", ifRevision: 1, requestId: "rename-feature" },
    "agent",
  );
  await engine.rename(
    { ref: filled.key, key: "PRODUCT-MAIN", ifRevision: 1, requestId: "rename-product" },
    "agent",
  );
  await engine.rename(
    {
      ref: project.key,
      key: "PROJECT-MAIN",
      ifRevision: project.revision,
      requestId: "rename-project",
    },
    "agent",
  );
  assert.deepEqual((await graph.context({ root: renamed.key })).edges, context.edges);
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: renamed.key, kind: "feature" });
  await deletion.delete(
    { ref: renamed.key, kind: "feature", ifVersion: preview.version, requestId: "delete-feature" },
    "agent",
  );
  const remaining = await graph.context({ root: "PRODUCT-MAIN" });
  assert.equal(remaining.edges.length, 1);
  assert.equal(remaining.edges[0]!.id, rootLink.edge.id);
  assert.ok(hasEdge(remaining, product.ref, "part-of", project.ref));
});

for (const withFeature of [false, true])
  test(`reconcile восстанавливает корень незаполненного продукта${withFeature ? " и старую фичу" : " без фич"}`, async (t) => {
    const { workspace } = await fixture(t);
    const storage = new StorageService(workspace);
    await storage.migrate({ backupDir: await migrationBackupDir() });
    const engine = new EntityEngine(workspace);
    const feature = withFeature
      ? await engine.create(
          {
            requestId: "old-feature",
            data: {
              kind: "feature",
              name: "Существующая фича",
              summary: "",
              description: "Требования",
            },
          },
          "agent",
        )
      : undefined;
    const product = await engine.get({ ref: "PRODUCT" });
    const before = feature ? await engine.get({ ref: feature.key }) : undefined;
    await workspace.locked(async () => {
      await replaceOwnedRelations(
        workspace.storageSession!,
        product.ref,
        "product-links",
        [],
        "agent",
      );
      if (feature)
        await replaceOwnedRelations(
          workspace.storageSession!,
          feature.ref,
          "feature-links",
          [],
          "agent",
        );
    });
    await storage.reindex();
    const graph = new GraphService(workspace);
    assert.equal((await graph.context({ root: feature?.key ?? product.key })).edges.length, 0);
    const input = { requestId: "repair-product-root" };
    const result = await storage.reconcileRelations(input, "agent");
    assert.equal(result.added, withFeature ? 2 : 1);
    assert.equal(result.removed, 0);
    assert.equal(result.updated, 0);
    assert.deepEqual(await storage.reconcileRelations(input, "agent"), {
      ...result,
      added: 0,
      updated: 0,
      removed: 0,
    });
    assert.deepEqual(await engine.get({ ref: product.key }), product);
    if (feature) assert.deepEqual(await engine.get({ ref: feature.key }), before);
    assert.equal((await graph.context({ root: product.key })).edges.length, withFeature ? 2 : 1);
    assert.deepEqual(await storage.reconcileRelations({ requestId: "recheck-root" }, "agent"), {
      added: 0,
      updated: 0,
      removed: 0,
      requestId: "recheck-root",
    });
  });

test("явная миграция старой фичи без заполненного паспорта сохраняет цепочку до проекта", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "legacy-feature",
      data: {
        kind: "feature",
        name: "Прежняя фича",
        summary: "",
        description: "Требования",
      },
    },
    "agent",
  );
  const before = await engine.get({ ref: feature.key });
  await writeLegacyMigrationFixture(workspace);
  assert.equal((await new GraphService(workspace).context({ root: feature.key })).edges.length, 0);
  await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() });
  assert.deepEqual(await engine.get({ ref: feature.key }), before);
  const context = await new GraphService(workspace).context({ root: feature.key });
  const product = await engine.get({ ref: "PRODUCT" });
  const project = await engine.resolve({ ref: "PROJECT" });
  assert.equal(product.revision, 0);
  assert.ok(hasEdge(context, feature.ref, "part-of", product.ref));
  assert.ok(hasEdge(context, product.ref, "part-of", project.ref));
});

const hasEdge = (graph: FullContext, from: EntityRef, type: string, to: EntityRef) =>
  graph.edges.some(
    (edge) =>
      edge.type === type &&
      edge.from.kind === from.kind &&
      edge.from.id === from.id &&
      edge.to.kind === to.kind &&
      edge.to.id === to.id,
  );

test("документ связывает все девять видов; контекст не обрывается на проекте, доске или документе", async (t) => {
  const { engine, feature, scenario, application, fi, si, graph } = await setup(t);
  const product = await engine.create(
    {
      requestId: "passport",
      data: { kind: "product", name: "Продукт", summary: "", description: "Паспорт" },
    },
    "agent",
  );
  const project = await engine.resolve({ ref: "PROJECT" });
  const board = await engine.resolve({ ref: "BOARD-INFRA" });
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: board.key } },
    "agent",
  );
  const material = await engine.create(
    {
      requestId: "material",
      data: {
        kind: "document",
        name: "Материал",
        summary: "",
        body: "Материал",
        documentKind: "rules",
      },
    },
    "agent",
  );
  const targets = [project, product, feature, scenario, application, fi, si, board, task, material];
  const document = await engine.create(
    {
      requestId: "all-kinds",
      data: {
        kind: "document",
        name: "Карта",
        summary: "",
        body: "Общие основания",
        documentKind: "description",
        relations: targets.map((target) => ({
          type: "documents" as const,
          target: target.ref,
          description: "Основание",
        })),
      },
    },
    "agent",
  );
  const context = await graph.context({ root: project.key });
  for (const target of targets) assert.ok(hasEdge(context, document.ref, "documents", target.ref));
  assert.equal(new Set(context.nodes.map((node) => node.ref.kind)).size, 9);
  assert.equal(context.complete, true);
  const before = context.edges.map((edge) => edge.id).sort();
  assert.deepEqual(
    (await graph.context({ root: material.key })).edges.map((edge) => edge.id).sort(),
    before,
  );
});

async function setup(t: TestContext) {
  const { root, workspace } = await fixture(t);
  await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() });
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: {
        kind: "feature",
        name: "Фича",
        summary: "",
        description: "Требования",
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
        name: "Сценарий",
        description: "Поведение",
      },
    },
    "agent",
  );
  const application = await engine.create(
    {
      requestId: "application",
      data: {
        kind: "application",
        name: "API",
        slug: "api",
        type: "backend",
        summary: "",
        description: "Сервис",
      },
    },
    "agent",
  );
  const fi = await engine.create(
    {
      requestId: "fi",
      data: {
        kind: "implementation",
        application: application.key,
        target: feature.key,
        title: "Фича API",
        description: "Вклад",
      },
    },
    "agent",
  );
  const si = await engine.create(
    {
      requestId: "si",
      data: {
        kind: "implementation",
        application: application.key,
        target: scenario.key,
        title: "Сценарий API",
        description: "Вклад",
      },
    },
    "agent",
  );
  return {
    root,
    workspace,
    engine,
    feature,
    scenario,
    application,
    fi,
    si,
    graph: new GraphService(workspace),
  };
}

test("предметное создание сохраняет вложенность SI/FI и полный обратный контекст без чтения-проектора", async (t) => {
  const { workspace, engine, feature, scenario, application, fi, si, graph } = await setup(t);
  const context = await graph.context({ root: si.key });
  assert.equal(context.complete, true);
  assert.ok(hasEdge(context, si.ref, "part-of", fi.ref));
  assert.ok(hasEdge(context, si.ref, "part-of", application.ref));
  assert.ok(hasEdge(context, si.ref, "implements", scenario.ref));
  assert.ok(hasEdge(context, scenario.ref, "part-of", feature.ref));
  assert.ok(hasEdge(context, fi.ref, "implements", feature.ref));
  assert.deepEqual((await graph.context({ root: feature.key })).edges, context.edges);
  const board = await engine.resolve({ ref: "BOARD-API" });
  assert.ok(hasEdge(context, board.ref, "part-of", application.ref));
  const ids = context.edges.map((edge) => edge.id).sort();
  const product = new ProductQueries(workspace);
  const state = await product.state();
  const scope = state.records.find((record) => record.fields.kind === "scope")!;
  await product.mutate(
    {
      action: "update",
      requestId: "withdraw",
      id: scope.id,
      ifRevision: scope.revision,
      ifVersion: state.version,
      fields: { kind: "scope", applicationId: application.ref.id, contracts: [] },
    },
    "agent",
  );
  assert.equal((await engine.get({ ref: si.key })).active, false);
  assert.deepEqual(
    (await graph.context({ root: si.key })).edges.map((edge) => edge.id).sort(),
    ids,
  );
});

test("цели, родитель, зависимости, related и перенос задачи согласуют точные рёбра и безопасный повтор", async (t) => {
  const { engine, feature, scenario, graph } = await setup(t);
  const parent = await engine.create(
    { requestId: "parent", data: { kind: "task", board: "BOARD-PRODUCT" } },
    "agent",
  );
  const other = await engine.create(
    { requestId: "other", data: { kind: "task", board: "BOARD-INFRA" } },
    "agent",
  );
  const secondParent = await engine.create(
    { requestId: "parent-two", data: { kind: "task", board: "BOARD-PRODUCT" } },
    "agent",
  );
  const command = {
    requestId: "task",
    data: {
      kind: "task" as const,
      board: "BOARD-PRODUCT",
      targets: [feature.key],
      parent: parent.key,
      dependencies: [other.key],
      related: [other.key],
    },
  };
  const task = await engine.create(command, "agent");
  assert.equal((await engine.get({ ref: task.key })).ref.id, task.ref.id);
  let context = await graph.context({ root: task.key });
  assert.ok(hasEdge(context, task.ref, "implements", feature.ref));
  assert.ok(hasEdge(context, task.ref, "part-of", parent.ref));
  assert.ok(hasEdge(context, task.ref, "depends-on", other.ref));
  assert.ok(hasEdge(context, task.ref, "related", other.ref));
  const stable = context.edges.find(
    (edge) => edge.from.id === task.ref.id && edge.type === "depends-on",
  )!.id;
  const updated = await engine.update(
    {
      ref: task.key,
      ifRevision: 1,
      requestId: "target",
      changes: { kind: "task", targets: [scenario.key] },
    },
    "agent",
  );
  await assert.rejects(
    engine.update(
      { ref: task.key, ifRevision: 1, requestId: "stale", changes: { kind: "task", targets: [] } },
      "other",
    ),
    { code: "REVISION_CONFLICT" },
  );
  context = await graph.context({ root: task.key });
  assert.ok(!hasEdge(context, task.ref, "implements", feature.ref));
  assert.ok(hasEdge(context, task.ref, "implements", scenario.ref));
  assert.ok(context.edges.some((edge) => edge.id === stable));
  const reparent = await engine.linkTask(
    {
      ref: task.key,
      target: secondParent.key,
      relation: "parent",
      ifRevision: updated.revision,
      requestId: "parent-change",
    },
    "agent",
  );
  const reverse = await engine.linkTask(
    {
      ref: other.key,
      target: task.key,
      relation: "related",
      remove: true,
      ifRevision: 1,
      requestId: "remove-related-from-other-end",
    },
    "agent",
  );
  assert.equal(reverse.revision, 2);
  context = await graph.context({ root: task.key });
  assert.ok(!hasEdge(context, task.ref, "part-of", parent.ref));
  assert.ok(hasEdge(context, task.ref, "part-of", secondParent.ref));
  assert.ok(!context.edges.some((edge) => edge.type === "related"));
  const current = await engine.get({ ref: task.key });
  assert.equal(current.revision, reparent.revision + 1);
  const cleared = await engine.update(
    {
      ref: task.key,
      ifRevision: current.revision,
      requestId: "clear",
      changes: { kind: "task", targets: [] },
    },
    "agent",
  );
  const moved = await engine.moveTask(
    {
      ref: task.key,
      board: "BOARD-INFRA",
      column: "ready",
      ifRevision: cleared.revision,
      requestId: "move",
    },
    "agent",
  );
  const board = await engine.resolve({ ref: "BOARD-INFRA" });
  const oldBoard = await engine.resolve({ ref: "BOARD-PRODUCT" });
  context = await graph.context({ root: moved.key });
  assert.ok(hasEdge(context, task.ref, "part-of", board.ref));
  assert.ok(!hasEdge(context, task.ref, "part-of", oldBoard.ref));
  assert.equal((await engine.resolve({ ref: task.key })).ref.id, task.ref.id);
  const unparent = await engine.linkTask(
    {
      ref: moved.key,
      target: secondParent.key,
      relation: "parent",
      remove: true,
      ifRevision: moved.revision,
      requestId: "unparent",
    },
    "agent",
  );
  await engine.linkTask(
    {
      ref: moved.key,
      target: other.key,
      relation: "depends-on",
      remove: true,
      ifRevision: unparent.revision,
      requestId: "undepend",
    },
    "agent",
  );
  context = await graph.context({ root: moved.key });
  assert.ok(
    context.edges.every((edge) => edge.from.id !== task.ref.id || edge.to.id === board.ref.id),
  );
});

test("документ: оба направления, замена и снятие сохраняют независимые рёбра; граф не обходит владельца", async (t) => {
  const { engine, feature, scenario, graph } = await setup(t);
  const doc = await engine.create(
    {
      requestId: "doc",
      data: {
        kind: "document",
        name: "ТЗ",
        summary: "",
        body: "## Требования\n",
        documentKind: "specification",
        targets: [feature.key],
        relations: [{ type: "references", target: scenario.ref, description: "Прочитать" }],
      },
    },
    "agent",
  );
  let context = await graph.context({ root: doc.key });
  assert.ok(hasEdge(context, doc.ref, "documents", feature.ref));
  assert.ok(hasEdge(context, scenario.ref, "references", doc.ref));
  const managed = context.edges.find((edge) => edge.type === "documents")!;
  for (const operation of [
    { action: "remove" as const, id: managed.id },
    { action: "update" as const, id: managed.id, description: "Обход" },
  ])
    await assert.rejects(
      graph.mutate(
        {
          requestId: `managed-${operation.action}`,
          ifVersion: context.version,
          operations: [operation],
        },
        "agent",
      ),
      { code: "RELATION_MANAGED" },
    );
  const independent = await graph.mutate(
    {
      requestId: "independent",
      ifVersion: context.version,
      operations: [
        {
          action: "add",
          from: doc.ref,
          to: feature.ref,
          type: "documents",
          description: "Диагностика",
        },
      ],
    },
    "agent",
  );
  const renamed = await engine.rename(
    { ref: doc.key, key: "SPEC-1", ifRevision: 1, requestId: "rename-doc" },
    "agent",
  );
  const update = {
    ref: renamed.key,
    ifRevision: renamed.revision,
    requestId: "replace-links",
    changes: {
      kind: "document" as const,
      targets: [],
      relations: [{ type: "documents" as const, target: scenario.ref, description: "Уточнено" }],
    },
  };
  const saved = await engine.update(update, "agent");
  await assert.rejects(engine.update(update, "agent"), { code: "REVISION_CONFLICT" });
  context = await graph.context({ root: doc.key });
  assert.ok(!context.edges.some((edge) => edge.id === managed.id));
  assert.ok(context.edges.some((edge) => edge.id === independent.ids[0]));
  assert.ok(!hasEdge(context, scenario.ref, "references", doc.ref));
  assert.ok(hasEdge(context, doc.ref, "documents", scenario.ref));
  await engine.update(
    {
      ref: saved.key,
      ifRevision: saved.revision,
      requestId: "unlink-doc",
      changes: { kind: "document", relations: [] },
    },
    "agent",
  );
  context = await graph.context({ root: doc.key });
  assert.ok(!hasEdge(context, doc.ref, "documents", scenario.ref));
  assert.ok(context.edges.some((edge) => edge.id === independent.ids[0]));
});

test("отказ после продуктовой записи откатывает пакет; прерывание публикации восстанавливает линк и связь вместе", async (t) => {
  const { root, workspace, engine, feature, graph } = await setup(t);
  const input = {
    requestId: "fault-doc",
    data: {
      kind: "document" as const,
      name: "Сбой",
      summary: "",
      body: "Текст",
      documentKind: "rules" as const,
      targets: [feature.key],
    },
  };
  const before = await graph.context({ root: feature.key });
  const originalIndex = StorageSession.prototype.indexSet;
  const indexMock = t.mock.method(
    StorageSession.prototype,
    "indexSet",
    function (this: StorageSession, ...args: Parameters<typeof originalIndex>) {
      if (args[0] === "edges") throw new Error("Отказ записи связи");
      return originalIndex.apply(this, args);
    },
  );
  await assert.rejects(engine.create(input, "agent"), /Отказ записи связи/);
  indexMock.mock.restore();
  assert.equal((await engine.list({ kind: "document" })).total, 0);
  assert.deepEqual(await graph.context({ root: feature.key }), before);
  const publish = StorageTransaction.prototype.publish;
  const publishMock = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    function (this: StorageTransaction, ...args: Parameters<typeof publish>) {
      const interrupted = new StorageTransaction(this.root, (stage, path) => {
        if (stage === "file" && path?.startsWith("entities/documents/"))
          throw new Error("Обрыв публикации");
      });
      return publish.apply(interrupted, args);
    },
  );
  await assert.rejects(engine.create(input, "agent"), /Обрыв публикации/);
  publishMock.mock.restore();
  const reopened = new EntityEngine(await openWorkspace(root));
  const saved = (await reopened.list({ kind: "document" })).items[0]!;
  assert.equal((await reopened.list({ kind: "document" })).total, 1);
  assert.ok(
    hasEdge(
      await new GraphService(workspace).context({ root: saved.key }),
      saved.ref,
      "documents",
      feature.ref,
    ),
  );
  assert.equal((await reopened.get({ ref: saved.key })).ref.id, saved.ref.id);
});

test("явное согласование исправляет прежние предметные группы, не меняя сущности и диагностические рёбра", async (t) => {
  const { workspace, engine, si, fi, graph } = await setup(t);
  const before = await engine.get({ ref: si.key });
  const initial = await graph.context({ root: si.key });
  const independent = await graph.mutate(
    {
      requestId: "diagnostic",
      ifVersion: initial.version,
      operations: [{ action: "add", from: si.ref, to: fi.ref, type: "related" }],
    },
    "agent",
  );
  const oldRelations = initial.edges.filter(
    (edge) => edge.from.id === si.ref.id && edge.to.id !== fi.ref.id,
  );
  await workspace.locked(async () => {
    await replaceOwnedRelations(
      workspace.storageSession!,
      si.ref,
      "implementation-links",
      oldRelations.map(({ id, type, from, to }) => ({ id, type, from, to, description: "" })),
      "agent",
    );
  });
  await new StorageService(workspace).reindex();
  assert.ok(!hasEdge(await graph.context({ root: si.key }), si.ref, "part-of", fi.ref));
  const service = new StorageService(workspace);
  const input = { requestId: "reconcile" };
  const saved = await service.reconcileRelations(input, "agent");
  assert.deepEqual(saved, { added: 1, updated: 0, removed: 0, requestId: "reconcile" });
  assert.deepEqual(await service.reconcileRelations(input, "agent"), {
    ...saved,
    added: 0,
    updated: 0,
    removed: 0,
  });
  assert.deepEqual(await engine.get({ ref: si.key }), before);
  const current = await graph.context({ root: si.key });
  assert.ok(hasEdge(current, si.ref, "part-of", fi.ref));
  for (const id of [...oldRelations.map((edge) => edge.id), ...independent.ids])
    assert.ok(current.edges.some((edge) => edge.id === id));
  assert.deepEqual(await service.reconcileRelations({ requestId: "second" }, "agent"), {
    added: 0,
    updated: 0,
    removed: 0,
    requestId: "second",
  });
});
