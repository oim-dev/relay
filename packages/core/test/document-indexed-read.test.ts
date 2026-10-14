import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { entityDetailSchema } from "@relay/contracts/entities";
import type { EntityRef, EntitiesQuery } from "@relay/contracts/entities";
import { DocumentLibraryService } from "../src/application/documents/library.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import {
  entityAddress,
  entityDigest,
  entitySummary,
  readEntityCatalog,
  resolveEntity,
} from "../src/application/entities/catalog.js";
import { documentTargets } from "../src/application/documents/read.js";
import { ProductQueries } from "../src/application/product/queries.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { ProductRepository } from "../src/storage/product.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import type { Workspace } from "../src/storage/workspace.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { fixture } from "./helpers/workspace.js";
import { treeHashes, persistent, frozenProject, tempDir } from "./helpers/migration-bases.js";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { migrateStorage } from "../src/application/storage/maintenance.js";

const body = "# Полный Markdown 🧪\r\n\n  отступ\t  \n\n`````\nraw\n`````\n";
const doc = (name: string, text = body) => ({
  kind: "document" as const,
  name,
  summary: `Когда читать ${name}`,
  body: text,
  documentKind: "instruction" as const,
});
const documentPath = (workspace: Workspace, id: string) =>
  join(workspace.dataRoot, "entities/documents", `${id}.json`);

async function logicalDetail(workspace: Workspace, ref: string) {
  return workspace.locked(async (owned) => {
    const catalog = await readEntityCatalog(workspace, owned);
    const entry = resolveEntity(catalog, ref, "document");
    assert.equal(entry.data.kind, "document");
    if (entry.data.kind !== "document") throw new Error("Нужен документ");
    const addresses = new Set(documentTargets(entry.data).map(entityAddress));
    assert(!("metadata" in entry));
    assert.equal(catalog.version, entityDigest([catalog.entries, catalog.reservedKeys]));
    return entityDetailSchema.parse({
      ...entitySummary(entry),
      data: entry.data,
      metadata: catalog.metadata?.get(entityAddress(entry.ref)),
      references: catalog.entries
        .filter((item) => addresses.has(entityAddress(item.ref)))
        .map(entitySummary),
    });
  });
}

async function measured<T>(t: TestContext, workspace: Workspace, operation: () => Promise<T>) {
  forgetStorageSegments(workspace.dataRoot);
  const forbidden = () => assert.fail("Чтение документов не должно собирать продукт/задачи");
  const blocked = [
    t.mock.method(ProductRepository.prototype, "all", forbidden),
    t.mock.method(ProductRepository.prototype, "snapshot", forbidden),
    t.mock.method(BoardTaskRepository.prototype, "all", forbidden),
  ];
  const files: string[] = [];
  const sessions = new Set<StorageSession>();
  const original = StorageSession.prototype.readFile;
  const read = t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      sessions.add(this);
      assert(
        !/^entities\/(products|features|scenarios|applications|implementations|boards|tasks|work-plans|releases)\//.test(
          path,
        ),
        path,
      );
      if (!this.files.has(path) && !this.originals.has(path)) files.push(path);
      return original.call(this, path);
    },
  );
  const scans: Array<{ index: string; entries: number }> = [];
  const originalEntries = StorageSession.prototype.indexEntries;
  const entries = t.mock.method(
    StorageSession.prototype,
    "indexEntries",
    async function (this: StorageSession, index: string) {
      sessions.add(this);
      const result = await originalEntries.call(this, index);
      scans.push({ index, entries: result.length });
      return result;
    },
  );
  const originalGet = StorageSession.prototype.indexGet;
  const gets = t.mock.method(
    StorageSession.prototype,
    "indexGet",
    async function (this: StorageSession, index: string, key: string) {
      sessions.add(this);
      return originalGet.call(this, index, key);
    },
  );
  try {
    const value = await operation();
    assert([...sessions].every((session) => !session.changed));
    const cost = {
      documents: files.filter((path) => path.startsWith("entities/documents/")).length,
      projects: files.filter((path) => path.startsWith("entities/projects/")).length,
      foreignBodies: 0,
      scans,
      indexGets: gets.mock.callCount(),
      coldSegments: [...sessions].reduce(
        (sum, session) => sum + session.index.metrics.segmentReads,
        0,
      ),
      dtoBytes: Buffer.byteLength(JSON.stringify(value)),
    };
    return {
      value,
      cost,
      cardReads: gets.mock.calls
        .filter((call) => call.arguments[0] === "cards")
        .map((call) => call.arguments[1]),
    };
  } finally {
    for (const mock of [...blocked, read, entries, gets]) mock.mock.restore();
  }
}

test("D05/D07: адреса/алиасы, точный DTO, effective section и метаданные одной ревизии", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Цель", summary: "", description: body },
    },
    "creator",
  );
  const saved = await engine.create(
    {
      requestId: "doc",
      data: {
        ...doc("Материал"),
        sectionId: "architecture",
        relations: [{ target: feature.ref, type: "documents", description: body }],
      },
    },
    "creator",
  );
  await engine.rename(
    { ref: feature.key, ifRevision: 1, key: "FEATURE-RENAMED", requestId: "rename-target" },
    "editor",
  );
  await engine.rename(
    { ref: saved.key, ifRevision: 1, key: "GUIDE-1", requestId: "rename-doc" },
    "editor",
  );
  const expected = await logicalDetail(workspace, saved.key);
  for (const ref of [
    saved.key,
    "GUIDE-1",
    saved.ref.id,
    `document:${saved.ref.id}`,
    `document:${saved.key}`,
  ]) {
    for (const kind of [undefined, "document"] as const) {
      const result = await measured(t, workspace, () =>
        engine.get({ ref, ...(kind ? { kind } : {}) }),
      );
      assert.deepEqual(result.value, expected);
      assert.equal(result.cost.documents, 1);
      assert.equal(result.cost.scans.length, 0);
    }
  }
  const product = await new ProductQueries(workspace).entity(saved.key);
  assert.equal(product.revision, expected.revision);
  const { createdAt, createdBy, updatedAt, updatedBy } = product;
  assert.deepEqual(expected.metadata, { createdAt, createdBy, updatedAt, updatedBy });
  assert.equal(updatedBy, "editor");
  assert.equal(expected.document?.updatedAt, updatedAt);
  assert.equal(expected.references[0]?.key, "FEATURE-RENAMED");
  assert(!("metadata" in expected.references[0]!));
  const { metadata: _metadata, ...oldResponse } = expected;
  assert.deepEqual(entityDetailSchema.parse(oldResponse), oldResponse);
  assert(
    !entityDetailSchema.safeParse({ ...oldResponse, metadata: { updatedBy: "unknown" } }).success,
  );
  await assert.rejects(engine.get({ ref: feature.key, kind: "document" }), {
    code: "ENTITY_KIND_MISMATCH",
  });
  await assert.rejects(engine.get({ ref: "MISSING", kind: "document" }), {
    code: "ENTITY_NOT_FOUND",
  });
  const before = await readFile(documentPath(workspace, saved.ref.id), "utf8");
  const sections = await library.sections();
  await library.changeSection(
    { action: "remove", id: "architecture", ifRevision: sections.revision, requestId: "remove" },
    "editor",
  );
  const after = await engine.get({ ref: saved.key });
  assert.equal(after.document?.sectionId, null);
  assert.equal(after.data.kind === "document" && after.data.sectionId, "architecture");
  assert.deepEqual(after.metadata, expected.metadata);
  assert.equal(await readFile(documentPath(workspace, saved.ref.id), "utf8"), before);
  assert.deepEqual(after, await logicalDetail(workspace, saved.key));
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: saved.key, kind: "document" });
  await deletion.delete(
    { ref: saved.key, kind: "document", ifVersion: preview.version, requestId: "delete" },
    "editor",
  );
  await assert.rejects(engine.get({ ref: saved.key, kind: "document" }), {
    code: "ENTITY_NOT_FOUND",
  });
});

test("D05: 40 отношений, предельный body, холодный I/O до/после роста чужих записей, все страницы", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const targets: EntityRef[] = [];
  for (let n = 0; n < 20; n++)
    targets.push(
      (
        await engine.create(
          {
            requestId: `feature-${n}`,
            data: { kind: "feature", name: `Фича ${n}`, summary: "", description: body },
          },
          "agent",
        )
      ).ref,
    );
  // Публичный контракт body ограничен 256 КиБ: 1 МиБ был бы недопустимым fixture.
  const largeBody = body + "x".repeat(250 * 1024 - Buffer.byteLength(body)) + "\nТОЛЬКОТЕЛО\n";
  const relations = targets.flatMap((target) =>
    (["documents", "references"] as const).map((type) => ({
      target,
      type,
      description: `${body}${type}\n${"я".repeat(1000)}\n`,
    })),
  );
  const saved = await engine.create(
    { requestId: "large", data: { ...doc("Большой", largeBody), relations } },
    "agent",
  );
  const second = await engine.create({ requestId: "second", data: doc("Другой") }, "agent");
  const costs = [];
  for (const growth of [0, 12]) {
    if (growth)
      for (let n = 0; n < growth; n++) {
        await engine.create(
          {
            requestId: `task-${n}`,
            data: { kind: "task", board: "BOARD-INFRA", description: body.repeat(100) },
          },
          "agent",
        );
        const plan = await new PlanningService(workspace).create(
          { title: `План ${n}`, goal: body, requestId: `plan-${n}` },
          "agent",
        );
        await new ReleasesService(workspace).create(
          {
            title: `Релиз ${n}`,
            version: String(n),
            planIds: [plan.id],
            requestId: `release-${n}`,
          },
          "agent",
        );
      }
    const before = await treeHashes(workspace.dataRoot, persistent);
    const get = await measured(t, workspace, () =>
      engine.get({ ref: saved.key, kind: "document" }),
    );
    assert.equal(get.value.data.kind === "document" && get.value.data.body, largeBody);
    const links = await measured(t, workspace, () => library.links({ ref: saved.key, limit: 2 }));
    assert.equal(links.cost.documents, 1);
    assert.equal(links.value.references.length, 1);
    assert.equal(links.value.items.length, 2);
    assert(!JSON.stringify(links.value).includes("ТОЛЬКОТЕЛО"));
    assert.deepEqual(
      new Set(links.cardReads),
      new Set([entityAddress(saved.ref), entityAddress(targets[0]!)]),
    );
    const sections = await measured(t, workspace, () => library.sections({ limit: 2 }));
    assert.equal(sections.cost.projects, 1);
    assert.equal(sections.cost.documents, 0);
    const list = await measured(t, workspace, () => engine.list({ kind: "document", limit: 1 }));
    assert.equal(list.cost.documents, 0);
    assert.equal(list.value.total, 2);
    assert.match(list.value.version, /^documents-v1:[a-f0-9]{64}$/);
    const search = await measured(t, workspace, () =>
      engine.list({ kind: "document", q: "ТОЛЬКОТЕЛО", refs: [saved.key] }),
    );
    assert.equal(search.cost.documents, 1);
    assert.equal(search.value.total, 1);
    assert(search.value.items[0]?.document?.excerpt?.includes("ТОЛЬКОТЕЛО"));
    const target = await measured(t, workspace, () =>
      engine.list({ kind: "document", target: entityAddress(targets[0]!) }),
    );
    assert.equal(target.cost.documents, 2);
    assert.equal(target.value.total, 1);
    const next = await engine.list({
      kind: "document",
      limit: 1,
      offset: 1,
      version: list.value.version,
    });
    assert.equal(next.items[0]?.ref.id, second.ref.id);
    assert.equal(next.nextOffset, null);
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
    costs.push({
      growth,
      get: get.cost,
      links: links.cost,
      sections: sections.cost,
      list: list.cost,
      search: search.cost,
      target: target.cost,
    });
  }
  t.diagnostic(JSON.stringify(costs));
  const items = [];
  const page = await library.links({ ref: saved.key, limit: 7 });
  for (let offset = 0; offset < 40; offset += 7) {
    const next = await measured(t, workspace, () =>
      library.links({ ref: saved.key, limit: 7, offset, version: page.version }),
    );
    items.push(...next.value.items);
    assert(next.value.references.length <= next.value.items.length);
    assert.equal(next.value.nextOffset, offset === 35 ? null : offset + 7);
  }
  assert.deepEqual(
    items,
    relations.map((link) => ({ source: "relations", ...link })),
  );
  const empty = await library.links({ ref: saved.key, offset: 100, version: page.version });
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.references, []);
  const catalog = await workspace.locked((owned) => readEntityCatalog(workspace, owned));
  await assert.rejects(engine.list({ kind: "document", version: catalog.version }), {
    code: "ENTITIES_CHANGED",
  });
  const listVersion = (await engine.list({ kind: "document" })).version;
  await engine.update(
    {
      ref: saved.key,
      changes: { kind: "document", summary: "Новое" },
      ifRevision: saved.revision,
      requestId: "change",
    },
    "agent",
  );
  await assert.rejects(library.links({ ref: saved.key, offset: 7, version: page.version }), {
    code: "VERSION_CONFLICT",
    exitCode: 2,
  });
  await assert.rejects(engine.list({ kind: "document", offset: 1, version: listVersion }), {
    code: "ENTITIES_CHANGED",
  });
});

test("D05: фильтры и библиотечные counts сохраняют прежний логический результат", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const target = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA" } },
    "agent",
  );
  const saved = [];
  for (let n = 0; n < 6; n++)
    saved.push(
      await engine.create(
        {
          requestId: `doc-${n}`,
          data: {
            ...doc(`Документ ${5 - n}`, `${body}\nТЕЛО-${n}`),
            sectionId: n % 2 ? "product" : null,
            pinned: n % 2 === 0,
            documentStatus: n > 3 ? "archived" : n === 0 ? "active" : "draft",
            relations: n % 2 ? [{ target: target.ref, type: "references", description: body }] : [],
          },
        },
        "agent",
      ),
    );
  for (const query of [
    {},
    { q: "ТЕЛО-1" },
    { q: "Когда читать" },
    { q: "   " },
    { target: target.key },
    { section: "none" },
    { section: "product", archived: "false" },
    { pinned: "true", sort: "updated" },
    { status: "draft", sort: "title" },
    { documentKind: "instruction" },
    { refs: [saved[0]!.key, saved[3]!.key] },
    { archived: "true" },
    { q: "НЕ НАЙТИ" },
    { offset: 10 },
  ] satisfies EntitiesQuery[]) {
    const indexed = await engine.list({ ...query, kind: "document", limit: 2 });
    // Принудительно выбираем dirty-reader, не меняя предметные данные и не публикуя индексы.
    const logical = await workspace.locked(async () => {
      const session = workspace.storageSession!;
      const changed = t.mock.getter(session, "changed", () => true);
      try {
        return await engine.list({ ...query, kind: "document", limit: 2 });
      } finally {
        changed.mock.restore();
      }
    });
    const { version: _indexed, ...actual } = indexed;
    const { version: _logical, ...expected } = logical;
    assert.deepEqual(actual, expected, JSON.stringify(query));
  }
});

test("D05/D07: dirty/legacy читают действительную запись без ранней проекции и выдуманных метаданных", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const saved = await engine.create({ requestId: "doc", data: doc("До") }, "creator");
  await workspace.mutate("test", { requestId: "outer" }, "editor", async () => {
    await engine.update(
      {
        ref: saved.key,
        ifRevision: 1,
        requestId: "inner",
        changes: { kind: "document", name: "После", body },
      },
      "editor",
    );
    assert(workspace.storageSession?.changed);
    const current = await engine.get({ ref: saved.key });
    assert.equal(current.revision, 2);
    assert.equal(current.metadata?.updatedBy, "editor");
    assert.equal((await library.links({ ref: saved.key })).title, "После");
    assert.equal((await engine.list({ kind: "document" })).items[0]?.title, "После");
    const sections = await library.sections();
    await library.changeSection(
      {
        action: "create",
        id: "dirty",
        name: "В сессии",
        ifRevision: sections.revision,
        requestId: "section",
      },
      "editor",
    );
    assert((await library.sections()).items.some((section) => section.id === "dirty"));
    return { revision: current.revision };
  });
  const before = await engine.get({ ref: saved.key });
  await writeLegacyMigrationFixture(workspace);
  const persistentBefore = await treeHashes(workspace.dataRoot, persistent);
  assert.deepEqual(await engine.get({ ref: saved.key }), before);
  assert.equal((await library.links({ ref: saved.key })).revision, before.revision);
  assert((await library.sections()).items.some((section) => section.id === "dirty"));
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), persistentBefore);
  await assert.rejects(
    library.changeSection(
      { action: "remove", id: "dirty", ifRevision: 2, requestId: "legacy" },
      "editor",
    ),
    { code: "STORAGE_MIGRATION_REQUIRED" },
  );
});

test("D05/D07: повреждение/потеря записи или индекса не превращается в пустую карточку", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const saved = await engine.create({ requestId: "doc", data: doc("Документ") }, "creator");
  const path = documentPath(workspace, saved.ref.id);
  const before = await readFile(path, "utf8");
  for (const change of [
    (raw: Record<string, any>) => {
      delete raw.createdBy;
    },
    (raw: Record<string, any>) => {
      raw.data.body = 7;
    },
  ]) {
    const raw = JSON.parse(before);
    change(raw);
    await writeFile(path, JSON.stringify(raw));
    await assert.rejects(engine.get({ ref: saved.key }), { code: "INVALID_DATA" });
    await assert.rejects(library.links({ ref: saved.key }), { code: "INVALID_DATA" });
    await writeFile(path, before);
  }
  const raw = JSON.parse(before);
  raw.data.body = ["Внешнее изменение без новой ревизии"];
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(engine.get({ ref: saved.key }), { code: "STORAGE_INDEX_STALE" });
  await assert.rejects(engine.list({ kind: "document", q: "Внешнее" }), {
    code: "STORAGE_INDEX_STALE",
  });
  await writeFile(path, before);
  await rm(path);
  await assert.rejects(engine.get({ ref: saved.key }), { code: "ENTITY_NOT_FOUND" });
  await writeFile(path, before);
  await workspace.locked(async () => {
    const session = workspace.storageSession!;
    const get = session.indexGet.bind(session);
    const mock = t.mock.method(session, "indexGet", (index: string, key: string) =>
      index === "cards" && key === entityAddress(saved.ref)
        ? Promise.resolve(undefined)
        : get(index, key),
    );
    try {
      await assert.rejects(engine.get({ ref: saved.key }), { code: "STORAGE_INDEX_CORRUPT" });
    } finally {
      mock.mock.restore();
    }
  });
  assert.equal(await readFile(path, "utf8"), before);
});

test("D05: сохранённая цель plan-stage читается без фиктивной карточки", async (t) => {
  const { project, configPath } = await frozenProject(t, "physical2-plan-v1-43d683b");
  await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  const workspace = await openWorkspace(project, configPath);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const documents = await engine.list({ kind: "document", limit: 100 });
  let found = false;
  for (const document of documents.items) {
    const full = await engine.get({ ref: document.key });
    const links = await library.links({ ref: document.key, limit: 100 });
    for (const link of links.items)
      if (link.target.kind === "plan-stage") {
        found = true;
        assert(
          !links.references.some(
            (target) => entityAddress(target.ref) === entityAddress(link.target),
          ),
        );
        assert(
          !full.references.some(
            (target) => entityAddress(target.ref) === entityAddress(link.target),
          ),
        );
        await assert.rejects(
          library.changeRelation(
            {
              source: "relations",
              action: "link",
              ref: document.key,
              target: entityAddress(link.target),
              ifRevision: document.revision,
              requestId: "stage",
            },
            "agent",
          ),
          { code: "ENTITY_RELOCATED" },
        );
      }
  }
  assert(found, "Историческая фикстура содержит адресное отношение к прежнему этапу");
});
