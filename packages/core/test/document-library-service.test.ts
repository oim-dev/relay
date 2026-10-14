import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentLinksQuerySchema,
  documentLinksPageSchema,
  documentSectionsQuerySchema,
  documentSectionsPageSchema,
  documentRelationChangeSchema,
  documentSectionChangeSchema,
} from "@relay/contracts/document-library";
import { DocumentLibraryService } from "../src/application/documents/library.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { ProductRepository } from "../src/storage/product.js";
import { readOwned } from "../src/storage/entity-store/relations.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { exists } from "../src/storage/files.js";
import { fixture } from "./helpers/workspace.js";
import { failWal } from "./helpers/wal.js";
import { persistent, treeHashes } from "./helpers/migration-bases.js";

const body = "\n# Правило 🧪\r\n\n  Пробелы\t  \n```ts\nconst x = 1\n```\n\n";
const doc = {
  kind: "document" as const,
  name: "Материал",
  summary: "",
  body,
  documentKind: "rules" as const,
};

test("Contracts: строгие страницы/union, defaults и отсутствие не равно очистке", () => {
  assert.deepEqual(documentLinksQuerySchema.parse({ ref: "DOC-1" }), {
    ref: "DOC-1",
    offset: 0,
    limit: 40,
  });
  assert.deepEqual(documentSectionsQuerySchema.parse({ limit: "2" }), { offset: 0, limit: 2 });
  const base = { ref: "DOC-1", target: "FEATURE-1", ifRevision: 1, requestId: "one" };
  const modern = { ...base, action: "link", source: "relations" };
  assert.deepEqual(documentRelationChangeSchema.parse(modern), {
    ...modern,
    relation: "documents",
  });
  assert.equal("description" in documentRelationChangeSchema.parse(modern), false);
  assert(documentRelationChangeSchema.safeParse({ ...modern, description: "" }).success);
  for (const value of [
    { ...modern, description: null },
    { ...modern, description: 7 },
    { ...modern, source: "links", description: "" },
    { ...modern, source: "links", relation: "documents" },
    { ...modern, action: "unlink", description: "" },
    { ...modern, ifRevision: -1 },
    { ...modern, actor: "" },
    { ...modern, extra: true },
  ])
    assert.equal(documentRelationChangeSchema.safeParse(value).success, false);
  assert(
    documentRelationChangeSchema.safeParse({ ...base, action: "unlink", source: "links" }).success,
  );
  const section = { action: "move", id: "a", before: null, ifRevision: 1, requestId: "section" };
  assert.deepEqual(documentSectionChangeSchema.parse(section), section);
  assert(!documentSectionChangeSchema.safeParse({ ...section, before: undefined }).success);
  assert(!documentSectionChangeSchema.safeParse({ ...section, name: "Лишнее" }).success);
  assert(!documentLinksPageSchema.safeParse({}).success);
  assert(!documentSectionsPageSchema.safeParse({}).success);
});

test("Библиотека: одна сессия/CAS, modern и legacy, пояснение/очистка/no-op, собственные рёбра", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Фича", summary: "", description: body },
    },
    "author",
  );
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA" } },
    "author",
  );
  const saved = await engine.create({ requestId: "document", data: doc }, "creator");
  const graph = new GraphService(workspace);
  const independent = await graph.mutate(
    {
      requestId: "independent",
      ifVersion: (await graph.read()).version,
      operations: [
        { action: "add", from: task.ref, to: saved.ref, type: "related", description: body },
      ],
    },
    "author",
  );
  const command = {
    ref: saved.key,
    target: task.key,
    source: "relations" as const,
    action: "link" as const,
    relation: "references" as const,
    ifRevision: 1,
    requestId: "link",
    description: body,
    actor: "explicit",
  };
  const publish = t.mock.method(StorageTransaction.prototype, "publish");
  const update = t.mock.method(EntityEngine.prototype, "update");
  const mutation = t.mock.method(GraphService.prototype, "mutate", () =>
    assert.fail("Нет диагностической записи графа"),
  );
  const result = await library.changeRelation(command, "default");
  assert.equal(publish.mock.callCount(), 1);
  assert.equal(update.mock.callCount(), 1);
  assert.equal(update.mock.calls[0]?.arguments[0].ifRevision, 1);
  mutation.mock.restore();
  publish.mock.restore();
  update.mock.restore();
  assert.deepEqual(result, {
    action: "update",
    ref: saved.ref,
    key: saved.key,
    revision: 2,
    requestId: "link",
  });
  let current = await engine.get({ ref: saved.key });
  assert.equal(current.metadata?.createdBy, "creator");
  assert.equal(current.metadata?.updatedBy, "explicit");
  assert.equal(current.data.kind === "document" && current.data.body, body);
  const owner = () => workspace.locked(() => readOwned(workspace.storageSession!, saved.ref));
  const owned = await owner();
  const edge = owned.entries.find((entry) => entry.edge.type === "references")!.edge;
  assert.equal(edge.from.id, task.ref.id);
  assert.equal(edge.to.id, saved.ref.id);
  assert.equal(edge.description.join("\n"), body);
  await assert.rejects(library.changeRelation({ ...command, target: "UNKNOWN" }, "default"), {
    code: "REVISION_CONFLICT",
  });
  const noDescription = { ...command, ifRevision: 2, description: undefined };
  const noop = await library.changeRelation(noDescription, "default");
  assert.equal(noop.revision, 3, "Повтор сохранения не превращается в дедупликацию requestId");
  assert.equal((await library.links({ ref: saved.key })).items[0]?.description, body);
  assert.equal(
    (await owner()).entries.find((entry) => entry.edge.type === "references")!.edge.id,
    edge.id,
  );
  const cleared = await library.changeRelation(
    { ...command, ifRevision: 3, description: "", requestId: "clear" },
    "default",
  );
  assert.equal(cleared.revision, 4);
  assert.equal((await library.links({ ref: saved.key })).items[0]?.description, "");
  const legacy = await library.changeRelation(
    {
      source: "links",
      action: "link",
      ref: saved.key,
      target: feature.key,
      ifRevision: 4,
      requestId: "legacy",
    },
    "default",
  );
  assert.equal(legacy.revision, 5);
  assert.deepEqual(
    (await library.links({ ref: saved.key })).items.map((entry) => entry.source),
    ["relations", "links"],
  );
  const unchanged = await treeHashes(workspace.dataRoot, persistent);
  for (const [input, code] of [
    [{ source: "relations", action: "link", target: feature.key }, "INVALID_REFERENCE"],
    [{ source: "links", action: "link", target: task.key }, "ENTITY_KIND_MISMATCH"],
    [{ source: "relations", action: "link", target: saved.key }, "INVALID_REFERENCE"],
    [
      { source: "relations", action: "unlink", target: feature.key, relation: "references" },
      "INVALID_ARGUMENT",
    ],
    [{ source: "links", action: "unlink", target: task.key }, "INVALID_ARGUMENT"],
    [{ source: "relations", action: "link", target: "UNKNOWN" }, "ENTITY_NOT_FOUND"],
  ] as const) {
    await assert.rejects(
      library.changeRelation(
        { ...input, ref: saved.key, ifRevision: 5, requestId: "invalid" },
        "default",
      ),
      { code },
    );
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), unchanged);
  }
  // Допустимое references не конвертирует/не удаляет прежнее documents той же цели.
  await library.changeRelation(
    {
      source: "relations",
      action: "link",
      relation: "references",
      target: feature.key,
      ref: saved.key,
      ifRevision: 5,
      requestId: "modern",
    },
    "default",
  );
  const noOpLegacy = await library.changeRelation(
    {
      source: "links",
      action: "link",
      target: feature.key,
      ref: saved.key,
      ifRevision: 6,
      requestId: "same-legacy",
    },
    "default",
  );
  assert.equal(noOpLegacy.revision, 7);
  await library.changeRelation(
    {
      source: "links",
      action: "unlink",
      target: feature.key,
      ref: saved.key,
      ifRevision: 7,
      requestId: "unlink-legacy",
    },
    "default",
  );
  await library.changeRelation(
    {
      source: "relations",
      action: "unlink",
      relation: "references",
      target: task.key,
      ref: saved.key,
      ifRevision: 8,
      requestId: "unlink",
    },
    "default",
  );
  current = await engine.get({ ref: saved.key });
  assert.equal(current.revision, 9);
  assert.equal(current.data.kind === "document" && current.data.body, body);
  const edges = (await graph.read({ root: saved.key })).edges;
  assert(edges.some((item) => item.id === independent.ids[0]));
  assert(!edges.some((item) => item.id === edge.id));
  const final = await owner();
  assert.equal(final.entries.find((item) => item.edge.id === edge.id)?.edge.active, false);
  assert.equal((await library.links({ ref: saved.key })).items.length, 1);
});

test("Библиотека: legacy PRODUCT/реализация и современные план/релиз разрешаются внутри операции", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: {
        kind: "feature",
        name: "Фича",
        summary: "",
        description: body,
      },
    },
    "agent",
  );
  const application = await engine.create(
    {
      requestId: "application",
      data: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        type: "frontend",
        summary: "",
        description: body,
      },
    },
    "agent",
  );
  const implementation = await engine.create(
    {
      requestId: "implementation",
      data: {
        kind: "implementation",
        application: application.key,
        target: feature.key,
        title: "Вклад",
        description: body,
      },
    },
    "agent",
  );
  await engine.rename(
    { ref: implementation.key, key: "IMPL-RENAMED", ifRevision: 1, requestId: "rename" },
    "agent",
  );
  const plan = await new PlanningService(workspace).create(
    { title: "План", requestId: "plan" },
    "agent",
  );
  const release = await new ReleasesService(workspace).create(
    { title: "Релиз", version: "1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  const saved = await engine.create({ requestId: "doc", data: doc }, "agent");
  let revision = 1;
  for (const target of ["PRODUCT", implementation.key]) {
    revision = (
      await library.changeRelation(
        {
          source: "links",
          action: "link",
          ref: saved.key,
          target,
          ifRevision: revision,
          requestId: `legacy-${revision}`,
        },
        "agent",
      )
    ).revision;
  }
  for (const target of [`work-plan:${plan.id}`, `release:${release.id}`]) {
    revision = (
      await library.changeRelation(
        {
          source: "relations",
          action: "link",
          ref: saved.key,
          target,
          ifRevision: revision,
          requestId: `modern-${revision}`,
        },
        "agent",
      )
    ).revision;
  }
  const detail = await engine.get({ ref: saved.key });
  assert.equal(detail.data.kind, "document");
  if (detail.data.kind !== "document") throw new Error("Нужен документ");
  assert.deepEqual(detail.data.links, [
    { kind: "product" },
    {
      kind: "implementation",
      id: implementation.ref.id,
      applicationId: application.ref.id,
    },
  ]);
  const page = await library.links({ ref: saved.key });
  assert.deepEqual(
    page.items.map((item) => [item.source, item.target.kind, item.type, item.description]),
    [
      ["relations", "work-plan", "documents", ""],
      ["relations", "release", "documents", ""],
      ["links", "product", "documents", ""],
      ["links", "implementation", "documents", ""],
    ],
  );
  assert.equal(
    page.references.find((item) => item.ref.id === implementation.ref.id)?.key,
    "IMPL-RENAMED",
  );
  for (const target of [`product:passport`, `implementation:${implementation.ref.id}`]) {
    revision = (
      await library.changeRelation(
        {
          source: "links",
          action: "unlink",
          ref: saved.key,
          target,
          ifRevision: revision,
          requestId: `remove-${revision}`,
        },
        "agent",
      )
    ).revision;
  }
  assert.equal((await library.links({ ref: saved.key })).total, 2);
});

test("Библиотека: разделы create/update/move/remove, 100 разделов страницами и guard PROJECT", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const initial = await library.sections();
  const created = await library.changeSection(
    {
      action: "create",
      id: "custom",
      name: "Особый",
      ifRevision: initial.revision,
      requestId: "create",
    },
    "editor",
  );
  assert.equal(created.ref.kind, "project");
  await assert.rejects(library.sections({ offset: 2, version: initial.version }), {
    code: "VERSION_CONFLICT",
    exitCode: 2,
  });
  const saved = await engine.create(
    { requestId: "doc", data: { ...doc, sectionId: "custom" } },
    "creator",
  );
  const documentPath = join(workspace.dataRoot, "entities/documents", `${saved.ref.id}.json`);
  const documentBefore = await readFile(documentPath, "utf8");
  let revision = created.revision;
  revision = (
    await library.changeSection(
      { action: "update", id: "custom", name: "Новое", ifRevision: revision, requestId: "update" },
      "editor",
    )
  ).revision;
  revision = (
    await library.changeSection(
      { action: "move", id: "custom", before: "product", ifRevision: revision, requestId: "move" },
      "editor",
    )
  ).revision;
  assert.equal((await library.sections()).items[0]?.id, "custom");
  revision = (
    await library.changeSection(
      { action: "move", id: "custom", before: null, ifRevision: revision, requestId: "last" },
      "editor",
    )
  ).revision;
  assert.equal((await library.sections()).items.at(-1)?.id, "custom");
  const noop = await library.changeSection(
    {
      action: "move",
      id: "custom",
      before: null,
      ifRevision: revision,
      requestId: "same-position",
    },
    "editor",
  );
  assert.equal(noop.revision, revision + 1);
  revision = noop.revision;
  const beforeInvalid = await treeHashes(workspace.dataRoot, persistent);
  for (const input of [
    { action: "create", id: "custom", name: "Повтор" },
    { action: "update", id: "missing", name: "Нет" },
    { action: "move", id: "custom", before: "custom" },
    { action: "move", id: "custom", before: "missing" },
    { action: "remove", id: "missing" },
  ] as const)
    await assert.rejects(
      library.changeSection({ ...input, ifRevision: revision, requestId: "invalid" }, "editor"),
      { code: "INVALID_ARGUMENT" },
    );
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), beforeInvalid);
  await assert.rejects(
    library.changeSection(
      { action: "remove", id: "custom", ifRevision: 1, requestId: "stale" },
      "editor",
    ),
    { code: "REVISION_CONFLICT" },
  );
  revision = (
    await library.changeSection(
      { action: "remove", id: "custom", ifRevision: revision, requestId: "remove" },
      "editor",
    )
  ).revision;
  assert.equal(await readFile(documentPath, "utf8"), documentBefore);
  assert.equal((await engine.get({ ref: saved.key })).document?.sectionId, null);
  const sections = Array.from({ length: 100 }, (_, n) => ({ id: `s${n}`, name: `Раздел ${n}` }));
  revision = (
    await engine.update(
      {
        ref: "PROJECT",
        ifRevision: revision,
        requestId: "hundred",
        changes: { kind: "project", documentSections: sections },
      },
      "editor",
    )
  ).revision;
  await assert.rejects(
    library.changeSection(
      {
        action: "create",
        id: "overflow",
        name: "Сто первый",
        ifRevision: revision,
        requestId: "overflow",
      },
      "editor",
    ),
    { code: "VALIDATION_ERROR" },
  );
  await engine.rename(
    { ref: "PROJECT", ifRevision: revision, key: "PROJECT-NEW", requestId: "rename" },
    "editor",
  );
  const first = await library.sections({ limit: 7 });
  assert.equal(first.projectKey, "PROJECT-NEW");
  const items = [];
  for (let offset = 0; offset < 100; offset += 7) {
    const next = await library.sections({ limit: 7, offset, version: first.version });
    assert.equal(next.version, first.version);
    items.push(...next.items);
    assert.equal(next.nextOffset, offset === 98 ? null : offset + 7);
  }
  assert.deepEqual(items, sections);
});

test("Библиотека: конкурентные записи используют исходный CAS, проигравшая не перезаписывает данные", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const saved = await engine.create({ requestId: "doc", data: doc }, "creator");
  const results = await Promise.allSettled(
    ["a", "b"].map((actor) =>
      library.changeRelation(
        {
          source: "relations",
          action: "link",
          ref: saved.key,
          target: "PROJECT",
          description: actor,
          ifRevision: 1,
          requestId: actor,
        },
        actor,
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert.equal(rejected.reason.code, "REVISION_CONFLICT");
  const current = await engine.get({ ref: saved.key });
  assert.equal(current.revision, 2);
  assert.equal(
    (await library.links({ ref: saved.key })).items[0]?.description,
    current.metadata?.updatedBy,
  );
});

test("Библиотека: строгая запись не пропускает повреждённый несвязанный каталог", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const library = new DocumentLibraryService(workspace);
  const saved = await engine.create({ requestId: "doc", data: doc }, "creator");
  const foreign = await engine.create(
    {
      requestId: "foreign",
      data: { kind: "feature", name: "Не связана", summary: "", description: body },
    },
    "creator",
  );
  const path = join(workspace.dataRoot, "entities/features", `${foreign.ref.id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.data.description = 7;
  await writeFile(path, JSON.stringify(raw));
  const before = await treeHashes(workspace.dataRoot, persistent);
  assert.equal((await engine.get({ ref: saved.key })).revision, 1);
  assert.equal((await library.links({ ref: saved.key })).total, 0);
  assert.equal((await engine.list({ kind: "document" })).total, 1);
  await assert.rejects(
    library.changeRelation(
      {
        source: "relations",
        action: "link",
        ref: saved.key,
        target: "PROJECT",
        ifRevision: 1,
        requestId: "change",
      },
      "editor",
    ),
    { code: "INVALID_DATA" },
  );
  await assert.rejects(
    library.changeSection(
      { action: "create", id: "safe", name: "Не запишется", ifRevision: 1, requestId: "section" },
      "editor",
    ),
    { code: "INVALID_DATA" },
  );
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
});

test("Библиотека: отказ между подготовкой документа и owned relations не публикует ни одной части", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const saved = await engine.create({ requestId: "doc", data: doc }, "creator");
  const before = await treeHashes(workspace.dataRoot, persistent);
  const save = ProductRepository.prototype.save;
  const mock = t.mock.method(
    ProductRepository.prototype,
    "save",
    async function (this: ProductRepository, ...args: Parameters<typeof save>) {
      await save.apply(this, args);
      assert(workspace.storageSession?.changed, "Документ уже подготовлен в общей сессии");
      throw new Error("Отказ до согласования отношений");
    },
  );
  await assert.rejects(
    new DocumentLibraryService(workspace).changeRelation(
      {
        source: "relations",
        action: "link",
        ref: saved.key,
        target: "PROJECT",
        description: body,
        ifRevision: 1,
        requestId: "rollback",
      },
      "editor",
    ),
    /Отказ до согласования отношений/,
  );
  mock.mock.restore();
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
  assert.equal((await engine.get({ ref: saved.key })).revision, 1);
  assert.equal((await new DocumentLibraryService(workspace).links({ ref: saved.key })).total, 0);
  assert.equal(await exists(join(workspace.dataRoot, "transactions/pending.json")), false);
});

for (const stage of ["before", "document", "relations"] as const) {
  test(`Библиотека: настоящий WAL changeRelation, сбой ${stage}, recovery без повторной команды`, async (t) => {
    const { workspace, root } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const saved = await engine.create({ requestId: "doc", data: doc }, "creator");
    const before = await treeHashes(workspace.dataRoot, persistent);
    failWal(t, (phase, path) => {
      if (
        (stage === "before" && phase === "intent") ||
        (stage === "document" && phase === "file" && path?.startsWith("entities/documents/")) ||
        (stage === "relations" && phase === "file" && path?.startsWith("relations/documents/"))
      )
        throw new Error(`Обрыв ${stage}`);
    });
    await assert.rejects(
      new DocumentLibraryService(workspace).changeRelation(
        {
          source: "relations",
          action: "link",
          ref: saved.key,
          target: "PROJECT",
          description: body,
          ifRevision: 1,
          requestId: "wal",
        },
        "editor",
      ),
      /Обрыв/,
    );
    assert(await exists(join(workspace.dataRoot, "transactions/pending.json")));
    t.mock.restoreAll();
    if (stage === "before")
      assert.equal(
        (await treeHashes(workspace.dataRoot, persistent)).get(
          `entities/documents/${saved.ref.id}.json`,
        ),
        before.get(`entities/documents/${saved.ref.id}.json`),
      );
    const restarted = await openWorkspace(root);
    const current = await new EntityEngine(restarted).get({ ref: saved.key });
    assert.equal(current.revision, 2);
    assert.equal(current.data.kind === "document" && current.data.body, body);
    assert.equal(current.metadata?.updatedBy, "editor");
    const links = await new DocumentLibraryService(restarted).links({ ref: saved.key });
    assert.equal(links.items[0]?.description, body);
    const owned = await restarted.locked(() => readOwned(restarted.storageSession!, saved.ref));
    assert.equal(owned.entries.filter((entry) => entry.edge.active).length, 1);
    assert.equal(owned.entries[0]?.edge.description.join("\n"), body);
    assert.equal(await exists(join(workspace.dataRoot, "transactions/pending.json")), false);
    assert.deepEqual(
      await new EntityEngine(await openWorkspace(root)).get({ ref: saved.key }),
      current,
    );
  });
}

test("Библиотека: WAL changeSection публикует PROJECT и индексы, не меняя документы", async (t) => {
  const { workspace, root } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const saved = await engine.create(
    { requestId: "doc", data: { ...doc, sectionId: "product" } },
    "creator",
  );
  const path = join(workspace.dataRoot, "entities/documents", `${saved.ref.id}.json`);
  const before = await readFile(path, "utf8");
  failWal(t, (phase, path) => {
    if (phase === "file" && path?.startsWith("entities/projects/"))
      throw new Error("Обрыв PROJECT");
  });
  await assert.rejects(
    new DocumentLibraryService(workspace).changeSection(
      { action: "remove", id: "product", ifRevision: 1, requestId: "wal-section" },
      "editor",
    ),
    /Обрыв/,
  );
  t.mock.restoreAll();
  const restarted = await openWorkspace(root);
  const library = new DocumentLibraryService(restarted);
  const sections = await library.sections();
  assert.equal(sections.revision, 2);
  assert(!sections.items.some((section) => section.id === "product"));
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(
    (await new EntityEngine(restarted).get({ ref: saved.key })).document?.sectionId,
    null,
  );
  assert.equal(await exists(join(workspace.dataRoot, "transactions/pending.json")), false);
});
