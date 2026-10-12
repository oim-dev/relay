/**
 * Целостность исполнителя миграции по внешнему ревью: неизвестные поля служебных файлов
 * (A16), отпечатки неизменяемых файлов в WAL и конфликт recovery (A21), fsync каталога
 * резервной копии (A18), полная проверка текущей базы (A02/A16), разорванные предметные
 * ссылки (A16), отсутствие постоянных изменений до intent (A19), бюджет записи без
 * комментариев (A10/A28) и exit code runner (A30).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { STORAGE_MAINTENANCE_ERROR_EXIT_CODES } from "@relay/contracts/storage-maintenance";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { nodeBackupIo } from "../src/storage/data-model/backup.js";
import type { BackupIo } from "../src/storage/data-model/backup.js";
import {
  diffTrees,
  frozenProject,
  persistent,
  planV1Format4,
  readJsonFile,
  tempDir,
  treeHashes,
  writeJsonFile,
} from "./helpers/migration-bases.js";

const CORE = new URL("..", import.meta.url).pathname;
const RUNNER = new URL("../scripts/migrate-storage.mts", import.meta.url).pathname;
const BOARD_RELATIONS = "relations/boards/iAvN1TdV.json";

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, expected, `${error.code}: ${error.message}`);
  return true;
};
const detail = (error: unknown) =>
  (error as AppError & { details: Record<string, unknown> }).details;
const codes = (blockers: readonly { code: string }[]) => blockers.map((blocker) => blocker.code);

/** Неизменность базы до intent: ни один постоянный файл не создан, не изменён и не удалён. */
async function unchanged(project: string, before: Map<string, string>) {
  const skip = (path: string) => persistent(path.replace(/^\.relay\//, ""));
  const after = await treeHashes(project);
  const diff = diffTrees(before, after).filter((path) => !skip(path));
  assert.deepEqual(diff, [], "постоянный набор не изменён");
}

test("A16: неизвестное поле файла отношений и keyspace блокирует до классификации, файл сохранён", async (t) => {
  for (const variant of ["owner-file", "edge", "keyspace"] as const) {
    const { project, root, configPath } = await planV1Format4(t);
    let path = BOARD_RELATIONS;
    if (variant === "keyspace") {
      path = `keyspaces/${(await readdir(join(root, "keyspaces")))[0]}`;
      const space = await readJsonFile(join(root, path));
      await writeJsonFile(join(root, path), { ...space, note: "неизвестное поле" });
    } else {
      const raw = await readJsonFile<{ entries: { edge: Record<string, unknown> }[] }>(
        join(root, path),
      );
      if (variant === "owner-file")
        await writeJsonFile(join(root, path), { ...raw, note: "пользовательская заметка" });
      else {
        raw.entries[0]!.edge.note = "поле ребра";
        await writeJsonFile(join(root, path), raw);
      }
    }
    const bytes = await readFile(join(root, path));
    const before = await treeHashes(project);
    const status = await inspectStorage({ configPath });
    assert.notEqual(status.status, "migration-required", variant);
    assert.notEqual(status.status, "current", variant);
    assert.ok(
      status.blockers.some((blocker) => blocker.path === path),
      `${variant}: ${JSON.stringify(status.blockers)}`,
    );
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, false, variant);
    await assert.rejects(
      migrateStorage({ configPath }, { backupDir: await tempDir(t) }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.ok(error.exitCode > 0);
        return true;
      },
    );
    assert.deepEqual(await readFile(join(root, path)), bytes, `${variant}: содержимое сохранено`);
    await unchanged(project, before);
  }
});

test("A21: удаление, правка и добавление файла вне изменений WAL после intent — конфликт recovery", async (t) => {
  type Mutation = {
    name: string;
    apply: (root: string, unchangedPath: string) => Promise<string>;
  };
  const mutations: Mutation[] = [
    {
      name: "удаление",
      apply: async (root, path) => {
        await unlink(join(root, path));
        return path;
      },
    },
    {
      name: "правка",
      apply: async (root, path) => {
        const raw = await readJsonFile(join(root, path));
        await writeJsonFile(join(root, path), { ...raw, revision: 999 });
        return path;
      },
    },
    {
      name: "добавление",
      apply: async (root, path) => {
        const added = `${dirname(path)}/Added001.json`;
        const raw = await readJsonFile(join(root, path));
        await writeJsonFile(join(root, added), { ...raw, id: "Added001", key: null });
        return added;
      },
    },
  ];
  for (const mutation of mutations) {
    const { root, configPath } = await planV1Format4(t);
    await assert.rejects(
      migrateStorage(
        { configPath },
        { backupDir: await tempDir(t) },
        {
          probe: (stage) => {
            if (stage === "intent") throw new Error("остановка после intent");
          },
        },
      ),
      /остановка после intent/,
    );
    const pending = await inspectPending(root);
    assert.equal(pending.kind, "migration");
    if (pending.kind !== "migration") return;
    const inWal = new Set(pending.intent.changes.map((change) => change.path));
    const tasks = (await readdir(join(root, "entities/tasks"))).map(
      (name) => `entities/tasks/${name}`,
    );
    const untouched = tasks.find((path) => !inWal.has(path));
    assert.ok(untouched, "есть задача, которую миграция не меняет");
    const conflictPath = await mutation.apply(root, untouched!);
    const walBytes = await readFile(join(root, "transactions/pending.json"));
    await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
      code("STORAGE_RECOVERY_CONFLICT")(error);
      assert.equal(detail(error).path, conflictPath, mutation.name);
      return true;
    });
    assert.deepEqual(
      await readFile(join(root, "transactions/pending.json")),
      walBytes,
      `${mutation.name}: WAL сохранён`,
    );
    assert.ok(
      (await stat(join(pending.intent.migration.backup.path, "backup-manifest.json"))).isFile(),
    );
    assert.equal((await inspectStorage({ configPath })).status, "recovery-required");
  }
});

test("A18: каталог копии и созданная цепочка предков закрепляются fsync; ошибка — до intent", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const outer = await tempDir(t);
  const backupDir = join(outer, "a", "b");
  const synced: string[] = [];
  const io: BackupIo = {
    ...nodeBackupIo,
    syncDirectory: async (path) => {
      synced.push(path);
      return nodeBackupIo.syncDirectory(path);
    },
  };
  const result = await migrateStorage({ configPath }, { backupDir }, { backupIo: io });
  const copy = result.backup!.path;
  const realOuter = dirname(dirname(dirname(copy)));
  for (const parent of [dirname(copy), dirname(dirname(copy)), realOuter])
    assert.ok(synced.includes(parent), `fsync ${parent}: ${JSON.stringify(synced)}`);
  assert.ok(
    synced.indexOf(dirname(copy)) > -1 && synced.indexOf(dirname(copy)) < synced.lastIndexOf(copy),
    "родитель закреплён после создания каталога копии",
  );

  // Ошибка fsync родителя копии: миграция останавливается до intent, база не изменена.
  const second = await planV1Format4(t);
  const before = await treeHashes(second.project);
  const failingDir = await tempDir(t);
  await assert.rejects(
    migrateStorage(
      { configPath: second.configPath },
      { backupDir: failingDir },
      {
        backupIo: {
          ...nodeBackupIo,
          syncDirectory: async (path) => {
            if (path === failingDir || path.endsWith(failingDir))
              throw Object.assign(new Error("EIO"), { code: "EIO" });
            return nodeBackupIo.syncDirectory(path);
          },
        },
      },
    ),
    code("STORAGE_BACKUP_FAILED"),
  );
  assert.equal((await inspectPending(second.root)).kind, "none");
  await unchanged(second.project, before);
  void project;
  void root;
});

test("A02/A16: текущая база с повреждённым keyspace или отношением — invalid, не no-op", async (t) => {
  for (const variant of ["keyspace", "relation"] as const) {
    const { project, root, configPath } = await planV1Format4(t);
    await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
    assert.equal((await inspectStorage({ configPath })).status, "current");
    let path: string;
    if (variant === "keyspace") {
      path = `keyspaces/${(await readdir(join(root, "keyspaces")))[0]}`;
      await writeJsonFile(join(root, path), {});
    } else {
      path = BOARD_RELATIONS;
      await writeJsonFile(join(root, path), { schemaVersion: 1 });
    }
    const before = await treeHashes(project);
    const status = await inspectStorage({ configPath });
    assert.equal(status.status, "invalid", `${variant}: ${JSON.stringify(status.blockers)}`);
    assert.ok(status.blockers.some((blocker) => blocker.path === path));
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, false);
    assert.equal(plan.status, "invalid");
    await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
      code("STORAGE_DATA_CORRUPT")(error);
      assert.equal((error as AppError).exitCode, 5);
      return true;
    });
    await unchanged(project, before);
  }
});

test("A16: разорванные предметные ссылки блокируют перенос (STORAGE_REFERENCE_BROKEN)", async (t) => {
  const cases: [string, (data: Record<string, unknown>) => void][] = [
    ["parentId", (data) => void (data.parentId = "Missing1")],
    ["dependencies", (data) => void (data.dependencies = ["Missing2"])],
    ["boardId", (data) => void (data.boardId = "Missing3")],
  ];
  for (const [name, mutate] of cases) {
    const { project, root, configPath } = await planV1Format4(t);
    const tasks = await readdir(join(root, "entities/tasks"));
    const path = `entities/tasks/${tasks[0]}`;
    const raw = await readJsonFile<{ data: Record<string, unknown> }>(join(root, path));
    mutate(raw.data);
    await writeJsonFile(join(root, path), raw);
    const before = await treeHashes(project);
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, false, name);
    assert.ok(
      codes(plan.blockers).includes("STORAGE_REFERENCE_BROKEN"),
      `${name}: ${JSON.stringify(plan.blockers)}`,
    );
    assert.ok(plan.blockers.some((blocker) => blocker.path === path || blocker.id));
    await assert.rejects(
      migrateStorage({ configPath }, { backupDir: await tempDir(t) }),
      code("STORAGE_REFERENCE_BROKEN"),
    );
    await unchanged(project, before);
  }
});

test("A19: сбой до intent на базе без служебных .gitignore не создаёт постоянных файлов", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  for (const path of [".indexes/.gitignore", "transactions/.gitignore"])
    await rm(join(root, path), { force: true });
  const before = await treeHashes(project);
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir: await tempDir(t) },
      {
        probe: (stage) => {
          if (stage === "staged") throw new Error("остановка до intent");
        },
      },
    ),
    /остановка до intent/,
  );
  assert.equal((await inspectPending(root)).kind, "none");
  await unchanged(project, before);
  for (const path of [".indexes/.gitignore", "transactions/.gitignore"])
    await assert.rejects(stat(join(root, path)), { code: "ENOENT" }, path);
  // Повтор строит корректный план и переносит базу.
  const result = await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  assert.equal(result.migrated, true);
  assert.equal((await inspectStorage({ configPath })).status, "current");
});

test("A10/A28: накопленная лента комментариев не входит в бюджет 16 МиБ при переносе physical 3", async (t) => {
  const { root, configPath } = await frozenProject(t, "physical3-3875aee");
  const path = "entities/tasks/Y9BV3V3U.json";
  const raw = await readJsonFile<{
    comments: Record<string, unknown>[];
    commentSequence: number;
  }>(join(root, path));
  assert.equal(raw.comments.length, 1);
  const template = raw.comments[0]!;
  const line = `${"ж".repeat(128 * 1024 - 1)}\r`;
  for (let index = 2; index <= 71; index++)
    raw.comments.push({
      ...template,
      id: String(index),
      sequence: index,
      description: [line, "", "конец"],
    });
  raw.commentSequence = 71;
  await writeJsonFile(join(root, path), raw);
  assert.ok((await stat(join(root, path))).size > 16 * 1024 * 1024, "файл задачи больше 16 МиБ");
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  assert.ok(plan.budgets.maxRecordBytes < 16 * 1024 * 1024);
  const result = await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  assert.equal(result.migrated, true);
  const migrated = await readJsonFile<{ comments: { id: string; description: string[] }[] }>(
    join(root, path),
  );
  assert.equal(migrated.comments.length, 71, "исходный комментарий и 70 добавленных");
  assert.deepEqual(migrated.comments.at(-1)!.description, [line, "", "конец"]);
  const workspace = await openWorkspace(dirname(root), configPath);
  assert.ok(workspace);
});

function runner(args: string[]): Promise<{ status: number; out: Record<string, unknown> }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--conditions=tasks-source", "--import", "tsx", RUNNER, ...args],
      { cwd: CORE, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const status = error ? Number((error as { code?: number }).code ?? 1) : 0;
        let out: Record<string, unknown> = {};
        try {
          out = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          out = { raw: stdout };
        }
        resolve({ status, out });
      },
    );
  });
}

test("A30: runner из checkout возвращает тот же ненулевой exit, что CLI, с машинной причиной", async (t) => {
  const { root, configPath } = await planV1Format4(t);
  const ok = await runner(["--config", configPath, "--status"]);
  assert.equal(ok.status, 0, JSON.stringify(ok.out));
  assert.equal(ok.out.status, "migration-required");
  const dry = await runner(["--config", configPath, "--dry-run"]);
  assert.equal(dry.status, 0);
  assert.equal(dry.out.applicable, true);

  await writeFile(join(root, BOARD_RELATIONS), "{не json");
  const corrupt = STORAGE_MAINTENANCE_ERROR_EXIT_CODES.STORAGE_DATA_CORRUPT;
  type Failure = { ok: false; error: { code: string; details: Record<string, unknown> } };
  for (const args of [["--status"], ["--dry-run"], ["--backup-dir", await tempDir(t)]]) {
    const run = await runner(["--config", configPath, ...args]);
    assert.equal(run.status, corrupt, `${args[0]}: ${JSON.stringify(run.out)}`);
    const failure = run.out as unknown as Failure;
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "STORAGE_DATA_CORRUPT");
    if (args[0] !== "--backup-dir") assert.equal(failure.error.details.status, "invalid");
    if (args[0] === "--dry-run") assert.equal(failure.error.details.applicable, false);
  }
});
