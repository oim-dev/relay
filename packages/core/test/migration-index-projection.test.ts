import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { StoredEntity } from "@relay/contracts/storage";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { defaultConfig } from "../src/domain/config.js";
import { AppError } from "../src/shared/errors.js";
import { migrateStorage, planStorageMigration } from "../src/application/storage/maintenance.js";
import { validateWorkspace } from "../src/application/validate.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import { tempDir, treeHashes, writeJsonFile, readJsonFile } from "./helpers/migration-bases.js";

const description = "Текст\r\n\n  пробелы Ω 界  \n";
const at = "2026-09-26T00:00:00.000Z";
type RelationSet = {
  entries: { edge: { active: boolean; type: string; from: EntityRef; to: EntityRef } }[];
};

/** Минимальная legacy-база из регрессии CLI: одна доска, две задачи и пустой паспорт. */
async function legacyBase(t: TestContext, filename = "config.json") {
  const project = await tempDir(t, "relay-migration-cards-");
  const root = join(project, ".relay");
  const configPath = join(root, filename);
  await mkdir(join(root, "boards/product/tasks"), { recursive: true });
  await writeJsonFile(configPath, {
    ...structuredClone(defaultConfig),
    projectId: "Legacy01",
    storageDir: "tasks",
    projectSettings: { version: 1, name: "Legacy", slug: "legacy", revision: 1 },
  });
  await writeJsonFile(join(root, "boards/product/board.json"), {
    version: 1,
    id: "board_product",
    slug: "product",
    prefix: "PRODUCT",
    kind: "product",
    applicationId: null,
    revision: 1,
    createdAt: at,
    createdBy: "relay",
  });
  for (const n of [1, 2])
    await writeJsonFile(join(root, `boards/product/tasks/LegacyT${n}.json`), {
      version: 4,
      id: `LegacyT${n}`,
      key: `PRODUCT-${n}`,
      keys: [`PRODUCT-${n}`, `OLD-${n}`],
      boardId: "board_product",
      title: `Сохранить ${n}`,
      description: description.split("\n"),
      productLinks: [],
      column: "inbox",
      rank: n,
      revision: 7,
      dependencies: [],
      related: [],
      parentId: n === 2 ? "LegacyT1" : null,
      acceptanceCriteria: [],
      requests: {},
      events: [],
      createdAt: at,
      updatedAt: at,
      createdBy: "agent",
      updatedBy: "agent",
    });
  return { project, root, configPath };
}

/** Не вычисляем oracle той же функцией проекции: поля ожидаются по смыслу предметного каталога. */
async function assertProjected(base: Awaited<ReturnType<typeof legacyBase>>) {
  const workspace = await openWorkspace(base.project, base.configPath);
  const before = await treeHashes(base.root);
  assert.deepEqual(await validateWorkspace(workspace), {
    valid: true,
    entities: 5,
    tasks: 2,
    boards: 1,
  });
  const cards = await workspace.locked(() => workspace.storageSession!.indexEntries("cards"));
  const byAddress = new Map(cards.map(([key, raw]) => [key, raw as Record<string, unknown>]));
  assert.equal(byAddress.get("board:board_product")!.title, "Продукт");
  assert.equal(byAddress.get("board:board_product")!.summary, "Доска задач: Продукт");
  assert.deepEqual(byAddress.get("board:board_product")!.selectors, ["product", "PRODUCT"]);
  assert.equal(byAddress.get("product:passport")!.title, "Продукт (паспорт не заполнен)");
  assert.equal(byAddress.get("product:passport")!.status, "uninitialized");
  assert.equal(
    byAddress.get("project:Legacy01")!.summary,
    "Область данных и настроек выбранного проекта",
  );
  for (const n of [1, 2]) {
    const card = byAddress.get(`task:LegacyT${n}`)!;
    assert.equal(card.context, "BOARD-PRODUCT · Продукт");
    assert.equal(card.title, `Сохранить ${n}`);
    assert.equal(card.revision, 7);
    assert.deepEqual(card.aliases, [`OLD-${n}`]);
    const record = await readJsonFile<StoredEntity>(
      join(base.root, `entities/tasks/LegacyT${n}.json`),
    );
    assert.equal(record.id, `LegacyT${n}`);
    assert.equal(record.revision, 7);
    assert.deepEqual(record.data.description, description.split("\n"));
    assert.equal(record.data.parentId, n === 2 ? "LegacyT1" : null);
    assert.equal(record.createdAt, at);
    assert.equal(record.updatedAt, at);
    assert.equal(record.createdBy, "agent");
    assert.equal(record.updatedBy, "agent");
    const relations = await readJsonFile<RelationSet>(
      join(base.root, `relations/tasks/LegacyT${n}.json`),
    );
    assert.ok(
      relations.entries.some(
        ({ edge }) =>
          edge.active &&
          edge.type === "part-of" &&
          edge.from.id === `LegacyT${n}` &&
          edge.to.id === "board_product",
      ),
    );
    if (n === 2)
      assert.ok(
        relations.entries.some(
          ({ edge }) =>
            edge.active &&
            edge.type === "part-of" &&
            edge.from.id === "LegacyT2" &&
            edge.to.id === "LegacyT1",
        ),
      );
  }
  assert.deepEqual(
    await treeHashes(base.root),
    before,
    "check и чтение проекции не меняют даже индексы",
  );
}

/** Проверяем границу callback: меняются только индексы в памяти, не готовый файловый пакет. */
function watchProjection(t: TestContext) {
  const registry = productionTransitionRegistry();
  const original = registry.projectIndexes.bind(registry);
  let calls = 0;
  t.mock.method(registry, "projectIndexes", async (input: Parameters<typeof original>[0]) => {
    calls++;
    assert.equal(input.session.store.detached, true);
    assert.equal(input.session.migration, true);
    const before = structuredClone([...input.session.files]);
    const finalConfig = await input.session.readFile(
      relative(input.session.store.root, input.configPath),
    );
    assert.deepEqual(input.config, finalConfig);
    assert.equal(
      "projectSettings" in (input.config as object),
      false,
      "legacy-настройки уже перенесены в запись проекта",
    );
    assert.ok(
      "projectSettings" in JSON.parse(await readFile(input.configPath, "utf8")),
      "на диске ещё исходная конфигурация",
    );
    await original(input);
    assert.deepEqual(
      [...input.session.files],
      before,
      "проектор не меняет сущности, отношения и конфигурацию",
    );
  });
  return () => calls;
}

for (const filename of ["config.json", "Настройки проекта.json"])
  test(`миграция → doctor: канонические карточки в одной публикации (${filename})`, async (t) => {
    const base = await legacyBase(t, filename);
    const calls = watchProjection(t);
    const before = await treeHashes(base.project);
    const plan = await planStorageMigration({ configPath: base.configPath });
    assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
    assert.equal(calls(), 1);
    assert.deepEqual(await treeHashes(base.project), before, "dry-run не меняет файлы и каталоги");
    const backupDir = await tempDir(t);
    let intents = 0;
    const result = await migrateStorage(
      { configPath: base.configPath },
      { backupDir, ifPlan: plan.planFingerprint },
      {
        probe(stage) {
          if (stage === "intent") intents++;
        },
      },
    );
    assert.equal(result.migrated, true);
    assert.equal(intents, 1, "проекция не требует второй публикации");
    assert.equal(calls(), 2);
    assert.equal((await inspectPending(base.root)).kind, "none");
    await assertProjected(base);
    const migrated = await treeHashes(base.project);
    assert.equal((await migrateStorage({ configPath: base.configPath })).migrated, false);
    assert.equal(calls(), 2, "no-op не пересобирает и не публикует проекцию");
    assert.deepEqual(await treeHashes(base.project), migrated);
  });

test("проекция миграции: отказ callback не публикует частичный результат или WAL", async (t) => {
  const base = await legacyBase(t);
  const registry = productionTransitionRegistry();
  t.mock.method(registry, "projectIndexes", async () => {
    throw new AppError("INVALID_DATA", "Ошибка проекции", 5);
  });
  const before = await treeHashes(base.project);
  const plan = await planStorageMigration({ configPath: base.configPath });
  assert.equal(plan.applicable, false);
  assert.ok(plan.blockers.some((blocker) => blocker.path === ".indexes/state.json"));
  const backupDir = await tempDir(t);
  await assert.rejects(migrateStorage({ configPath: base.configPath }, { backupDir }), {
    code: "STORAGE_TRANSITION_OUTPUT_INVALID",
  });
  assert.deepEqual(await treeHashes(base.project), before);
  assert.deepEqual(await readdir(backupDir), []);
});

test("проекция миграции: отсутствие карточки реальной подготовленной записи остаётся ошибкой", async (t) => {
  const base = await legacyBase(t);
  const registry = productionTransitionRegistry();
  const original = registry.projectIndexes.bind(registry);
  let missingCardDetected = false;
  t.mock.method(registry, "projectIndexes", async (input: Parameters<typeof original>[0]) => {
    assert.ok(await input.session.indexGet("records", "project:Legacy01"));
    input.session.indexSet("cards", "project:Legacy01", undefined);
    try {
      await original(input);
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "STORAGE_INDEX_CORRUPT");
      assert.match(error.message, /project:Legacy01/);
      missingCardDetected = true;
      throw error;
    }
  });
  const before = await treeHashes(base.project);
  const backupDir = await tempDir(t);
  await assert.rejects(migrateStorage({ configPath: base.configPath }, { backupDir }), {
    code: "STORAGE_TRANSITION_OUTPUT_INVALID",
  });
  assert.equal(missingCardDetected, true);
  assert.deepEqual(await treeHashes(base.project), before);
  assert.deepEqual(await readdir(backupDir), []);
  assert.equal((await inspectPending(base.root)).kind, "none");
});

for (const point of ["intent", "indexes"])
  test(`проекция миграции: recovery после ${point} использует готовые карточки WAL без повторного callback`, async (t) => {
    const base = await legacyBase(t);
    const calls = watchProjection(t);
    const backupDir = await tempDir(t);
    let intents = 0;
    let interrupted = false;
    await assert.rejects(
      migrateStorage(
        { configPath: base.configPath },
        { backupDir },
        {
          probe(stage, path) {
            if (stage === "intent") intents++;
            if (
              !interrupted &&
              (point === "intent" ? stage === "intent" : stage === "phase" && path === "indexes")
            ) {
              interrupted = true;
              throw new Error("Обрыв публикации");
            }
          },
        },
      ),
      /Обрыв публикации/,
    );
    assert.equal(calls(), 1);
    const pending = await inspectPending(base.root);
    assert.equal(pending.kind, "migration");
    const result = await migrateStorage(
      { configPath: base.configPath },
      {},
      {
        probe(stage) {
          if (stage === "intent") intents++;
        },
      },
    );
    assert.equal(result.resumed, true);
    assert.equal(calls(), 1);
    assert.equal(intents, 1);
    assert.equal((await inspectPending(base.root)).kind, "none");
    await assertProjected(base);
  });
