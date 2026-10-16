import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { entityDetailSchema } from "@relay/contracts/entities";
import type { EntityGetQuery } from "@relay/contracts/entities";
import { BoardsService, boardViews } from "../src/application/boards/service.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import {
  entityDigest,
  entitySummary,
  readEntityCatalog,
  resolveEntity,
} from "../src/application/entities/catalog.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { BoardRepository } from "../src/storage/boards.js";
import { ProductRepository } from "../src/storage/product.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import type { Workspace } from "../src/storage/workspace.js";
import { fixture, legacyFixture } from "./helpers/workspace.js";
import { treeHashes } from "./helpers/migration-bases.js";
import { failWal } from "./helpers/wal.js";
import { frozenProject, tempDir } from "./helpers/migration-bases.js";
import { migrateStorage } from "../src/application/storage/maintenance.js";
import { openWorkspace } from "../src/storage/workspace.js";

const markdown = "# Точный текст 🧪 東京\r\n\n  Отступ  \n".repeat(300);
const application = (n: number) => ({
  kind: "application" as const,
  name: `Приложение ${n} 🧪 東京`,
  slug: `app-${n}`,
  prefix: `AU${String(n).padStart(2, "0")}`,
  type: "frontend" as const,
  summary: `Назначение ${n}`,
  description: markdown,
});
const persistent = (workspace: Workspace) =>
  treeHashes(workspace.dataRoot, (path) => path.startsWith("runtime"));

/** Независимый прежний источник: полные записи, а не индексная проекция. */
async function logicalBoards(workspace: Workspace) {
  return workspace.locked(async () => {
    const items = boardViews(
      await new BoardRepository(workspace).all(),
      await new ProductRepository(workspace).all(),
    );
    return { items, total: items.length, version: entityDigest(items), nextOffset: null };
  });
}
async function logicalDetail(workspace: Workspace, query: EntityGetQuery) {
  return workspace.locked(async (owned) => {
    const catalog = await readEntityCatalog(workspace, owned);
    const entry = resolveEntity(catalog, query.ref, query.kind);
    assert.equal(entry.data.kind, "board");
    if (entry.data.kind !== "board") throw new Error("Ожидалась доска");
    const id = entry.data.applicationId;
    return entityDetailSchema.parse({
      ...entitySummary(entry),
      data: entry.data,
      references: catalog.entries
        .filter((item) => item.ref.kind === "application" && item.ref.id === id)
        .map(entitySummary),
    });
  });
}

/** Холодные сегменты и реальные файлы отдельно от вызовов методов и размера выдачи. */
async function measured<T>(t: TestContext, workspace: Workspace, operation: () => Promise<T>) {
  forgetStorageSegments(workspace.dataRoot);
  const forbidden = () => assert.fail("Доска не должна читать полный каталог продукта или задач");
  const blocked = [
    t.mock.method(ProductRepository.prototype, "all", forbidden),
    t.mock.method(ProductRepository.prototype, "snapshot", forbidden),
    t.mock.method(BoardTaskRepository.prototype, "all", forbidden),
  ];
  const sessions = new Set<StorageSession>();
  const files: string[] = [];
  const scans: { index: string; entries: number }[] = [];
  const originalRead = StorageSession.prototype.readFile;
  const read = t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      sessions.add(this);
      assert.ok(
        !/^entities\/(tasks|documents|work-plans|releases|features|scenarios)\//.test(path),
        path,
      );
      if (!this.files.has(path) && !this.originals.has(path)) files.push(path);
      return originalRead.call(this, path);
    },
  );
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
  const originalRecords = StorageSession.prototype.records;
  const records = t.mock.method(
    StorageSession.prototype,
    "records",
    async function (this: StorageSession, kind: string) {
      assert.equal(kind, "board");
      return originalRecords.call(this, kind);
    },
  );
  const gets = t.mock.method(StorageSession.prototype, "indexGet");
  const allBoards = t.mock.method(BoardRepository.prototype, "all");
  try {
    const result = await operation();
    assert.ok([...sessions].every((session) => !session.changed));
    return {
      result,
      cost: {
        fullProductTaskScans: blocked.reduce((count, call) => count + call.mock.callCount(), 0),
        boardCatalogs: allBoards.mock.callCount(),
        boardReads: files.filter((path) => path.startsWith("entities/boards/")).length,
        applicationReads: files.filter((path) => path.startsWith("entities/applications/")).length,
        keyspaceReads: files.filter((path) => path.startsWith("keyspaces/")).length,
        indexGets: gets.mock.callCount(),
        scans,
        coldSegments: [...sessions].reduce(
          (sum, session) => sum + session.index.metrics.segmentReads,
          0,
        ),
      },
    };
  } finally {
    for (const call of [...blocked, read, entries, records, gets, allBoards]) call.mock.restore();
  }
}

test("BOARD-04: полные BoardView/EntityDetail, адреса/aliases/owner key и стабильные 2/20/18, страницы 7+7+4", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const boards = new BoardsService(workspace);
  assert.deepEqual(await boards.list(), await logicalBoards(workspace));
  assert.equal((await boards.list()).total, 2);
  const apps = [];
  for (let n = 1; n <= 18; n++)
    apps.push(await engine.create({ data: application(n), requestId: `app-${n}` }, "agent"));
  const full = await logicalBoards(workspace);
  assert.equal(full.total, 20);
  assert.deepEqual(await boards.list({ limit: 100 }), full);
  assert.equal(full.items[0]!.kind, "product");
  assert.equal(full.items.at(-1)!.kind, "infrastructure");
  assert.deepEqual(
    full.items.slice(1, -1).map((board) => board.applicationId),
    apps.map((app) => app.ref.id),
  );
  for (const board of full.items) {
    const expected = await logicalDetail(workspace, { ref: board.id, kind: "board" });
    for (const address of [board.id, board.slug, board.prefix, board.key!]) {
      assert.deepEqual(await boards.get(address), board);
      assert.deepEqual(await boards.get(`board:${address}`), board);
      assert.deepEqual(await engine.get({ ref: address, kind: "board" }), expected);
    }
    for (const ref of [board.id, board.key!, `board:${board.id}`, `board:${board.key}`])
      assert.deepEqual(await engine.get({ ref }), expected);
    assert.equal(typeof board.createdAt, "string");
    assert.equal(typeof board.createdBy, "string");
  }
  const first = full.items[1]!;
  const app = apps[0]!;
  await engine.update(
    {
      ref: app.key,
      changes: { kind: "application", name: "Новое имя владельца" },
      ifRevision: 1,
      requestId: "app-name",
    },
    "agent",
  );
  await assert.rejects(boards.list({ offset: 7, version: full.version }), {
    code: "BOARD_CHANGED",
  });
  const named = await boards.list({ limit: 100 });
  await engine.rename(
    { ref: app.key, key: "APP-RENAMED", ifRevision: 2, requestId: "app-key" },
    "agent",
  );
  // Ключ владельца не входит в BoardView; opaque version остаётся прежней.
  assert.deepEqual(await boards.list({ limit: 100 }), named);
  await engine.rename(
    { ref: first.id, key: "BOARD-RENAMED", ifRevision: 1, requestId: "board-key" },
    "agent",
  );
  await assert.rejects(boards.list({ offset: 7, version: named.version }), {
    code: "BOARD_CHANGED",
  });
  const renamed = await boards.get(first.key!);
  assert.equal(renamed.key, "BOARD-RENAMED");
  assert.equal(renamed.prefix, first.prefix);
  assert.equal(renamed.slug, first.slug);
  assert.equal(renamed.revision, 2);
  const detail = await engine.get({ ref: first.key!, kind: "board" });
  assert.equal(detail.references[0]!.key, "APP-RENAMED");
  assert.deepEqual(detail, await logicalDetail(workspace, { ref: first.key!, kind: "board" }));
  assert.deepEqual(await engine.get({ ref: "BOARD-RENAMED", kind: "board" }), detail);
  assert.deepEqual(
    (await engine.keys({ ref: first.id })).items.map((item) => item.key),
    ["BOARD-RENAMED", first.key],
  );

  const deletion = new EntityDeletionService(workspace);
  for (const app of apps.slice(-2)) {
    const before = await boards.list({ limit: 7 });
    const oldBoard = await boards.get(application(app === apps.at(-1) ? 18 : 17).slug);
    const preview = await deletion.preview({ ref: app.key, kind: "application" });
    await deletion.delete(
      {
        ref: app.key,
        kind: "application",
        ifVersion: preview.version,
        requestId: `delete-${app.key}`,
      },
      "agent",
    );
    await assert.rejects(boards.list({ offset: 7, version: before.version }), {
      code: "BOARD_CHANGED",
    });
    await assert.rejects(boards.get(oldBoard.id), { code: "NOT_FOUND" });
    await assert.rejects(engine.get({ ref: oldBoard.id, kind: "board" }), {
      code: "ENTITY_NOT_FOUND",
    });
  }
  const expected = await logicalBoards(workspace);
  assert.equal(expected.total, 18);
  const actual = [];
  const lengths = [];
  let offset = 0;
  do {
    const page = await boards.list({ limit: 7, offset, version: expected.version });
    actual.push(...page.items);
    lengths.push(page.items.length);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  assert.deepEqual(lengths, [7, 7, 4]);
  assert.deepEqual(actual, expected.items);
  assert.equal(new Set(actual.map((board) => board.id)).size, 18);
  assert.deepEqual(await boards.list({ limit: 7, offset: 18, version: expected.version }), {
    items: [],
    total: 18,
    nextOffset: null,
    version: expected.version,
  });
});

test("BOARD-04: рост несвязанных tasks/docs/plans не увеличивает адресное чтение; list читает только компактный состав", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const boards = new BoardsService(workspace);
  for (let n = 1; n <= 18; n++)
    await engine.create({ data: application(n), requestId: `app-${n}` }, "agent");
  const board = await boards.get("app-1");
  const operations: (() => Promise<unknown>)[] = [
    () => boards.get(board.id),
    () => boards.get("app-1"),
    () => boards.get("AU01"),
    () => engine.get({ ref: "BOARD-AU01", kind: "board" }),
    () => engine.get({ ref: "board:AU01", kind: "board" }),
    () => engine.get({ ref: "BOARD-PRODUCT", kind: "board" }),
  ];
  const baseline = [];
  for (const operation of operations) baseline.push(await measured(t, workspace, operation));
  const listBefore = await measured(t, workspace, () => boards.list({ limit: 1 }));
  t.diagnostic(`list 20 boards, 0 unrelated: ${JSON.stringify(listBefore.cost)}`);
  for (let n = 0; n < 24; n++) {
    await engine.create(
      {
        data: { kind: "task", board: "product", title: `Работа ${n}`, description: markdown },
        requestId: `task-${n}`,
      },
      "agent",
    );
    await engine.create(
      {
        data: {
          kind: "document",
          name: `Документ ${n}`,
          summary: "",
          documentKind: "description",
          body: markdown,
        },
        requestId: `doc-${n}`,
      },
      "agent",
    );
    const plan = await new PlanningService(workspace).create(
      { title: `План ${n}`, goal: markdown, requestId: `plan-${n}` },
      "agent",
    );
    await new ReleasesService(workspace).create(
      { title: `Релиз ${n}`, version: `${n}`, planIds: [plan.id], requestId: `release-${n}` },
      "agent",
    );
  }
  const files = await persistent(workspace);
  for (const [index, operation] of operations.entries()) {
    const actual = await measured(t, workspace, operation);
    assert.deepEqual(actual.result, baseline[index]!.result);
    const { coldSegments: _beforeSegments, ...before } = baseline[index]!.cost;
    const { coldSegments: _afterSegments, ...after } = actual.cost;
    assert.deepEqual(after, before);
    assert.equal(after.boardCatalogs, 0);
    assert.equal(after.boardReads, 1);
    assert.equal(after.applicationReads, index === 5 ? 0 : 1);
    t.diagnostic(
      `get ${index}, 0 → 96 unrelated: ${JSON.stringify(baseline[index]!.cost)} → ${JSON.stringify(actual.cost)}`,
    );
  }
  const listAfter = await measured(t, workspace, () => boards.list({ limit: 1 }));
  assert.deepEqual(listAfter.result, listBefore.result);
  assert.equal(listAfter.cost.boardReads, 20);
  assert.equal(listAfter.cost.applicationReads, 0);
  assert.equal(listAfter.cost.fullProductTaskScans, 0);
  t.diagnostic(`list 20 boards, 96 unrelated: ${JSON.stringify(listAfter.cost)}`);
  assert.deepEqual(await persistent(workspace), files);
});

for (const outcome of ["commit", "rollback"] as const)
  test(`BOARD-04: dirty create/rename, чтение без ранней проекции, ${outcome}`, async (t) => {
    const { workspace } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const boards = new BoardsService(workspace);
    const before = await boards.list();
    const files = await persistent(workspace);
    let final = before;
    let finalDetail;
    const abort = new Error("Откат проверки");
    const check = async () => {
      const session = workspace.storageSession!;
      assert.equal(session.changed, true);
      const noWrite = () => assert.fail("Чтение не должно актуализировать карточки");
      const indexSet = t.mock.method(session, "indexSet", noWrite);
      const write = t.mock.method(session, "writeFile", noWrite);
      try {
        final = await boards.list();
        assert.deepEqual(final, await logicalBoards(workspace));
        const expected = await logicalDetail(workspace, { ref: "AU01", kind: "board" });
        for (const ref of ["BOARD-AU01", "AU01", "app-1"])
          assert.deepEqual(await engine.get({ ref, kind: "board" }), expected);
        finalDetail = expected;
        assert.deepEqual(await boards.get("AU01"), final.items[1]);
        assert.deepEqual(await persistent(workspace), files);
      } finally {
        indexSet.mock.restore();
        write.mock.restore();
      }
    };
    const operation = () =>
      workspace.mutate("test", { requestId: "outer" }, "agent", async () => {
        const app = await engine.create({ data: application(1), requestId: "app" }, "agent");
        await check();
        await engine.rename(
          { ref: app.key, key: "APP-RENAMED", ifRevision: 1, requestId: "app-key" },
          "agent",
        );
        await engine.update(
          {
            ref: app.key,
            changes: { kind: "application", name: "Имя в сессии" },
            ifRevision: 2,
            requestId: "app-name",
          },
          "agent",
        );
        await engine.rename(
          { ref: "BOARD-AU01", key: "BOARD-RENAMED", ifRevision: 1, requestId: "board-key" },
          "agent",
        );
        await check();
        if (outcome === "rollback") throw abort;
        return null;
      });
    if (outcome === "rollback") {
      await assert.rejects(operation(), (error) => error === abort);
      assert.deepEqual(await boards.list(), before);
      assert.deepEqual(await persistent(workspace), files);
      await assert.rejects(engine.get({ ref: "BOARD-RENAMED", kind: "board" }), {
        code: "ENTITY_NOT_FOUND",
      });
    } else {
      await operation();
      assert.deepEqual(await boards.list(), final);
      assert.deepEqual(await engine.get({ ref: "AU01", kind: "board" }), finalDetail);
      await assert.rejects(boards.list({ offset: 1, version: before.version }), {
        code: "BOARD_CHANGED",
      });
    }
  });

test("BOARD-04: legacy fallback сохраняет DTO, версию и адреса без записи", async (t) => {
  const { workspace } = await legacyFixture(t);
  const boards = new BoardsService(workspace);
  const engine = new EntityEngine(workspace);
  const expected = await logicalBoards(workspace);
  const files = await persistent(workspace);
  assert.deepEqual(await boards.list(), expected);
  for (const board of expected.items) {
    assert.deepEqual(await boards.get(board.slug), board);
    assert.deepEqual(await boards.get(board.prefix), board);
    assert.deepEqual(
      await engine.get({ ref: board.id, kind: "board" }),
      await logicalDetail(workspace, { ref: board.id, kind: "board" }),
    );
  }
  assert.deepEqual(await persistent(workspace), files);
});

test("BOARD-04: повреждения выбранной доски/приложения, потеря индексов, profile и stale не обходятся", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const boards = new BoardsService(workspace);
  const app = await engine.create({ data: application(1), requestId: "app" }, "agent");
  const board = await boards.get("app-1");
  const boardPath = join(workspace.dataRoot, `entities/boards/${board.id}.json`);
  const appPath = join(workspace.dataRoot, `entities/applications/${app.ref.id}.json`);
  const boardRaw = JSON.parse(await readFile(boardPath, "utf8"));
  const appRaw = JSON.parse(await readFile(appPath, "utf8"));
  const getBoth = () => [
    () => boards.get(board.id),
    () => engine.get({ ref: board.key!, kind: "board" }),
  ];
  for (const scope of ["product", "application"] as const) {
    await writeFile(
      boardPath,
      JSON.stringify({ ...boardRaw, data: { ...boardRaw.data, scope, slug: "other" } }),
    );
    for (const operation of [...getBoth(), () => boards.list()])
      await assert.rejects(operation(), { code: "INVALID_DATA" });
  }
  await writeFile(boardPath, JSON.stringify(boardRaw));
  await writeFile(appPath, JSON.stringify({ ...appRaw, dataVersion: 999 }));
  for (const operation of getBoth())
    await assert.rejects(operation(), { code: "STORAGE_DATA_MIGRATION_REQUIRED" });
  await writeFile(appPath, JSON.stringify(appRaw));

  const statePath = join(workspace.dataRoot, ".indexes/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  for (const root of ["cards", "records", "selectors"]) {
    await writeFile(
      statePath,
      JSON.stringify({ ...state, roots: { ...state.roots, [root]: null } }),
    );
    forgetStorageSegments(workspace.dataRoot);
    for (const operation of [
      () => boards.get("app-1"),
      () => engine.get({ ref: "app-1", kind: "board" }),
      () => boards.list(),
    ])
      await assert.rejects(operation(), { code: "STORAGE_INDEX_CORRUPT" });
  }
  await writeFile(statePath, JSON.stringify(state));
  forgetStorageSegments(workspace.dataRoot);
  await writeFile(join(workspace.dataRoot, "runtime/index-stale.json"), "{}");
  for (const operation of [...getBoth(), () => boards.list()])
    await assert.rejects(operation(), { code: "STORAGE_INDEX_STALE" });
  await rm(join(workspace.dataRoot, "runtime/index-stale.json"));
  const manifestPath = join(workspace.dataRoot, "storage.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, dataModelVersion: 999 }));
  for (const operation of [...getBoth(), () => boards.list()])
    await assert.rejects(operation(), { code: "STORAGE_VERSION_UNSUPPORTED" });
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await boards.get(board.id)).id, board.id);
});

test("BOARD-04: обычный WAL восстанавливается до адресного get; конфликт не скрывается", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  failWal(t, (stage, path) => {
    if (stage === "file" && path?.startsWith("entities/boards/")) throw new Error("Сбой WAL");
  });
  await assert.rejects(
    engine.create({ data: application(1), requestId: "app" }, "agent"),
    /Сбой WAL/,
  );
  t.mock.restoreAll();
  const detail = await engine.get({ ref: "BOARD-AU01", kind: "board" });
  assert.equal(detail.references[0]!.key, "AU01");
  assert.equal((await new BoardsService(workspace).list()).total, 3);

  failWal(t, (stage, path) => {
    if (stage === "file" && path?.startsWith("entities/boards/")) throw new Error("Сбой WAL");
  });
  await assert.rejects(
    engine.create({ data: application(2), requestId: "app2" }, "agent"),
    /Сбой WAL/,
  );
  t.mock.restoreAll();
  const pendingPath = join(workspace.dataRoot, "transactions/pending.json");
  const pending = await readFile(pendingPath, "utf8");
  const intent = JSON.parse(pending);
  // Меняем именно подготовленный WAL-файл, а не постороннюю запись.
  const file = intent.changes.find((entry: { path: string }) =>
    entry.path.startsWith("entities/boards/"),
  );
  await writeFile(join(workspace.dataRoot, file.path), "{}");
  for (const operation of [
    () => engine.get({ ref: "BOARD-AU01", kind: "board" }),
    () => new BoardsService(workspace).get("app-1"),
    () => new BoardsService(workspace).list(),
  ])
    await assert.rejects(operation(), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert.equal(await readFile(pendingPath, "utf8"), pending);
});

for (const name of ["physical2-plan-v1-43d683b", "physical4-v0.7.0-52c4609"])
  test(`BOARD-04: ${name}, чтение сразу после workspace-cards@2 без записи/перепроекции`, async (t) => {
    const { project, configPath } = await frozenProject(t, name);
    await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
    const workspace = await openWorkspace(project, configPath);
    const boards = new BoardsService(workspace);
    const engine = new EntityEngine(workspace);
    const expected = await logicalBoards(workspace);
    const before = await persistent(workspace);
    assert.deepEqual(
      (await measured(t, workspace, () => boards.list({ limit: 100 }))).result,
      expected,
    );
    for (const board of expected.items) {
      const detail = await logicalDetail(workspace, { ref: board.id, kind: "board" });
      for (const ref of [board.id, board.key!, board.slug, board.prefix]) {
        assert.deepEqual((await measured(t, workspace, () => boards.get(ref))).result, board);
        assert.deepEqual(
          (await measured(t, workspace, () => engine.get({ ref, kind: "board" }))).result,
          detail,
        );
      }
    }
    assert.deepEqual(await persistent(workspace), before);
  });

test("BOARD-04: каталог проверяет отсутствие доски у приложения и порядок одинаковых createdAt", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const boards = new BoardsService(workspace);
  for (let n = 1; n <= 3; n++)
    await engine.create({ data: application(n), requestId: `app-${n}` }, "agent");
  await workspace.locked(async () => {
    const stored = await new BoardRepository(workspace).all();
    const products = await new ProductRepository(workspace).all();
    const tied = stored.map((board) => ({ ...board, createdAt: stored[0]!.createdAt }));
    const views = boardViews(tied.reverse(), products);
    assert.deepEqual(
      views.slice(1, -1).map((board) => board.id),
      stored
        .filter((board) => board.kind === "application")
        .map((board) => board.id)
        .sort((a, b) => a.localeCompare(b)),
    );
  });
  const board = await boards.get("app-1");
  await workspace.locked(async () => {
    workspace.storageSession!.indexSet("records", `board:${board.id}`, {
      ref: { kind: "board", id: board.id },
      deleted: true,
    });
  });
  await assert.rejects(boards.list(), {
    code: "INVALID_DATA",
    message: "У приложения отсутствует доска",
  });
});
