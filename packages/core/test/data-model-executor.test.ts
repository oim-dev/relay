/**
 * Исполнитель миграции модели данных (K6): status, dry-run, migrate на реальных базах
 * во временных каталогах. A02, A05, A06/A07 на диске, A13, A17, A21, A22, A23, A25 (Core), A28,
 * продолжение WAL v2 и обычный WAL операции (ТЗ 8.2). Ожидания задаются исходными файлами
 * и независимыми ответами старого reader в oracle фикстур, а не выводом исполнителя.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  storageMigrationPlanSchema,
  storageMigrationResultSchema,
} from "@relay/contracts/storage-maintenance";
import type { StorageMigrationPlan } from "@relay/contracts/storage-maintenance";
import type { JsonValue } from "@relay/contracts/storage";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { StorageService } from "../src/application/storage/service.js";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { ProgressService } from "../src/application/progress/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { digest, jsonValue, RECORD_BYTES } from "../src/storage/entity-store/format.js";
import { verifyBackupContent } from "../src/storage/data-model/backup.js";
import { createTransitionRegistry } from "../src/storage/data-model/registry.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import { planningV1ToV2 } from "../src/storage/data-model/transitions/planning-v1-to-v2.js";
import { DATA_MODEL_PROFILES } from "../src/storage/data-model/profiles.js";
import {
  HISTORICAL_KINDS,
  HistoricalKindCatalog,
} from "../src/storage/data-model/history/catalog.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { note, syntheticRegistry } from "./helpers/synthetic-data-model.js";
import {
  FIXTURES,
  diffTrees,
  frozenProject,
  persistent,
  planV1Format4,
  readJsonFile,
  tempDir,
  treeHashes,
  writeJsonFile,
} from "./helpers/migration-bases.js";

const PHYSICAL4 = "physical4-v0.7.0-52c4609";
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, expected, `${error.code}: ${error.message}`);
  return true;
};
const oracleOf = async (name: string) =>
  JSON.parse(await readFile(join(FIXTURES, name, "oracle.json"), "utf8"));

test("A02: текущая база — status current, dry-run без шагов, migrate no-op без backup и изменений", async (t) => {
  const project = await tempDir(t);
  await initialize(project, "tasks");
  const root = join(project, ".relay");
  const configPath = join(root, "config.json");
  // Новая база создаётся сразу с маркером текущего профиля.
  assert.equal((await readJsonFile(join(root, "storage.json"))).dataModelVersion, 2);
  const before = await treeHashes(project);
  assert.equal((await inspectStorage({ configPath })).status, "current");
  const plan = await planStorageMigration({ configPath });
  storageMigrationPlanSchema.parse(plan);
  assert.equal(plan.status, "current");
  assert.equal(plan.applicable, true);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.changes.files, {});
  const backupDir = await tempDir(t);
  const result = await migrateStorage({ configPath }, { backupDir, ifPlan: plan.planFingerprint });
  storageMigrationResultSchema.parse(result);
  assert.equal(result.migrated, false);
  assert.equal(result.backup, null);
  assert.deepEqual(result.steps, []);
  assert.deepEqual(await readdir(backupDir), [], "backup при no-op не создаётся");
  assert.equal((await migrateStorage({ configPath })).migrated, false);
  await assert.rejects(
    migrateStorage({ configPath }, { ifPlan: "0".repeat(64) }),
    code("STORAGE_PLAN_STALE"),
  );
  assert.deepEqual(diffTrees(before, await treeHashes(project)), [], "ни один файл не изменён");
  // Обёртка StorageService — та же реализация.
  const workspace = await openWorkspace(project, configPath);
  assert.equal((await new StorageService(workspace).migrate()).migrated, false);
  assert.deepEqual(diffTrees(before, await treeHashes(project)), []);
});

test("A05/A13/A17/A23: формат 4 с планированием v1 — dry-run без изменений, --if-plan, перенос и повтор", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const oracle = await oracleOf("physical2-plan-v1-43d683b");
  const before = await treeHashes(project);
  const status = await inspectStorage({ configPath });
  assert.equal(status.status, "migration-required");
  assert.equal(status.current.dataModel, null, "профиль 1 записан отсутствием поля");

  // A13: dry-run — хеши всего набора до/после равны, ничего не создаётся.
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  assert.deepEqual(
    plan.steps.map((step) => `${step.id}@${step.version}`),
    ["planning-v1-to-v2@1", "profile.1-to-2@1"],
  );
  assert.deepEqual(plan.profiles, { from: 1, to: 2 });
  assert.ok(plan.changes.relations.revoked > 0 && plan.changes.relations.created > 0);
  assert.ok(plan.changes.addresses.relocated > 0);
  assert.ok(plan.budgets.walBytes > 0 && plan.space.backupRequired > plan.budgets.backupBytes);
  assert.deepEqual(diffTrees(before, await treeHashes(project)), []);
  // Детерминизм: одинаковые данные и реестр — одинаковый план.
  assert.deepEqual(await planStorageMigration({ configPath }), plan);

  // Без --backup-dir изменяющая миграция не начинается.
  await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
    code("STORAGE_BACKUP_REQUIRED")(error);
    assert.equal((error as AppError).exitCode, 2);
    return true;
  });
  assert.deepEqual(diffTrees(before, await treeHashes(project)), []);

  // A17: правка, добавление, удаление файла и изменение реестра делают план устаревшим.
  const backupDir = await tempDir(t);
  const stale = async (change: () => Promise<void>, revert: () => Promise<void>) => {
    await change();
    await assert.rejects(
      migrateStorage({ configPath }, { backupDir, ifPlan: plan.planFingerprint }),
      code("STORAGE_PLAN_STALE"),
    );
    await revert();
  };
  const task = join(root, "entities/tasks", (await readdir(join(root, "entities/tasks")))[0]!);
  const taskBytes = await readFile(task);
  await stale(
    () => writeFile(task, `${taskBytes.toString("utf8")}\n`),
    () => writeFile(task, taskBytes),
  );
  await stale(
    () => writeFile(join(root, "entities/tasks/.gitkeep"), ""),
    () => rm(join(root, "entities/tasks/.gitkeep")),
  );
  const gitignore = await readFile(join(root, "transactions/.gitignore"));
  await stale(
    () => rm(join(root, "transactions/.gitignore")),
    () => writeFile(join(root, "transactions/.gitignore"), gitignore),
  );
  const storage = workspaceStorageRegistry();
  const changedRegistry = createTransitionRegistry({
    profiles: DATA_MODEL_PROFILES,
    transitions: [{ ...planningV1ToV2, version: 2 }],
    storage,
    historical: new HistoricalKindCatalog(storage, HISTORICAL_KINDS),
  });
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir, ifPlan: plan.planFingerprint },
      { registry: changedRegistry },
    ),
    code("STORAGE_PLAN_STALE"),
  );
  assert.deepEqual(await readdir(backupDir), [], "устаревший план не создаёт backup");
  assert.deepEqual(diffTrees(before, await treeHashes(project)), []);

  const result = await migrateStorage({ configPath }, { backupDir, ifPlan: plan.planFingerprint });
  storageMigrationResultSchema.parse(result);
  assert.equal(result.migrated, true);
  assert.equal(result.resumed, false);
  assert.deepEqual(result.steps, plan.steps);
  assert.equal(result.planFingerprint, plan.planFingerprint);
  assert.ok(result.backup);
  const manifest = await verifyBackupContent(result.backup);
  assert.equal(manifest.planFingerprint, plan.planFingerprint);
  assert.equal(manifest.pendingOperationWal, false);
  assert.equal(manifest.source.profile, 1);
  assert.ok(!manifest.files.some((file) => file.path.startsWith("runtime/write.lock")));
  assert.equal(
    (await readJsonFile(join(root, "storage.json"))).dataModelVersion,
    2,
    "последним опубликован маркер целевого профиля",
  );
  assert.equal((await inspectPending(root)).kind, "none", "WAL удалён после публикации");
  const after = await inspectStorage({ configPath });
  assert.equal(after.status, "current", JSON.stringify(after.blockers));
  assert.deepEqual(after.warnings, []);
  // R8: действующие сущности без надгробий и технических записей.
  const live = Object.entries(after.current.owners)
    .filter(
      ([kind]) =>
        !["scope", "plan-stage", "release-snapshot", "release-snapshot-entry"].includes(kind),
    )
    .reduce(
      (sum, [, owner]) => sum + Object.values(owner.versions).reduce((s, v) => s + v.live, 0),
      0,
    );
  assert.equal(result.entities, live);

  // A23: повтор после успеха — no-op без backup и изменений.
  const migrated = await treeHashes(project, persistent);
  const again = await migrateStorage({ configPath }, { backupDir });
  assert.equal(again.migrated, false);
  assert.equal(again.backup, null);
  assert.deepEqual(diffTrees(migrated, await treeHashes(project, persistent)), []);
  assert.equal((await readdir(backupDir)).length, 1, "ровно одна резервная копия");

  // Независимый oracle старого reader: порядок этапов и состав.
  const workspace = await openWorkspace(project, configPath);
  const plans = new PlanningService(workspace);
  for (const [alias, items] of [
    ["P1", oracle.oldReader.p1Stages.items],
    ["P2", oracle.oldReader.p2Stages.items],
  ] as const) {
    const page = await plans.stages(oracle.entities[alias].key, { limit: 100 });
    assert.deepEqual(
      page.items.map((stage: { id: string; title: string; taskIds: string[] }) => [
        stage.id,
        stage.title,
        stage.taskIds,
      ]),
      (items as { id: string; title: string; taskIds: string[] }[]).map((item) => [
        item.id,
        item.title,
        item.taskIds,
      ]),
      alias,
    );
  }
  // Прежний адрес этапа не выдаётся повторно и указывает на план.
  const stageId = oracle.oldReader.p1Stages.items[0].id as string;
  await assert.rejects(
    new EntityEngine(workspace).resolve({ ref: `plan-stage:${stageId}` }),
    code("ENTITY_RELOCATED"),
  );
});

test("A25 (Core): после миграции работают CAS-обновление, комментарий, документ/контекст, план, релиз, прогресс; повторное открытие", async (t) => {
  const { project, configPath } = await frozenProject(t, PHYSICAL4);
  const oracle = await oracleOf(PHYSICAL4);
  const backupDir = await tempDir(t);
  const stateBefore = await readJsonFile<{ version: string }>(
    join(project, ".relay/.indexes/state.json"),
  );
  const root = join(project, ".relay");
  const filesOnly = async () =>
    new Map([...(await treeHashes(root, persistent))].filter(([, hash]) => hash !== "dir"));
  const filesBefore = await filesOnly();
  const markerPlan = await planStorageMigration({ configPath });
  const result = await migrateStorage(
    { configPath },
    { backupDir, ifPlan: markerPlan.planFingerprint },
  );
  assert.equal(result.migrated, true);
  // Переход только маркера — явный шаг плана и результата.
  assert.deepEqual(
    markerPlan.steps.map((step) => [step.id, step.type]),
    [["profile.1-to-2", "profile"]],
  );
  assert.deepEqual(result.steps, markerPlan.steps);
  // План и результат совпадают с фактическими изменениями файлов по хешам дерева.
  const after = await filesOnly();
  const diff = { create: 0, update: 0, delete: 0 };
  const byCategory: Record<string, typeof diff> = {};
  const category = (path: string) =>
    path === "storage.json" ? "manifest" : path.startsWith(".indexes/") ? "indexes" : path;
  for (const [path, hash] of after)
    if (filesBefore.get(path) !== hash) {
      const kind = filesBefore.has(path) ? "update" : "create";
      diff[kind]++;
      (byCategory[category(path)] ??= { create: 0, update: 0, delete: 0 })[kind]++;
    }
  for (const path of filesBefore.keys())
    if (!after.has(path)) {
      diff.delete++;
      (byCategory[category(path)] ??= { create: 0, update: 0, delete: 0 }).delete++;
    }
  assert.deepEqual(markerPlan.changes.files, byCategory);
  assert.equal(result.counts.changed, diff.create + diff.update + diff.delete);
  assert.equal(
    Object.values(result.counts.owners).reduce((sum, owner) => sum + owner.changed, 0),
    result.counts.changed,
  );
  const stateAfter = await readJsonFile<{ version: string }>(
    join(project, ".relay/.indexes/state.json"),
  );
  assert.notEqual(stateAfter.version, stateBefore.version, "версия снимка индексов сменилась");

  const workspace = await openWorkspace(project, configPath);
  const tasks = new BoardTasksService(workspace);
  const t1 = oracle.entities.T1;
  const current = await tasks.get(t1.key);
  assert.equal(current.description, t1.description, "точный текст с CRLF");
  await assert.rejects(
    tasks.update(
      t1.key,
      { title: "Конфликт", ifRevision: current.revision + 1, requestId: "cas-stale" },
      "tester",
    ),
    code("REVISION_CONFLICT"),
  );
  const updated = await tasks.update(
    t1.key,
    { title: "После миграции", ifRevision: current.revision, requestId: "cas" },
    "tester",
  );
  assert.equal(updated.revision, current.revision + 1);
  const before = await tasks.listComments(t1.key, { limit: 100 });
  await tasks.publishComment(t1.key, {
    title: "Новый комментарий",
    description: "Текст\r\nпосле миграции\n",
    actor: "tester",
    actorRole: "operator",
    requestId: "comment",
  });
  const comments = await tasks.listComments(t1.key, { limit: 100 });
  assert.equal(comments.items.length, before.items.length + 1);
  const engine = new EntityEngine(workspace);
  const document = await engine.get({ ref: oracle.entities.D1.key });
  assert.equal((document.data as { body: string }).body, oracle.entities.D1.body);
  const context = await new GraphService(workspace).context({ root: oracle.entities.D1.key });
  assert.equal(context.complete, true);
  const plan = await new PlanningService(workspace).stages(oracle.entities.P2.key, { limit: 100 });
  assert.deepEqual(
    plan.items.map((stage: { id: string }) => stage.id),
    oracle.entities.P2.stages.map((stage: { id: string }) => stage.id),
  );
  const release = await new ReleasesService(workspace).get(oracle.entities.R1.key);
  assert.deepEqual(release.planIds, oracle.entities.R1.planIds);
  const progress = await new ProgressService(workspace).workPlan({ ref: oracle.entities.P2.key });
  assert.ok(progress);
  // Повторное открытие видит тот же результат.
  const reopened = await openWorkspace(project, configPath);
  const again = await new BoardTasksService(reopened).get(t1.key);
  assert.equal(again.title, "После миграции");
  assert.equal(again.revision, updated.revision);
  assert.equal((await inspectStorage({ configPath })).status, "current");
});

test("8.2: обычный WAL операции — копия с WAL, recovery, новое планирование; dry-run его не исполняет", async (t) => {
  const { project, root, configPath } = await frozenProject(t, PHYSICAL4);
  const directory = join(root, "entities/tasks");
  const name = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
  const path = `entities/tasks/${name}`;
  const original = jsonValue(await readJsonFile(join(root, path))) as Record<string, JsonValue>;
  const changed = { ...original, revision: (original.revision as number) + 1 };
  await writeJsonFile(join(root, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [{ path, before: digest(original), after: changed }],
  });
  const before = await treeHashes(project);
  const status = await inspectStorage({ configPath });
  assert.equal(status.status, "recovery-required");
  assert.equal(status.pending?.kind, "operation");
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  assert.equal(plan.status, "recovery-required");
  await assert.rejects(migrateStorage({ configPath }), code("STORAGE_BACKUP_REQUIRED"));
  // --if-plan при ожидающей операции отклоняется до копии и recovery.
  const early = await tempDir(t);
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: early, ifPlan: plan.planFingerprint }),
    code("STORAGE_PLAN_STALE"),
  );
  assert.deepEqual(await readdir(early), []);
  assert.deepEqual(diffTrees(before, await treeHashes(project)), [], "pending не исполнен");

  const backupDir = await tempDir(t);
  const result = await migrateStorage({ configPath }, { backupDir });
  assert.equal(result.migrated, true);
  const manifest = await verifyBackupContent(result.backup!);
  assert.equal(manifest.pendingOperationWal, true);
  assert.ok(manifest.files.some((file) => file.path === "transactions/pending.json"));
  assert.deepEqual(await readJsonFile(join(root, path)), changed, "операция завершена вперёд");
  assert.equal((await inspectStorage({ configPath })).status, "current");
});

test("A21 и продолжение WAL v2: сбой после intent, пропавший backup, конфликт, продолжение без --backup-dir", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const backupDir = await tempDir(t);
  let written = 0;
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir },
      {
        probe: (stage, path) => {
          if (stage === "file" && path?.startsWith("entities/") && ++written === 2)
            throw new Error("остановка после части сущностей");
        },
      },
    ),
    /остановка после части сущностей/,
  );
  const pending = await inspectPending(root);
  assert.equal(pending.kind, "migration");
  if (pending.kind !== "migration") return;
  const backupPath = pending.intent.migration.backup.path;
  // Обычное открытие и диагностика не допубликовывают миграцию.
  assert.equal((await inspectStorage({ configPath })).status, "recovery-required");
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.status, "recovery-required");
  await assert.rejects(openWorkspace(project, configPath), code("STORAGE_RECOVERY_REQUIRED"));

  // Пропавший backup: продолжения без защиты нет, WAL сохраняется.
  await rename(backupPath, `${backupPath}.moved`);
  await assert.rejects(migrateStorage({ configPath }), code("STORAGE_BACKUP_MISSING"));
  assert.equal((await inspectPending(root)).kind, "migration");
  await rename(`${backupPath}.moved`, backupPath);

  // Подменённый байт в копии без смены размера: полная сверка sha256, продолжения нет.
  const manifestCopy = JSON.parse(await readFile(join(backupPath, "backup-manifest.json"), "utf8"));
  const copied = join(
    backupPath,
    "files",
    "config-root",
    manifestCopy.files.find((file: { path: string }) => file.path.startsWith("entities/")).path,
  );
  const original = await readFile(copied);
  const flipped = Buffer.from(original);
  flipped[flipped.length - 2] = flipped[flipped.length - 2] === 0x20 ? 0x21 : 0x20;
  await writeFile(copied, flipped);
  await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
    code("STORAGE_BACKUP_MISSING")(error);
    assert.equal((error as AppError & { details: { reason: string } }).details.reason, "file-hash");
    return true;
  });
  assert.equal((await inspectPending(root)).kind, "migration", "WAL сохранён");
  await writeFile(copied, original);

  // WAL предварительной сборки без итога плана: понятная диагностика, без тупика.
  const walBytes = await readFile(join(root, "transactions/pending.json"));
  const wal = JSON.parse(walBytes.toString("utf8"));
  delete wal.migration.report;
  await writeFile(join(root, "transactions/pending.json"), JSON.stringify(wal));
  const preRelease = await inspectStorage({ configPath });
  assert.equal(preRelease.status, "unsupported");
  assert.match(preRelease.blockers[0]!.next, /RESTORE\.md/);
  await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
    code("STORAGE_VERSION_UNSUPPORTED")(error);
    assert.match((error as AppError & { details: { next: string } }).details.next, /RESTORE\.md/);
    return true;
  });
  await writeFile(join(root, "transactions/pending.json"), walBytes);

  // Посторонняя правка цели WAL: конфликт с путём, WAL и backup сохраняются.
  const target = pending.intent.changes.find(
    (change) => change.path.startsWith("entities/work-plans/") && change.after !== null,
  )!;
  const targetPath = join(root, target.path);
  const saved = await readFile(targetPath);
  await writeFile(targetPath, JSON.stringify({ foreign: true }));
  await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
    code("STORAGE_RECOVERY_CONFLICT")(error);
    assert.equal(
      (error as AppError).details &&
        (error as AppError & { details: { path: string } }).details.path,
      target.path,
    );
    return true;
  });
  assert.equal((await inspectPending(root)).kind, "migration");
  assert.ok((await stat(join(backupPath, "backup-manifest.json"))).isFile());
  await writeFile(targetPath, saved);

  const resumed = await migrateStorage({ configPath });
  storageMigrationResultSchema.parse(resumed);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.migrated, true);
  assert.deepEqual(resumed.backup, pending.intent.migration.backup);
  assert.equal((await inspectPending(root)).kind, "none");
  assert.equal((await inspectStorage({ configPath })).status, "current");
  // Тот же предметный результат, что у непрерывного переноса.
  const clean = await planV1Format4(t);
  const cleanResult = await migrateStorage(
    { configPath: clean.configPath },
    { backupDir: await tempDir(t) },
  );
  // Итог продолжения берётся из WAL: те же шаги, счётчики и число сущностей, не нули.
  assert.deepEqual(resumed.steps, cleanResult.steps);
  assert.deepEqual(resumed.counts, cleanResult.counts);
  assert.equal(resumed.entities, cleanResult.entities);
  assert.ok(resumed.steps[0]!.records.changed > 0);
  const skip = (path: string) => persistent(path) || path === ".indexes/state.json";
  const expected = await treeHashes(clean.root, skip);
  const actual = await treeHashes(root, skip);
  assert.deepEqual(diffTrees(expected, actual), []);
});

test("A22: две миграции через symlink-пути и миграция + reader: один writer, без чтения промежуточной схемы", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const alias = join(await tempDir(t), "alias");
  await symlink(root, alias);
  const backupDir = await tempDir(t);
  const workspace = await openWorkspace(project, configPath);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const first = migrateStorage(
    { configPath },
    { backupDir },
    {
      probe: async (stage, path) => {
        if (stage === "phase" && path === "entities") {
          entered();
          await gate;
        }
      },
    },
  );
  await inside;
  const order: string[] = [];
  const log = (entry: string) => order.push(entry);
  const second = migrateStorage({ configPath: join(alias, "config.json") }, { backupDir }).then(
    (value) => (log("second"), value),
    (error: unknown) => (log("second"), error),
  );
  const reader = new PlanningService(workspace)
    .stages("PLN-1", { limit: 100 })
    .then((value) => (log("reader"), value));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(order, [], "пока миграция держит замок, никто не читает и не пишет");
  release();
  const done = await first;
  const [other, plan] = await Promise.all([second, reader]);
  assert.equal(done.migrated, true);
  if (other instanceof AppError) assert.equal(other.code, "STORAGE_BUSY");
  else assert.equal((other as { migrated: boolean }).migrated, false, "вторая миграция — no-op");
  assert.ok(plan.items.length > 0, "reader видит профиль 2");
  assert.equal((await readdir(backupDir)).length, 1, "одна резервная копия");
});

test("A06/A07/A28 на диске: синтетическая цепочка из трёх шагов и граница бюджета записи", async (t) => {
  const registry = syntheticRegistry(13);
  const base = async (records: ReturnType<typeof note>[], text = "") => {
    const project = await tempDir(t);
    const root = join(project, ".relay");
    await mkdir(join(root, "entities/notes"), { recursive: true });
    await writeJsonFile(join(root, "config.json"), { version: 1, projectId: "Synth01" });
    await writeJsonFile(join(root, "storage.json"), {
      format: "relay-entities",
      schemaVersion: 4,
      dataModelVersion: 10,
    });
    for (const record of records) {
      const value = structuredClone(record) as Record<string, unknown>;
      if (text && "data" in value) (value.data as { text?: string }).text = text;
      await writeJsonFile(join(root, `entities/notes/${record.id}.json`), value);
    }
    return { project, root, configPath: join(root, "config.json") };
  };
  // A07: смешанные версии одного вида и надгробие сходятся к профилю 13.
  const mixed = [
    note("a1", 1, { name: "A: подзаголовок", text: "строка\r\n\nвторая\n", tags: ["x", "y"] }),
    note("b2", 2, { title: "B", text: "текст", tags: ["y"] }),
    note("c3", 3, { title: "C: c", text: "", tagIds: [] }),
    note("d4", 1, {}, true),
  ];
  const once = await base(mixed);
  const plan = await planStorageMigration(once, { registry });
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ["note-v1-to-v2", "note-tags-to-tag", "note-v3-to-v4", "profile.10-to-13"],
    "порядок шагов задаёт реестр",
  );
  await migrateStorage(once, { backupDir: await tempDir(t) }, { registry });
  assert.equal((await inspectStorage(once, { registry })).status, "current");

  // A06: результат одной цепочки равен последовательным переносам 10→11→12→13.
  const v1 = [
    note("a1", 1, { name: "A: подзаголовок", text: "строка\r\n\nвторая\n", tags: ["x", "y"] }),
    note("e5", 1, { name: "E", text: "е", tags: ["y"] }),
    note("d4", 1, {}, true),
  ];
  const chain = await base(v1);
  await migrateStorage(chain, { backupDir: await tempDir(t) }, { registry });
  const stepwise = await base(v1);
  for (const profile of [11, 12, 13] as const)
    await migrateStorage(
      stepwise,
      { backupDir: await tempDir(t) },
      { registry: syntheticRegistry(profile) },
    );
  const skip = (path: string) => persistent(path) || path === ".indexes/state.json";
  assert.deepEqual(
    diffTrees(await treeHashes(stepwise.root, skip), await treeHashes(chain.root, skip)),
    [],
  );
  const a1 = await readJsonFile(join(once.root, "entities/notes/a1.json"));
  assert.deepEqual(a1.data, {
    title: "A",
    subtitle: "подзаголовок",
    body: ["строка\r", "", "вторая", ""],
    tagIds: (a1.data as { tagIds: string[] }).tagIds,
  });
  assert.equal(a1.revision, 7, "техническое преобразование не меняет ревизию");

  // A28: граничный объём записи проходит, превышение на байт — блокер до изменений.
  // Размер подготовленной записи измеряется dry-run и доводится до предела ровно.
  const probe = await base([note("big", 1, { name: "Big", text: "", tags: [] })], "x".repeat(4096));
  const measured = await planStorageMigration(probe, { registry });
  const exact = "x".repeat(4096 + RECORD_BYTES - measured.budgets.maxRecordBytes);
  const boundary = await base([note("big", 1, { name: "Big", text: "", tags: [] })], exact);
  const ok = await planStorageMigration(boundary, { registry });
  assert.equal(ok.budgets.maxRecordBytes, RECORD_BYTES);
  assert.equal(ok.applicable, true);
  await migrateStorage(boundary, { backupDir: await tempDir(t) }, { registry });
  assert.equal((await inspectStorage(boundary, { registry })).status, "current");
  const over = await base([note("big", 1, { name: "Big", text: "", tags: [] })], `${exact}x`);
  const before = await treeHashes(over.project);
  const blocked = await planStorageMigration(over, { registry });
  assert.equal(blocked.applicable, false);
  assert.deepEqual(
    blocked.blockers.map((blocker) => blocker.code),
    ["STORAGE_LIMIT_EXCEEDED"],
  );
  const backupDir = await tempDir(t);
  await assert.rejects(
    migrateStorage(over, { backupDir }, { registry }),
    code("STORAGE_LIMIT_EXCEEDED"),
  );
  assert.deepEqual(diffTrees(before, await treeHashes(over.project)), []);
  assert.deepEqual(await readdir(backupDir), [], "превышение найдено до backup");
});

test("Детерминизм: одинаковый вход даёт одинаковый план и предметный результат", async (t) => {
  const left = await planV1Format4(t);
  const right = await planV1Format4(t);
  const [a, b] = await Promise.all([planStorageMigration(left), planStorageMigration(right)]);
  const strip = (plan: StorageMigrationPlan) => ({ ...plan, project: null });
  assert.deepEqual(strip(a), strip(b));
  await migrateStorage(left, { backupDir: await tempDir(t) });
  await migrateStorage(right, { backupDir: await tempDir(t) });
  const skip = (path: string) => persistent(path) || path === ".indexes/state.json";
  assert.deepEqual(
    diffTrees(await treeHashes(left.root, skip), await treeHashes(right.root, skip)),
    [],
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(left.root, "storage.json")))
      .digest("hex"),
    createHash("sha256")
      .update(await readFile(join(right.root, "storage.json")))
      .digest("hex"),
  );
  void productionTransitionRegistry;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("8.2/A22: legacy-журнал — копия, recovery и новый план под непрерывным замком; writer ждёт", async (t) => {
  const { project, root, configPath } = await frozenProject(t, "legacy-5c7265b");
  const task = await readJsonFile(join(root, "boards/api/tasks/DTAv61jm.json"));
  await writeJsonFile(join(root, "kanban-pending.json"), {
    version: 1,
    writes: [{ slug: "api", task }],
    removes: [],
  });
  assert.equal((await inspectStorage({ configPath })).status, "recovery-required");
  await assert.rejects(migrateStorage({ configPath }), code("STORAGE_BACKUP_REQUIRED"));
  const workspace = await openWorkspace(project, configPath);
  const order: string[] = [];
  let writer: Promise<unknown> | undefined;
  const result = await migrateStorage(
    { configPath },
    { backupDir: await tempDir(t) },
    {
      afterRecovery: async () => {
        // Между recovery и новым планом замок не отпускается: writer не входит.
        writer = workspace
          .locked(async () => void order.push("writer"))
          .catch((error: unknown) => void order.push(`busy:${(error as { code?: string }).code}`));
        await sleep(400);
        order.push("plan");
      },
    },
  );
  order.push("migrated");
  await writer;
  // Writer либо вошёл после миграции, либо не дождался замка — но не между шагами.
  assert.equal(order[0], "plan");
  const entered = order.indexOf("writer");
  assert.ok(entered === -1 || entered > order.indexOf("migrated"), order.join(","));
  assert.ok(order.length === 3, order.join(","));
  assert.equal(result.migrated, true);
  const manifest = await verifyBackupContent(result.backup!);
  assert.equal(manifest.pendingOperationWal, true);
  assert.ok(manifest.files.some((file) => file.path === "kanban-pending.json"));
  assert.equal((await inspectStorage({ configPath })).status, "current");
});

test("A22: потеря замка до intent останавливает публикацию; после intent база восстановима", async (t) => {
  // Владение теряется: lockfile удалён другим процессом, обновление замка это обнаруживает.
  const lose = (root: string) => async () => {
    await rm(join(root, "runtime/write.lock"), { recursive: true, force: true });
    await sleep(2600);
  };
  // До intent постоянный набор неизменен целиком, включая .indexes (страницы — в runtime).
  const skipDerived = persistent;

  const early = await planV1Format4(t);
  const before = await treeHashes(early.root, skipDerived);
  const backupDir = await tempDir(t);
  await assert.rejects(
    migrateStorage(
      early,
      { backupDir },
      {
        probe: async (stage) => {
          if (stage === "staged") await lose(early.root)();
        },
      },
    ),
    code("LOCK_LOST"),
  );
  assert.equal((await inspectPending(early.root)).kind, "none", "intent не записан");
  assert.deepEqual(diffTrees(before, await treeHashes(early.root, skipDerived)), []);
  assert.equal((await inspectStorage(early)).status, "migration-required");

  const late = await planV1Format4(t);
  let lost = false;
  await assert.rejects(
    migrateStorage(
      late,
      { backupDir: await tempDir(t) },
      {
        probe: async (stage, path) => {
          if (stage === "phase" && path === "entities" && !lost) {
            lost = true;
            await lose(late.root)();
          }
        },
      },
    ),
    code("LOCK_LOST"),
  );
  assert.equal((await inspectPending(late.root)).kind, "migration", "WAL сохранён");
  const resumed = await migrateStorage(late);
  assert.equal(resumed.resumed, true);
  const clean = await planV1Format4(t);
  await migrateStorage(clean, { backupDir: await tempDir(t) });
  const skip = (path: string) => persistent(path) || path === ".indexes/state.json";
  assert.deepEqual(
    diffTrees(await treeHashes(clean.root, skip), await treeHashes(late.root, skip)),
    [],
  );
});

test("A28: превышение пакета WAL — блокер dry-run и apply до изменений (уменьшенный предел)", async (t) => {
  const { project, configPath } = await planV1Format4(t);
  const before = await treeHashes(project);
  const limits = { walBytes: 16 * 1024 };
  const plan = await planStorageMigration({ configPath }, { limits });
  assert.equal(plan.applicable, false);
  assert.deepEqual(
    plan.blockers.map((blocker) => blocker.code),
    ["STORAGE_LIMIT_EXCEEDED"],
  );
  const backupDir = await tempDir(t);
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir }, { limits }),
    code("STORAGE_LIMIT_EXCEEDED"),
  );
  assert.deepEqual(await readdir(backupDir), []);
  assert.deepEqual(diffTrees(before, await treeHashes(project)), []);
  // Тот же план в действующем пределе 128 МиБ применим, оценка не меньше фактического WAL.
  const real = await planStorageMigration({ configPath });
  assert.equal(real.applicable, true);
  assert.equal(real.budgets.limits.walBytes, 128 * 1024 * 1024);
  let walSize = 0;
  await migrateStorage(
    { configPath },
    { backupDir },
    {
      probe: async (stage) => {
        if (stage === "intent")
          walSize = (await stat(join(project, ".relay/transactions/pending.json"))).size;
      },
    },
  );
  assert.ok(
    walSize > 0 && real.budgets.walBytes >= walSize,
    `${real.budgets.walBytes} ≥ ${walSize}`,
  );
});
