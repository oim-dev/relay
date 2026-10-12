import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { storageErrorDetailsSchema } from "@relay/contracts/storage-maintenance";
import { EntityStore, withStorageLocks } from "../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import type { EntityCodec, EntityRecord } from "../src/storage/entity-store/registry.js";
import { markdownCodec } from "../src/storage/entity-store/codecs.js";
import { StorageTransaction, inspectPending } from "../src/storage/entity-store/transaction.js";
import type {
  MigrationIntent,
  TransactionProbe,
  TransactionStage,
} from "../src/storage/entity-store/transaction.js";
import { currentManifest } from "../src/storage/data-model/manifest.js";
import { jsonValue } from "../src/storage/entity-store/format.js";
import { initialize, openWorkspace, readWorkspaceConfig } from "../src/storage/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { AppError } from "../src/shared/errors.js";

const at = "2026-10-01T10:00:00.000Z";
const note: EntityCodec = {
  kind: "note",
  collection: "notes",
  dataVersion: 1,
  schema: z.strictObject({ title: z.string(), body: z.string() }),
  ...markdownCodec([["body"]]),
  card: (record) => ({ title: String(record.data.title), status: "", selectors: [] }),
};
/** Запись совместимости прежнего адреса: содержание перенесено в note. */
const stage: EntityCodec = {
  kind: "stage",
  collection: "stages",
  dataVersion: 1,
  schema: z.strictObject({ noteId: z.string() }),
  encode: (data) => data as Record<string, string>,
  decode: (data) => data,
  relocation: (record) => ({
    ref: { kind: "note", id: String(record.data.noteId) },
    stageId: record.id,
  }),
  card: (record) => ({
    title: record.key ?? record.id,
    status: "relocated",
    selectors: [],
    active: false,
  }),
};
const registry = () => new EntityStorageRegistry([note, stage]);
const noteRecord = (id: string, revision = 1, title = `Заметка ${id}`): EntityRecord => ({
  schemaVersion: 3,
  dataVersion: 1,
  kind: "note",
  id,
  revision,
  key: `NOTE-${id.toUpperCase()}`,
  aliases: [],
  createdAt: at,
  createdBy: "agent",
  updatedAt: at,
  updatedBy: "agent",
  data: { title, body: "## Текст\n\n  отступ  \r\n" },
});
const stageRecord = (id: string, noteId: string, key: string): EntityRecord => ({
  schemaVersion: 3,
  dataVersion: 1,
  kind: "stage",
  id,
  revision: 1,
  key,
  aliases: [],
  createdAt: at,
  createdBy: "agent",
  updatedAt: at,
  updatedBy: "agent",
  data: { noteId },
});
const command = (requestId: string) => ({
  namespace: "test",
  actor: "agent",
  requestId,
  request: requestId,
});

async function files(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      for (const [key, value] of await files(root, path)) result.set(key, value);
    else result.set(path, await readFile(join(root, path), "utf8"));
  }
  return result;
}
const persistent = (map: Map<string, string>) =>
  new Map([...map].filter(([path]) => !path.startsWith("runtime/")));
const manifestOf = async (root: string) =>
  JSON.parse(await readFile(join(root, "storage.json"), "utf8")) as Record<string, unknown>;
async function setManifest(root: string, value: Record<string, unknown>) {
  await writeFile(join(root, "storage.json"), JSON.stringify(value));
}
/** Ошибка с кодом, exit code и details по общей схеме Contracts. */
function storageFailure(code: string, exitCode: number, details: Record<string, unknown> = {}) {
  return (error: unknown) => {
    assert(error instanceof AppError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    const parsed = storageErrorDetailsSchema.parse(error.details);
    for (const [key, value] of Object.entries(details))
      assert.deepEqual(parsed[key as keyof typeof parsed], value, key);
    return true;
  };
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-data-model-open-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, ".relay");
  const store = await EntityStore.create(root, registry());
  await store.run(command("seed"), async (tx) => {
    await tx.put(noteRecord("a"), null);
    await tx.put(noteRecord("b"), null);
    return null;
  });
  return { directory, root: store.root, store };
}

function migrationIntent(backup: string): MigrationIntent {
  return {
    id: randomUUID(),
    registryDigest: "a".repeat(64),
    planFingerprint: "b".repeat(64),
    source: { layout: "unified-4", physical: 4, profile: 1 },
    target: { profile: 2 },
    transitions: ["profile-marker@1"],
    backup: { path: backup, manifestSha256: "c".repeat(64) },
    // Итог плана пишет каждый выпущенный исполнитель; WAL без него — предварительная сборка.
    report: {
      entities: 0,
      steps: [],
      counts: { checked: 0, changed: 0, removedByRule: 0, owners: {} },
    },
  };
}

/** Профиль 1 → 2 с изменением записи: подготовка вне публикации, публикация WAL v2. */
async function prepareMigration(root: string) {
  const { productId: _productId, dataModelVersion: _profile, ...legacy } = await manifestOf(root);
  await setManifest(root, legacy);
  const detached = await EntityStore.detached(root, registry());
  const live = await EntityStore.open(root, registry());
  const session = detached.session(await live.state());
  await session.put(noteRecord("a", 2, "Перенесённая заметка"), 1);
  await session.importRecord(stageRecord("s1", "a", "STG-1"));
  await session.writeFile("storage.json", jsonValue(currentManifest()));
  return session.prepare("migration-fixed-version");
}

async function publishMigration(
  root: string,
  probe?: TransactionProbe,
  verify: (intent: MigrationIntent) => Promise<void> = async () => {},
) {
  const changes = await prepareMigration(root);
  const intent = migrationIntent(join(dirname(root), "backup"));
  await withStorageLocks({ root }, (owned) =>
    new StorageTransaction(root, probe).publish(changes, owned, {
      migration: { intent, verify },
    }),
  );
  return intent;
}

test("новая база: manifest текущего профиля; EntityStore.create пишет dataModelVersion", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await manifestOf(root), {
    format: "relay-entities",
    schemaVersion: 4,
    dataModelVersion: 2,
  });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-data-model-init-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await initialize(directory, "tasks");
  assert.equal((await manifestOf(dirname(workspace.configPath))).dataModelVersion, 2);
});

test("профиль 1 и устаревший формат: предметная работа отказывает без изменения файлов", async (t) => {
  const { root, store } = await fixture(t);
  const { dataModelVersion: _profile, ...profile1 } = await manifestOf(root);
  await setManifest(root, profile1);
  const before = persistent(await files(root));
  const required = storageFailure("STORAGE_MIGRATION_REQUIRED", 4, {
    reason: "profile",
    current: 1,
    expected: 2,
    path: "storage.json",
  });
  await assert.rejects(store.get({ kind: "note", id: "a" }), required);
  await assert.rejects(
    store.run(command("blocked"), async (tx) => {
      await tx.put(noteRecord("c"), null);
      return null;
    }),
    required,
  );
  await assert.rejects(store.reindex(), required);
  // Открытие для явного обслуживания возможно: физический storage migrate проходит этим путём.
  const reopened = await EntityStore.open(root, registry());
  assert.equal(reopened.compatible, false);
  await assert.rejects(reopened.resolve("NOTE-A"), required);
  await setManifest(root, { format: "relay-entities", schemaVersion: 3 });
  await assert.rejects(
    store.get({ kind: "note", id: "a" }),
    storageFailure("STORAGE_MIGRATION_REQUIRED", 4, { reason: "physical", current: 3 }),
  );
  await setManifest(root, profile1);
  assert.deepEqual(persistent(await files(root)), before);
});

test("профиль новее поддерживаемого: отказ при открытии и чтении конфигурации", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-data-model-future-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await initialize(directory, "tasks");
  const root = dirname(workspace.configPath);
  await setManifest(root, { ...(await manifestOf(root)), dataModelVersion: 3 });
  const before = await files(root);
  const unsupported = storageFailure("STORAGE_VERSION_UNSUPPORTED", 4, {
    reason: "profile",
    current: 3,
    expected: 2,
  });
  await assert.rejects(readWorkspaceConfig(directory), unsupported);
  await assert.rejects(openWorkspace(directory), unsupported);
  await assert.rejects(EntityStore.open(root, registry()), unsupported);
  await assert.rejects(
    new BoardTasksService(workspace).create({ board: "product", requestId: "x" }, "agent"),
    unsupported,
  );
  assert.deepEqual(await files(root), before);
});

test("долгоживущий процесс перепроверяет профиль при каждом захвате замка", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-data-model-live-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory, "tasks");
  const workspace = await openWorkspace(directory);
  const root = dirname(workspace.configPath);
  const tasks = new BoardTasksService(workspace);
  await tasks.create({ board: "product", requestId: "first" }, "agent");
  const current = await manifestOf(root);
  const { dataModelVersion: _profile, ...profile1 } = current;
  await setManifest(root, profile1);
  const before = persistent(await files(root));
  await assert.rejects(
    tasks.create({ board: "product", requestId: "second" }, "agent"),
    storageFailure("STORAGE_MIGRATION_REQUIRED", 4, { reason: "profile" }),
  );
  // Watcher-путь: внешняя проверка не пишет index-stale при несовместимом профиле.
  assert.deepEqual(persistent(await files(root)), before);
  assert.equal(before.has("runtime/index-stale.json"), false);
  await setManifest(root, current);
  await tasks.create({ board: "product", requestId: "third" }, "agent");
});

test("WAL v2: обычный recovery не допубликовывает миграцию и отвечает RECOVERY_REQUIRED", async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(
    publishMigration(root, (stage) => {
      if (stage === "intent") throw new Error("Остановка после intent");
    }),
    /Остановка после intent/,
  );
  const pending = await inspectPending(root);
  assert.equal(pending.kind, "migration");
  const before = await files(root);
  const required = storageFailure("STORAGE_RECOVERY_REQUIRED", 4, {
    reason: "migration",
    path: "transactions/pending.json",
  });
  await assert.rejects(store.get({ kind: "note", id: "a" }), required);
  await assert.rejects(EntityStore.open(root, registry()), required);
  await assert.rejects(
    withStorageLocks({ root }, (owned) => new StorageTransaction(root).recover(owned)),
    required,
  );
  await assert.rejects(
    withStorageLocks({ root }, (owned) =>
      new StorageTransaction(root).publish([{ path: "keyspaces/x.json", after: {} }], owned),
    ),
    required,
  );
  assert.deepEqual(await files(root), before);
  // Проверка исполнителя (backup) не прошла: WAL и файлы сохраняются.
  await assert.rejects(
    withStorageLocks({ root }, (owned) =>
      new StorageTransaction(root).recover(owned, {
        migration: async () => {
          throw new AppError("STORAGE_BACKUP_MISSING", "Нет backup", 5);
        },
      }),
    ),
    { code: "STORAGE_BACKUP_MISSING" },
  );
  assert.deepEqual(await files(root), before);
  const seen: string[] = [];
  const result = await withStorageLocks({ root }, (owned) =>
    new StorageTransaction(root).recover(owned, {
      migration: async (intent) => {
        seen.push(intent.id);
      },
    }),
  );
  assert.equal(result.kind, "migration");
  assert.deepEqual(seen, [pending.kind === "migration" ? pending.intent.migration.id : ""]);
  assert.equal((await inspectPending(root)).kind, "none");
  assert.equal((await manifestOf(root)).dataModelVersion, 2);
  assert.equal((await store.get({ kind: "note", id: "a" })).data.title, "Перенесённая заметка");
});

test("readWorkspaceConfig при WAL v2 не восстанавливает и не создаёт каталогов", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-data-model-config-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await initialize(directory, "tasks");
  const root = dirname(workspace.configPath);
  const pending = {
    schemaVersion: 2,
    changes: [{ path: "keyspaces/x.json", before: null, after: {} }],
    migration: migrationIntent(join(directory, "backup")),
  };
  await writeFile(join(root, "transactions/pending.json"), JSON.stringify(pending));
  await rm(join(root, "runtime"), { recursive: true });
  const before = await files(root);
  const required = storageFailure("STORAGE_RECOVERY_REQUIRED", 4, { reason: "migration" });
  await assert.rejects(readWorkspaceConfig(directory), required);
  await assert.rejects(openWorkspace(directory), required);
  assert.deepEqual(await files(root), before);
  assert.equal((await readdir(root)).includes("runtime"), false);
  // Без конфигурации путь тот же: WAL распознаётся до любого recovery.
  await rm(workspace.configPath);
  await assert.rejects(readWorkspaceConfig(directory), required);
});

test("неизвестный или повреждённый WAL блокирует запись и сохраняется", async (t) => {
  const { root, store } = await fixture(t);
  const path = join(root, "transactions/pending.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 3, changes: [] }));
  const before = await files(root);
  const unsupported = storageFailure("STORAGE_VERSION_UNSUPPORTED", 4, {
    reason: "wal",
    current: 3,
  });
  await assert.rejects(store.get({ kind: "note", id: "a" }), unsupported);
  await assert.rejects(EntityStore.open(root, registry()), unsupported);
  assert.deepEqual(await files(root), before);
  await writeFile(path, "{ повреждено");
  await assert.rejects(
    store.run(command("x"), async () => null),
    storageFailure("STORAGE_DATA_CORRUPT", 5, { reason: "wal" }),
  );
  await writeFile(path, JSON.stringify({ schemaVersion: 1, changes: [], extra: true }));
  await assert.rejects(
    store.get({ kind: "note", id: "a" }),
    storageFailure("STORAGE_DATA_CORRUPT", 5),
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).extra, true);
});

test("WAL v2: остановка в каждой probe-точке завершается тем же результатом", async (t) => {
  const reference = await fixture(t);
  await publishMigration(reference.root);
  const expected = persistent(await files(reference.root));
  const points: [TransactionStage, string?][] = [
    ["staged"],
    ["intent"],
    ["file", "entities/notes/a.json"],
    ["phase", "entities"],
    ["phase", "indexes"],
    ["phase", "state"],
    ["phase", "manifest"],
    ["published"],
    ["removed"],
  ];
  for (const [point, detail] of points) {
    const { root, store } = await fixture(t);
    await assert.rejects(
      publishMigration(root, (stage, path) => {
        if (stage === point && (detail === undefined || path === detail))
          throw new Error(`Остановка ${point}`);
      }),
      new RegExp(`Остановка ${point}`),
    );
    const pending = await inspectPending(root);
    if (point === "staged") {
      // До intent постоянное состояние не изменено: только производные страницы индекса.
      assert.equal(pending.kind, "none");
      await assert.rejects(store.get({ kind: "note", id: "a" }), {
        code: "STORAGE_MIGRATION_REQUIRED",
      });
      continue;
    }
    if (point === "removed") assert.equal(pending.kind, "none");
    else {
      assert.equal(pending.kind, "migration", point);
      await assert.rejects(store.get({ kind: "note", id: "b" }), {
        code: "STORAGE_RECOVERY_REQUIRED",
      });
      await withStorageLocks({ root }, (owned) =>
        new StorageTransaction(root).recover(owned, { migration: async () => {} }),
      );
    }
    const actual = persistent(await files(root));
    // Набор файлов совпадает с непрерванной публикацией; дублей и пропусков нет.
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), point);
    for (const [path, text] of expected)
      if (!path.startsWith(".indexes/") || path === ".indexes/state.json")
        assert.equal(actual.get(path), text, `${point}: ${path}`);
    assert.equal((await store.get({ kind: "note", id: "a" })).revision, 2);
  }
});

test("WAL v2: посторонняя правка после прерывания не затирается", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    publishMigration(root, (stage) => {
      if (stage === "intent") throw new Error("Остановка");
    }),
    /Остановка/,
  );
  const path = join(root, "entities/notes/a.json");
  const foreign = JSON.parse(await readFile(path, "utf8"));
  foreign.data.title = "Чужая правка";
  await writeFile(path, JSON.stringify(foreign));
  const wal = await readFile(join(root, "transactions/pending.json"), "utf8");
  await assert.rejects(
    withStorageLocks({ root }, (owned) =>
      new StorageTransaction(root).recover(owned, { migration: async () => {} }),
    ),
    storageFailure("STORAGE_RECOVERY_CONFLICT", 5, { path: "entities/notes/a.json" }),
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).data.title, "Чужая правка");
  assert.equal(await readFile(join(root, "transactions/pending.json"), "utf8"), wal);
});

test("публикация миграции требует маркер целевого профиля и проверку до intent", async (t) => {
  const { root } = await fixture(t);
  const changes = await prepareMigration(root);
  const intent = migrationIntent(join(dirname(root), "backup"));
  await assert.rejects(
    withStorageLocks({ root }, (owned) =>
      new StorageTransaction(root).publish(
        changes.filter((change) => change.path !== "storage.json"),
        owned,
        { migration: { intent, verify: async () => {} } },
      ),
    ),
    { code: "INVALID_DATA" },
  );
  const before = await files(root);
  await assert.rejects(
    withStorageLocks({ root }, (owned) =>
      new StorageTransaction(root).publish(changes, owned, {
        migration: {
          intent,
          verify: async () => {
            throw new AppError("STORAGE_BACKUP_MISSING", "Нет backup", 5);
          },
        },
      }),
    ),
    { code: "STORAGE_BACKUP_MISSING" },
  );
  assert.deepEqual(await files(root), before);
  const pending = JSON.parse(
    await (async () => {
      await assert.rejects(
        withStorageLocks({ root }, (owned) =>
          new StorageTransaction(root, (stage) => {
            if (stage === "intent") throw new Error("стоп");
          }).publish(changes, owned, { migration: { intent, verify: async () => {} } }),
        ),
        /стоп/,
      );
      return readFile(join(root, "transactions/pending.json"), "utf8");
    })(),
  );
  assert.equal(pending.schemaVersion, 2);
  assert.equal(pending.migration.id, intent.id);
  // Новые страницы индекса подготовлены до intent и в WAL не входят.
  assert(
    !pending.changes.some(
      (change: { path: string; after: unknown }) =>
        change.path.startsWith(".indexes/segments/") && change.after !== null,
    ),
  );
});

test("relocation: прежний адрес отвечает ENTITY_RELOCATED, ключ зарезервирован, запись только миграцией", async (t) => {
  const { root, store } = await fixture(t);
  await publishMigration(root);
  const relocated = (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, "ENTITY_RELOCATED");
    assert.equal(error.exitCode, 3);
    assert.deepEqual(error.details, {
      code: "ENTITY_RELOCATED",
      from: "stage:s1",
      to: "note:a",
      stageId: "s1",
      key: "STG-1",
      next: "Используйте адрес note:a",
    });
    return true;
  };
  await assert.rejects(store.resolve("STG-1"), relocated);
  await assert.rejects(store.resolve("STG-1", "note"), relocated);
  await assert.rejects(store.resolve("s1", ["note"]), relocated);
  await assert.rejects(store.resolve("stage:s1", "note"), relocated);
  await assert.rejects(store.resolve("stage:s1"), relocated);
  // Явно ожидающее действие получает минимальную карточку записи совместимости.
  const card = await store.resolve("STG-1", "stage");
  assert.equal(card.status, "relocated");
  assert.equal(card.active, false);
  await assert.rejects(
    store.run(command("put-stage"), async (tx) => {
      await tx.put({ ...stageRecord("s1", "a", "STG-1"), revision: 2 }, 1);
      return null;
    }),
    relocated,
  );
  await assert.rejects(
    store.run(command("import-stage"), async (tx) => {
      await tx.importRecord(stageRecord("s2", "b", "STG-2"));
      return null;
    }),
    { code: "ENTITY_RELOCATED" },
  );
  await assert.rejects(
    store.run(command("remove-stage"), async (tx) => {
      await tx.remove({ kind: "stage", id: "s1" }, 1, "agent");
      return null;
    }),
    relocated,
  );
  await assert.rejects(
    store.run(command("reuse-key"), async (tx) => {
      await tx.put({ ...noteRecord("c"), key: "STG-1" }, null);
      return null;
    }),
    { code: "ENTITY_KEY_CONFLICT" },
  );
  assert.equal((await store.resolve("NOTE-A")).ref.id, "a");
  // Переиндексация сохраняет резерв адреса и ответ.
  await store.reindex();
  await assert.rejects(store.resolve("STG-1"), relocated);
});

test("STORAGE_DATA_MIGRATION_REQUIRED при чтении несёт details по общей схеме", async (t) => {
  const { root, store } = await fixture(t);
  const path = join(root, "entities/notes/a.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.dataVersion = 2;
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(
    store.get({ kind: "note", id: "a" }),
    storageFailure("STORAGE_DATA_MIGRATION_REQUIRED", 4, {
      owner: "note",
      current: 2,
      expected: 1,
      path: "entities/notes/a.json",
    }),
  );
});

test("единый замок: symlink-путь ждёт владельца, legacy и unified берутся без взаимоблокировки", async (t) => {
  const { directory, root } = await fixture(t);
  const alias = join(directory, "alias");
  await symlink(root, alias);
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = withStorageLocks({ root }, async () => {
    order.push("first:start");
    await held;
    order.push("first:end");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = withStorageLocks({ root: alias }, async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  // Legacy-каталог данных внутри .relay использует тот же lockfile: берётся один раз.
  await mkdir(join(root, "tasks"));
  assert.equal(
    await withStorageLocks({ root, legacyRoot: join(root, "tasks") }, async (owned) => {
      owned();
      return "ok";
    }),
    "ok",
  );
  // Отдельный legacy-каталог: сначала его замок, затем unified; созданный runtime удаляется.
  const legacy = join(directory, "legacy-data");
  await mkdir(legacy);
  await withStorageLocks({ root, legacyRoot: legacy }, async () => {
    assert((await readdir(directory)).includes(".legacy-data-runtime"));
  });
  assert.equal((await readdir(directory)).includes(".legacy-data-runtime"), false);
});
