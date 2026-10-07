import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { storageStatusSchema } from "@relay/contracts/storage-maintenance";
import { configSchema } from "../src/domain/config.js";
import { AppError } from "../src/shared/errors.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import {
  diagnoseStorageSource,
  inspectStorageSource,
  readStorageSource,
  resolveSourceTarget,
} from "../src/storage/data-model/source/reader.js";
import {
  maintenanceLockFiles,
  withMaintenanceLock,
} from "../src/storage/data-model/source/maintenance-lock.js";
import { fingerprintFiles, planFingerprint } from "../src/storage/data-model/plan/fingerprint.js";
import { syntheticRegistry } from "./helpers/synthetic-data-model.js";
import {
  copyBase,
  frozenBase,
  legacyBase,
  readJsonFile,
  setManifest,
  temporaryDirectory,
  treeHashes,
  unifiedBase,
  writeJsonFile,
} from "./helpers/source-fixtures.js";

const registry = productionTransitionRegistry();
const inspect = (path: string) => inspectStorageSource(path, { registry, lock: { retries: 0 } });
const codes = (status: { blockers: { code: string }[] }) => status.blockers.map((b) => b.code);
const fingerprintOf = async (path: string) => {
  const { source, diagnosis } = await inspect(path);
  const steps = diagnosis.steps
    ? [...(diagnosis.steps.physical ? [diagnosis.steps.physical] : []), ...diagnosis.steps.data]
    : [];
  return planFingerprint(source, registry, steps);
};

test("A13: status текущей базы не меняет ни одного байта и не оставляет следов замка", async (t) => {
  const { project, root } = await unifiedBase(t);
  const before = await treeHashes(project);
  const { source, diagnosis } = await inspect(join(root, "config.json"));
  assert.deepEqual(await treeHashes(project), before);
  const status = storageStatusSchema.parse(diagnosis.status);
  assert.equal(status.status, "current");
  assert.equal(status.layout, "unified-4");
  assert.equal(status.current.physical, 4);
  assert.equal(status.current.dataModel, 2);
  assert.deepEqual(status.current.envelope, [3]);
  assert.equal(status.current.owners.project?.versions["1"]?.live, 1);
  assert.equal(status.current.owners.board?.versions["1"]?.live, 2);
  assert.equal(status.pending, null);
  assert.deepEqual(status.blockers, []);
  assert.deepEqual(diagnosis.steps, { physical: null, data: [], marker: false });
  // Полная инвентаризация: каждый постоянный файл с размером и sha256.
  const files = source.entries.filter((entry) => entry.type === "file" && entry.persistent);
  assert.ok(files.length >= 10);
  for (const entry of files) {
    const bytes = await readFile(join(root, entry.path));
    assert.equal(entry.size, bytes.byteLength, entry.path);
    assert.match(entry.sha256!, /^[a-f0-9]{64}$/);
  }
  const category = (path: string) => source.entries.find((entry) => entry.path === path)?.category;
  assert.equal(category("storage.json"), "manifest");
  assert.equal(category("config.json"), "config");
  assert.equal(category(".indexes/state.json"), "indexes");
  assert.equal(category("relations/products/passport.json"), "relations");
  assert.ok(source.entries.some((entry) => entry.category === "keyspaces"));
  assert.equal(
    source.entries.find((entry) => entry.path === "entities/products/passport.json")?.owner,
    "product",
  );
  // present пригоден для registry.plan.
  assert.deepEqual(registry.plan(source.present), []);
});

test("A13: профиль 1 и legacy — диагностика без создания runtime, storageDir и индексов", async (t) => {
  const { project, root } = await unifiedBase(t);
  await setManifest(root, { dataModelVersion: undefined });
  await rm(join(root, "runtime"), { recursive: true });
  const before = await treeHashes(project);
  const { diagnosis } = await inspect(root);
  assert.deepEqual(await treeHashes(project), before, "временный runtime и замок удалены");
  assert.equal(diagnosis.status.status, "migration-required");
  assert.equal(diagnosis.status.current.dataModel, null);
  assert.deepEqual(diagnosis.steps, { physical: null, data: [], marker: true });

  const legacy = await legacyBase(t);
  const legacyBefore = await treeHashes(legacy.project);
  const result = await inspect(join(legacy.root, "config.json"));
  assert.deepEqual(await treeHashes(legacy.project), legacyBefore, "tasks и runtime не созданы");
  assert.equal(result.source.layout, "legacy");
  assert.equal(result.diagnosis.status.layout, "legacy");
  assert.equal(result.diagnosis.status.project.id, "Legacy01");
  assert.ok(
    result.source.entries.some(
      (entry) => entry.path === "boards/product/board.json" && entry.category === "legacy-source",
    ),
  );
  // Физический legacy-переход регистрирует отдельный пакет; до него — различимый отказ.
  if (!registry.physicalFrom("legacy")) {
    assert.equal(result.diagnosis.status.status, "unsupported");
    assert.deepEqual(codes(result.diagnosis.status), ["STORAGE_TRANSITION_MISSING"]);
  } else assert.equal(result.diagnosis.status.status, "migration-required");
});

test("A13: замороженные исторические базы legacy/1/2/3/4 распознаются без изменения байтов", async (t) => {
  const expected = [
    ["legacy-5c7265b", "legacy", null, []],
    ["legacy-c1c353f", "legacy", null, []],
    ["physical1-90d7b26", "unified-1", 1, [1]],
    ["physical2-v0.6.1-ec4a2cc", "unified-2", 2, [1]],
    ["physical2-plan-v1-43d683b", "unified-2", 2, [1]],
    ["physical3-3875aee", "unified-3", 3, [2]],
    ["physical4-v0.7.0-52c4609", "unified-4", 4, [3]],
  ] as const;
  for (const [name, layout, physical, envelope] of expected) {
    const { project, root } = await frozenBase(t, name);
    const before = await treeHashes(project);
    const { source, diagnosis } = await inspect(join(root, "config.json"));
    assert.deepEqual(await treeHashes(project), before, name);
    const status = diagnosis.status;
    assert.equal(status.layout, layout, name);
    assert.equal(status.current.physical, physical, name);
    assert.equal(status.current.dataModel, null, name);
    assert.deepEqual(status.current.envelope, envelope, name);
    assert.ok(status.project.id, name);
    // Повреждений и неизвестных файлов в корректных исторических базах нет.
    const damage = status.blockers.filter(
      (blocker) => !["STORAGE_TRANSITION_MISSING"].includes(blocker.code),
    );
    assert.deepEqual(damage, [], name);
    assert.ok(!source.entries.some((entry) => entry.category === "unknown"), name);
    if (layout !== "legacy") {
      assert.ok((status.current.owners.task?.versions["1"]?.tombstones ?? 0) >= 1, name);
      assert.ok(!status.warnings.some((warning) => warning.code === "STORAGE_INDEX_STALE"), name);
    }
    if (status.blockers.length) assert.equal(status.status, "unsupported", name);
    else assert.equal(status.status, "migration-required", name);
  }
  // Исторический план v1: виды и версии, которых нет в текущем реестре хранения, учтены.
  const plan = await frozenBase(t, "physical2-plan-v1-43d683b");
  const { source } = await inspect(plan.root);
  assert.deepEqual([...(source.present.get("work-plan") ?? [])], [1]);
  assert.ok(source.present.has("plan-stage"));
  assert.ok(source.present.has("release-snapshot-entry"));
});

test("A14: историческая конфигурация иного имени читается, неизвестное поле — invalid, точный выбор проекта", async (t) => {
  const first = await unifiedBase(t);
  const second = await unifiedBase(t);
  const config = await readJsonFile(join(first.root, "config.json"));
  // Исторические формы (git log -p src/domain/config.ts, packages/core/src/domain/config.ts):
  // схема 1efc794 без mode/server/mcp/цветов статусов и встроенный аудит настроек проекта
  // bf95518…1afe138 (projectSettings.requests/events). Схема только расширялась, а аудит
  // настроек текущая схема принимает — отдельного перехода конфигурации не требуется.
  const settings = (config.projectSettings ?? {
    name: "Проект",
    slug: "project",
    revision: 1,
    version: 2,
  }) as Record<string, unknown>;
  const old = {
    version: 1,
    projectId: config.projectId,
    storageDir: config.storageDir,
    defaultStatus: "todo",
    readyStatuses: ["todo"],
    statuses: {
      todo: { terminal: false, satisfiesDependencies: false },
      done: { terminal: true, satisfiesDependencies: true },
    },
    output: { format: "text", defaultLimit: 20, maxBytes: 16384 },
    projectSettings: {
      ...settings,
      requests: { r1: { hash: "h", result: { id: "p", key: "PRJ", revision: 1 } } },
      events: [{ revision: 1, actor: "agent", at: "2026-09-20T00:00:00.000Z", action: "create" }],
    },
  };
  await unlink(join(first.root, "config.json"));
  await writeJsonFile(join(first.root, "project-a.json"), old);
  assert.equal(configSchema.safeParse(old).success, true, "историческая форма читается");

  const target = await resolveSourceTarget(join(first.root, "project-a.json"));
  assert.equal(target.configPath, join(first.root, "project-a.json"));
  assert.equal(target.config?.projectId, config.projectId);
  const { source, diagnosis } = await inspect(join(first.root, "project-a.json"));
  assert.equal(diagnosis.status.project.id, config.projectId);
  assert.equal(diagnosis.status.project.configPath, join(first.root, "project-a.json"));
  assert.equal(diagnosis.status.project.root, first.root);
  assert.equal(source.entries.find((entry) => entry.path === "project-a.json")?.category, "config");
  assert.equal(diagnosis.status.status, "current", JSON.stringify(diagnosis.blockers));
  // Поле, которого не было ни в одной исторической форме, — повреждение.
  await writeJsonFile(join(first.root, "project-a.json"), {
    ...config,
    history: { enabled: true },
  });
  const unknownField = await inspect(join(first.root, "project-a.json"));
  assert.equal(unknownField.diagnosis.status.status, "invalid");
  assert.deepEqual(
    unknownField.diagnosis.status.blockers.map((blocker) => [blocker.code, blocker.path]),
    [["STORAGE_DATA_CORRUPT", "project-a.json"]],
  );
  await writeJsonFile(join(first.root, "project-a.json"), old);

  const other = await inspect(second.root);
  assert.notEqual(other.diagnosis.status.project.id, config.projectId);
  assert.equal(other.diagnosis.status.project.root, second.root);
  assert.equal(other.diagnosis.status.project.configPath, join(second.root, "config.json"));

  // У базы есть маркер: отсутствие выбранного файла конфигурации — блокер, а не выбор чужого.
  const missing = await inspect(join(first.root, "missing.json"));
  assert.equal(missing.diagnosis.status.status, "invalid");
  assert.deepEqual(codes(missing.diagnosis.status), ["STORAGE_RECORD_MISSING"]);
  assert.equal(missing.diagnosis.status.project.id, null);
  const empty = await temporaryDirectory(t);
  await assert.rejects(inspect(join(empty, "config.json")), { code: "CONFIG_NOT_FOUND" });
});

test("A16: потеря записи, повреждённый JSON и UTF-8 — блокеры с путём без пользовательского текста", async (t) => {
  const { root } = await unifiedBase(t);
  const secret = "секретный-текст-пользователя";
  const board = (await inspect(root)).source.entries.find((entry) =>
    entry.path.startsWith("entities/boards/"),
  )!.path;
  await unlink(join(root, board));
  await writeFile(join(root, "entities/products/passport.json"), `{"broken": "${secret}"`);
  const keyspace = (await inspect(root)).source.entries.find((entry) =>
    entry.path.startsWith("keyspaces/"),
  )!.path;
  await writeFile(join(root, keyspace), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
  const before = await treeHashes(root);
  const { diagnosis } = await inspect(root);
  assert.deepEqual(await treeHashes(root), before);
  const status = diagnosis.status;
  assert.equal(status.status, "invalid");
  const byPath = new Map(status.blockers.map((blocker) => [blocker.path, blocker.code]));
  assert.equal(byPath.get(board), "STORAGE_RECORD_MISSING");
  assert.equal(byPath.get("entities/products/passport.json"), "STORAGE_DATA_CORRUPT");
  assert.equal(byPath.get(keyspace), "STORAGE_DATA_CORRUPT");
  assert.ok(!JSON.stringify(status).includes(secret));
  for (const blocker of status.blockers) assert.ok(blocker.next.length > 0);
});

test("A16: неизвестный файл в управляемой области блокирует, посторонний вне её сохраняется", async (t) => {
  const { root } = await unifiedBase(t);
  await writeFile(join(root, "entities/boards/notes.txt"), "заметка");
  await writeJsonFile(join(root, "entities/widgets/w1.json"), { kind: "widget" });
  await writeFile(join(root, "README.md"), "посторонний файл пользователя");
  await mkdir(join(root, "attachments"));
  await writeFile(join(root, "attachments/image.bin"), Buffer.from([1, 2, 3]));
  const before = await treeHashes(root);
  const { source, diagnosis } = await inspect(root);
  assert.deepEqual(await treeHashes(root), before, "посторонние файлы не тронуты");
  assert.equal(diagnosis.status.status, "unsupported");
  const byPath = new Map(diagnosis.status.blockers.map((blocker) => [blocker.path, blocker.code]));
  assert.equal(byPath.get("entities/boards/notes.txt"), "STORAGE_FORMAT_UNKNOWN");
  assert.equal(byPath.get("entities/widgets/w1.json"), "UNKNOWN_ENTITY_KIND");
  assert.ok(!byPath.has("README.md"));
  const warned = new Set(diagnosis.status.warnings.map((warning) => warning.path));
  assert.ok(warned.has("README.md") && warned.has("attachments"));
  const readme = source.entries.find((entry) => entry.path === "README.md")!;
  assert.equal(readme.category, "outside");
  assert.equal(readme.managed, false);
  // Посторонний каталог раскрывается: его файлы входят в отпечаток и резервную копию.
  const image = source.entries.find((entry) => entry.path === "attachments/image.bin");
  assert.ok(image && image.managed === false && image.persistent && image.sha256);
});

test("раскладки: unified 1/2/3, будущий формат и профиль, потерянный маркер", async (t) => {
  const { root } = await unifiedBase(t);
  const variant = async (
    patch: Record<string, unknown>,
    extra?: (root: string) => Promise<void>,
  ) => {
    const copy = await copyBase(t, root);
    await setManifest(copy, patch);
    await extra?.(copy);
    return (await inspect(copy)).diagnosis.status;
  };
  const v1 = await variant({ schemaVersion: 1, dataModelVersion: undefined }, (copy) =>
    writeJsonFile(join(copy, "operations/00000000-0000-4000-8000-000000000001.json"), {}),
  );
  assert.equal(v1.layout, "unified-1");
  assert.equal(v1.current.physical, 1);
  const v2 = await variant({ schemaVersion: 2, dataModelVersion: undefined }, (copy) =>
    writeJsonFile(
      join(copy, "history/00000000-0000-4000-8000-000000000001/0000000000000001.json"),
      {},
    ),
  );
  assert.equal(v2.layout, "unified-2");
  const v3 = await variant({ schemaVersion: 3, dataModelVersion: undefined });
  assert.equal(v3.layout, "unified-3");
  for (const status of [v1, v2, v3])
    if (!registry.physicalFrom(status.layout!)) {
      assert.equal(status.status, "unsupported");
      assert.ok(codes(status).includes("STORAGE_TRANSITION_MISSING"));
    }
  // Журнал прежней версии в чужом формате — неизвестный файл управляемой области.
  const misplaced = await variant({}, (copy) =>
    writeJsonFile(join(copy, "operations/00000000-0000-4000-8000-000000000001.json"), {}),
  );
  assert.deepEqual(codes(misplaced), ["STORAGE_FORMAT_UNKNOWN"]);

  const future = await variant({ schemaVersion: 5 });
  assert.equal(future.status, "unsupported");
  assert.equal(future.layout, null);
  assert.equal(future.current.physical, 5);
  assert.deepEqual(codes(future), ["STORAGE_VERSION_UNSUPPORTED"]);
  const newer = await variant({ dataModelVersion: 3 });
  assert.equal(newer.status, "unsupported");
  assert.equal(newer.current.dataModel, 3);
  assert.deepEqual(codes(newer), ["STORAGE_VERSION_UNSUPPORTED"]);

  const lost = await copyBase(t, root);
  await unlink(join(lost, "storage.json"));
  const missing = (await inspect(lost)).diagnosis.status;
  assert.equal(missing.status, "invalid");
  assert.deepEqual(codes(missing), ["STORAGE_FORMAT_MISSING"]);
});

test("recovery-required при любом WAL; диагностика не выполняет recovery", async (t) => {
  const { root } = await unifiedBase(t);
  const operation = await copyBase(t, root);
  await writeJsonFile(join(operation, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [{ path: "entities/boards/x.json", before: null, after: { a: 1 } }],
  });
  const before = await treeHashes(operation);
  const status = (await inspect(operation)).diagnosis.status;
  assert.deepEqual(await treeHashes(operation), before, "WAL не применён и не удалён");
  assert.equal(status.status, "recovery-required");
  assert.deepEqual(status.pending, { kind: "operation", path: "transactions/pending.json" });

  const migration = await copyBase(t, root);
  await writeJsonFile(join(migration, "transactions/pending.json"), {
    schemaVersion: 2,
    migration: { report: {} },
    changes: [],
  });
  assert.equal((await inspect(migration)).diagnosis.status.pending?.kind, "migration");

  const unknown = await copyBase(t, root);
  await writeJsonFile(join(unknown, "transactions/pending.json"), { schemaVersion: 9 });
  const unknownStatus = (await inspect(unknown)).diagnosis.status;
  assert.equal(unknownStatus.status, "unsupported");
  assert.equal(unknownStatus.pending?.kind, "unknown");

  const legacy = await legacyBase(t);
  await writeJsonFile(join(legacy.root, "kanban-pending.json"), { changes: [] });
  const legacyStatus = (await inspect(legacy.root)).diagnosis.status;
  assert.equal(legacyStatus.status, "recovery-required");
  assert.deepEqual(legacyStatus.pending, { kind: "legacy", path: "kanban-pending.json" });

  // Конфига и маркера нет, WAL публикует маркер (инициализация): статус строится,
  // recovery не выполняется.
  const orphan = await copyBase(t, root);
  const manifest = await readJsonFile(join(orphan, "storage.json"));
  await unlink(join(orphan, "config.json"));
  await unlink(join(orphan, "storage.json"));
  await writeJsonFile(join(orphan, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [{ path: "storage.json", before: null, after: manifest }],
  });
  const orphanStatus = (await inspect(join(orphan, "config.json"))).diagnosis.status;
  assert.equal(orphanStatus.status, "recovery-required");
  assert.equal(orphanStatus.layout, null);
  // WAL без маркера при потерянном storage.json восстановить нельзя: совместимость не подтверждена.
  const markerless = await copyBase(t, root);
  await unlink(join(markerless, "storage.json"));
  await writeJsonFile(join(markerless, "transactions/pending.json"), {
    schemaVersion: 1,
    changes: [],
  });
  const markerlessStatus = (await inspect(markerless)).diagnosis.status;
  assert.equal(markerlessStatus.status, "invalid");
  assert.equal(markerlessStatus.blockers[0]?.code, "STORAGE_FORMAT_MISSING");
});

test("A17: правка, добавление и удаление источника и смена реестра меняют planFingerprint", async (t) => {
  const { root } = await unifiedBase(t);
  const base = await fingerprintOf(root);
  assert.equal(await fingerprintOf(root), base, "повторная диагностика детерминирована");
  const moved = await copyBase(t, root);
  assert.equal(await fingerprintOf(moved), base, "абсолютный путь не входит в отпечаток");

  const record = "entities/products/passport.json";
  await appendFile(join(root, record), " ");
  const edited = await fingerprintOf(root);
  assert.notEqual(edited, base);
  await writeJsonFile(join(root, "keyspaces/extra.json"), { schemaVersion: 1 });
  const added = await fingerprintOf(root);
  assert.notEqual(added, edited);
  await unlink(join(root, "keyspaces/extra.json"));
  assert.equal(await fingerprintOf(root), edited, "состав вернулся — отпечаток тоже");
  const keyspace = (await inspect(root)).source.entries.find((entry) =>
    entry.path.startsWith("keyspaces/"),
  )!;
  await unlink(join(root, keyspace.path));
  assert.notEqual(await fingerprintOf(root), edited);
  const { source } = await inspect(moved);
  // Состав каталогов управляемой области тоже входит в отпечаток.
  await mkdir(join(moved, "relations/boards"), { recursive: true });
  const { source: withDirectory } = await inspect(moved);
  assert.notEqual(
    planFingerprint(withDirectory, registry, []),
    planFingerprint(source, registry, []),
  );
  await rm(join(moved, "relations/boards"), { recursive: true });
  await writeFile(join(moved, "outside.txt"), "x");
  const { source: withOutside } = await inspect(moved);
  assert.notEqual(
    planFingerprint(withOutside, registry, []),
    planFingerprint(source, registry, []),
  );
  assert.ok(fingerprintFiles(withOutside).some(([key]) => key === "config-root:outside.txt"));
  assert.ok(!fingerprintFiles(source).some(([key]) => key.includes("runtime")));

  const other = syntheticRegistry(13);
  assert.notEqual(other.digest, registry.digest);
  assert.notEqual(
    planFingerprint(source, { digest: other.digest, profile: registry.profile }, []),
    planFingerprint(source, registry, []),
  );
  assert.notEqual(
    planFingerprint(source, registry, [{ id: "step", version: 1 }]),
    planFingerprint(source, registry, [{ id: "step", version: 2 }]),
  );
});

test("замок: symlink-путь и writer дают STORAGE_BUSY; без замка чтения нет", async (t) => {
  const { project, root } = await unifiedBase(t);
  const alias = join(await temporaryDirectory(t), "alias");
  await symlink(root, alias);
  assert.deepEqual(
    (await maintenanceLockFiles({ root: alias })).map((file) => file.lockfilePath),
    (await maintenanceLockFiles({ root })).map((file) => file.lockfilePath),
  );
  await withMaintenanceLock({ root }, async (owned) => {
    owned();
    await assert.rejects(inspect(join(alias, "config.json")), { code: "STORAGE_BUSY" });
  });
  const release = await lockfile.lock(root, {
    lockfilePath: join(root, "runtime/write.lock"),
    realpath: false,
  });
  try {
    await assert.rejects(inspect(root), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "STORAGE_BUSY");
      assert.equal(error.exitCode, 4);
      return true;
    });
  } finally {
    await release();
  }
  // legacy storageDir внутри .relay использует тот же runtime: один замок, без самоблокировки.
  const legacy = await legacyBase(t);
  const files = await maintenanceLockFiles({
    root: legacy.root,
    storageRoot: join(legacy.root, "tasks"),
  });
  assert.equal(files.length, 1);

  // Нельзя создать runtime без записи в каталог базы — диагностика, не чтение без замка.
  await rm(join(root, "runtime"), { recursive: true });
  const before = await treeHashes(project);
  await chmod(root, 0o555);
  t.after(() => chmod(root, 0o755).catch(() => {}));
  let called = false;
  await assert.rejects(
    withMaintenanceLock({ root }, async () => {
      called = true;
    }),
    { code: "STORAGE_BUSY" },
  );
  assert.equal(called, false);
  await chmod(root, 0o755);
  assert.deepEqual(await treeHashes(project), before);
});

test("diagnose: версия записи новее целевой — unsupported без плана", async (t) => {
  const { root } = await unifiedBase(t);
  const source = await readStorageSource(await resolveSourceTarget(root), { registry });
  const project = source.records.find((record) => record.kind === "project")!;
  // Версия выше целевой: различимый отказ «новее поддерживаемой», без чтения данных.
  const newer = diagnoseStorageSource(
    {
      ...source,
      present: new Map([["project", new Set([project.dataVersion + 1])]]),
    },
    registry,
  );
  assert.equal(newer.status.status, "unsupported");
  assert.deepEqual(codes(newer.status), ["STORAGE_VERSION_UNSUPPORTED"]);
  assert.equal(newer.steps, null);
});

test("legacy: storageDir вне каталога конфигурации — отдельная область и замок legacy-writers", async (t) => {
  const { project, root } = await legacyBase(t);
  const config = await readJsonFile(join(root, "config.json"));
  await writeJsonFile(join(root, "config.json"), { ...config, storageDir: "../data" });
  await writeJsonFile(join(project, "data/item.json"), { id: "x" });
  const before = await treeHashes(project);
  const files = await maintenanceLockFiles({ root, storageRoot: join(project, "data") });
  assert.deepEqual(
    files.map((file) => file.lockfilePath),
    [join(project, ".data-runtime/write.lock"), join(root, "runtime/write.lock")],
  );
  const { source, diagnosis } = await inspect(join(root, "config.json"));
  assert.deepEqual(await treeHashes(project), before, "оба временных runtime удалены");
  assert.equal(diagnosis.status.project.storageRoot, join(project, "data"));
  const item = source.entries.find(
    (entry) => entry.area === "storage-root" && entry.path === "item.json",
  );
  assert.equal(item?.category, "legacy-source");
  assert.ok(fingerprintFiles(source).some(([key]) => key === "storage-root:item.json"));
});
