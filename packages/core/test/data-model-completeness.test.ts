/**
 * Полнота проверок обслуживания (третье ревью): совместимость профиля до любого recovery
 * (ТЗ 5.2, A15/A24), одна полная проверка текущей базы и подготовки миграции (A02/A16),
 * идентичность проекта в конфигурации (A08/A25), ссылки исторических снимков выпуска (R2),
 * Unicode-имя конфигурации legacy (A03/A14), исторические схемы в явном status (ТЗ 5.1).
 * Все базы — временные копии на диске.
 */
import assert from "node:assert/strict";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { StorageBlocker } from "@relay/contracts/storage-maintenance";
import type { JsonValue } from "@relay/contracts/storage";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  maintenanceFailure,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { StorageService } from "../src/application/storage/service.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import { integrityBlockers } from "../src/storage/data-model/plan/integrity.js";
import type { RecordFacts } from "../src/storage/data-model/plan/integrity.js";
import { unlink, writeFile } from "node:fs/promises";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { digest, jsonValue } from "../src/storage/entity-store/format.js";
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
import type { Base } from "./helpers/migration-bases.js";

type Context = Parameters<typeof tempDir>[0];

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, expected, `${error.code}: ${error.message}`);
  return true;
};
const blocked = (blockers: readonly StorageBlocker[], expected: string, path?: string) =>
  assert.ok(
    blockers.some(
      (blocker) => blocker.code === expected && (path === undefined || blocker.path === path),
    ),
    `${expected} ${path ?? ""}: ${JSON.stringify(blockers)}`,
  );
async function unchanged(project: string, before: Map<string, string>) {
  assert.deepEqual(
    diffTrees(before, await treeHashes(project)).filter(
      (path) => !persistent(path.replace(/^-?\.relay\//, "")),
    ),
    [],
    "постоянный набор не изменён",
  );
}

/** База текущего профиля: исторический план v1, перенесённый до профиля 2. */
async function currentBase(t: Context): Promise<Base> {
  const base = await planV1Format4(t);
  await migrateStorage({ configPath: base.configPath }, { backupDir: await tempDir(t) });
  assert.equal((await inspectStorage({ configPath: base.configPath })).status, "current");
  return base;
}

/** Все три входа обслуживания блокируют базу и не меняют её. */
async function rejectedEverywhere(
  t: Context,
  base: Base,
  expected: string,
  path: string,
  status: "invalid" | "unsupported" = "invalid",
) {
  const { project, root, configPath } = base;
  const before = await treeHashes(project);
  const inspected = await inspectStorage({ configPath });
  assert.equal(inspected.status, status, JSON.stringify(inspected.blockers));
  blocked(inspected.blockers, expected, path);
  assert.ok(maintenanceFailure(inspected, "status"), "ненулевой исход status");
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  blocked(plan.blockers, expected, path);
  const backupDir = await tempDir(t);
  await assert.rejects(migrateStorage({ configPath }, { backupDir }), code(expected));
  assert.deepEqual(await readdir(backupDir), [], "резервная копия не создана");
  assert.equal((await inspectPending(root)).kind, "none");
  await unchanged(project, before);
}

test("ТЗ 5.2: база будущего профиля с обычным WAL не восстанавливается ни одним входом", async (t) => {
  const { project, root, configPath } = await currentBase(t);
  const manifest = await readJsonFile(join(root, "storage.json"));
  await writeJsonFile(join(root, "storage.json"), { ...manifest, dataModelVersion: 3 });
  const name = (await readdir(join(root, "entities/tasks"))).find((file) =>
    file.endsWith(".json"),
  )!;
  const path = `entities/tasks/${name}`;
  const original = jsonValue(await readJsonFile(join(root, path))) as Record<string, JsonValue>;
  const changed = { ...original, revision: (original.revision as number) + 1 };
  await writeJsonFile(join(root, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [{ path, before: digest(original), after: changed }],
  });
  const before = await treeHashes(project);
  const unsupported = code("STORAGE_VERSION_UNSUPPORTED");

  const status = await inspectStorage({ configPath });
  assert.equal(status.status, "unsupported", JSON.stringify(status.blockers));
  blocked(status.blockers, "STORAGE_VERSION_UNSUPPORTED", "storage.json");
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, false);
  assert.equal(plan.status, "unsupported");
  const backupDir = await tempDir(t);
  await assert.rejects(migrateStorage({ configPath }, { backupDir }), unsupported);
  assert.deepEqual(await readdir(backupDir), [], "резервная копия не создана");
  await assert.rejects(openWorkspace(project, configPath), unsupported);

  assert.equal((await inspectPending(root)).kind, "operation", "pending сохранён");
  assert.deepEqual(await readJsonFile(join(root, path)), original, "операция не исполнена");
  await unchanged(project, before);
});

test("A02: коллизия ключей двух задач текущей базы — invalid во всех входах", async (t) => {
  const base = await currentBase(t);
  const directory = join(base.root, "entities/tasks");
  const [first, second] = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  const left = await readJsonFile<{ key: string }>(join(directory, first!));
  const right = await readJsonFile<{ key: string }>(join(directory, second!));
  right.key = left.key;
  await writeJsonFile(join(directory, second!), right);
  await rejectedEverywhere(t, base, "STORAGE_ADDRESS_COLLISION", `entities/tasks/${second}`);
});

test("A02: активное ребро на отсутствующую задачу текущей базы — invalid во всех входах", async (t) => {
  const base = await currentBase(t);
  const directory = join(base.root, "relations/tasks");
  let path: string | undefined;
  for (const name of (await readdir(directory)).filter((file) => file.endsWith(".json"))) {
    const set = await readJsonFile<{
      storage: string;
      entries: { edge: { active: boolean; to: { kind: string; id: string } } }[];
    }>(join(directory, name));
    const entry = set.storage === "inline" && set.entries.find((item) => item.edge.active);
    if (!entry) continue;
    entry.edge.to = { kind: "task", id: "Missing1" };
    await writeJsonFile(join(directory, name), set);
    path = `relations/tasks/${name}`;
    break;
  }
  assert.ok(path, "найден набор с активным ребром");
  await rejectedEverywhere(t, base, "STORAGE_REFERENCE_BROKEN", path);
});

test("A08/A25: projectId конфигурации обязан указывать на запись проекта", async (t) => {
  // Профиль 1: перенос не публикуется, Workspace не получит базу без настроек.
  const legacy = await planV1Format4(t);
  const config = await readJsonFile(legacy.configPath);
  await writeJsonFile(legacy.configPath, { ...config, projectId: "Missing1" });
  await rejectedEverywhere(t, legacy, "STORAGE_REFERENCE_BROKEN", "config.json");
  // Текущий профиль: status и no-op сообщают ту же причину.
  const current = await currentBase(t);
  const settings = await readJsonFile(current.configPath);
  await writeJsonFile(current.configPath, { ...settings, projectId: "Missing1" });
  await rejectedEverywhere(t, current, "STORAGE_REFERENCE_BROKEN", "config.json");
});

test("A08: исходная конфигурация с верным projectId открывается после переноса", async (t) => {
  const { project, configPath } = await currentBase(t);
  const workspace = await openWorkspace(project, configPath);
  assert.ok(workspace.config.projectSettings, "настройки проекта прочитаны");
});

test("R2: снимок выпуска ссылается на релиз и свои записи; запись — на свой снимок", async (t) => {
  const cases: [string, (snapshot: Record<string, unknown>, entry: string) => unknown][] = [
    [
      "releaseId",
      (snapshot) => {
        (snapshot.data as Record<string, unknown>).releaseId = "Missing1";
      },
    ],
    [
      "entryIds",
      (snapshot) => {
        ((snapshot.data as Record<string, unknown>).entryIds as string[]).push("Missing1");
      },
    ],
    [
      "entryIds-owner",
      (snapshot, entry) => {
        const data = snapshot.data as { entryIds: string[] };
        data.entryIds = data.entryIds.filter((id) => `${id}.json` !== entry);
      },
    ],
  ];
  for (const [label, mutate] of cases)
    for (const profile of ["current", "profile1"] as const) {
      const base = profile === "current" ? await currentBase(t) : await planV1Format4(t);
      if (profile === "profile1")
        // Снимки появляются при переносе планирования; маркер 1 оставляет их в базе формата 4.
        await migrateThenUnmark(t, base);
      const directory = join(base.root, "entities/release-snapshots");
      const [name] = await readdir(directory);
      const path = `entities/release-snapshots/${name}`;
      const snapshot = await readJsonFile(join(base.root, path));
      const entry = (await readdir(join(base.root, "entities/release-snapshot-entries")))[0]!;
      mutate(snapshot, entry);
      await writeJsonFile(join(base.root, path), snapshot);
      const inspected = await inspectStorage({ configPath: base.configPath });
      assert.equal(inspected.status, "invalid", `${label}/${profile}`);
      blocked(
        inspected.blockers,
        "STORAGE_REFERENCE_BROKEN",
        label === "entryIds-owner" ? `entities/release-snapshot-entries/${entry}` : path,
      );
      const plan = await planStorageMigration({ configPath: base.configPath });
      assert.equal(plan.applicable, false, `${label}/${profile}`);
    }
});

/** Профиль 1 со снимками: перенос до профиля 2 и возврат маркера без dataModelVersion. */
async function migrateThenUnmark(t: Context, base: Base) {
  await migrateStorage({ configPath: base.configPath }, { backupDir: await tempDir(t) });
  const path = join(base.root, "storage.json");
  const { dataModelVersion: _profile, ...manifest } = await readJsonFile(path);
  await writeJsonFile(path, manifest);
  assert.equal(
    (await inspectStorage({ configPath: base.configPath })).status,
    "migration-required",
  );
}

test("A03/A14: legacy-база с Unicode-именем конфигурации переносится", async (t) => {
  const { project, root, configPath: original } = await frozenProject(t, "legacy-5c7265b");
  const configPath = join(root, "настройки.json");
  await rename(original, configPath);
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  const result = await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
  assert.equal(result.migrated, true);
  assert.equal((await inspectStorage({ configPath })).status, "current");
  await openWorkspace(project, configPath);
});

test("A03: небезопасные пути источника по-прежнему отвергаются физическим reader", async () => {
  const { createFsSourceIo } = await import("../src/storage/migration/unified-sources.js");
  const io = createFsSourceIo({
    root: "/nonexistent-root",
    layout: "legacy",
    configName: "config.json",
    configPath: "/nonexistent-root/config.json",
    catalog: {
      kindOfCollection: () => undefined,
      collectionOf: () => undefined,
      validateRecord: () => {
        throw new Error("не вызывается");
      },
    },
  });
  for (const path of ["../outside.json", "/etc/passwd", "a/../b.json", "a//b.json", "a\\b.json"])
    await assert.rejects(io.read(path, "config-root"), code("STORAGE_UNSAFE_PATH"), path);
  assert.equal(await io.read("настройки.json", "config-root"), null);
});

test("ТЗ 5.1: status проверяет исторические схемы physical 3 и legacy", async (t) => {
  const physical = await frozenProject(t, "physical3-3875aee");
  const tasks = join(physical.root, "entities/tasks");
  const task = (await readdir(tasks)).find((file) => file.endsWith(".json"))!;
  const raw = await readJsonFile(join(tasks, task));
  delete raw.data;
  await writeJsonFile(join(tasks, task), raw);
  const physicalStatus = await inspectStorage({ configPath: physical.configPath });
  assert.equal(physicalStatus.status, "invalid", JSON.stringify(physicalStatus.blockers));
  blocked(physicalStatus.blockers, "STORAGE_DATA_CORRUPT");
  assert.ok(maintenanceFailure(physicalStatus, "status"));

  const legacy = await frozenProject(t, "legacy-5c7265b");
  const board = join(legacy.root, "boards/api/board.json");
  await writeJsonFile(board, { ...(await readJsonFile(board)), kind: 17 });
  const before = await treeHashes(legacy.project);
  const legacyStatus = await inspectStorage({ configPath: legacy.configPath });
  assert.equal(legacyStatus.status, "invalid", JSON.stringify(legacyStatus.blockers));
  blocked(legacyStatus.blockers, "STORAGE_DATA_CORRUPT");
  await unchanged(legacy.project, before);
  // Корректные исторические базы остаются migration-required.
  for (const name of ["legacy-5c7265b", "physical3-3875aee"]) {
    const base = await frozenProject(t, name);
    const status = await inspectStorage({ configPath: base.configPath });
    assert.equal(
      status.status,
      "migration-required",
      `${name}: ${JSON.stringify(status.blockers)}`,
    );
  }
});

test("A14: WAL legacy-миграции сохраняет Unicode-путь конфигурации legacy", async (t) => {
  const { root, configPath: original } = await frozenProject(t, "legacy-5c7265b");
  const configPath = join(root, "настройки.json");
  await rename(original, configPath);
  await assert.rejects(
    migrateStorage(
      { configPath },
      { backupDir: await tempDir(t) },
      {
        probe: (stage) => {
          if (stage === "intent") throw new Error("остановка intent");
        },
      },
    ),
    /остановка intent/,
  );
  const wal = JSON.parse(await readFile(join(root, "transactions/pending.json"), "utf8"));
  assert.equal(wal.schemaVersion, 2);
  const result = await migrateStorage({ configPath });
  assert.equal(result.resumed, true);
});

test("R8: counts.changed и plan.changes.files включают служебные .gitignore после публикации", async (t) => {
  for (const name of ["legacy-c1c353f", "physical1-90d7b26"]) {
    const { project, configPath } = await frozenProject(t, name);
    const before = await treeHashes(project);
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
    const result = await migrateStorage({ configPath }, { backupDir: await tempDir(t) });
    const after = await treeHashes(project);
    const files = diffTrees(before, after).filter((path) => {
      const relative = path.replace(/^-?\.relay\//, "");
      const hash = path.startsWith("-") ? before.get(path.slice(1)) : after.get(path);
      return path.startsWith("-.relay/") || path.startsWith(".relay/")
        ? !persistent(relative) && hash !== "dir"
        : false;
    });
    assert.equal(result.counts.changed, files.length, `${name}: ${JSON.stringify(files)}`);
    const planned = Object.values(plan.changes.files).reduce(
      (sum, item) => sum + item.create + item.update + item.delete,
      0,
    );
    assert.equal(planned, files.length, name);
    for (const ignore of [".relay/.indexes/.gitignore", ".relay/transactions/.gitignore"])
      if (!before.has(ignore)) assert.ok(after.has(ignore), ignore);
    // Инструкция восстановления предлагает чтение, доступное во всех поддерживаемых версиях.
    const restore = await readFile(join(result.backup!.path, "RESTORE.md"), "utf8");
    assert.match(restore, /task list/);
    assert.doesNotMatch(restore, /relay\.\/[^`]*doctor check`/);
  }
});

/** Обычный WAL изменения задачи текущей базы; возвращает путь и исходное содержимое. */
async function pendingTaskChange(root: string) {
  const name = (await readdir(join(root, "entities/tasks"))).find((file) =>
    file.endsWith(".json"),
  )!;
  const path = `entities/tasks/${name}`;
  const original = jsonValue(await readJsonFile(join(root, path))) as Record<string, JsonValue>;
  await writeJsonFile(join(root, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [
      {
        path,
        before: digest(original),
        after: { ...original, revision: (original.revision as number) + 1 },
      },
    ],
  });
  return { path, original };
}

test("ТЗ 5.1–5.2: неизвестный или повреждённый manifest запрещает recovery обычного WAL", async (t) => {
  const variants: [string, (manifest: Record<string, unknown>) => string, string, string][] = [
    [
      "лишнее поле",
      (m) => JSON.stringify({ ...m, futureField: true }),
      "STORAGE_FORMAT_UNKNOWN",
      "unsupported",
    ],
    [
      "неизвестный format",
      (m) => JSON.stringify({ ...m, format: "other" }),
      "STORAGE_FORMAT_UNKNOWN",
      "unsupported",
    ],
    ["повреждённый JSON", () => "{", "STORAGE_DATA_CORRUPT", "invalid"],
  ];
  for (const [label, mutate, expected, status] of variants) {
    const { project, root, configPath } = await currentBase(t);
    const manifest = await readJsonFile(join(root, "storage.json"));
    await writeFile(join(root, "storage.json"), mutate(manifest));
    const { path, original } = await pendingTaskChange(root);
    const before = await treeHashes(project);
    const inspected = await inspectStorage({ configPath });
    assert.equal(inspected.status, status, `${label}: ${JSON.stringify(inspected.blockers)}`);
    blocked(inspected.blockers, expected, "storage.json");
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, false, label);
    const backupDir = await tempDir(t);
    await assert.rejects(migrateStorage({ configPath }, { backupDir }), code(expected), label);
    assert.deepEqual(await readdir(backupDir), [], label);
    await assert.rejects(openWorkspace(project, configPath), code(expected), label);
    assert.equal((await inspectPending(root)).kind, "operation", label);
    assert.deepEqual(await readJsonFile(join(root, path)), original, label);
    await unchanged(project, before);
  }
});

test("R2: planEntryIds снимка и повторы entryIds проверяются в любом профиле", async (t) => {
  const cases: [string, (data: { entryIds: string[]; planEntryIds: string[] }) => void][] = [
    ["planEntryIds", (data) => void data.planEntryIds.push("Missing1")],
    ["entryIds-repeat", (data) => void data.entryIds.push(data.entryIds[0]!)],
    [
      "planEntryIds-repeat",
      (data) => {
        data.planEntryIds.push(data.entryIds[0]!);
        data.planEntryIds.push(data.entryIds[0]!);
      },
    ],
  ];
  for (const [label, mutate] of cases)
    for (const profile of ["current", "profile1"] as const) {
      const base = await currentBase(t);
      if (profile === "profile1") {
        const path = join(base.root, "storage.json");
        const { dataModelVersion: _profile, ...manifest } = await readJsonFile(path);
        await writeJsonFile(path, manifest);
      }
      const directory = join(base.root, "entities/release-snapshots");
      const [name] = await readdir(directory);
      const snapshot = await readJsonFile<{ data: { entryIds: string[]; planEntryIds: string[] } }>(
        join(directory, name!),
      );
      mutate(snapshot.data);
      await writeJsonFile(join(directory, name!), snapshot);
      const inspected = await inspectStorage({ configPath: base.configPath });
      assert.equal(inspected.status, "invalid", `${label}/${profile}`);
      assert.ok(
        inspected.blockers.some((b) => b.path === `entities/release-snapshots/${name}`),
        `${label}/${profile}: ${JSON.stringify(inspected.blockers)}`,
      );
      const plan = await planStorageMigration({ configPath: base.configPath });
      assert.equal(plan.applicable, false, `${label}/${profile}`);
    }
});

test("A28: обратные ссылки 10 000 записей снимка проверяются за линейное время", () => {
  const registry = productionTransitionRegistry();
  const count = 10000;
  const entries = Array.from({ length: count }, (_, index) => `E${String(index).padStart(7, "0")}`);
  const records: RecordFacts[] = [
    {
      kind: "release-snapshot",
      id: "S1",
      path: "entities/release-snapshots/S1.json",
      live: true,
      addressable: false,
      addresses: [],
      commentsConsistent: true,
      refs: entries.map((id) => ({
        field: "entryIds",
        kind: "release-snapshot-entry",
        id,
        inverse: "snapshotId",
      })),
    },
    ...entries.map((id) => ({
      kind: "release-snapshot-entry",
      id,
      path: `entities/release-snapshot-entries/${id}.json`,
      live: true,
      addressable: false,
      addresses: [],
      commentsConsistent: true,
      refs: [{ field: "snapshotId", kind: "release-snapshot", id: "S1", inverse: "entryIds" }],
    })),
  ];
  const started = performance.now();
  const blockers = integrityBlockers(
    { records, relations: [], keyspaces: [], config: null },
    registry,
  );
  const elapsed = performance.now() - started;
  assert.deepEqual(blockers, []);
  assert.ok(elapsed < 250, `${elapsed} мс`);
});

/** Путь корневой страницы индекса `name` по `.indexes/state.json`. */
async function rootPage(root: string, name: string) {
  const state = await readJsonFile<{ roots: Record<string, string | null> }>(
    join(root, ".indexes/state.json"),
  );
  const hash = state.roots[name]!;
  return `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;
}

test("A02: потерянная страница рабочего индекса текущей базы — не passed; reindex её восстанавливает", async (t) => {
  const base = await currentBase(t);
  const page = await rootPage(base.root, "cards");
  await unlink(join(base.root, page));
  const before = await treeHashes(base.project);
  const inspected = await inspectStorage({ configPath: base.configPath });
  assert.equal(inspected.status, "invalid", JSON.stringify(inspected));
  const blocker = inspected.blockers.find((item) => item.path === page);
  assert.ok(blocker, JSON.stringify(inspected.blockers));
  assert.equal(blocker.code, "STORAGE_INDEX_STALE");
  assert.match(blocker.next, /storage reindex/);
  assert.equal((await planStorageMigration({ configPath: base.configPath })).applicable, false);
  await assert.rejects(
    migrateStorage({ configPath: base.configPath }),
    code("STORAGE_INDEX_STALE"),
  );
  await unchanged(base.project, before);
  // Источники истины целы: явная пересборка возвращает базу в current.
  await new StorageService(await openWorkspace(base.project, base.configPath)).reindex();
  assert.equal((await inspectStorage({ configPath: base.configPath })).status, "current");
});

test("FORMAT: перенос, который перестраивает индексы, не блокируется потерянной старой страницей", async (t) => {
  const base = await currentBase(t);
  const path = join(base.root, "storage.json");
  const { dataModelVersion: _profile, ...manifest } = await readJsonFile(path);
  await writeJsonFile(path, manifest);
  const page = await rootPage(base.root, "cards");
  await unlink(join(base.root, page));
  const inspected = await inspectStorage({ configPath: base.configPath });
  assert.equal(inspected.status, "migration-required", JSON.stringify(inspected.blockers));
  assert.ok(inspected.warnings.some((item) => item.code === "STORAGE_INDEX_STALE"));
  const result = await migrateStorage(
    { configPath: base.configPath },
    { backupDir: await tempDir(t) },
  );
  assert.equal(result.migrated, true);
  assert.equal((await inspectStorage({ configPath: base.configPath })).status, "current");
});

test("ТЗ 5.1–5.2: потерянный manifest запрещает recovery WAL, который его не создаёт", async (t) => {
  const { project, root, configPath } = await currentBase(t);
  await unlink(join(root, "storage.json"));
  const { path, original } = await pendingTaskChange(root);
  const before = await treeHashes(project);
  const inspected = await inspectStorage({ configPath });
  assert.equal(inspected.status, "invalid", JSON.stringify(inspected.blockers));
  blocked(inspected.blockers, "STORAGE_FORMAT_MISSING", "storage.json");
  assert.equal((await planStorageMigration({ configPath })).applicable, false);
  const backupDir = await tempDir(t);
  await assert.rejects(
    migrateStorage({ configPath }, { backupDir }),
    code("STORAGE_FORMAT_MISSING"),
  );
  assert.deepEqual(await readdir(backupDir), []);
  await assert.rejects(openWorkspace(project, configPath), code("STORAGE_FORMAT_MISSING"));
  assert.equal((await inspectPending(root)).kind, "operation");
  assert.deepEqual(await readJsonFile(join(root, path)), original);
  await unchanged(project, before);
});

test("ТЗ 5.1: WAL, публикующий совместимый manifest, восстанавливается без маркера на диске", async (t) => {
  const { project, root, configPath } = await currentBase(t);
  const manifest = jsonValue(await readJsonFile(join(root, "storage.json")));
  await unlink(join(root, "storage.json"));
  await writeJsonFile(join(root, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [{ path: "storage.json", before: null, after: manifest }],
  });
  await openWorkspace(project, configPath);
  assert.equal((await inspectPending(root)).kind, "none");
  assert.deepEqual(await readJsonFile(join(root, "storage.json")), manifest);
});

test("A28: обход страниц индекса учитывает посещённые страницы", async (t) => {
  const base = await currentBase(t);
  const statePath = join(base.root, ".indexes/state.json");
  const state = await readJsonFile<{ roots: Record<string, string | null> }>(statePath);
  // 14 уровней ветвей, у каждой четыре ссылки на одну следующую страницу (4^14 путей).
  const put = async (value: unknown) => {
    const hash = digest(jsonValue(value));
    const directory = join(base.root, `.indexes/segments/${hash.slice(0, 2)}`);
    await import("node:fs/promises").then((fs) => fs.mkdir(directory, { recursive: true }));
    await writeJsonFile(join(directory, `${hash}.json`), value);
    return hash;
  };
  let hash = await put({ schemaVersion: 1, type: "leaf", entries: [] });
  for (let level = 0; level < 14; level++)
    hash = await put({
      schemaVersion: 1,
      type: "branch",
      children: { a: hash, b: hash, c: hash, d: hash },
    });
  await writeJsonFile(statePath, { ...state, roots: { ...state.roots, extra: hash } });
  const started = performance.now();
  await inspectStorage({ configPath: base.configPath });
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} мс`);
});

test("A02: отсутствие состояния индексов или корня cards текущей базы — reindex, при переносе — предупреждение", async (t) => {
  for (const variant of ["state", "root"] as const) {
    const base = await currentBase(t);
    const statePath = join(base.root, ".indexes/state.json");
    if (variant === "state") await unlink(statePath);
    else {
      const state = await readJsonFile<{ roots: Record<string, string | null> }>(statePath);
      delete state.roots.cards;
      await writeJsonFile(statePath, state);
    }
    const inspected = await inspectStorage({ configPath: base.configPath });
    assert.equal(inspected.status, "invalid", `${variant}: ${JSON.stringify(inspected)}`);
    const blocker = inspected.blockers.find((item) => item.code === "STORAGE_INDEX_STALE");
    assert.ok(blocker, variant);
    assert.match(blocker.next, /storage reindex/);
    await assert.rejects(
      migrateStorage({ configPath: base.configPath }),
      code("STORAGE_INDEX_STALE"),
    );
    await new StorageService(await openWorkspace(base.project, base.configPath)).reindex();
    assert.equal(
      (await inspectStorage({ configPath: base.configPath })).status,
      "current",
      variant,
    );
  }
  // Профиль 1 без состояния индексов: перенос строит индексы, это предупреждение.
  const legacy = await planV1Format4(t);
  const status = await inspectStorage({ configPath: legacy.configPath });
  assert.equal(status.status, "migration-required", JSON.stringify(status.blockers));
});

test("R2: признак плана записи снимка соответствует planEntryIds в любом профиле", async (t) => {
  for (const profile of ["current", "profile1"] as const) {
    const base = await currentBase(t);
    if (profile === "profile1") {
      const path = join(base.root, "storage.json");
      const { dataModelVersion: _profile, ...manifest } = await readJsonFile(path);
      await writeJsonFile(path, manifest);
    }
    const directory = join(base.root, "entities/release-snapshots");
    const [name] = await readdir(directory);
    const snapshot = await readJsonFile<{ data: { planEntryIds: string[] } }>(
      join(directory, name!),
    );
    assert.ok(snapshot.data.planEntryIds.length, "в фикстуре есть записи плана");
    snapshot.data.planEntryIds = [];
    await writeJsonFile(join(directory, name!), snapshot);
    const inspected = await inspectStorage({ configPath: base.configPath });
    assert.equal(inspected.status, "invalid", `${profile}: ${JSON.stringify(inspected.blockers)}`);
    blocked(inspected.blockers, "STORAGE_REFERENCE_BROKEN");
    assert.equal((await planStorageMigration({ configPath: base.configPath })).applicable, false);
  }
});

/** Оставить единственный набор отношений с неактивными рёбрами. */
async function onlyInactiveEdges(root: string) {
  const { rm } = await import("node:fs/promises");
  let kept = false;
  for (const collection of await readdir(join(root, "relations"))) {
    const directory = join(root, "relations", collection);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (!kept && name.endsWith(".json")) {
        const set = await readJsonFile<{
          storage: string;
          entries: { edge: { active: boolean } }[];
        }>(path);
        if (set.storage === "inline" && set.entries.length) {
          for (const entry of set.entries) entry.edge.active = false;
          await writeJsonFile(path, set);
          kept = true;
          continue;
        }
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  assert.ok(kept);
}

test("A02: база только с неактивными рёбрами — current после reindex и после переноса", async (t) => {
  const current = await currentBase(t);
  await onlyInactiveEdges(current.root);
  // Индексы производны: без них reindex строит их из оставшихся источников.
  const { rm } = await import("node:fs/promises");
  await rm(join(current.root, ".indexes"), { recursive: true, force: true });
  await new StorageService(await openWorkspace(current.project, current.configPath)).reindex();
  const state = await readJsonFile<{ roots: Record<string, string | null> }>(
    join(current.root, ".indexes/state.json"),
  );
  assert.equal(state.roots.adjacency ?? null, null, "построитель не создаёт adjacency");
  const status = await inspectStorage({ configPath: current.configPath });
  assert.equal(status.status, "current", JSON.stringify(status.blockers));

  const legacy = await planV1Format4(t);
  await onlyInactiveEdges(legacy.root);
  await migrateStorage({ configPath: legacy.configPath }, { backupDir: await tempDir(t) });
  const migrated = await inspectStorage({ configPath: legacy.configPath });
  assert.equal(migrated.status, "current", JSON.stringify(migrated.blockers));
});

test("A28/A02: страница на двух позициях дерева индекса — не passed", async (t) => {
  const base = await currentBase(t);
  const statePath = join(base.root, ".indexes/state.json");
  const state = await readJsonFile<{ roots: Record<string, string | null> }>(statePath);
  const { mkdir } = await import("node:fs/promises");
  const put = async (value: unknown) => {
    const hash = digest(jsonValue(value));
    const directory = join(base.root, `.indexes/segments/${hash.slice(0, 2)}`);
    await mkdir(directory, { recursive: true });
    await writeJsonFile(join(directory, `${hash}.json`), value);
    return hash;
  };
  // Настоящий лист cards под всеми 16 позициями ветви.
  const cardsRoot = state.roots.cards!;
  const leaf = await readJsonFile<{ type: string }>(
    join(base.root, `.indexes/segments/${cardsRoot.slice(0, 2)}/${cardsRoot}.json`),
  );
  assert.equal(leaf.type, "leaf", "в небольшой базе корень cards — лист");
  const children = Object.fromEntries([..."0123456789abcdef"].map((nibble) => [nibble, cardsRoot]));
  const branch = await put({ schemaVersion: 1, type: "branch", children });
  await writeJsonFile(statePath, { ...state, roots: { ...state.roots, cards: branch } });
  const inspected = await inspectStorage({ configPath: base.configPath });
  assert.equal(inspected.status, "invalid", JSON.stringify(inspected.blockers));
  const blocker = inspected.blockers.find((item) => item.code === "STORAGE_INDEX_STALE");
  assert.ok(blocker, JSON.stringify(inspected.blockers));
  assert.match(blocker.next, /storage reindex/);
  await assert.rejects(
    migrateStorage({ configPath: base.configPath }),
    code("STORAGE_INDEX_STALE"),
  );
});
