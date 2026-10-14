import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { ProductQueries } from "@relay/core/application/product/queries";
import { lintProduct } from "@relay/core/application/product/content";
import { ProductRepository } from "@relay/core/storage/product";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { EntityEngine } from "@relay/core/application/entities/service";
import { StorageSession } from "@relay/core/storage/entity-store/store";
import { StorageTransaction } from "@relay/core/storage/entity-store/transaction";
import { readOwned } from "@relay/core/storage/entity-store/relations";
import { openWorkspace } from "@relay/core/storage/workspace";
import {
  productImplementationDetailSchema,
  productParticipationPageSchema,
  productParticipationReplaceSchema,
  productParticipationSavedSchema,
} from "@relay/contracts/product-participation";
import {
  productLintPageSchema,
  productOverviewMapPageSchema,
  productValidationSchema,
} from "@relay/contracts/product-query";
import { fixture } from "./helpers/workspace.js";
import { productSavedSchema } from "@relay/contracts/entities/product";

const actor = "product-audit";
const markdown =
  "\r\n  Собственный вклад\t\n\n" + "Подробности вклада. ".repeat(30) + "\r\n\nКонец\n";

async function setup(t: TestContext) {
  const { workspace, root } = await fixture(t);
  const product = new ProductQueries(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Поиск", summary: "", description: "Описание. ".repeat(30) },
    },
    actor,
  );
  const scenario = await product.mutate(
    {
      action: "create",
      requestId: "scenario",
      fields: {
        kind: "scenario",
        featureId: feature.id,
        name: "Найти",
        description: "Сценарий. ".repeat(30),
      },
    },
    actor,
  );
  const application = await product.mutate(
    {
      action: "create",
      requestId: "application",
      fields: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        type: "frontend",
        summary: "",
        description: "Назначение",
      },
    },
    actor,
  );
  const selections = [feature, scenario].map((entry) => ({
    kind: "target" as const,
    target: entry.key!,
    title: `Вклад ${entry.key}`,
    description: markdown,
    status: "done" as const,
  }));
  const replace = async (next = selections) => {
    const page = await product.participation({ application: application.key! });
    return product.replaceParticipation(
      {
        application: application.key!,
        selections: next,
        ifRevision: page.revision,
        ifVersion: page.version,
        requestId: "replace",
      },
      actor,
    );
  };
  return { workspace, root, product, feature, scenario, application, selections, replace };
}

test("квитанция participation сохраняет optional key предметной mutation, не создавая публичного ключа scope", async (t) => {
  const { product, workspace, replace } = await setup(t);
  const saved = await replace();
  assert.equal(Object.hasOwn(saved, "key"), false);
  assert.equal(Object.hasOwn(productParticipationSavedSchema.parse(saved), "key"), false);
  const legacyKey = "LEGACY-SCOPE-KEY";
  await workspace.locked(async () => {
    const session = workspace.storageSession!;
    const stored = await session.get({ kind: "scope", id: saved.scopeId });
    assert.equal(stored.key, null);
    assert.deepEqual(stored.aliases, []);
    // Текущая схема хранения запрещает настоящий публичный ключ технического scope.
    assert.throws(() => session.store.registry.validate({ ...stored, key: legacyKey }), {
      code: "INVALID_DATA",
    });
  });
  const page = await product.participation({ application: "WEB" });
  const mutate = product.mutate.bind(product);
  let sourceReceipt: Awaited<ReturnType<typeof mutate>> | undefined;
  // Синтетический совместимый ответ предметной границы, не фиктивная legacy-база:
  // проверяем, что адаптер не теряет допустимое optional поле ProductSaved.
  const source = t.mock.method(product, "mutate", async (...args: Parameters<typeof mutate>) => {
    sourceReceipt = productSavedSchema.parse({ ...(await mutate(...args)), key: legacyKey });
    return sourceReceipt;
  });
  const compatible = await product.replaceParticipation(
    {
      application: "WEB",
      selections: page.items.map((entry) => ({ kind: "existing", ref: entry.key })),
      ifRevision: page.revision,
      ifVersion: page.version,
      requestId: "compatible-receipt",
    },
    actor,
  );
  source.mock.restore();
  assert.equal(compatible.key, legacyKey);
  assert.notEqual(compatible.key, compatible.application.key);
  assert.deepEqual(productParticipationSavedSchema.parse(compatible), compatible);
  // Именно эту проекцию использует прежний CLI --implementations / --clear.
  assert.equal(
    JSON.stringify({
      id: compatible.scopeId,
      ...("key" in compatible && typeof compatible.key === "string" ? { key: compatible.key } : {}),
      revision: compatible.revision,
    }),
    JSON.stringify(sourceReceipt),
  );
  const { key: _key, ...withoutKey } = compatible;
  assert.equal(Object.hasOwn(productParticipationSavedSchema.parse(withoutKey), "key"), false);
  assert.equal(
    productParticipationSavedSchema.safeParse({ ...withoutKey, key: null }).success,
    false,
  );
  assert.equal(Object.hasOwn(await product.entity(compatible.scopeId), "key"), false);
});

test("серверные validate/lint: прежние правила, полные страницы, публичные FI/SI и отсутствие чужих текстов", async (t) => {
  const { product, workspace, feature, replace } = await setup(t);
  await replace();
  const state = await product.state();
  assert.deepEqual(productValidationSchema.parse(await product.validate()), {
    valid: true,
    records: state.records.length,
    version: state.version,
  });
  const old = lintProduct(state, { limit: 100 });
  const all = productLintPageSchema.parse(await product.lint({ limit: 100 }));
  assert.equal(all.total, old.total);
  assert.equal(all.records, old.records);
  assert.deepEqual(
    all.warnings.map(({ recordId, title, field, code, message }) => ({
      id: recordId,
      name: title,
      field,
      code,
      message,
    })),
    old.warnings,
  );
  const warnings = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = await product.lint({ offset, limit: 1, version: all.version });
    assert.equal(page.total, all.total);
    warnings.push(...page.warnings);
    offset = page.nextOffset;
  }
  assert.deepEqual(warnings, all.warnings);
  const fi = await product.implementation("WEB-FI-1");
  const single = await product.lint({ ref: `implementation:${fi.id}` });
  assert.equal(single.records, 1);
  assert.equal(single.total, 1);
  assert.equal(single.warnings[0]!.implementationTarget, "feature");
  assert.equal(single.warnings[0]!.canonicalRef, "WEB-FI-1");
  assert.equal(
    (await new EntityEngine(workspace).get({ ref: single.warnings[0]!.canonicalRef })).ref.id,
    fi.id,
  );
  const si = await product.lint({ ref: "WEB-SI-1" });
  assert.equal(si.warnings[0]!.implementationTarget, "scenario");
  assert.ok(!JSON.stringify(single).includes(markdown));
  assert.equal(
    (await product.lint({ ref: feature.key! })).warnings.every(
      (entry) => entry.ref.id === feature.id,
    ),
    true,
  );
  await assert.rejects(product.lint({ ref: "UNKNOWN" }), { code: "PRODUCT_RECORD_NOT_FOUND" });
  await product.updateImplementation(
    { ref: fi.id, ifRevision: fi.revision, title: "Переименовано", requestId: "edit" },
    actor,
  );
  await assert.rejects(product.lint({ version: all.version }), {
    code: "VERSION_CONFLICT",
    exitCode: 4,
  });

  const raw = await new ProductRepository(workspace).all();
  const broken = raw.map((entry) =>
    entry.fields.kind === "scenario"
      ? { ...entry, fields: { ...entry.fields, featureId: "Missing1" } }
      : entry,
  );
  const mock = t.mock.method(ProductRepository.prototype, "ensureKeys", async () => broken);
  await assert.rejects(product.validate(), { code: "INVALID_REFERENCE" });
  mock.mock.restore();
});

test("карта — полная самостоятельная выборка с исходным snapshot guard обзора и адресом приложения scope", async (t) => {
  const { product, workspace, replace } = await setup(t);
  await replace();
  const overview = await product.overview();
  const all = productOverviewMapPageSchema.parse(
    await product.overviewMap({ version: overview.snapshotVersion, limit: 100 }),
  );
  assert.equal(all.total, overview.items.length);
  assert.equal(all.version, overview.version);
  assert.equal(all.snapshotVersion, overview.snapshotVersion);
  assert.deepEqual(
    all.items.map((entry) => entry.id),
    overview.items.map((entry) => entry.id),
  );
  assert.equal("snapshot" in all, false);
  assert.equal("readiness" in all, false);
  const scope = all.items.find((entry) => entry.kind === "scope")!;
  assert.equal(scope.subject.key, "WEB");
  assert.equal(scope.subject.ref.kind, "application");
  assert.match(scope.name, /Web/);
  const items = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = await product.overviewMap({ offset, limit: 1, version: overview.snapshotVersion });
    assert.equal(page.total, all.total);
    items.push(...page.items);
    offset = page.nextOffset;
  }
  assert.deepEqual(items, all.items);
  const beforeParticipation = await product.participation({ application: "WEB", limit: 1 });
  await new BoardTasksService(workspace).create(
    { board: "web", requestId: "new-task", title: "Работа" },
    actor,
  );
  assert.equal((await product.state()).version, overview.version);
  await assert.rejects(product.overviewMap({ version: overview.snapshotVersion }), {
    code: "VERSION_CONFLICT",
    exitCode: 4,
  });
  await assert.rejects(
    product.participation({ application: "WEB", version: beforeParticipation.snapshotVersion }),
    { code: "VERSION_CONFLICT", exitCode: 4 },
  );
  assert.equal(
    (await product.participation({ application: "WEB" })).version,
    beforeParticipation.version,
  );
});

test("новые FI+SI публикуются одной mutation; компактные страницы, raw status и тексты сохраняются при выборе refs", async (t) => {
  const { product, workspace, selections, replace } = await setup(t);
  const empty = await product.participation({ application: "WEB" });
  assert.equal(empty.scopeId, null);
  assert.equal(empty.revision, 0);
  assert.equal(empty.total, 0);
  const publish = StorageTransaction.prototype.publish;
  const count = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    function (this: StorageTransaction, ...args: Parameters<typeof publish>) {
      return publish.apply(this, args);
    },
  );
  const saved = productParticipationSavedSchema.parse(await replace());
  assert.equal(count.mock.callCount(), 1);
  count.mock.restore();
  assert.equal(saved.selected, 2);
  assert.equal(saved.revision, 1);
  const page = productParticipationPageSchema.parse(
    await product.participation({ application: "WEB", limit: 1 }),
  );
  assert.equal(page.version, saved.version);
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.items[0]!.savedStatus, "done");
  assert.equal(page.items[0]!.status, "none");
  assert.ok(!JSON.stringify(page).includes("description"));
  assert.ok(!JSON.stringify(page).includes("basis"));
  const second = await product.participation({
    application: "WEB",
    offset: page.nextOffset!,
    limit: 1,
    version: page.snapshotVersion,
  });
  assert.equal(second.nextOffset, null);
  assert.notEqual(second.items[0]!.ref.id, page.items[0]!.ref.id);
  const fi = productImplementationDetailSchema.parse(await product.implementation("WEB-FI-1"));
  assert.equal(fi.fields.description, markdown);
  assert.equal(fi.savedStatus, "done");
  assert.equal(fi.fields.status, "none");
  assert.equal(fi.createdBy, actor);
  await new BoardTasksService(workspace).create(
    { board: "web", requestId: "work", productLinks: [{ kind: "implementation", id: fi.id }] },
    actor,
  );
  const working = await product.implementation(fi.id);
  assert.equal(working.savedStatus, "done");
  assert.equal(working.fields.status, "partial");
  assert.equal(working.revision, fi.revision);
  const owned = await workspace.locked(() =>
    readOwned(workspace.storageSession!, { kind: "implementation", id: fi.id }),
  );
  assert.ok(
    owned.entries.some(
      ({ edge }) => edge.active && edge.type === "implements" && edge.to.id === fi.fields.featureId,
    ),
  );
  const prior = await product.participation({ application: "WEB" });
  const refs = prior.items.map((entry) => ({ kind: "existing" as const, ref: entry.key }));
  const same = await product.replaceParticipation(
    {
      application: "WEB",
      selections: refs,
      ifRevision: prior.revision,
      ifVersion: prior.version,
      requestId: "same",
    },
    actor,
  );
  assert.equal(same.revision, prior.revision + 1);
  assert.deepEqual(await product.implementation(fi.id), working);
  assert.deepEqual(
    await workspace.locked(() =>
      readOwned(workspace.storageSession!, { kind: "implementation", id: fi.id }),
    ),
    owned,
  );
  await assert.rejects(
    product.replaceParticipation(
      {
        application: "WEB",
        selections,
        ifRevision: same.revision,
        ifVersion: same.version,
        requestId: "existing-target",
      },
      actor,
    ),
    { code: "ALREADY_EXISTS" },
  );
});

test("снятый вклад редактируется с key и без него, включая generic update, без реактивации и потери отношений", async (t) => {
  const { product, workspace, replace } = await setup(t);
  await replace();
  const before = await product.participation({ application: "WEB" });
  const fi = await product.implementation("WEB-FI-1");
  const relations = await workspace.locked(() =>
    readOwned(workspace.storageSession!, { kind: "implementation", id: fi.id }),
  );
  const cleared = await product.replaceParticipation(
    {
      application: "WEB",
      selections: [],
      ifRevision: before.revision,
      ifVersion: before.version,
      requestId: "clear",
    },
    actor,
  );
  const inactive = await product.implementation(fi.id);
  assert.equal(inactive.fields.active, false);
  assert.equal((await product.participation({ application: "WEB" })).total, 2);
  assert.equal((await product.lint({ ref: fi.id })).total, 1);
  const updated = await product.updateImplementation(
    {
      ref: fi.id,
      ifRevision: inactive.revision,
      description: markdown + "Исправлено\n",
      requestId: "inactive-edit",
    },
    actor,
  );
  assert.equal(updated.revision, inactive.revision + 1);
  const withKey = await product.updateImplementation(
    {
      ref: fi.id,
      key: fi.key!,
      ifRevision: updated.revision,
      title: "Исправление с ключом",
      requestId: "inactive-key",
    },
    actor,
  );
  const generic = await new EntityEngine(workspace).update(
    {
      ref: fi.key!,
      ifRevision: withKey.revision,
      changes: { kind: "implementation", title: "Исправление без ключа" },
      requestId: "generic",
    },
    actor,
  );
  const current = await product.implementation(fi.id);
  assert.equal(current.revision, generic.revision);
  assert.equal(current.fields.active, false);
  assert.equal(current.savedStatus, "done");
  assert.equal(current.fields.status, "none");
  assert.equal(current.fields.description, markdown + "Исправлено\n");
  assert.equal(current.createdAt, fi.createdAt);
  assert.equal(current.fields.featureId, fi.fields.featureId);
  assert.deepEqual(
    await workspace.locked(() =>
      readOwned(workspace.storageSession!, { kind: "implementation", id: fi.id }),
    ),
    relations,
  );
  await assert.rejects(
    product.updateImplementation(
      {
        ref: fi.id,
        ifRevision: inactive.revision,
        title: "Устаревшая правка",
        requestId: "stale-inactive",
      },
      actor,
    ),
    { code: "REVISION_CONFLICT" },
  );
  await assert.rejects(
    product.replaceParticipation(
      {
        application: "WEB",
        selections: [],
        ifRevision: cleared.revision,
        ifVersion: cleared.version,
        requestId: "stale-product",
      },
      actor,
    ),
    { code: "REVISION_CONFLICT" },
  );
  const page = await product.participation({ application: "WEB" });
  await product.replaceParticipation(
    {
      application: "WEB",
      selections: page.items.map((entry) => ({ kind: "existing", ref: entry.ref.id })),
      ifRevision: page.revision,
      ifVersion: page.version,
      requestId: "restore",
    },
    actor,
  );
  const restored = await product.implementation(fi.id);
  assert.equal(restored.fields.active, true);
  assert.equal(restored.id, fi.id);
  assert.equal(restored.key, fi.key);
  assert.equal(restored.fields.description, current.fields.description);
  assert.equal(restored.savedStatus, current.savedStatus);
});

test("ошибочный состав, дубли, исходный CAS и конкурентные writers не оставляют части новых FI/SI", async (t) => {
  const { product, selections } = await setup(t);
  const initial = await product.participation({ application: "WEB" });
  const command = {
    application: "WEB",
    selections,
    ifRevision: initial.revision,
    ifVersion: initial.version,
    requestId: "atomic",
  };
  for (const selected of [
    [selections[1]!],
    [selections[0]!, selections[0]!],
    [...selections, { ...selections[0]!, target: "UNKNOWN" }],
  ]) {
    await assert.rejects(product.replaceParticipation({ ...command, selections: selected }, actor));
    assert.deepEqual(await product.participation({ application: "WEB" }), initial);
  }
  await assert.rejects(product.replaceParticipation({ ...command, ifRevision: 1 }, actor), {
    code: "REVISION_CONFLICT",
  });
  await assert.rejects(product.replaceParticipation({ ...command, ifVersion: "outdated" }, actor), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(
    productParticipationReplaceSchema.safeParse({
      ...command,
      selections: [{ kind: "target", target: "FEATURE-1", title: "Без текста" }],
    }).success,
    false,
  );
  const results = await Promise.allSettled([
    product.replaceParticipation(command, actor),
    product.replaceParticipation({ ...command, requestId: "competing" }, actor),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (entry) => entry.status === "rejected" && entry.reason.code === "REVISION_CONFLICT",
    ).length,
    1,
  );
  const page = await product.participation({ application: "WEB" });
  assert.equal(page.total, 2);
  assert.equal(page.revision, 1);
  await assert.rejects(product.replaceParticipation(command, actor), { code: "REVISION_CONFLICT" });
  assert.deepEqual(await product.participation({ application: "WEB" }), page);
});

test("отказ между составом и отношениями отменяет пакет; обрыв публикации восстанавливает FI/SI и их связи вместе", async (t) => {
  const { root, workspace, product, selections } = await setup(t);
  const initial = await product.participation({ application: "WEB" });
  const command = {
    application: "WEB",
    selections,
    ifRevision: initial.revision,
    ifVersion: initial.version,
    requestId: "fault",
  };
  const originalIndex = StorageSession.prototype.indexSet;
  const indexMock = t.mock.method(
    StorageSession.prototype,
    "indexSet",
    function (this: StorageSession, ...args: Parameters<typeof originalIndex>) {
      if (args[0] === "edges") throw new Error("Отказ отношений состава");
      return originalIndex.apply(this, args);
    },
  );
  await assert.rejects(product.replaceParticipation(command, actor), /Отказ отношений состава/);
  indexMock.mock.restore();
  assert.deepEqual(await product.participation({ application: "WEB" }), initial);
  const publish = StorageTransaction.prototype.publish;
  const publishMock = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    function (this: StorageTransaction, ...args: Parameters<typeof publish>) {
      return publish.apply(
        new StorageTransaction(this.root, (stage, path) => {
          if (stage === "file" && path?.startsWith("entities/implementations/"))
            throw new Error("Обрыв состава");
        }),
        args,
      );
    },
  );
  await assert.rejects(product.replaceParticipation(command, actor), /Обрыв состава/);
  publishMock.mock.restore();
  const reopened = new ProductQueries(await openWorkspace(root));
  const recovered = await reopened.participation({ application: "WEB" });
  assert.equal(recovered.total, 2);
  assert.equal(recovered.revision, 1);
  const fi = await reopened.implementation("WEB-FI-1");
  const si = await reopened.implementation("WEB-SI-1");
  assert.equal(fi.fields.description, markdown);
  assert.equal(si.savedStatus, "done");
  const relations = await workspace.locked(() =>
    readOwned(workspace.storageSession!, { kind: "implementation", id: si.id }),
  );
  assert.ok(
    relations.entries.some(
      ({ edge }) => edge.active && edge.type === "part-of" && edge.to.id === fi.id,
    ),
  );
  assert.ok(
    relations.entries.some(
      ({ edge }) =>
        edge.active && edge.type === "implements" && edge.to.id === si.fields.scenarioId,
    ),
  );
  assert.deepEqual(await reopened.participation({ application: "WEB" }), recovered);
});

test("новые чтения и замена разрешают прежние ключи, сохраняя текущие адреса, и отклоняют вклад чужого приложения", async (t) => {
  const { product, workspace, feature, replace } = await setup(t);
  await replace();
  const engine = new EntityEngine(workspace);
  const fi = await product.implementation("WEB-FI-1");
  await engine.rename(
    { ref: "WEB", key: "FRONTEND", ifRevision: 1, requestId: "rename-app" },
    actor,
  );
  await engine.rename(
    {
      ref: feature.id,
      key: "FEATURE-SEARCH",
      ifRevision: feature.revision,
      requestId: "rename-target",
    },
    actor,
  );
  await engine.rename(
    { ref: fi.id, key: "WEB-SEARCH", ifRevision: fi.revision, requestId: "rename-fi" },
    actor,
  );
  const page = await product.participation({ application: "WEB" });
  assert.equal(page.application.key, "FRONTEND");
  assert.equal(page.items.find((entry) => entry.ref.id === fi.id)!.target.key, "FEATURE-SEARCH");
  assert.equal((await product.implementation("WEB-FI-1")).canonicalRef, "WEB-SEARCH");
  assert.equal((await product.lint({ ref: "WEB-FI-1" })).warnings[0]!.canonicalRef, "WEB-SEARCH");
  await product.replaceParticipation(
    {
      application: "WEB",
      selections: [
        { kind: "existing", ref: "WEB-FI-1" },
        { kind: "existing", ref: "WEB-SI-1" },
      ],
      ifRevision: page.revision,
      ifVersion: page.version,
      requestId: "alias-replace",
    },
    actor,
  );
  assert.equal((await product.implementation("WEB-SEARCH")).savedStatus, "done");
  await product.mutate(
    {
      action: "create",
      requestId: "other-app",
      fields: {
        kind: "application",
        name: "API",
        slug: "api",
        prefix: "API",
        type: "backend",
        summary: "",
        description: "Сервис",
      },
    },
    actor,
  );
  const other = await product.participation({ application: "API" });
  await assert.rejects(
    product.replaceParticipation(
      {
        application: "API",
        selections: [{ kind: "existing", ref: "WEB-SEARCH" }],
        ifRevision: other.revision,
        ifVersion: other.version,
        requestId: "foreign",
      },
      actor,
    ),
    { code: "INVALID_REFERENCE" },
  );
  assert.deepEqual(await product.participation({ application: "API" }), other);
});

for (const kind of ["FI", "SI"] as const)
  for (const active of [true, false])
    test(`прямой update ${kind}: старый alias после rename, CAS и сохранение ${active ? "активного" : "снятого"} вклада`, async (t) => {
      const { product, workspace, replace } = await setup(t);
      await replace();
      const originalKey = `WEB-${kind}-1`;
      const renamedKey = `WEB-${kind}-RENAMED`;
      const finalKey = `WEB-${kind}-FINAL`;
      const initial = await product.implementation(originalKey);
      const owner = { kind: "implementation", id: initial.id };
      const relations = await workspace.locked(() => readOwned(workspace.storageSession!, owner));
      const renamed = await product.updateImplementation(
        { ref: originalKey, key: renamedKey, ifRevision: initial.revision, requestId: "rename" },
        actor,
      );
      assert.equal(renamed.id, initial.id);
      assert.equal((await product.implementation(originalKey)).canonicalRef, renamedKey);
      if (!active) {
        const participation = await product.participation({ application: "WEB" });
        await product.replaceParticipation(
          {
            application: "WEB",
            selections: [],
            ifRevision: participation.revision,
            ifVersion: participation.version,
            requestId: "withdraw",
          },
          actor,
        );
      }
      const before = await product.implementation(originalKey);
      const description = `${markdown}\nПравка ${kind} по старому ключу\r\n`;
      const changed = await product.updateImplementation(
        {
          ref: originalKey,
          ifRevision: before.revision,
          title: "Правка по алиасу",
          description,
          requestId: "alias-update",
        },
        actor,
      );
      assert.equal(changed.revision, before.revision + 1);
      assert.equal(changed.key, renamedKey);
      const after = await product.implementation(originalKey);
      assert.equal(after.id, initial.id);
      assert.equal(after.fields.description, description);
      assert.equal(after.fields.title, "Правка по алиасу");
      assert.equal(after.fields.active, active);
      assert.equal(after.savedStatus, initial.savedStatus);
      assert.equal(after.fields.status, "none");
      assert.equal(after.fields.basis, initial.fields.basis);
      assert.equal(after.fields.featureId, initial.fields.featureId);
      assert.equal(after.fields.scenarioId, initial.fields.scenarioId);
      assert.equal(after.fields.applicationId, initial.fields.applicationId);
      assert.equal(after.createdAt, initial.createdAt);
      assert.equal(after.createdBy, initial.createdBy);
      assert.deepEqual(await product.implementation(renamedKey), after);
      assert.deepEqual(await product.implementation(initial.id), after);
      await assert.rejects(
        product.updateImplementation(
          {
            ref: originalKey,
            ifRevision: before.revision,
            description: "Устаревший текст",
            requestId: "stale-alias",
          },
          actor,
        ),
        { code: "REVISION_CONFLICT", exitCode: 4 },
      );
      assert.deepEqual(await product.implementation(originalKey), after);

      // Второе переименование тоже идёт напрямую по типизированному старому алиасу.
      const renamedAgain = await product.updateImplementation(
        {
          ref: `implementation:${originalKey}`,
          key: finalKey,
          ifRevision: after.revision,
          requestId: "rename-by-alias",
        },
        actor,
      );
      assert.equal(renamedAgain.revision, after.revision + 1);
      const final = await product.implementation(finalKey);
      assert.deepEqual(new Set(final.reservedKeys), new Set([originalKey, renamedKey]));
      for (const ref of [originalKey, renamedKey, initial.id])
        assert.deepEqual(await product.implementation(ref), final);

      // Все публичные формы адреса остаются пригодными для записи после переименований.
      let revision = final.revision;
      for (const ref of [initial.id, finalKey, renamedKey]) {
        const saved = await product.updateImplementation(
          { ref, ifRevision: revision, title: `Правка ${ref}`, requestId: `update-${ref}` },
          actor,
        );
        assert.equal(saved.id, initial.id);
        assert.equal(saved.key, finalKey);
        assert.equal(saved.revision, revision + 1);
        revision = saved.revision;
      }
      const last = await product.implementation(originalKey);
      assert.equal(last.revision, revision);
      assert.equal(last.fields.active, active);
      assert.equal(last.savedStatus, initial.savedStatus);
      assert.equal(last.fields.description, description);
      assert.deepEqual(
        await workspace.locked(() => readOwned(workspace.storageSession!, owner)),
        relations,
      );
    });

test("одна замена смешивает existing FI и новый SI с собственным текстом без перезаписи raw данных FI", async (t) => {
  const { product, feature, replace } = await setup(t);
  await replace();
  const fi = await product.implementation("WEB-FI-1");
  const oldSi = await product.implementation("WEB-SI-1");
  await product.mutate(
    {
      action: "update",
      id: feature.id,
      ifRevision: feature.revision,
      requestId: "requirements",
      fields: {
        kind: "feature",
        name: "Поиск",
        summary: "",
        description: "Новые требования не подтверждают ручную отметку реализации",
      },
    },
    actor,
  );
  const scenario = await product.mutate(
    {
      action: "create",
      requestId: "next-scenario",
      fields: {
        kind: "scenario",
        name: "Другой сценарий",
        featureId: feature.id,
        description: "Проверяемый результат",
      },
    },
    actor,
  );
  const page = await product.participation({ application: "WEB" });
  const saved = await product.replaceParticipation(
    {
      application: "WEB",
      ifRevision: page.revision,
      ifVersion: page.version,
      requestId: "mixed",
      selections: [
        { kind: "existing", ref: fi.key! },
        {
          kind: "target",
          target: scenario.key!,
          title: "Новый SI",
          description: "\n# Собственный вклад\r\n\n",
        },
      ],
    },
    actor,
  );
  assert.equal(saved.selected, 2);
  assert.deepEqual(await product.implementation(fi.id), fi);
  assert.equal((await product.implementation(oldSi.id)).fields.active, false);
  const composition = await product.participation({ application: "WEB" });
  assert.equal(composition.total, 3);
  const newSi = composition.items.find((entry) => entry.target.ref.id === scenario.id)!;
  assert.equal(newSi.savedStatus, "none");
  assert.equal(
    (await product.implementation(newSi.ref.id)).fields.description,
    "\n# Собственный вклад\r\n\n",
  );
  await assert.rejects(
    product.replaceParticipation(
      {
        application: "WEB",
        ifRevision: composition.revision,
        ifVersion: composition.version,
        requestId: "si-only",
        selections: [{ kind: "existing", ref: newSi.key }],
      },
      actor,
    ),
    { code: "INVALID_REFERENCE" },
  );
  assert.deepEqual(await product.participation({ application: "WEB" }), composition);
});

test("lint не теряет замечания после 100; серверные страницы и validate не передают большой чужой Markdown", async (t) => {
  const { product, workspace, replace } = await setup(t);
  await replace();
  // Подготовка большого набора одним тестовым пакетом; публичная операция lint остаётся обычной.
  await workspace.mutate("product-fixture", { requestId: "many-features" }, actor, async () => {
    for (let index = 0; index < 51; index++)
      await product.mutate(
        {
          action: "create",
          requestId: `feature-${index}`,
          fields: {
            kind: "feature",
            name: `Фича ${index}`,
            summary: "",
            description: index === 0 ? "ЧужойMarkdown ".repeat(9000) : "Описание. ".repeat(30),
          },
        },
        actor,
      );
    return { created: 51 };
  });
  const full = [];
  let total = 0;
  let version: string | undefined;
  for (let offset: number | null = 0; offset !== null;) {
    const page = await product.lint({ offset, limit: 100, ...(version ? { version } : {}) });
    version = page.version;
    total = page.total;
    full.push(...page.warnings);
    offset = page.nextOffset;
  }
  assert.equal(total, 108);
  assert.equal(full.length, total);
  assert.equal(new Set(full.map((entry) => `${entry.ref.id}:${entry.code}`)).size, total);
  const validate = await product.validate();
  assert.equal(validate.records, (await product.state()).records.length);
  assert.ok(JSON.stringify(validate).length < 200);
  const selected = await product.lint({ ref: "WEB-FI-1" });
  assert.equal(selected.records, 1);
  assert.equal(selected.total, 1);
  assert.ok(JSON.stringify(selected).length < 1500);
  assert.ok(!JSON.stringify(selected).includes("ЧужойMarkdown"));
  const page = await product.participation({ application: "WEB", limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(JSON.stringify(page).length < 2000);
});
