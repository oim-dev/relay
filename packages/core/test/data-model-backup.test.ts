/**
 * Резервная копия миграции (A18) и восстановление копии в отдельный каталог (A27, Core).
 * Отказы записи, fsync и места симулируются на замороженной фикстуре через BackupIo;
 * EACCES и пути проверяются на реальной файловой системе. Исходная база не меняется.
 */
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import {
  BACKUP_MANIFEST,
  BACKUP_RESTORE,
  nodeBackupIo,
  verifyBackupContent,
} from "../src/storage/data-model/backup.js";
import type { BackupIo } from "../src/storage/data-model/backup.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import {
  diffTrees,
  frozenProject,
  persistent,
  tempDir,
  treeHashes,
} from "./helpers/migration-bases.js";

const PHYSICAL4 = "physical4-v0.7.0-52c4609";
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, expected, `${error.code}: ${error.message}`);
  return true;
};
const errno = (name: string) => Object.assign(new Error(name), { code: name });

test("A18/A27: состав и хеши копии, завершённость, без замка; развёртывание в отдельный каталог", async (t) => {
  const { root, configPath } = await frozenProject(t, PHYSICAL4);
  await writeFile(join(root, "notes.txt"), "посторонний файл пользователя\n");
  const original = await treeHashes(root);
  const backupDir = await tempDir(t);
  const result = await migrateStorage({ configPath }, { backupDir });
  const manifest = await verifyBackupContent(result.backup!);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.source.profile, 1);
  assert.ok(
    (await readFile(join(result.backup!.path, BACKUP_RESTORE), "utf8")).includes("отдельный"),
  );
  const copied = new Set(manifest.files.map((file) => file.path));
  for (const [path, hash] of original) {
    if (hash === "dir" || persistent(path)) continue;
    assert.ok(copied.has(path), `в копии нет ${path}`);
  }
  assert.ok(copied.has("notes.txt"), "посторонний файл сохранён в копии");
  assert.ok(
    ![...copied].some((path) => path.startsWith("runtime/")),
    "замок и runtime не копируются",
  );

  // A27: копия разворачивается в отдельный каталог и совпадает с состоянием до миграции.
  const restored = join(await tempDir(t), ".relay");
  await mkdir(restored);
  await cp(join(result.backup!.path, "files/config-root"), restored, { recursive: true });
  for (const directory of manifest.directories)
    await mkdir(join(restored, directory.path), { recursive: true });
  const skip = (path: string) => persistent(path);
  const before = new Map([...original].filter(([path]) => !persistent(path)));
  assert.deepEqual(diffTrees(before, await treeHashes(restored, skip)), []);
  const status = await inspectStorage({ configPath: join(restored, "config.json") });
  assert.equal(status.status, "migration-required", "восстановленная база — исходный профиль 1");
  assert.equal(status.current.dataModel, null);
  // Повторный перенос восстановленной копии даёт тот же предметный результат.
  await migrateStorage(
    { configPath: join(restored, "config.json") },
    { backupDir: await tempDir(t) },
  );
  const result2 = (path: string) => persistent(path) || path === ".indexes/state.json";
  assert.deepEqual(
    diffTrees(await treeHashes(root, result2), await treeHashes(restored, result2)),
    [],
  );
});

test("A18: недопустимые пути и отказы записи, fsync и места не меняют исходную базу", async (t) => {
  const { project, root, configPath } = await frozenProject(t, PHYSICAL4);
  const before = await treeHashes(project);
  const unchanged = async () => {
    assert.deepEqual(diffTrees(before, await treeHashes(project)), []);
    assert.equal((await inspectPending(root)).kind, "none");
  };
  // Внутри базы, через symlink внутрь базы, внутри Git-рабочей копии с базой, путь-файл.
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: join(root, "backups") }),
    code("STORAGE_UNSAFE_PATH"),
  );
  const outside = await tempDir(t);
  await symlink(root, join(outside, "link"));
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: join(outside, "link", "nested") }),
    code("STORAGE_UNSAFE_PATH"),
  );
  await writeFile(join(outside, "file"), "");
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: join(outside, "file") }),
    code("STORAGE_UNSAFE_PATH"),
  );
  await unchanged();

  const checkout = await tempDir(t);
  await mkdir(join(checkout, ".git"));
  await cp(project, join(checkout, "project"), { recursive: true });
  await assert.rejects(
    migrateStorage(
      { configPath: join(checkout, "project/.relay/config.json") },
      { backupDir: join(checkout, "backups") },
    ),
    code("STORAGE_UNSAFE_PATH"),
  );

  // EACCES: каталог копии недоступен для записи.
  const readonly = await tempDir(t);
  await chmod(readonly, 0o555);
  t.after(() => chmod(readonly, 0o755).catch(() => {}));
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: readonly }),
    code("STORAGE_BACKUP_FAILED"),
  );
  await chmod(readonly, 0o755);
  await unchanged();

  // ENOSPC при записи файла, ошибка fsync, недостаточно места по statfs.
  const failing = (patch: Partial<BackupIo>): BackupIo => ({ ...nodeBackupIo, ...patch });
  let writes = 0;
  const cases: [string, BackupIo, string][] = [
    [
      "enospc",
      failing({
        writeFile: async (path, bytes) => {
          if (++writes === 3) throw errno("ENOSPC");
          return nodeBackupIo.writeFile(path, bytes);
        },
      }),
      "STORAGE_INSUFFICIENT_SPACE",
    ],
    [
      "fsync",
      failing({ syncDirectory: async () => Promise.reject(errno("EIO")) }),
      "STORAGE_BACKUP_FAILED",
    ],
    ["space", failing({ freeBytes: async () => 1024 }), "STORAGE_INSUFFICIENT_SPACE"],
  ];
  for (const [name, io, expected] of cases) {
    const backupDir = await tempDir(t);
    await assert.rejects(
      migrateStorage({ configPath }, { backupDir }, { backupIo: io }),
      code(expected),
      name,
    );
    await unchanged();
    for (const directory of await readdir(backupDir))
      assert.deepEqual(
        (await readdir(join(backupDir, directory))).includes(BACKUP_MANIFEST),
        false,
        "неполная копия не помечена завершённой",
      );
  }

  // Существующие копии не перезаписываются: каждый запуск создаёт новый каталог.
  const shared = await tempDir(t);
  await mkdir(join(shared, "relay-backup-existing"));
  const result = await migrateStorage({ configPath }, { backupDir: shared });
  assert.deepEqual((await readdir(shared)).length, 2);
  assert.ok(result.backup!.path.startsWith(shared));
});

test("A17/A18: посторонний каталог внутри корня копируется рекурсивно побайтно и входит в отпечаток", async (t) => {
  const { root, configPath } = await frozenProject(t, PHYSICAL4);
  await mkdir(join(root, "notes/sub"), { recursive: true });
  const bytes = Buffer.from([0xff, 0x00, 0x41, 0x0d, 0x0a]);
  await writeFile(join(root, "notes/sub/raw.bin"), bytes);
  const plan = await planStorageMigration({ configPath });
  await writeFile(join(root, "notes/sub/raw.bin"), Buffer.from([0xff, 0x00, 0x42, 0x0d, 0x0a]));
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t), ifPlan: plan.planFingerprint }),
    code("STORAGE_PLAN_STALE"),
  );
  await writeFile(join(root, "notes/sub/raw.bin"), bytes);
  const result = await migrateStorage(
    { configPath },
    { backupDir: await tempDir(t), ifPlan: plan.planFingerprint },
  );
  const manifest = await verifyBackupContent(result.backup!);
  assert.ok(manifest.directories.some((entry) => entry.path === "notes/sub"));
  assert.deepEqual(
    await readFile(join(result.backup!.path, "files/config-root/notes/sub/raw.bin")),
    bytes,
  );
  assert.deepEqual(await readFile(join(root, "notes/sub/raw.bin")), bytes, "файл не тронут");
});
