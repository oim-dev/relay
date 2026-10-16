import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  entityDefinitions,
  entityKinds,
  entityKeysPageSchema,
  entityKeySpacesSchema,
} from "@relay/contracts/entities";
import type { EntityKind, EntityGetQuery, CreateEntity } from "@relay/contracts/entities";
import { graphPageSchema } from "@relay/contracts/entities/graph";
import type { GraphQuery } from "@relay/contracts/entities/graph";
import { EntityEngine } from "../src/application/entities/service.js";
import {
  entityAddress,
  entityDigest,
  readEntityCatalog,
  resolveEntity,
} from "../src/application/entities/catalog.js";
import { GraphService } from "../src/application/graph/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { BoardRepository } from "../src/storage/boards.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import { ProductRepository } from "../src/storage/product.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import { digest } from "../src/storage/entity-store/format.js";
import type { Workspace } from "../src/storage/workspace.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { migrateStorage } from "../src/application/storage/maintenance.js";
import { fixture } from "./helpers/workspace.js";
import { treeHashes, frozenProject, tempDir } from "./helpers/migration-bases.js";

const markdown = "# Точный текст\r\n\n  Отступ 🧪 東京  \n".repeat(300);

async function mixedFixture(t: TestContext) {
  const base = await fixture(t);
  const { workspace } = base;
  const engine = new EntityEngine(workspace);
  let sequence = 0;
  const create = (data: CreateEntity["data"]) =>
    engine.create({ data, requestId: `seed-${sequence++}` }, "agent");
  await create({ kind: "product", name: "Продукт", summary: "", description: markdown });
  const feature = await create({
    kind: "feature",
    name: "Фича",
    summary: "",
    description: markdown,
  });
  const scenario = await create({
    kind: "scenario",
    featureId: feature.key,
    name: "Сценарий",
    description: markdown,
  });
  const app = await create({
    kind: "application",
    name: "Клиент 🧪",
    slug: "web",
    prefix: "WEB",
    type: "frontend",
    summary: "",
    description: markdown,
  });
  await create({
    kind: "implementation",
    application: app.key,
    target: feature.key,
    title: "Общий вклад",
    description: markdown,
  });
  const implementation = await create({
    kind: "implementation",
    application: app.key,
    target: scenario.key,
    title: "Реализация",
    description: markdown,
  });
  const task = await create({
    kind: "task",
    board: "BOARD-WEB",
    title: "Работа",
    description: markdown,
    targets: [implementation.key],
  });
  const plan = await new PlanningService(workspace).create(
    { title: "План", requestId: "plan" },
    "agent",
  );
  await new ReleasesService(workspace).create(
    { title: "Релиз", version: "1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  return { ...base, engine, feature, scenario, app, implementation, task, create };
}

/** Прежний логический источник: полные записи и productState, не persisted cards. */
function logicalGraph(workspace: Workspace) {
  return new GraphService(workspace, () =>
    workspace.locked(async (owned) => {
      const catalog = await readEntityCatalog(workspace, owned);
      return {
        nodes: catalog.entries.map((entry) => ({
          ref: entry.ref,
          key: entry.key,
          title: entry.title,
          revision: entry.revision,
          status: entry.status ?? "",
        })),
        aliases: Object.fromEntries(
          catalog.entries.map((entry) => [entityAddress(entry.ref), entry.aliases]),
        ),
      };
    }),
  );
}

async function logicalKeys(workspace: Workspace, query: EntityGetQuery) {
  return workspace.locked(async (owned) => {
    const entry = resolveEntity(await readEntityCatalog(workspace, owned), query.ref, query.kind);
    const items = [...new Set([entry.key, ...entry.aliases])].map((key) => ({
      ref: entry.ref,
      key,
      current: key === entry.key,
    }));
    return { items, total: items.length, nextOffset: null, version: entityDigest(items) };
  });
}

async function logicalSpaces(workspace: Workspace, kind: EntityKind) {
  return workspace.locked(async (owned) => {
    const catalog = await readEntityCatalog(workspace, owned);
    const dynamic = ["task", "board", "application", "implementation"].includes(kind);
    const scopeKind = ["application", "implementation"].includes(kind) ? "application" : "board";
    const prefix = (
      {
        project: "PROJECT",
        product: "PRODUCT",
        feature: "FEATURE",
        scenario: "SCENARIO",
        document: "DOC",
        "work-plan": "PLN",
        release: "REL",
      } as Partial<Record<EntityKind, string>>
    )[kind]!;
    const items = dynamic
      ? catalog.entries
          .filter((entry) => entry.ref.kind === scopeKind)
          .map((entry) => {
            assert.ok(entry.data.kind === "board" || entry.data.kind === "application");
            const prefix = entry.data.prefix ?? entry.key;
            return {
              scope: entry.ref,
              title: entry.title,
              prefix: kind === "board" ? `BOARD-${prefix}` : prefix,
              pattern:
                kind === "implementation"
                  ? `${prefix}-FI/SI-<номер>`
                  : kind === "application"
                    ? prefix
                    : kind === "board"
                      ? `BOARD-${prefix}`
                      : `${prefix}-<номер>`,
            };
          })
      : [
          {
            scope: null,
            title: entityDefinitions.find((entry) => entry.kind === kind)!.title,
            prefix,
            pattern: ["project", "product"].includes(kind) ? prefix : `${prefix}-<номер>`,
          },
        ];
    return { items, total: items.length, nextOffset: null, version: entityDigest(items) };
  });
}

/** Счётчики вызовов индексов и фактических холодных сегментов; не тайминг/SLA. */
async function measured<T>(t: TestContext, workspace: Workspace, operation: () => Promise<T>) {
  forgetStorageSegments(workspace.dataRoot);
  const forbidden = () => assert.fail("inspect не должен читать все предметные записи или их тела");
  const blocked = [
    t.mock.method(ProductRepository.prototype, "snapshot", forbidden),
    t.mock.method(ProductRepository.prototype, "all", forbidden),
    t.mock.method(BoardRepository.prototype, "all", forbidden),
    t.mock.method(BoardTaskRepository.prototype, "all", forbidden),
    t.mock.method(StorageSession.prototype, "records", forbidden),
    t.mock.method(StorageSession.prototype, "get", forbidden),
  ];
  const sessions = new Set<StorageSession>();
  const files: string[] = [];
  const originalRead = StorageSession.prototype.readFile;
  const read = t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      sessions.add(this);
      assert.ok(!path.startsWith("entities/"), path);
      if (!this.files.has(path) && !this.originals.has(path)) files.push(path);
      return originalRead.call(this, path);
    },
  );
  const originalGet = StorageSession.prototype.indexGet;
  const get = t.mock.method(
    StorageSession.prototype,
    "indexGet",
    async function (this: StorageSession, ...args: Parameters<typeof originalGet>) {
      sessions.add(this);
      return originalGet.apply(this, args);
    },
  );
  const entries = t.mock.method(StorageSession.prototype, "indexEntries");
  const parsed = t.mock.method(StorageSession.prototype, "indexGetParsed");
  const postings = t.mock.method(StorageSession.prototype, "postings");
  try {
    const result = await operation();
    assert.ok([...sessions].every((session) => !session.changed));
    return {
      result,
      cost: {
        fullScans: blocked.reduce((sum, call) => sum + call.mock.callCount(), 0),
        entityReads: files.filter((path) => path.startsWith("entities/")).length,
        relationReads: files.filter((path) => path.startsWith("relations/")).length,
        keyspaceReads: files.filter((path) => path.startsWith("keyspaces/")).length,
        indexGets: get.mock.callCount(),
        parsedGets: parsed.mock.callCount(),
        indexEntries: entries.mock.calls.map((call) => call.arguments[0]),
        postings: postings.mock.callCount(),
        coldSegments: [...sessions].reduce(
          (sum, session) => sum + session.index.metrics.segmentReads,
          0,
        ),
      },
    };
  } finally {
    for (const call of [...blocked, read, get, entries, parsed, postings]) call.mock.restore();
  }
}

test("INSP-06: смешанный каталог, полный DTO/версии, 20 узлов/40 рёбер, все страницы и фильтры без тел", async (t) => {
  const { workspace, engine, create, implementation } = await mixedFixture(t);
  const graph = new GraphService(workspace);
  const old = logicalGraph(workspace);
  const documents: Awaited<ReturnType<typeof create>>[] = [];
  const early = await measured(t, workspace, () =>
    engine.keys({ ref: implementation.key, limit: 1 }),
  );
  for (let n = 0; n < 20; n++)
    documents.push(
      await create({
        kind: "document",
        name: `Похожий документ ${n} 🧪 東京`,
        summary: "",
        body: markdown,
        documentKind: "description",
      }),
    );
  const root = documents[0]!;
  const operations = Array.from({ length: 19 }, (_, n) => ({
    action: "add" as const,
    from: documents[n]!.ref,
    to: documents[n + 1]!.ref,
    type: "references",
    description: `## Пояснение ${n}\r\n\n  Текст  \n`,
  }));
  operations.push(
    { action: "add", from: root.ref, to: root.ref, type: "references", description: "Петля" },
    {
      action: "add",
      from: root.ref,
      to: documents[1]!.ref,
      type: "related",
      description: "Параллельное",
    },
    ...Array.from({ length: 19 }, (_, n) => ({
      action: "add" as const,
      from: documents[n + 1]!.ref,
      to: documents[n]!.ref,
      type: "related",
      description: `Обратное ${n}`,
    })),
  );
  await graph.mutate(
    { requestId: "dense", ifVersion: (await graph.read()).version, operations },
    "agent",
  );
  const before = await treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime"));
  const queries: GraphQuery[] = [
    { limit: 1 },
    { root: root.key, depth: 0, limit: 1 },
    { root: root.key, depth: 1, direction: "outgoing", limit: 1 },
    { root: root.key, depth: 2, direction: "incoming", type: "references", limit: 2 },
    { root: root.key, depth: 100, limit: 1 },
    { root: root.key, depth: 3, type: "related", direction: "both", limit: 2 },
    { root: root.key, depth: 100, q: "документ 1", limit: 2 },
    { q: "Нет совпадений", limit: 1 },
    { q: root.key, limit: 1 },
    { q: entityAddress(root.ref), limit: 1 },
    { q: "# Точный текст", limit: 1 },
    { type: "references", limit: 2 },
    { root: root.key, depth: 2, profile: "context", limit: 1 },
  ];
  let pages = 0;
  for (const query of queries) {
    let offset = 0;
    let version: string | undefined;
    do {
      const input = { ...query, offset, ...(version ? { version } : {}) };
      const expected = await old.read(input);
      const actual = await measured(t, workspace, () => graph.read(input));
      assert.deepEqual(actual.result, expected, JSON.stringify(input));
      assert.deepEqual(graphPageSchema.parse(actual.result), expected);
      assert.ok(actual.cost.relationReads <= Number(query.limit));
      if (pages++ === 0) t.diagnostic(`graph limit=1: ${JSON.stringify(actual.cost)}`);
      version = actual.result.version;
      if (actual.result.nextOffset === null) break;
      offset = actual.result.nextOffset;
    } while (true);
  }
  const dense = (
    await measured(t, workspace, () => graph.read({ root: root.key, depth: 100, limit: 100 }))
  ).result;
  assert.equal(dense.totalNodes, 20);
  assert.equal(dense.totalEdges, 40);
  assert.equal(
    dense.edges.filter((edge) => entityAddress(edge.from) === entityAddress(edge.to)).length,
    1,
  );
  const context = (await measured(t, workspace, () => graph.context({ root: root.key }))).result;
  assert.equal(context.complete, true);
  assert.equal(context.nodes.length, 20);
  assert.equal(context.edges.length, 40);
  assert.equal(context.version, dense.version);
  assert.equal((await graph.read({ root: root.key, depth: 1, limit: 1 })).depthLimited, true);
  const later = await measured(t, workspace, () =>
    engine.keys({ ref: implementation.key, limit: 1 }),
  );
  assert.deepEqual(later.result, early.result);
  assert.deepEqual(later.cost, early.cost, "Рост чужих документов/графа не меняет стоимость keys");
  t.diagnostic(
    `keys limit=1 до/после 20 документов: ${JSON.stringify(later.cost)}; проверено страниц графа: ${pages}`,
  );
  assert.deepEqual(
    await treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime")),
    before,
  );
});

test("INSP-06: ключи, алиасы, selectors и scopes всех видов сохраняют порядок, версии и stale guards", async (t) => {
  const { workspace, engine, app, task, create } = await mixedFixture(t);
  const doc = await create({
    kind: "document",
    name: "Документ",
    summary: "",
    body: markdown,
    documentKind: "description",
  });
  const firstRename = await engine.rename(
    { ref: doc.key, key: "DOC-ROOT", ifRevision: 1, requestId: "rename-1" },
    "agent",
  );
  await engine.rename(
    { ref: doc.key, key: "DOC-FINAL", ifRevision: firstRename.revision, requestId: "rename-2" },
    "agent",
  );
  assert.deepEqual(
    (
      await measured(t, workspace, () =>
        new GraphService(workspace).read({ root: doc.key, limit: 1 }),
      )
    ).result,
    await logicalGraph(workspace).read({ root: doc.key, limit: 1 }),
  );
  await engine.rename(
    { ref: app.key, key: "APP-RENAMED", ifRevision: app.revision, requestId: "rename-app" },
    "agent",
  );
  const board = await engine.resolve({ ref: "BOARD-WEB" });
  await engine.rename(
    { ref: board.key, key: "BOARD-RENAMED", ifRevision: board.revision, requestId: "rename-board" },
    "agent",
  );
  const catalog = await workspace.locked((owned) => readEntityCatalog(workspace, owned));
  assert.deepEqual(new Set(catalog.entries.map((entry) => entry.ref.kind)), new Set(entityKinds));
  for (const entry of catalog.entries) {
    const queries: EntityGetQuery[] = [
      entry.key,
      entry.ref.id,
      entityAddress(entry.ref),
      ...entry.aliases,
    ].map((ref) => ({ ref }));
    queries.push(...entry.selectors.map((ref) => ({ ref, kind: entry.ref.kind })));
    for (const query of queries) {
      const expected = await logicalKeys(workspace, query);
      const actual = await measured(t, workspace, () => engine.keys(query));
      assert.deepEqual(actual.result, expected, JSON.stringify(query));
      assert.deepEqual(entityKeysPageSchema.parse(actual.result), expected);
    }
  }
  const expectedKeys = await logicalKeys(workspace, { ref: doc.key });
  const collected = [];
  for (let offset = 0; offset < expectedKeys.total; offset++) {
    const page = (
      await measured(t, workspace, () =>
        engine.keys({ ref: doc.key, limit: 1, offset, version: expectedKeys.version }),
      )
    ).result;
    assert.equal(page.nextOffset, offset + 1 < expectedKeys.total ? offset + 1 : null);
    collected.push(...page.items);
  }
  assert.deepEqual(collected, expectedKeys.items);
  for (const kind of entityKinds) {
    const expected = await logicalSpaces(workspace, kind);
    const actual = await measured(t, workspace, () => engine.keySpaces({ kind, limit: 1 }));
    assert.equal(actual.result.version, expected.version);
    assert.deepEqual(entityKeySpacesSchema.parse(actual.result), actual.result);
    const collected = [...actual.result.items];
    for (let offset = actual.result.nextOffset; offset !== null;) {
      const page = (
        await measured(t, workspace, () =>
          engine.keySpaces({ kind, limit: 1, offset: offset!, version: expected.version }),
        )
      ).result;
      collected.push(...page.items);
      offset = page.nextOffset;
    }
    assert.deepEqual(collected, expected.items);
    if (kind === "project" || kind === "task" || kind === "application")
      t.diagnostic(`key-spaces ${kind} limit=1: ${JSON.stringify(actual.cost)}`);
    if (!["task", "board", "application", "implementation"].includes(kind)) {
      assert.equal(actual.cost.indexGets, 1, "Только конфигурация при входе в Workspace.locked");
      assert.deepEqual(actual.cost.indexEntries, []);
    }
  }
  const appSpaces = await engine.keySpaces({ kind: "application" });
  assert.equal(appSpaces.items[0]!.prefix, "WEB", "rename не меняет префикс");
  const keyVersion = (await engine.keys({ ref: task.key, limit: 1 })).version;
  await engine.rename(
    { ref: task.key, key: "TASK-NEW", ifRevision: task.revision, requestId: "rename-task" },
    "agent",
  );
  await assert.rejects(engine.keys({ ref: task.key, offset: 1, version: keyVersion }), {
    code: "ENTITIES_CHANGED",
  });
  await engine.update(
    {
      ref: app.key,
      ifRevision: 2,
      requestId: "app-name",
      changes: { kind: "application", name: "Новое имя" },
    },
    "agent",
  );
  await assert.rejects(
    engine.keySpaces({ kind: "application", offset: 1, version: appSpaces.version }),
    { code: "ENTITIES_CHANGED" },
  );
  await assert.rejects(engine.keys({ ref: doc.key, kind: "task" }), {
    code: "ENTITY_KIND_MISMATCH",
  });
  await assert.rejects(engine.keys({ ref: "unknown" }), { code: "ENTITY_NOT_FOUND" });
  await measured(t, workspace, () => engine.resolve({ ref: doc.key }));
  await measured(t, workspace, () => engine.types());
});

const reviewApplication = {
  kind: "application" as const,
  name: "Приложение проверки",
  slug: "review-app",
  prefix: "REVIEW",
  type: "frontend" as const,
  summary: "",
  description: "Описание",
};

test("INSP-06: dirty keys разрешает префикс доски как selector до проекции карточек", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  await workspace.mutate("review", { requestId: "review" }, "qa", async () => {
    await engine.create({ requestId: "app", data: reviewApplication }, "qa");
    const query = { ref: "REVIEW", kind: "board" as const };
    const expected = await logicalKeys(workspace, query);
    assert.deepEqual(await engine.keys(query), expected);
    assert.equal(expected.items[0]!.key, "BOARD-REVIEW");
    return null;
  });
});

for (const outcome of ["commit", "rollback"] as const)
  test(`INSP-06: dirty keys/keySpaces, create/rename, DTO/версии до и после ${outcome}`, async (t) => {
    const { workspace } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const kinds = ["task", "board", "application", "implementation"] as const;
    const readSpaces = () =>
      Promise.all(kinds.map((kind) => engine.keySpaces({ kind, limit: 100 })));
    const beforeSpaces = await readSpaces();
    const beforeKeys = await engine.keys({ ref: "BOARD-PRODUCT" });
    const beforeFiles = await treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime"));
    let finalSpaces = beforeSpaces;
    let finalKeys = beforeKeys;
    let newBoardKeys: typeof beforeKeys | undefined;
    const abort = new Error("Откат общей операции проверки");

    // Чтение видит подготовленные данные, но не актуализирует/публикует проекцию само.
    const readOnly = async <T>(operation: () => Promise<T>) => {
      const session = workspace.storageSession!;
      assert.equal(session.changed, true);
      const files = structuredClone([...session.files]);
      const forbidden = () => assert.fail("Чтение dirty-сессии не должно писать индексы или файлы");
      const indexSet = t.mock.method(session, "indexSet", forbidden);
      const writeFile = t.mock.method(session, "writeFile", forbidden);
      try {
        const result = await operation();
        assert.equal(workspace.storageSession, session);
        assert.deepEqual([...session.files], files);
        assert.deepEqual(
          await treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime")),
          beforeFiles,
        );
        return result;
      } finally {
        indexSet.mock.restore();
        writeFile.mock.restore();
      }
    };
    const checkSpaces = () =>
      readOnly(async () => {
        const actual = await readSpaces();
        for (const [index, kind] of kinds.entries()) {
          const expected = await logicalSpaces(workspace, kind);
          assert.deepEqual(actual[index], expected, kind);
          assert.deepEqual(entityKeySpacesSchema.parse(actual[index]), expected);
        }
        return actual;
      });
    const checkKeys = (queries: EntityGetQuery[]) =>
      readOnly(async () => {
        for (const query of queries) {
          const expected = await logicalKeys(workspace, query);
          const actual = await engine.keys(query);
          assert.deepEqual(actual, expected, JSON.stringify(query));
          assert.deepEqual(entityKeysPageSchema.parse(actual), expected);
          for (let offset = 0; offset < expected.total; offset++) {
            const page = await engine.keys({
              ...query,
              offset,
              limit: 1,
              version: expected.version,
            });
            assert.deepEqual(page.items, expected.items.slice(offset, offset + 1));
            assert.equal(page.nextOffset, offset + 1 < expected.total ? offset + 1 : null);
          }
        }
      });
    const operation = () =>
      workspace.mutate("review", { requestId: "review" }, "qa", async () => {
        const app = await engine.create({ requestId: "app", data: reviewApplication }, "qa");
        const createdSpaces = await checkSpaces();
        assert.equal(
          createdSpaces[0]!.items.find((entry) => entry.prefix === "REVIEW")!.title,
          reviewApplication.name,
        );
        for (const [index, kind] of kinds.entries())
          await assert.rejects(
            engine.keySpaces({ kind, offset: 1, limit: 1, version: beforeSpaces[index]!.version }),
            { code: "ENTITIES_CHANGED" },
          );
        const board = await logicalKeys(workspace, { ref: "BOARD-REVIEW" });
        const boardRef = board.items[0]!.ref;
        const boardQueries: EntityGetQuery[] = [
          { ref: "BOARD-REVIEW" },
          { ref: boardRef.id },
          { ref: entityAddress(boardRef) },
          { ref: "review-app", kind: "board" },
          { ref: "REVIEW", kind: "board" },
        ];
        await checkKeys(boardQueries);
        await engine.rename(
          { ref: app.key, key: "APP-RENAMED", ifRevision: app.revision, requestId: "app-key" },
          "qa",
        );
        await engine.rename(
          {
            ref: "BOARD-REVIEW",
            key: "BOARD-REVIEW-RENAMED",
            ifRevision: 1,
            requestId: "board-key",
          },
          "qa",
        );
        await engine.rename(
          {
            ref: "BOARD-PRODUCT",
            key: "BOARD-PRODUCT-RENAMED",
            ifRevision: 1,
            requestId: "existing-key",
          },
          "qa",
        );
        // Публичный ключ/алиасы меняются; префикс и пространственная версия — нет.
        assert.deepEqual(await checkSpaces(), createdSpaces);
        await checkKeys([
          ...boardQueries,
          { ref: "BOARD-REVIEW-RENAMED" },
          { ref: "BOARD-PRODUCT" },
          { ref: "BOARD-PRODUCT-RENAMED" },
          { ref: "PRODUCT", kind: "board" },
          { ref: "product", kind: "board" },
          { ref: app.key },
          { ref: "APP-RENAMED" },
          { ref: entityAddress(app.ref) },
        ]);
        await assert.rejects(
          engine.keys({ ref: "BOARD-REVIEW", offset: 1, version: board.version }),
          { code: "ENTITIES_CHANGED" },
        );
        await assert.rejects(
          engine.keys({ ref: "BOARD-PRODUCT", offset: 1, version: beforeKeys.version }),
          { code: "ENTITIES_CHANGED" },
        );
        await engine.update(
          {
            ref: app.key,
            changes: { kind: "application", name: "Новое имя приложения" },
            ifRevision: 2,
            requestId: "app-title",
          },
          "qa",
        );
        finalSpaces = await checkSpaces();
        for (const [index, kind] of kinds.entries())
          await assert.rejects(
            engine.keySpaces({ kind, offset: 1, limit: 1, version: createdSpaces[index]!.version }),
            { code: "ENTITIES_CHANGED" },
          );
        finalKeys = await readOnly(() => engine.keys({ ref: "BOARD-PRODUCT" }));
        newBoardKeys = await readOnly(() => engine.keys({ ref: "BOARD-REVIEW" }));
        if (outcome === "rollback") throw abort;
        return null;
      });
    if (outcome === "rollback") await assert.rejects(operation(), (error) => error === abort);
    else await operation();
    assert.equal(workspace.storageSession, undefined);

    const expectedSpaces = outcome === "commit" ? finalSpaces : beforeSpaces;
    for (const [index, kind] of kinds.entries()) {
      const expected = expectedSpaces[index]!;
      const actual = await measured(t, workspace, () =>
        engine.keySpaces({ kind, limit: 100, version: expected.version }),
      );
      assert.deepEqual(actual.result, expected);
      assert.deepEqual(actual.result, await logicalSpaces(workspace, kind));
      const rejected = outcome === "commit" ? beforeSpaces[index]! : finalSpaces[index]!;
      await assert.rejects(
        engine.keySpaces({ kind, offset: 1, limit: 1, version: rejected.version }),
        { code: "ENTITIES_CHANGED" },
      );
    }
    const expectedKeys = outcome === "commit" ? finalKeys : beforeKeys;
    const actualKeys = await measured(t, workspace, () =>
      engine.keys({ ref: "BOARD-PRODUCT", version: expectedKeys.version }),
    );
    assert.deepEqual(actualKeys.result, expectedKeys);
    assert.deepEqual(actualKeys.result, await logicalKeys(workspace, { ref: "BOARD-PRODUCT" }));
    await assert.rejects(
      engine.keys({
        ref: "BOARD-PRODUCT",
        offset: 1,
        version: (outcome === "commit" ? beforeKeys : finalKeys).version,
      }),
      { code: "ENTITIES_CHANGED" },
    );
    if (outcome === "commit") {
      assert.deepEqual(
        (
          await measured(t, workspace, () =>
            engine.keys({ ref: "REVIEW", kind: "board", version: newBoardKeys!.version }),
          )
        ).result,
        newBoardKeys,
      );
    } else {
      await assert.rejects(engine.keys({ ref: "BOARD-REVIEW" }), { code: "ENTITY_NOT_FOUND" });
      await assert.rejects(engine.keys({ ref: "APP-RENAMED" }), { code: "ENTITY_NOT_FOUND" });
      assert.deepEqual(
        await treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime")),
        beforeFiles,
      );
    }
  });

test("INSP-06: предметная мутация обновляет calculated status и guard без изменения ревизии реализации", async (t) => {
  const { workspace, engine, task, implementation } = await mixedFixture(t);
  const graph = new GraphService(workspace);
  let version = (await graph.read({ limit: 1 })).version;
  let revision = task.revision;
  for (const [column, status] of [
    ["done", "done"],
    ["review", "partial"],
    ["cancelled", "partial"],
  ] as const) {
    const saved = await engine.moveTask(
      { ref: task.key, column, ifRevision: revision, requestId: column },
      "agent",
    );
    revision = saved.revision;
    await assert.rejects(graph.read({ offset: 1, limit: 1, version }), { code: "GRAPH_CHANGED" });
    const expected = await logicalGraph(workspace).read({ limit: 100 });
    const actual = (await measured(t, workspace, () => graph.read({ limit: 100 }))).result;
    assert.deepEqual(actual, expected);
    const node = actual.nodes.find((node) => node.ref.id === implementation.ref.id)!;
    assert.equal(node.status, status);
    assert.equal(node.revision, implementation.revision);
    assert.equal((await graph.context({ root: implementation.key })).version, actual.version);
    version = actual.version;
  }
  const saved = await graph.mutate(
    {
      ifVersion: version,
      requestId: "edge",
      operations: [
        {
          action: "add",
          from: task.ref,
          to: implementation.ref,
          type: "references",
          description: markdown,
        },
      ],
    },
    "agent",
  );
  await assert.rejects(graph.read({ offset: 1, limit: 1, version }), { code: "GRAPH_CHANGED" });
  assert.equal((await graph.read()).version, saved.version);
  const edge = (await graph.read({ root: task.key })).edges.find(
    (edge) => edge.id === saved.ids[0],
  )!;
  assert.equal(edge.description, markdown);
  const removed = await graph.mutate(
    {
      ifVersion: saved.version,
      requestId: "remove-edge",
      operations: [{ action: "remove", id: edge.id }],
    },
    "agent",
  );
  const after = (await measured(t, workspace, () => graph.read())).result;
  assert.equal(after.version, removed.version);
  assert.deepEqual(after, await logicalGraph(workspace).read());
  assert.ok(!after.edges.some((entry) => entry.id === edge.id));
});

test("INSP-06: повреждённые карточки, адреса и смежность не дают пустого успеха", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  assert.deepEqual(
    await engine.keySpaces({ kind: "application" }),
    await logicalSpaces(workspace, "application"),
  );
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-PRODUCT", title: "Задача" }, requestId: "task" },
    "agent",
  );
  const graph = new GraphService(workspace);
  const initial = await graph.read(); // Проверка также после прогрева версии.
  const address = entityAddress(task.ref);
  const originalGet = StorageSession.prototype.indexGet;
  for (const [index, value] of [
    ["cards", undefined],
    ["cards", { ref: { kind: "task", id: "wrong" } }],
    ["records", undefined],
  ] as const) {
    const mock = t.mock.method(
      StorageSession.prototype,
      "indexGet",
      async function (this: StorageSession, name: string, key: string) {
        return name === index && key === address ? value : originalGet.call(this, name, key);
      },
    );
    try {
      await assert.rejects(engine.keys({ ref: task.key }), { code: "STORAGE_INDEX_CORRUPT" });
      if (index === "cards")
        await assert.rejects(graph.read({ limit: 1 }), { code: "STORAGE_INDEX_CORRUPT" });
    } finally {
      mock.mock.restore();
    }
  }
  const post = t.mock.method(StorageSession.prototype, "postings", async () => []);
  try {
    await assert.rejects(graph.read({ limit: 1 }), { code: "STORAGE_INDEX_CORRUPT" });
  } finally {
    post.mock.restore();
  }
  const originalEntries = StorageSession.prototype.indexEntries;
  const brokenEdge = t.mock.method(
    StorageSession.prototype,
    "indexEntries",
    async function (this: StorageSession, name: string) {
      const entries = await originalEntries.call(this, name);
      if (name !== "edges") return entries;
      return entries.map(([id, raw]) => [
        id,
        { ...(raw as object), to: { kind: "document", id: "missing" } },
      ]);
    },
  );
  try {
    await assert.rejects(graph.read({ limit: 1 }), { code: "INVALID_REFERENCE" });
  } finally {
    brokenEdge.mock.restore();
  }
  assert.deepEqual(await graph.read(), initial);
});

test("INSP-06: потеря сегмента/корня и внешняя правка keyspace диагностируются без ремонта", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const graph = new GraphService(workspace);
  const statePath = join(workspace.dataRoot, ".indexes/state.json");
  const bytes = await readFile(statePath, "utf8");
  const state = JSON.parse(bytes);
  const cardHash: string = state.roots.cards;
  const segment = join(
    workspace.dataRoot,
    `.indexes/segments/${cardHash.slice(0, 2)}/${cardHash}.json`,
  );
  const cardBytes = await readFile(segment);
  await rm(segment);
  forgetStorageSegments(workspace.dataRoot);
  for (const read of [
    () => engine.keys({ ref: "PROJECT" }),
    () => engine.keySpaces({ kind: "task" }),
    () => graph.read({ limit: 1 }),
  ])
    await assert.rejects(read(), { code: "STORAGE_INDEX_CORRUPT" });
  await writeFile(segment, cardBytes);
  for (const root of ["cards", "records", "addresses"]) {
    await writeFile(
      statePath,
      JSON.stringify({ ...state, roots: { ...state.roots, [root]: null } }),
    );
    await assert.rejects(graph.read({ limit: 1 }), { code: "STORAGE_INDEX_CORRUPT" });
    await writeFile(statePath, bytes);
  }
  await writeFile(
    statePath,
    JSON.stringify({ ...state, roots: { ...state.roots, edges: null, adjacency: null } }),
  );
  await assert.rejects(graph.read({ limit: 1 }), { code: "STORAGE_INDEX_CORRUPT" });
  await writeFile(statePath, bytes);
  const board = await engine.resolve({ ref: "BOARD-PRODUCT" });
  const path = join(workspace.dataRoot, `keyspaces/${board.ref.id}.json`);
  const original = await readFile(path, "utf8");
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), prefix: "CHANGED" }));
  await assert.rejects(engine.keySpaces({ kind: "task", limit: 1 }), {
    code: "STORAGE_INDEX_STALE",
  });
  assert.notEqual(digest(JSON.parse(await readFile(path, "utf8"))), digest(JSON.parse(original)));
});

for (const name of ["physical2-plan-v1-43d683b", "physical4-v0.7.0-52c4609"])
  test(`INSP-06: ${name}, чтение сразу после канонической миграции без перепроекции`, async (t) => {
    const { project, configPath } = await frozenProject(t, name);
    await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
    const workspace = await openWorkspace(project, configPath);
    const engine = new EntityEngine(workspace);
    const expected = await logicalGraph(workspace).read({ limit: 100 });
    const actual = await measured(t, workspace, () =>
      new GraphService(workspace).read({ limit: 100 }),
    );
    assert.deepEqual(actual.result, expected);
    for (const kind of entityKinds) {
      const expected = await logicalSpaces(workspace, kind);
      assert.deepEqual(
        (await measured(t, workspace, () => engine.keySpaces({ kind }))).result,
        expected,
      );
    }
    for (const node of actual.result.nodes.filter((node) => node.ref.kind !== "plan-stage"))
      assert.deepEqual(
        (await measured(t, workspace, () => engine.keys({ ref: node.key }))).result,
        await logicalKeys(workspace, { ref: node.key }),
      );
  });
