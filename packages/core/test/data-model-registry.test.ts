import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { storageTokenSchema } from "@relay/contracts/storage";
import {
  STORAGE_MAINTENANCE_ERROR_EXIT_CODES,
  storageErrorDetailsSchema,
  storageMigrationPlanSchema,
  storageMigrationResultSchema,
  storageStatusSchema,
} from "@relay/contracts/storage-maintenance";
import { AppError } from "../src/shared/errors.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { EntityStorageRegistry } from "../src/storage/entity-store/registry.js";
import {
  HISTORICAL_KINDS,
  HistoricalKindCatalog,
} from "../src/storage/data-model/history/catalog.js";
import { manifestV4Profile1Schema } from "../src/storage/data-model/history/manifest-v4-profile1.js";
import { intentV1Schema } from "../src/storage/data-model/history/intent-v1.js";
import {
  CURRENT_DATA_MODEL,
  DATA_MODEL_PROFILES,
  PROFILE_1,
  currentProfile,
} from "../src/storage/data-model/profiles.js";
import {
  currentManifest,
  manifestProfile,
  parseStorageManifest,
  requireCurrentProfile,
} from "../src/storage/data-model/manifest.js";
import {
  createTransitionRegistry,
  deterministicId,
  transitionOwners,
} from "../src/storage/data-model/registry.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import { storageError } from "../src/storage/data-model/errors.js";
import type {
  DiskData,
  RecordTransition,
  SnapshotTransition,
} from "../src/storage/data-model/types.js";
import {
  SYNTHETIC_PROFILES,
  bytes,
  note,
  noteRename,
  noteSplit,
  noteTags,
  noteV1,
  noteV2,
  runInMemory,
  simpleCodec,
  syntheticInput,
  syntheticRegistry,
  withTransitions,
} from "./helpers/synthetic-data-model.js";

/** Ожидаемая ошибка: код и, для реестра, вид причины. */
function fails(action: () => unknown, code: string, reason?: string): AppError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof AppError, `ожидалась AppError ${code}, получено ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (reason) assert.equal((caught.details as { reason?: string }).reason, reason, caught.message);
  assert.equal(
    caught.exitCode,
    STORAGE_MAINTENANCE_ERROR_EXIT_CODES[code as "STORAGE_REGISTRY_INVALID"],
  );
  storageErrorDetailsSchema.parse(caught.details);
  return caught;
}

const dataOf = (record: { data?: unknown } | object) =>
  "data" in record ? record.data : undefined;
const tagId = (label: string) => deterministicId("note-tags-to-tag", `tag:${label}`);
const versionsOf = (records: { kind: string; dataVersion: number }[]) => {
  const map = new Map<string, Set<number>>();
  for (const record of records)
    map.set(record.kind, (map.get(record.kind) ?? new Set()).add(record.dataVersion));
  return map;
};

test("A06: цепочка из трёх шагов равна последовательному применению, порядок и ID видны", () => {
  const source = [
    note("n1", 1, { name: "Отчёт: квартал", text: "строка 1\nстрока 2", tags: ["work", "q1"] }),
    note("n2", 1, { name: "Без подзаголовка", text: "", tags: [] }),
    note("n3", 1, {}, true),
  ];
  const before = structuredClone(source);
  const direct = runInMemory(syntheticRegistry(13), source);
  assert.deepEqual(direct.steps, ["note-v1-to-v2@1", "note-tags-to-tag@1", "note-v3-to-v4@1"]);
  assert.deepEqual(source, before, "исходные записи не изменяются");

  // Три отдельных запуска, каждый со своим реестром целевого профиля.
  const first = runInMemory(syntheticRegistry(11), source);
  assert.deepEqual(first.steps, ["note-v1-to-v2@1"]);
  const second = runInMemory(syntheticRegistry(12), first.records);
  assert.deepEqual(second.steps, ["note-tags-to-tag@1"]);
  const third = runInMemory(syntheticRegistry(13), second.records);
  assert.deepEqual(third.steps, ["note-v3-to-v4@1"]);
  assert.equal(bytes(direct.records), bytes(third.records));

  // Независимый оракул результата: оболочка сохраняется, данные преобразованы.
  const n1 = direct.records.find((record) => record.id === "n1")!;
  assert.equal(n1.revision, 7);
  assert.equal(n1.key, "NOTE-N1");
  assert.deepEqual("data" in n1 && n1.data, {
    title: "Отчёт",
    subtitle: "квартал",
    body: ["строка 1", "строка 2"],
    tagIds: [tagId("work"), tagId("q1")],
  });
  const n3 = direct.records.find((record) => record.id === "n3")!;
  assert("deleted" in n3 && n3.dataVersion === 4);
  assert.deepEqual(
    direct.records
      .filter((record) => record.kind === "tag")
      .map((record) => "data" in record && record.data.label)
      .sort(),
    ["q1", "work"],
  );
  // Повторный запуск на тех же данных даёт те же байты (детерминизм, ID без случайности).
  assert.equal(bytes(runInMemory(syntheticRegistry(13), source).records), bytes(direct.records));
});

test("A07: смешанные версии одного вида и нескольких видов сходятся к целевому профилю", () => {
  const source = [
    note("a", 1, { name: "A: один", text: "x", tags: ["shared"] }),
    note("b", 2, { title: "B", text: "y", tags: ["shared", "b"] }),
    note("c", 3, { title: "C: три", text: "z", tagIds: [tagId("old")] }),
    note("d", 4, { title: "D", subtitle: null, body: ["w"], tagIds: [] }),
    note("e", 2, {}, true),
    {
      schemaVersion: 3 as const,
      dataVersion: 1,
      kind: "tag",
      id: tagId("old"),
      revision: 1,
      key: null,
      aliases: [],
      data: { label: "old" },
      createdAt: "2024-01-01T00:00:00.000Z",
      createdBy: "tester",
      updatedAt: "2024-01-01T00:00:00.000Z",
      updatedBy: "tester",
    },
  ];
  const registry = syntheticRegistry(13);
  const plan = registry.plan(versionsOf(source));
  assert.deepEqual(
    plan.map((step) => step.id),
    ["note-v1-to-v2", "note-tags-to-tag", "note-v3-to-v4"],
  );
  assert.deepEqual(plan.map(transitionOwners), [["note"], ["note", "tag"], ["note"]]);
  const result = runInMemory(registry, source);
  for (const record of result.records)
    assert.equal(record.dataVersion, registry.target(record.kind), `${record.kind}/${record.id}`);
  const byId = new Map(result.records.map((record) => [record.id, record]));
  assert.deepEqual(dataOf(byId.get("a")!), {
    title: "A",
    subtitle: "один",
    body: ["x"],
    tagIds: [tagId("shared")],
  });
  assert.deepEqual(dataOf(byId.get("c")!), {
    title: "C",
    subtitle: "три",
    body: ["z"],
    tagIds: [tagId("old")],
  });
  assert.deepEqual(dataOf(byId.get("d")!), {
    title: "D",
    subtitle: null,
    body: ["w"],
    tagIds: [],
  });
  assert.equal(result.records.filter((record) => record.kind === "tag").length, 3);

  // Только высокие версии: шаги ниже не планируются; всё актуально — пустой план.
  assert.deepEqual(
    registry.plan(new Map([["note", new Set([3, 4])]])).map((step) => step.id),
    ["note-v3-to-v4"],
  );
  assert.deepEqual(
    registry.plan(
      new Map([
        ["note", new Set([4])],
        ["tag", new Set([1])],
      ]),
    ),
    [],
  );
  // Метка ждёт snapshot-шаг, который ещё может породить её версию.
  assert.deepEqual(
    registry
      .plan(
        new Map([
          ["note", new Set([1])],
          ["tag", new Set([1])],
        ]),
      )
      .map((step) => step.id),
    ["note-v1-to-v2", "note-tags-to-tag", "note-v3-to-v4"],
  );
});

test("A15: ошибки реестра и невозможные переходы различимы и обнаруживаются до работы с данными", () => {
  const input = syntheticInput(13);

  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [noteRename, { ...noteRename }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "duplicate-id",
  );
  fails(
    () => createTransitionRegistry(withTransitions(input, [noteRename, noteTags])),
    "STORAGE_REGISTRY_INVALID",
    "gap",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [
          noteRename,
          { ...noteRename, id: "note-v1-to-v2-bis" },
          noteTags,
          noteSplit,
        ]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "ambiguous",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [{ ...noteRename, to: 3, output: noteV2 }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "non-adjacent",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [{ ...noteRename, output: noteV1 }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "output-mismatch",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [noteRename, noteTags, { ...noteSplit, output: noteV2 }]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "output-mismatch",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [
          { ...noteRename, dependsOn: ["note-v3-to-v4"] },
          noteTags,
          { ...noteSplit, dependsOn: ["note-v1-to-v2"] },
        ]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "cycle",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [{ ...noteRename, dependsOn: ["missing"] }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "unknown-dependency",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(
          input,
          [noteRename, noteTags, noteSplit],
          [
            ...SYNTHETIC_PROFILES.slice(0, 3),
            { ...SYNTHETIC_PROFILES[3]!, owners: { note: 3, tag: 1 } },
          ],
        ),
      ),
    "STORAGE_REGISTRY_INVALID",
    "profile-mismatch",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [
          noteRename,
          { ...noteTags, produces: { note: 3, tag: "removed" } },
          noteSplit,
        ]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "removed-current",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [{ ...noteRename, owner: "ghost" }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "unknown-kind",
  );
  fails(
    () =>
      createTransitionRegistry(
        withTransitions(input, [{ ...noteRename, id: "Bad ID" }, noteTags, noteSplit]),
      ),
    "STORAGE_REGISTRY_INVALID",
    "invalid-id",
  );

  // Цикл по узлам (вид, версия) через snapshot-переходы, порождающие новые виды.
  const alpha = z.strictObject({ a: z.number() });
  const beta = z.strictObject({ b: z.number() });
  const cyclicStorage = new EntityStorageRegistry([
    simpleCodec("alpha", 3, alpha),
    simpleCodec("beta", 3, beta),
  ]);
  const cyclic = {
    profiles: [{ ...SYNTHETIC_PROFILES[0]!, version: 1, owners: { alpha: 3, beta: 3 } }],
    storage: cyclicStorage,
    historical: new HistoricalKindCatalog(cyclicStorage, []),
  };
  const snap = (id: string, from: string, to: string): SnapshotTransition => ({
    id,
    version: 1,
    type: "snapshot",
    description: id,
    requires: { [from]: 1 },
    produces: { [from]: 2, [to]: 1 },
    inputs: { [from]: from === "alpha" ? alpha : beta },
    outputs: { [from]: from === "alpha" ? alpha : beta, [to]: to === "alpha" ? alpha : beta },
    apply: () => undefined,
  });
  const step = (kind: string, schema: z.ZodType): RecordTransition => ({
    id: `${kind}-v2-to-v3`,
    version: 1,
    type: "record",
    description: kind,
    owner: kind,
    from: 2,
    to: 3,
    input: schema,
    output: schema,
    apply: (data) => data,
  });
  fails(
    () =>
      createTransitionRegistry({
        ...cyclic,
        transitions: [
          snap("alpha-split", "alpha", "beta"),
          snap("beta-split", "beta", "alpha"),
          step("alpha", alpha),
          step("beta", beta),
        ],
      }),
    "STORAGE_REGISTRY_INVALID",
    "cycle",
  );
  // Взаимная блокировка: шаг ждёт snapshot, который сам ждёт результата шага.
  fails(
    () =>
      createTransitionRegistry({
        ...cyclic,
        profiles: [{ ...SYNTHETIC_PROFILES[0]!, version: 1, owners: { alpha: 3, beta: 3 } }],
        transitions: [
          { ...step("alpha", alpha), id: "alpha-v1-to-v2", from: 1, to: 2, dependsOn: ["joint"] },
          {
            id: "joint",
            version: 1,
            type: "snapshot",
            description: "joint",
            requires: { alpha: 2, beta: 1 },
            produces: { alpha: 3, beta: 3 },
            inputs: { alpha, beta },
            outputs: { alpha, beta },
            apply: () => undefined,
          },
        ],
      }),
    "STORAGE_REGISTRY_INVALID",
    "deadlock",
  );

  // Невозможные переходы для фактических версий: будущая, неизвестный вид, нет перехода.
  const registry = syntheticRegistry(13);
  fails(() => registry.plan(new Map([["note", new Set([5])]])), "STORAGE_VERSION_UNSUPPORTED");
  fails(() => registry.plan(new Map([["ghost", new Set([1])]])), "UNKNOWN_ENTITY_KIND");
  fails(() => registry.kindOfCollection("ghosts"), "UNKNOWN_ENTITY_KIND");
  const partial = createTransitionRegistry(
    withTransitions(input, [noteTags, noteSplit], SYNTHETIC_PROFILES.slice(1)),
  );
  fails(() => partial.plan(new Map([["note", new Set([1])]])), "STORAGE_TRANSITION_MISSING");
  fails(
    () => partial.validateRecord(note("x", 1, { name: "x", text: "", tags: [] })),
    "STORAGE_TRANSITION_MISSING",
  );

  // Неверный промежуточный выход во время применения; исходные записи не меняются.
  const broken = createTransitionRegistry(
    withTransitions(input, [
      { ...noteRename, apply: (data: DiskData) => ({ ...data }) },
      noteTags,
      noteSplit,
    ]),
  );
  const source = [note("n", 1, { name: "n", text: "", tags: [] })];
  const before = structuredClone(source);
  const error = fails(() => runInMemory(broken, source), "STORAGE_TRANSITION_OUTPUT_INVALID");
  assert.equal((error.details as { step?: string }).step, "note-v1-to-v2");
  assert.deepEqual(source, before);
  // Данные не проходят историческую схему своей версии — повреждение, а не выход шага.
  fails(
    () => registry.validateRecord(note("y", 2, { title: 1, text: "", tags: [] })),
    "STORAGE_DATA_CORRUPT",
  );
  fails(() => registry.validateRecord({ kind: "note" }), "STORAGE_DATA_CORRUPT");
});

test("A29: новый владелец и следующий профиль добавляются регистрацией без правки движка", () => {
  const memoV1 = z.strictObject({ text: z.string() });
  const memoV2 = z.strictObject({ lines: z.array(z.string()) });
  const base = syntheticInput(13, {
    codecs: [simpleCodec("memo", 2, memoV2)],
  });
  const memoStep: RecordTransition = {
    id: "memo-v1-to-v2",
    version: 1,
    type: "record",
    description: "Текст заметки в массив строк",
    owner: "memo",
    from: 1,
    to: 2,
    input: memoV1,
    output: memoV2,
    apply: (data) => ({ lines: (data.text as string).split("\n") }),
  };
  const registry = createTransitionRegistry({
    ...base,
    profiles: [
      ...SYNTHETIC_PROFILES,
      { ...SYNTHETIC_PROFILES[3]!, version: 14, owners: { note: 4, tag: 1, memo: 2 } },
    ],
    transitions: [...base.transitions, memoStep],
  });
  assert.equal(registry.kindOfCollection("memos"), "memo");
  const memo = { ...note("m", 1, { text: "a\nb" }), kind: "memo", key: "MEMO-1" };
  const result = runInMemory(registry, [memo, note("n", 1, { name: "n", text: "t", tags: [] })]);
  assert.deepEqual(result.steps, [
    "memo-v1-to-v2@1",
    "note-v1-to-v2@1",
    "note-tags-to-tag@1",
    "note-v3-to-v4@1",
  ]);
  const migrated = result.records.find((record) => record.kind === "memo")!;
  assert.deepEqual("data" in migrated && migrated.data, { lines: ["a", "b"] });
  assert.notEqual(registry.digest, syntheticRegistry(13).digest);
});

test("Целостность поставки: целевой профиль равен владельцам хранения, реестр строится", () => {
  const owners = Object.fromEntries(
    workspaceStorageRegistry()
      .definitions()
      .map((definition) => [definition.kind, definition.dataVersion]),
  );
  assert.deepEqual(
    { ...currentProfile().owners },
    owners,
    "повышение dataVersion требует нового профиля",
  );
  assert.equal(currentProfile().version, CURRENT_DATA_MODEL);
  assert.deepEqual(
    DATA_MODEL_PROFILES.map((profile) => profile.version),
    [...DATA_MODEL_PROFILES.map((profile) => profile.version)].sort((a, b) => a - b),
  );
  // Профиль 1 заморожен состоянием 0.9.2 и не следует за текущими кодеками.
  assert.equal(PROFILE_1.owners["work-plan"], 2);
  const registry = productionTransitionRegistry();
  assert.match(registry.digest, /^[a-f0-9]{64}$/);
  assert.equal(registry.profile.version, CURRENT_DATA_MODEL);
  // Исторические коллекции распознаются каталогом; без перехода их версия не поддерживается молча.
  for (const historical of HISTORICAL_KINDS)
    assert.equal(registry.kindOfCollection(historical.collection), historical.kind);
  for (const definition of workspaceStorageRegistry().definitions())
    assert.equal(registry.kindOfCollection(definition.collection), definition.kind);
  // Одинаковые определения дают одинаковый digest.
  assert.equal(syntheticRegistry(13).digest, syntheticRegistry(13).digest);
});

test("Детерминированный ID перехода стабилен, имеет формат UUID и проходит токен хранения", () => {
  const id = deterministicId("planning-v1-to-v2", "edge:1:task:T");
  assert.equal(id, deterministicId("planning-v1-to-v2", "edge:1:task:T"));
  assert.notEqual(id, deterministicId("planning-v1-to-v2", "edge:2:task:T"));
  assert.notEqual(id, deterministicId("other", "edge:1:task:T"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  storageTokenSchema.parse(id);
});

test("Manifest: профиль, различимые отказы и отказ прежнего строгого parser", () => {
  const manifest = currentManifest("P1");
  assert.deepEqual(manifest, {
    format: "relay-entities",
    schemaVersion: 4,
    productId: "P1",
    dataModelVersion: 2,
  });
  requireCurrentProfile(parseStorageManifest(manifest));
  assert.equal(
    manifestProfile(parseStorageManifest({ format: "relay-entities", schemaVersion: 4 })),
    1,
  );
  assert.equal(
    manifestProfile(parseStorageManifest({ format: "relay-entities", schemaVersion: 3 })),
    null,
  );

  const migration = fails(
    () =>
      requireCurrentProfile(parseStorageManifest({ format: "relay-entities", schemaVersion: 4 })),
    "STORAGE_MIGRATION_REQUIRED",
  );
  assert.deepEqual(
    {
      reason: (migration.details as { reason: string }).reason,
      current: (migration.details as { current: number }).current,
    },
    { reason: "profile", current: 1 },
  );
  assert.equal(
    (
      fails(
        () =>
          requireCurrentProfile(
            parseStorageManifest({ format: "relay-entities", schemaVersion: 2 }),
          ),
        "STORAGE_MIGRATION_REQUIRED",
      ).details as { reason: string }
    ).reason,
    "physical",
  );
  fails(
    () => parseStorageManifest({ format: "relay-entities", schemaVersion: 4, dataModelVersion: 3 }),
    "STORAGE_VERSION_UNSUPPORTED",
  );
  fails(
    () => parseStorageManifest({ format: "relay-entities", schemaVersion: 5 }),
    "STORAGE_VERSION_UNSUPPORTED",
  );
  fails(
    () => parseStorageManifest({ format: "other", schemaVersion: 4 }),
    "STORAGE_FORMAT_UNKNOWN",
  );
  fails(
    () => parseStorageManifest({ format: "relay-entities", schemaVersion: 4, extra: 1 }),
    "STORAGE_FORMAT_UNKNOWN",
  );
  fails(
    () => parseStorageManifest({ format: "relay-entities", schemaVersion: 3, dataModelVersion: 2 }),
    "STORAGE_FORMAT_UNKNOWN",
  );
  fails(() => parseStorageManifest([]), "STORAGE_DATA_CORRUPT");

  // Исторический parser 0.9.2 отвергает manifest нового профиля, но принимает прежний.
  assert.equal(manifestV4Profile1Schema.safeParse(manifest).success, false);
  assert.equal(
    manifestV4Profile1Schema.safeParse({ format: "relay-entities", schemaVersion: 4 }).success,
    true,
  );
  assert.equal(intentV1Schema.safeParse({ schemaVersion: 1, changes: [] }).success, true);
  assert.equal(intentV1Schema.safeParse({ schemaVersion: 2, changes: [] }).success, false);
});

test("Contracts: схемы результата обслуживания проверяются в runtime, exit codes из таблицы", () => {
  const status = {
    status: "migration-required",
    project: { id: "P", configPath: "/p/.relay/config.json", root: "/p/.relay" },
    layout: "unified-4",
    current: {
      physical: 4,
      dataModel: null,
      envelope: [3],
      owners: { task: { versions: { "1": { live: 2, tombstones: 1 } }, target: 1 } },
    },
    target: { dataModel: 2, owners: { task: 1 } },
    counts: { files: 10, bytes: 1000 },
    pending: null,
    blockers: [],
    blockersTotal: 0,
    warnings: [],
  };
  storageStatusSchema.parse(status);
  assert.equal(storageStatusSchema.safeParse({ ...status, extra: true }).success, false);
  assert.equal(
    storageStatusSchema.safeParse({
      ...status,
      blockers: [{ code: "STORAGE_DATA_CORRUPT", message: "x", path: "/abs", next: "y" }],
    }).success,
    false,
    "абсолютный путь в блокере запрещён",
  );
  const step = {
    id: "planning-v1-to-v2",
    version: 1,
    type: "snapshot",
    owners: ["work-plan"],
    records: { checked: 1, changed: 1, removed: 0 },
  };
  storageMigrationPlanSchema.parse({
    ...status,
    steps: [step],
    profiles: { from: 1, to: 2 },
    changes: {
      files: { "entities/work-plan": { create: 0, update: 1, delete: 0 } },
      relations: { kept: 0, revoked: 0, created: 0 },
      addresses: { reservedKept: 0, relocated: 0 },
    },
    removedByRule: [{ category: "release-snapshot", count: 1, bytes: 10 }],
    budgets: {
      maxRecordBytes: 1,
      walBytes: 1,
      indexBytes: 1,
      backupBytes: 1,
      limits: { recordBytes: 16, walBytes: 128 },
    },
    space: { backupRequired: 1, rootRequired: 1 },
    planFingerprint: "a".repeat(64),
    applicable: true,
  });
  const result = {
    migrated: true,
    format: "relay-entities",
    schemaVersion: 4,
    entities: 3,
    operations: 0,
    resumed: false,
    profiles: { from: 1, to: 2 },
    steps: [step],
    planFingerprint: "b".repeat(64),
    counts: {
      checked: 4,
      changed: 1,
      removedByRule: 0,
      owners: { task: { checked: 4, changed: 1, removedByRule: 0 } },
    },
    checks: {
      schemas: "passed",
      references: "passed",
      addresses: "passed",
      indexes: "passed",
      budgets: "passed",
    },
    backup: { path: "/backups/relay-backup", manifestSha256: "c".repeat(64) },
  };
  storageMigrationResultSchema.parse(result);
  assert.equal(
    storageMigrationResultSchema.safeParse({
      ...result,
      checks: { ...result.checks, schemas: "failed" },
    }).success,
    false,
  );
  const error = storageError("STORAGE_BACKUP_REQUIRED", "Нужен каталог");
  assert.equal(error.exitCode, 2);
  assert.match((error.details as { next: string }).next, /--backup-dir/);
  assert.equal(storageError("ENTITY_RELOCATED", "x").exitCode, 3);
  assert.equal(storageError("STORAGE_RECOVERY_REQUIRED", "x").exitCode, 4);
  assert.equal(storageError("STORAGE_REGISTRY_INVALID", "x").exitCode, 5);
});

test("Оболочка исторической версии проверяется по публичности вида из каталога", () => {
  const registry = syntheticRegistry(13);
  const tag = {
    schemaVersion: 3 as const,
    dataVersion: 1,
    kind: "tag",
    id: "t1",
    revision: 1,
    key: "TAG-1",
    aliases: [],
    data: { label: "x" },
    createdAt: "2024-01-01T00:00:00.000Z",
    createdBy: "a",
    updatedAt: "2024-01-01T00:00:00.000Z",
    updatedBy: "a",
  };
  fails(() => registry.validateRecord(tag), "STORAGE_DATA_CORRUPT");
  registry.validateRecord({ ...tag, key: null });
  const record = note("z", 1, { name: "z", text: "", tags: [] });
  assert.equal(registry.validateRecord(record).dataVersion, 1);
  assert.equal(registry.validator("note", 1).source, "transition");
  assert.equal(registry.validator("note", 4).source, "current");
});
