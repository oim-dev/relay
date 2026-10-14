import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  storageMigrationPlanSchema,
  storageMigrationResultSchema,
  storageStatusSchema,
} from "@relay/contracts/storage-maintenance";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { StorageService } from "../src/application/storage/service.js";
import { openWorkspace } from "../src/storage/workspace.js";
import {
  readJsonFile,
  setManifest,
  temporaryDirectory,
  treeHashes,
  unifiedBase,
  writeJsonFile,
} from "./helpers/source-fixtures.js";

for (const damage of ["marker", "files"] as const) {
  const damageIndex = async (root: string) => {
    if (damage === "marker")
      await writeJsonFile(join(root, "runtime/index-stale.json"), {
        paths: ["entities/products/passport.json"],
        total: 1,
      });
    else {
      const path = join(root, "relations/products/passport.json");
      const relations = await readJsonFile(path);
      await writeJsonFile(path, { ...relations, entries: [] });
    }
  };

  test(`STR-01: ${damage} блокирует current/no-op без скрытого reindex`, async (t) => {
    const { project, root } = await unifiedBase(t);
    const target = { configPath: join(root, "config.json") };
    await damageIndex(root);
    const before = await treeHashes(project);
    const status = storageStatusSchema.parse(await inspectStorage(target));
    assert.equal(status.status, "invalid");
    assert.equal(status.blockersTotal, 1);
    assert.equal(status.blockers[0]?.code, "STORAGE_INDEX_STALE");
    assert.equal(
      status.blockers[0]?.path,
      damage === "marker" ? "runtime/index-stale.json" : "relations/products/passport.json",
    );
    assert.match(status.blockers[0]!.next, /storage reindex/);
    assert.deepEqual(status.warnings, []);
    const plan = storageMigrationPlanSchema.parse(await planStorageMigration(target));
    assert.equal(plan.status, "invalid");
    assert.equal(plan.applicable, false);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.blockers, status.blockers);
    await assert.rejects(migrateStorage(target), { code: "STORAGE_INDEX_STALE", exitCode: 4 });
    assert.deepEqual(await treeHashes(project), before, "ни backup, ни reindex, ни WAL");

    await new StorageService(await openWorkspace(project)).reindex();
    assert.equal((await inspectStorage(target)).status, "current");
    const indexed = await treeHashes(project);
    const noop = storageMigrationResultSchema.parse(await migrateStorage(target));
    assert.equal(noop.migrated, false);
    assert.equal(noop.checks.indexes, "passed");
    assert.equal(noop.backup, null);
    assert.deepEqual(await treeHashes(project), indexed);
  });

  test(`STR-01: ${damage} не блокирует реальный перенос с проверенным backup`, async (t) => {
    const { project, root } = await unifiedBase(t);
    const target = { configPath: join(root, "config.json") };
    await setManifest(root, { dataModelVersion: undefined });
    await damageIndex(root);
    const before = await treeHashes(project);
    const status = await inspectStorage(target);
    const plan = await planStorageMigration(target);
    for (const result of [status, plan]) {
      assert.equal(result.status, "migration-required");
      assert.deepEqual(result.blockers, []);
      assert.equal(result.warningsTotal, 1);
      assert.equal(result.warnings[0]?.code, "STORAGE_INDEX_STALE");
      assert.match(result.warnings[0]!.message, /перенос построит индексы заново/);
    }
    assert.equal(plan.applicable, true);
    assert.deepEqual(await treeHashes(project), before);
    const result = await migrateStorage(target, {
      backupDir: await temporaryDirectory(t, "relay-str-backup-"),
      ifPlan: plan.planFingerprint,
    });
    assert.equal(result.migrated, true);
    assert.equal(result.checks.indexes, "passed");
    assert.ok(result.backup);
    const after = await inspectStorage(target);
    assert.equal(after.status, "current");
    assert.equal(after.warningsTotal, 0);
  });
}

test("STR-05: 0/1/50/55 предупреждений различимы в status и плане; миграция сохраняет 55 файлов", async (t) => {
  const { project, root } = await unifiedBase(t);
  const target = { configPath: join(root, "config.json") };
  let created = 0;
  for (const total of [0, 1, 50, 55]) {
    for (; created < total; created++)
      await writeFile(
        join(root, `note${String(created).padStart(2, "0")}.txt`),
        `Текст ${created}\r\n\n`,
      );
    const before = await treeHashes(project);
    const status = storageStatusSchema.parse(await inspectStorage(target));
    const plan = storageMigrationPlanSchema.parse(await planStorageMigration(target));
    for (const result of [status, plan]) {
      assert.equal(result.status, "current");
      assert.equal(result.warningsTotal, total);
      assert.equal(result.warnings.length, Math.min(total, 50));
      assert.ok(result.warnings.every((warning) => warning.code === "STORAGE_FOREIGN_FILE"));
      assert.equal(
        storageStatusSchema.safeParse({ ...status, warningsTotal: undefined }).success,
        false,
      );
      assert.equal(storageStatusSchema.safeParse({ ...status, warningsTotal: -1 }).success, false);
    }
    assert.deepEqual(await treeHashes(project), before);
  }
  await setManifest(root, { dataModelVersion: undefined });
  const before = await treeHashes(project);
  const plan = await planStorageMigration(target);
  assert.equal(plan.warningsTotal, 55);
  assert.equal(plan.warnings.length, 50);
  await migrateStorage(target, {
    backupDir: await temporaryDirectory(t, "relay-str-backup-"),
    ifPlan: plan.planFingerprint,
  });
  const after = await treeHashes(project);
  for (const [path, hash] of before)
    if (path.includes("/note")) assert.equal(after.get(path), hash, path);
  const status = await inspectStorage(target);
  assert.equal(status.status, "current");
  assert.equal(status.warningsTotal, 55);
  assert.equal(status.warnings.length, 50);
});

test("STR-05: total включает предупреждения об индексах за пределами первых 50", async (t) => {
  const { project, root } = await unifiedBase(t);
  const target = { configPath: join(root, "config.json") };
  await setManifest(root, { dataModelVersion: undefined });
  for (let i = 0; i < 50; i++) await writeFile(join(root, `note${i}.txt`), "Посторонний файл\n");
  await writeJsonFile(join(root, "runtime/index-stale.json"), { paths: [], total: 0 });
  const before = await treeHashes(project);
  for (const result of [await inspectStorage(target), await planStorageMigration(target)]) {
    assert.equal(result.status, "migration-required");
    assert.equal(result.warnings.length, 50);
    assert.equal(result.warningsTotal, 51);
    assert.ok(result.warnings.every((warning) => warning.code === "STORAGE_FOREIGN_FILE"));
  }
  assert.deepEqual(await treeHashes(project), before);
});
