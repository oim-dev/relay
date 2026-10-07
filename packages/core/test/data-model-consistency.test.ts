/**
 * Согласованность исполнителя миграции (повторное ревью): защита всех постоянных путей в
 * WAL (A14/A21), фактический дисковый объём и точный бюджет WAL (A28), итоговая
 * конфигурация (A16/A25), владельцы пространств ключей и ссылки, зарегистрированные
 * владельцем (A16/A29), полная проверка текущей базы (A02), следующие шаги ошибок.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { StorageBlocker } from "@relay/contracts/storage-maintenance";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { nodeBackupIo } from "../src/storage/data-model/backup.js";
import { note, syntheticRegistry } from "./helpers/synthetic-data-model.js";
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

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, expected, `${error.code}: ${error.message}`);
  return true;
};
const detail = (error: unknown) =>
  (error as AppError & { details: Record<string, unknown> }).details;
const stopAt = (stage: string) => ({
  probe: (current: string) => {
    if (current === stage) throw new Error(`остановка ${stage}`);
  },
});
async function unchanged(project: string, before: Map<string, string>) {
  const after = await treeHashes(project);
  assert.deepEqual(
    diffTrees(before, after).filter((path) => !persistent(path.replace(/^\.relay\//, ""))),
    [],
    "постоянный набор не изменён",
  );
}
const blocked = (blockers: readonly StorageBlocker[], expected: string, path?: string) =>
  assert.ok(
    blockers.some(
      (blocker) => blocker.code === expected && (path === undefined || blocker.path === path),
    ),
    `${expected} ${path ?? ""}: ${JSON.stringify(blockers)}`,
  );

test("A14/A21: конфигурация с Unicode-именем защищена в WAL; её удаление после intent — конфликт", async (t) => {
  const { root } = await planV1Format4(t);
  const name = "настройки.json";
  await rename(join(root, "config.json"), join(root, name));
  const configPath = join(root, name);
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }, stopAt("intent")),
    /остановка intent/,
  );
  const pending = await inspectPending(root);
  assert.equal(pending.kind, "migration");
  if (pending.kind !== "migration") return;
  assert.ok(pending.intent.migration.unchanged?.some((file) => file.path === name));
  const saved = await readFile(configPath);
  await unlink(configPath);
  const wal = await readFile(join(root, "transactions/pending.json"));
  await assert.rejects(migrateStorage({ configPath }), (error: unknown) => {
    code("STORAGE_RECOVERY_CONFLICT")(error);
    assert.equal(detail(error).path, name);
    return true;
  });
  assert.deepEqual(await readFile(join(root, "transactions/pending.json")), wal);
  await writeFile(configPath, saved);
  assert.equal((await migrateStorage({ configPath })).resumed, true);
});

/** Большая лента комментариев physical 3 (как в A10/A28 первого ревью). */
async function commentsBase(t: Parameters<typeof tempDir>[0]) {
  const base = await frozenProject(t, "physical3-3875aee");
  const path = join(base.root, "entities/tasks/Y9BV3V3U.json");
  const raw = await readJsonFile<{ comments: Record<string, unknown>[]; commentSequence: number }>(
    path,
  );
  const template = raw.comments[0]!;
  const line = "ж".repeat(128 * 1024);
  for (let index = 2; index <= 71; index++)
    raw.comments.push({ ...template, id: String(index), sequence: index, description: [line] });
  raw.commentSequence = 71;
  await writeJsonFile(path, raw);
  return base;
}

test("A28: требуемое место корня считается по фактическому WAL с комментариями", async (t) => {
  const { project, root, configPath } = await commentsBase(t);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  assert.ok(plan.budgets.walBytes < 1024 * 1024, "предметный бюджет WAL без комментариев");
  // Фактический WAL при остановке после intent.
  const probeBase = await commentsBase(t);
  await assert.rejects(
    migrateStorage(
      { configPath: probeBase.configPath },
      { backupDir: await tempDir(t) },
      stopAt("intent"),
    ),
    /остановка intent/,
  );
  const walSize = (await readFile(join(probeBase.root, "transactions/pending.json"))).byteLength;
  assert.ok(walSize > 17 * 1024 * 1024);
  // Публикация пишет и WAL целиком, и запись задачи с той же лентой.
  const written = (await readFile(join(root, "entities/tasks/Y9BV3V3U.json"))).byteLength;
  assert.ok(
    plan.space.rootRequired >= walSize + written * 0.95,
    `rootRequired ${plan.space.rootRequired} < WAL ${walSize} + запись ${written}`,
  );
  // Места хватает на запись и половину WAL, но не на обе копии ленты: отказ до изменений.
  const before = await treeHashes(project);
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir: await tempDir(t) },
      { freeBytes: async () => written + Math.floor(walSize / 2) },
    ),
    code("STORAGE_INSUFFICIENT_SPACE"),
  );
  assert.equal((await inspectPending(root)).kind, "none");
  await unchanged(project, before);
});

test("A28: бюджет WAL в плане равен точной сериализации записываемого intent", async (t) => {
  const { root, configPath } = await planV1Format4(t);
  // Много неизменяемых файлов: размер отпечатков unchanged заметен в бюджете.
  for (let index = 0; index < 1500; index++) {
    const id = `Tomb${String(index).padStart(4, "0")}`;
    await writeJsonFile(join(root, `entities/tasks/${id}.json`), {
      schemaVersion: 3,
      dataVersion: 1,
      kind: "task",
      id,
      revision: 1,
      key: `WEB-${5000 + index}`,
      aliases: [],
      deleted: { at: "2024-01-02T03:04:05.000Z", actor: "tester" },
    });
  }
  const plan = await planStorageMigration({ configPath });
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }, stopAt("intent")),
    /остановка intent/,
  );
  const wal = await readJsonFile<{ changes: { path: string; after: unknown }[] }>(
    join(root, "transactions/pending.json"),
  );
  const budget = {
    ...wal,
    changes: wal.changes.map((change) => {
      const after = change.after as Record<string, unknown> | null;
      if (change.path.startsWith("entities/") && after && after.schemaVersion === 3) {
        const { comments: _comments, ...rest } = after;
        return { ...change, after: rest };
      }
      return change;
    }),
  };
  const actual = Buffer.byteLength(`${JSON.stringify(budget, null, 2)}\n`);
  assert.ok(plan.budgets.walBytes >= actual, `план ${plan.budgets.walBytes} < факт ${actual}`);
  // Неизвестны только путь копии и необязательные поля восстановления: запас ограничен.
  assert.ok(plan.budgets.walBytes - actual <= 4096 + 256, `${plan.budgets.walBytes} − ${actual}`);
});

test("A16/A25: итоговая конфигурация проверяется текущей схемой до публикации", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const config = await readJsonFile(configPath);
  await writeJsonFile(configPath, { ...config, defaultStatus: "отсутствует" });
  const before = await treeHashes(project);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  blocked(plan.blockers, "STORAGE_DATA_CORRUPT", "config.json");
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }),
    code("STORAGE_DATA_CORRUPT"),
  );
  assert.equal((await inspectPending(root)).kind, "none");
  await unchanged(project, before);
});

test("A16: владелец пространства ключей обязан существовать", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const name = (await readdir(join(root, "keyspaces")))[0]!;
  const space = await readJsonFile<{ owner: { kind: string; id: string } }>(
    join(root, "keyspaces", name),
  );
  await writeJsonFile(join(root, "keyspaces", name), {
    ...space,
    owner: { ...space.owner, id: "Missing1" },
  });
  const before = await treeHashes(project);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  blocked(plan.blockers, "STORAGE_REFERENCE_BROKEN", `keyspaces/${name}`);
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }),
    code("STORAGE_REFERENCE_BROKEN"),
  );
  await unchanged(project, before);
});

test("A16: область плана на отсутствующий продукт или проект блокирует перенос", async (t) => {
  for (const kind of ["product", "project"]) {
    const { root, configPath } = await planV1Format4(t);
    const plans = await readdir(join(root, "entities/work-plans"));
    const path = `entities/work-plans/${plans[0]}`;
    const raw = await readJsonFile<{ data: Record<string, unknown> }>(join(root, path));
    raw.data.scope = [{ kind, id: "Missing1" }];
    await writeJsonFile(join(root, path), raw);
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, false, kind);
    blocked(plan.blockers, "STORAGE_REFERENCE_BROKEN", path);
  }
});

test("A02: текущая база с разорванной ссылкой — invalid в status, dry-run и migrate", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  const tasks = await readdir(join(root, "entities/tasks"));
  const path = `entities/tasks/${tasks[0]}`;
  const raw = await readJsonFile<{ data: Record<string, unknown> }>(join(root, path));
  raw.data.parentId = "Missing1";
  await writeJsonFile(join(root, path), raw);
  const before = await treeHashes(project);
  const status = await inspectStorage({ configPath });
  assert.equal(status.status, "invalid");
  blocked(status.blockers, "STORAGE_REFERENCE_BROKEN", path);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  await assert.rejects(migrateStorage({ configPath }), code("STORAGE_REFERENCE_BROKEN"));
  await unchanged(project, before);
});

test("A29: правила ссылок регистрирует владелец; производственный исполнитель их применяет", async (t) => {
  const registry = syntheticRegistry(13);
  const project = await tempDir(t);
  const root = join(project, ".relay");
  await mkdir(join(root, "entities/notes"), { recursive: true });
  await writeJsonFile(join(root, "config.json"), { version: 1, projectId: "Synth01" });
  await writeJsonFile(join(root, "storage.json"), {
    format: "relay-entities",
    schemaVersion: 4,
    dataModelVersion: 12,
  });
  await writeJsonFile(
    join(root, "entities/notes/n1.json"),
    note("n1", 3, { title: "N", text: "t", tagIds: ["Missing1"] }),
  );
  const configPath = join(root, "config.json");
  const plan = await planStorageMigration({ configPath }, { registry });
  assert.equal(plan.applicable, false);
  blocked(plan.blockers, "STORAGE_REFERENCE_BROKEN", "entities/notes/n1.json");
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }, { registry }),
    code("STORAGE_REFERENCE_BROKEN"),
  );
});

test("next по ситуации: копия испорчена до intent; WAL предварительной сборки при открытии", async (t) => {
  const { project, root, configPath } = await planV1Format4(t);
  const originals = new Map<string, Uint8Array>();
  const before = await treeHashes(project);
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir: await tempDir(t) },
      {
        backupIo: {
          ...nodeBackupIo,
          // Копия записана повреждённой, но проверка createBackup видит исходные байты.
          writeFile: async (path, bytes) => {
            if (!originals.size && path.includes("/files/config-root/entities/")) {
              originals.set(path, bytes);
              const copy = Buffer.from(bytes);
              copy[copy.length - 2] = copy[copy.length - 2] === 0x20 ? 0x21 : 0x20;
              return nodeBackupIo.writeFile(path, copy);
            }
            return nodeBackupIo.writeFile(path, bytes);
          },
          readFile: async (path) => originals.get(path) ?? nodeBackupIo.readFile(path),
        },
      },
    ),
    (error: unknown) => {
      code("STORAGE_BACKUP_MISSING")(error);
      assert.doesNotMatch(String(detail(error).next), /pending\.json/);
      return true;
    },
  );
  assert.equal((await inspectPending(root)).kind, "none");
  await unchanged(project, before);

  // WAL v2 без итога плана: обычное открытие даёт тот же следующий шаг, что status.
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir: await tempDir(t) }, stopAt("intent")),
    /остановка intent/,
  );
  const walPath = join(root, "transactions/pending.json");
  const wal = JSON.parse(await readFile(walPath, "utf8"));
  delete wal.migration.report;
  await writeFile(walPath, JSON.stringify(wal));
  const status = await inspectStorage({ configPath });
  await assert.rejects(openWorkspace(project, configPath), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(detail(error).next, status.blockers[0]!.next);
    return true;
  });
});

test("A14: исторические формы конфигурации переносятся без изменений и открываются Workspace", async (t) => {
  const { project, configPath } = await planV1Format4(t);
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  // Форма 1efc794…c1270c9 (без mode/server/mcp, сервер 3000) и аудит настроек bf95518…1afe138.
  const historical = {
    version: 1,
    projectId: config.projectId,
    storageDir: config.storageDir,
    defaultStatus: "todo",
    readyStatuses: ["todo"],
    statuses: {
      todo: { terminal: false, satisfiesDependencies: false },
      done: { terminal: true, satisfiesDependencies: true },
    },
    server: { port: 3000 },
    output: { format: "text", defaultLimit: 20, maxBytes: 16384 },
    projectSettings: {
      name: "Проект",
      slug: "project",
      revision: 1,
      version: 2,
      requests: { r1: { hash: "h1", result: { id: "p", key: "PRJ", revision: 1 } } },
      events: [{ revision: 1, actor: "agent", at: "2026-09-20T00:00:00.000Z", action: "create" }],
    },
  };
  await writeJsonFile(configPath, historical);
  const bytes = await readFile(configPath);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  assert.deepEqual(await readFile(configPath), bytes, "конфигурация не переписана");
  assert.equal((await inspectStorage({ configPath })).status, "current");
  await openWorkspace(project, configPath);
});
