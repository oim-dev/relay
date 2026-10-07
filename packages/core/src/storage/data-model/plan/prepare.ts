import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { entityAddress, entityRefSchema } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import type {
  StorageBlocker,
  StorageMaintenanceErrorCode,
  StorageMigrationPlan,
  StorageMigrationStep,
} from "@relay/contracts/storage-maintenance";
import { AppError } from "../../../shared/errors.js";
import { EntityStore } from "../../entity-store/store.js";
import { writeOwnedRelations } from "../../entity-store/relations.js";
import { RECORD_BYTES, WAL_BYTES, digest, jsonValue } from "../../entity-store/format.js";
import type { FileChange } from "../../entity-store/format.js";
import {
  intentBytes,
  migrationIntentOf,
  persistentPathSchema,
  splitMigrationChanges,
} from "../../entity-store/transaction.js";
import { storageError } from "../errors.js";
import { physicalSourceIo } from "../../migration/unified-sources.js";
import { physicalCatalog } from "../transitions/index.js";
import { MANIFEST_PATH, currentManifest } from "../manifest.js";
import { applyRecordTransition, deterministicId } from "../registry.js";
import type { TransitionRegistry } from "../registry.js";
import { blockerOf } from "../source/reader.js";
import { readUnifiedSets } from "../source/unified-sets.js";
import type { SourceTarget, StorageSource } from "../source/reader.js";
import type {
  ChangeSet,
  PhysicalSnapshot,
  SnapshotTransition,
  SnapshotView,
  TransitionDefinition,
} from "../types.js";
import { describeStep } from "./planner.js";
import { configProjectId, integrityBlockers, recordFacts } from "./integrity.js";
import type { ProfileStep } from "./planner.js";
import type { StepCounts } from "./planner.js";

/**
 * Подготовка миграции вне опубликованного состояния (ТЗ 8.1 п.3, дизайн §4.3 п.6).
 *
 * 1. Модель источника: формат 4 читается с диска, иные раскладки — физическим составным
 *    шагом (чистое чтение) с записями в исходных dataVersion.
 * 2. Предметные шаги в порядке плана: record-переходы через проверку входа/выхода
 *    замороженными схемами, snapshot-переходы через контролируемое чтение снимка и набор
 *    изменений; выход каждого шага проверяется до следующего.
 * 3. Полная проверка: текущие кодеки, уникальность ключей и алиасов, комментарии, ссылки
 *    активных связей и ID рёбер, итоговые индексы, полный состав файлов, бюджеты.
 * 4. Набор FileChange для одной публикации WAL: записи, отношения, keyspaces, конфигурация,
 *    удаление распознанных исторических источников и прежних страниц индекса, новое состояние
 *    индексов (новая версия снимка) и последним — manifest целевого профиля.
 *
 * Работает только в памяти: файлы базы читаются, но не создаются и не меняются (dry-run и
 * исполнитель используют один путь). Нет часов, сети и случайных ID в предметных данных;
 * UUID версии снимка индексов — служебный.
 */

const SEGMENT_PATH = /^\.indexes\/segments\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/;
const CATEGORY = /^[a-z][a-z0-9/-]{0,127}$/;
const MAX_BLOCKERS = 50;
/** Служебные файлы постоянных каталогов, создаваемые `prepareDirectories` после публикации. */
const SERVICE_IGNORES = [".indexes/.gitignore", "transactions/.gitignore"] as const;

export type ModelRelation = { owner: EntityRef; value: JsonValue };

/** Согласованный снимок проекта на одном этапе подготовки. */
export type MigrationModel = {
  records: Map<string, StoredRecord>;
  relations: Map<string, ModelRelation>;
  keyspaces: Map<string, StoredKeySpace>;
  /** Новое содержимое конфигурации; null — файл не меняется. */
  config: JsonValue | null;
  productId: string | null;
};

type Removal = { path: string; category: string; bytes: number };

export type PreparedMigration = {
  /** Изменения одной публикации; страницы индекса стейджатся исполнителем WAL. */
  readonly changes: readonly FileChange[];
  readonly steps: readonly StorageMigrationStep[];
  readonly changesSummary: StorageMigrationPlan["changes"];
  readonly removedByRule: StorageMigrationPlan["removedByRule"];
  readonly budgets: StorageMigrationPlan["budgets"];
  readonly rootRequired: number;
  /** R8: действующие записи сущностей без надгробий и технических владельцев. */
  readonly entities: number;
  readonly counts: {
    checked: number;
    changed: number;
    removedByRule: number;
    owners: Record<string, { checked: number; changed: number; removedByRule: number }>;
  };
  /** Распознанные служебные файлы runtime/, удаляемые исполнителем после публикации (вне WAL). */
  readonly runtimeRemovals: readonly string[];
  /** Отпечаток итогового предметного набора (без служебных UUID): проверка детерминизма. */
  readonly resultDigest: string;
  /** Постоянные файлы корня вне публикации с sha256 байтов: сверка recovery (WAL `unchanged`). */
  readonly unchanged: readonly { path: string; sha256: string }[];
};

export type PrepareInput = {
  readonly source: StorageSource;
  readonly target: SourceTarget;
  readonly registry: TransitionRegistry;
  readonly steps: readonly TransitionDefinition[];
  /** Шаг маркера профиля формата 4; добавляется последним в сводку шагов. */
  readonly profileStep?: ProfileStep | null;
  readonly owned: () => void;
  /** Пределы бюджетов; тесты уменьшают их, публикация WAL проверяет свои действующие. */
  readonly limits?: { readonly recordBytes?: number; readonly walBytes?: number };
};

const refOf = (record: StoredRecord): EntityRef => ({ kind: record.kind, id: record.id });
const isLive = (record: StoredRecord) => !("deleted" in record);
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const recordPath = (registry: TransitionRegistry, record: StoredRecord) =>
  `entities/${registry.catalog.entry(record.kind)?.collection ?? record.kind}/${record.id}.json`;
const prettyBytes = (value: unknown) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);

/** Набор блокеров подготовки: все причины сразу, первая — код ошибки. */
class Blockers {
  readonly items: StorageBlocker[] = [];
  add(error: unknown, fallback?: Partial<StorageBlocker>) {
    const blocker = blockerOf(error);
    const merged = { ...blocker };
    for (const [key, value] of Object.entries(fallback ?? {}))
      if ((merged as Record<string, unknown>)[key] === undefined)
        (merged as Record<string, unknown>)[key] = value;
    this.items.push(merged);
  }
  push(
    code: StorageMaintenanceErrorCode,
    message: string,
    details: Partial<Omit<StorageBlocker, "code" | "message" | "next">> = {},
  ) {
    this.items.push(blockerOf(storageError(code, message, details)));
  }
  /** Ошибка с несколькими причинами: details.blockers содержит все (≤50). */
  throwIfAny(message: string) {
    const first = this.items[0];
    if (!first) return;
    throw storageError(first.code, `${message}: найдено причин — ${this.items.length}`, {
      ...(first.owner ? { owner: first.owner } : {}),
      ...(first.step ? { step: first.step } : {}),
      ...(first.path ? { path: first.path } : {}),
      ...(first.id ? { id: first.id } : {}),
      ...(first.current !== undefined ? { current: first.current } : {}),
      ...(first.expected !== undefined ? { expected: first.expected } : {}),
      blockers: this.items.slice(0, MAX_BLOCKERS),
      next: first.next,
    });
  }
}

/** Блокеры AppError переходов (details.blockers) переносятся целиком. */
function absorb(blockers: Blockers, error: unknown, step?: string) {
  if (!(error instanceof AppError)) throw error;
  const nested = (error.details as { blockers?: StorageBlocker[] } | undefined)?.blockers;
  if (Array.isArray(nested) && nested.length) {
    blockers.items.push(...nested);
    return;
  }
  blockers.add(error, step ? { step } : {});
}

const sessionCodes: Record<string, StorageMaintenanceErrorCode> = {
  RELATION_ID_CONFLICT: "STORAGE_ADDRESS_COLLISION",
  INVALID_REFERENCE: "STORAGE_REFERENCE_BROKEN",
  STORAGE_LIMIT_EXCEEDED: "STORAGE_LIMIT_EXCEEDED",
  ENTITY_KEY_CONFLICT: "STORAGE_ADDRESS_COLLISION",
  STORAGE_DATA_MIGRATION_REQUIRED: "STORAGE_TRANSITION_OUTPUT_INVALID",
  UNKNOWN_ENTITY_KIND: "UNKNOWN_ENTITY_KIND",
};

/** Ошибка итоговой проверки сессии → блокер хранилища с путём/ID, без текста пользователя. */
function sessionBlocker(
  blockers: Blockers,
  error: unknown,
  detail: { path?: string; owner?: string; id?: string },
) {
  const appError = error instanceof AppError ? error : undefined;
  if (!appError && !(error instanceof z.ZodError)) throw error;
  const code = (appError && sessionCodes[appError.code]) ?? "STORAGE_TRANSITION_OUTPUT_INVALID";
  const message =
    code === "STORAGE_ADDRESS_COLLISION"
      ? "ID связи или адрес занят другим владельцем"
      : code === "STORAGE_REFERENCE_BROKEN"
        ? "Активная связь ссылается на отсутствующую сущность"
        : code === "STORAGE_LIMIT_EXCEEDED"
          ? "Подготовленные данные превышают предел записи"
          : "Подготовленная запись не проходит текущую схему";
  blockers.push(code, message, {
    ...(detail.path ? { path: detail.path } : {}),
    ...(detail.owner ? { owner: detail.owner } : {}),
    ...(detail.id ? { id: detail.id.slice(0, 256) } : {}),
  });
}

// ------------------------------------------------------------------------------------------
// Модель источника
// ------------------------------------------------------------------------------------------

const inlineEntriesSchema = z.looseObject({
  schemaVersion: z.literal(1),
  owner: entityRefSchema,
  storage: z.literal("inline"),
  entries: z.array(
    z.looseObject({
      slot: z.string(),
      edge: z.looseObject({ id: z.string(), active: z.boolean() }),
    }),
  ),
});

async function readJsonBytes(path: string): Promise<JsonValue> {
  const bytes = await readFile(path);
  return jsonValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

/**
 * Модель базы формата 4: записи, собранные наборы отношений, keyspaces. Отношения и keyspaces
 * читаются строгими замороженными схемами (`readUnifiedSets`): неизвестное поле или объект —
 * блокер до пересборки, а не молчаливое удаление при перезаписи.
 */
async function readUnifiedModel(
  source: StorageSource,
  registry: TransitionRegistry,
  owned: () => void,
  blockers: Blockers,
): Promise<{ model: MigrationModel; relationFiles: Map<string, string[]> }> {
  const model: MigrationModel = {
    records: new Map(),
    relations: new Map(),
    keyspaces: new Map(),
    config: null,
    productId: source.manifest?.productId ?? null,
  };
  for (const entry of source.entries) {
    if (entry.area !== "config-root" || entry.type !== "file" || !entry.managed) continue;
    if (entry.category !== "entities") continue;
    try {
      owned();
      const record = registry.validateRecord(await readJsonBytes(join(source.root, entry.path)));
      model.records.set(entityAddress(refOf(record)), record);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
        blockers.push("STORAGE_DATA_CORRUPT", "Постоянный файл не соответствует формату", {
          path: entry.path,
        });
      else blockers.add(error, { path: entry.path });
    }
  }
  const sets = await readUnifiedSets(source, registry, owned);
  blockers.items.push(...sets.blockers);
  for (const set of sets.relations)
    model.relations.set(entityAddress(set.owner), { owner: set.owner, value: set.value });
  for (const space of sets.keyspaces) model.keyspaces.set(space.id, space);
  // Прежние файлы наборов (манифест владельца и сегменты) заменяются пересобранным набором.
  const relationFiles = new Map<string, string[]>();
  for (const entry of source.entries) {
    if (entry.area !== "config-root" || entry.type !== "file" || entry.category !== "relations")
      continue;
    const parts = entry.path.split("/");
    if (!entry.owner || (parts.length !== 3 && parts.length !== 4)) continue;
    const id = parts.length === 3 ? parts[2]!.slice(0, -".json".length) : parts[2]!;
    const address = entityAddress({ kind: entry.owner, id } as EntityRef);
    const files = relationFiles.get(address) ?? [];
    files.push(entry.path);
    relationFiles.set(address, files);
  }
  return { model, relationFiles };
}

/**
 * Модель исходной раскладки до формата 4: физический составной шаг читает файлы его
 * замороженными историческими схемами (чистое чтение без записи), затем каждая запись
 * проверяется схемой своей версии. Тот же вход у подготовки миграции и у явного `status`.
 */
async function readPhysicalModel(
  source: StorageSource,
  target: SourceTarget,
  registry: TransitionRegistry,
  physical: Extract<TransitionDefinition, { type: "physical" }>,
  owned: () => void,
  blockers: Blockers,
): Promise<{ snapshot: PhysicalSnapshot; model: MigrationModel }> {
  let snapshot: PhysicalSnapshot;
  try {
    snapshot = await physical.read(
      physicalSourceIo(
        { ...source, storageRoot: source.storageRoot ?? target.storageRoot },
        physicalCatalog(registry),
      ),
      owned,
    );
  } catch (error) {
    absorb(blockers, error, physical.id);
    blockers.throwIfAny("Физический перенос неприменим");
    throw error;
  }
  const model: MigrationModel = {
    records: new Map(),
    relations: new Map(),
    keyspaces: new Map(),
    config: snapshot.config,
    productId: snapshot.productId,
  };
  for (const raw of snapshot.records)
    try {
      const record = registry.validateRecord(raw);
      const address = entityAddress(refOf(record));
      if (model.records.has(address))
        throw storageError("STORAGE_ADDRESS_COLLISION", "Физический шаг выдал запись дважды", {
          owner: record.kind,
          id: record.id.slice(0, 256),
        });
      model.records.set(address, record);
    } catch (error) {
      absorb(blockers, error, physical.id);
    }
  for (const relation of snapshot.relations)
    model.relations.set(entityAddress(relation.owner), {
      owner: relation.owner,
      value: relation.value,
    });
  for (const space of snapshot.keyspaces) model.keyspaces.set(space.id, space);
  return { snapshot, model };
}

/**
 * Явный `status` исходной раскладки до формата 4 (ТЗ 5.1): весь постоянный набор читается
 * историческими схемами физического шага без исполнения преобразований и без записи.
 * Возвращает блокеры чтения; пусто — набор распознан.
 */
export async function historicalSourceBlockers(input: {
  readonly source: StorageSource;
  readonly target: SourceTarget;
  readonly registry: TransitionRegistry;
  readonly steps: readonly TransitionDefinition[];
  readonly owned: () => void;
}): Promise<StorageBlocker[]> {
  const physical = input.steps.find((step) => step.type === "physical");
  if (!physical) return [];
  const blockers = new Blockers();
  try {
    await readPhysicalModel(
      input.source,
      input.target,
      input.registry,
      physical,
      input.owned,
      blockers,
    );
  } catch (error) {
    if (!blockers.items.length) absorb(blockers, error, physical.id);
  }
  return blockers.items;
}

// ------------------------------------------------------------------------------------------
// Применение шагов
// ------------------------------------------------------------------------------------------

type StepOutcome = { counts: StepCounts; removals: Removal[] };

function projectIdOf(model: MigrationModel, source: StorageSource): string | null {
  const projects = [...model.records.values()].filter(
    (record) => record.kind === "project" && isLive(record),
  );
  if (projects.length === 1) return projects[0]!.id;
  return source.config?.projectId ?? null;
}

const ENVELOPE_FIXED = [
  "kind",
  "id",
  "key",
  "aliases",
  "revision",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "deleted",
  "comments",
  "commentSequence",
  "reservedKeys",
] as const;

/** Техническое преобразование не меняет идентичность, ревизию, авторство и комментарии. */
function sameEnvelope(before: StoredRecord, after: StoredRecord): boolean {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  return ENVELOPE_FIXED.every(
    (key) => digest(jsonValue(left[key] ?? null)) === digest(jsonValue(right[key] ?? null)),
  );
}

function applySnapshot(
  step: SnapshotTransition,
  registry: TransitionRegistry,
  model: MigrationModel,
  source: StorageSource,
  sourcePaths: ReadonlyMap<string, number>,
  blockers: Blockers,
): StepOutcome {
  const invalid = (message: string, details: Partial<StorageBlocker> = {}) =>
    storageError("STORAGE_TRANSITION_OUTPUT_INVALID", message, { step: step.id, ...details });
  const byKind = new Map<string, StoredRecord[]>();
  for (const record of model.records.values()) {
    const list = byKind.get(record.kind) ?? [];
    list.push(record);
    byKind.set(record.kind, list);
  }
  for (const list of byKind.values()) list.sort((a, b) => byText(a.id, b.id));
  const projectId = projectIdOf(model, source);
  const view: SnapshotView = {
    records: (kind) => structuredClone(byKind.get(kind) ?? []),
    relations: (owner) => {
      const set = model.relations.get(entityAddress(owner));
      return set ? structuredClone(set.value) : null;
    },
    keyspaces: () => structuredClone([...model.keyspaces.values()]),
    project: () => ({ id: projectId }),
  };
  const puts = new Map<string, StoredRecord>();
  const removes = new Map<string, { ref: EntityRef; category: string }>();
  const relationWrites = new Map<string, ModelRelation | null>();
  const sources: Removal[] = [];
  let failure: AppError | undefined;
  const fail = (error: AppError) => {
    failure ??= error;
    throw error;
  };
  const changes: ChangeSet = {
    put(record) {
      const address = entityAddress(refOf(record));
      const produced = step.produces[record.kind];
      if (typeof produced !== "number" || record.dataVersion !== produced || puts.has(address))
        fail(
          invalid("Шаг записал запись вне объявленного выхода", {
            owner: record.kind,
            id: record.id.slice(0, 256),
          }),
        );
      puts.set(address, structuredClone(record));
    },
    remove(ref, category) {
      const address = entityAddress(ref);
      if (!model.records.has(address) || !CATEGORY.test(category) || !(ref.kind in step.produces))
        fail(
          invalid("Шаг удалил неизвестную запись", { owner: ref.kind, id: ref.id.slice(0, 256) }),
        );
      removes.set(address, { ref: { ...ref }, category });
    },
    relations(owner, value) {
      if (value !== null) {
        const parsed = inlineEntriesSchema.safeParse(value);
        if (!parsed.success || entityAddress(parsed.data.owner) !== entityAddress(owner))
          fail(invalid("Шаг вернул набор отношений не в собранной форме", { owner: owner.kind }));
      }
      relationWrites.set(
        entityAddress(owner),
        value === null ? null : { owner: { ...owner }, value: structuredClone(value) },
      );
    },
    removeSource(path, category) {
      if (!sourcePaths.has(path) || !CATEGORY.test(category))
        fail(invalid("Шаг удалил неизвестный исходный файл"));
      sources.push({ path, category, bytes: sourcePaths.get(path)! });
    },
    newId: (seed) => deterministicId(step.id, seed),
  };
  try {
    step.apply(view, changes);
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof AppError) throw error;
    throw invalid("Шаг перехода завершился ошибкой");
  }
  // Выход шага: схема целевой версии, неизменная оболочка существующих записей.
  for (const [address, record] of puts) {
    const before = model.records.get(address);
    if ("deleted" in record) {
      if (before && !sameEnvelope(before, record))
        blockers.add(invalid("Шаг изменил оболочку надгробия", { owner: record.kind }));
      continue;
    }
    const schema = step.outputs[record.kind];
    if (!schema?.safeParse(record.data).success)
      blockers.add(
        invalid("Результат шага не соответствует схеме целевой версии", {
          owner: record.kind,
          id: record.id.slice(0, 256),
          expected: step.produces[record.kind] as number,
        }),
      );
    else if (before && !sameEnvelope(before, record))
      blockers.add(
        invalid("Шаг изменил идентичность, ревизию или авторство записи", {
          owner: record.kind,
          id: record.id.slice(0, 256),
        }),
      );
  }
  let checked = 0;
  for (const record of model.records.values())
    if (step.requires[record.kind] === record.dataVersion) checked++;
  let changed = 0;
  for (const [address, record] of puts) {
    const before = model.records.get(address);
    if (!before || digest(jsonValue(before)) !== digest(jsonValue(record))) changed++;
    model.records.set(address, record);
  }
  const removals: Removal[] = [...sources];
  for (const [address, { ref, category }] of removes) {
    model.records.delete(address);
    const path = `entities/${registry.catalog.entry(ref.kind)?.collection ?? ref.kind}/${ref.id}.json`;
    removals.push({ path, category, bytes: sourcePaths.get(path) ?? 0 });
  }
  for (const [address, value] of relationWrites) {
    if (value === null) model.relations.delete(address);
    else model.relations.set(address, value);
    changed++;
  }
  // Ни одна запись входной версии не должна остаться непреобразованной.
  for (const record of model.records.values())
    if (step.requires[record.kind] === record.dataVersion)
      blockers.add(
        invalid("Шаг оставил запись входной версии", {
          owner: record.kind,
          id: record.id.slice(0, 256),
          current: record.dataVersion,
        }),
      );
  return { counts: { checked, changed, removed: removals.length }, removals };
}

const sourcePathsOf = (source: StorageSource) =>
  new Set(
    source.entries
      .filter((entry) => entry.area === "config-root" && entry.type === "file")
      .map((entry) => entry.path),
  );

// ------------------------------------------------------------------------------------------
// Итоговые проверки и публикация в память
// ------------------------------------------------------------------------------------------

type Built = {
  changes: FileChange[];
  pages: Set<string>;
};

async function buildChanges(
  model: MigrationModel,
  input: PrepareInput,
  relationFiles: ReadonlyMap<string, string[]>,
  removals: readonly Removal[],
  blockers: Blockers,
): Promise<Built> {
  const { source, registry, owned } = input;
  const storage = registry.storage;
  const store = await EntityStore.detached(source.root, storage);
  const session = store.session();
  const sorted = [...model.records.values()].sort((a, b) =>
    byText(entityAddress(refOf(a)), entityAddress(refOf(b))),
  );
  // Удаляемые по правилу файлы и прежние файлы отношений — до записи нового состава.
  for (const removal of removals)
    try {
      // runtime/ не входит в WAL: служебные следы удаляет исполнитель после публикации.
      if (removal.path.startsWith("runtime/")) continue;
      await session.writeFile(removal.path, null);
    } catch (error) {
      sessionBlocker(blockers, error, { path: removal.path });
    }
  for (const files of relationFiles.values())
    for (const path of files) await session.writeFile(path, null);
  for (const record of sorted) {
    owned();
    const path = `entities/${registry.catalog.entry(record.kind)?.collection}/${record.id}.json`;
    try {
      if (storage.path(refOf(record)) !== path)
        throw storageError("STORAGE_TRANSITION_OUTPUT_INVALID", "Неверный ID-путь записи", {
          path,
        });
      await session.writeFile(path, jsonValue(record));
      await session.indexRecord(record);
    } catch (error) {
      sessionBlocker(blockers, error, { path, owner: record.kind, id: record.id });
    }
  }
  for (const space of [...model.keyspaces.values()].sort((a, b) => byText(a.id, b.id)))
    try {
      storage.definition(space.entityKind);
      await session.writeFile(`keyspaces/${space.id}.json`, jsonValue(space));
    } catch (error) {
      sessionBlocker(blockers, error, { path: `keyspaces/${space.id}.json` });
    }
  const relations = [...model.relations.values()].sort((a, b) =>
    byText(entityAddress(a.owner), entityAddress(b.owner)),
  );
  for (const { owner, value } of relations) {
    owned();
    const collection = registry.catalog.entry(owner.kind)?.collection ?? owner.kind;
    const base = `relations/${collection}/${owner.id}`;
    try {
      const set = inlineEntriesSchema.parse(value);
      const ids = new Set<string>();
      for (const entry of set.entries) {
        if (ids.has(entry.edge.id))
          throw storageError("STORAGE_ADDRESS_COLLISION", "Повтор ID ребра в наборе отношений", {
            path: `${base}.json`,
            id: entry.edge.id.slice(0, 256),
          });
        ids.add(entry.edge.id);
      }
      // Прежний файл по тому же адресу (иная раскладка) заменяется целиком.
      await session.writeFile(`${base}.json`, null);
      await writeOwnedRelations(
        session,
        owner,
        set.entries as unknown as Parameters<typeof writeOwnedRelations>[2],
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "STORAGE_ADDRESS_COLLISION")
        blockers.add(error);
      else
        sessionBlocker(blockers, error, { path: `${base}.json`, owner: owner.kind, id: owner.id });
    }
  }
  if (model.config !== null) {
    const configName = source.configPath.slice(source.root.length + 1);
    await session.writeFile(configName, jsonValue(model.config));
  }
  blockers.throwIfAny("Подготовленный результат не прошёл проверку");

  owned();
  const prepared = await session.prepare(randomUUID());
  const pages = new Set(
    prepared
      .filter((change) => SEGMENT_PATH.test(change.path) && change.after !== null)
      .map((change) => change.path),
  );
  const changes: FileChange[] = [];
  const existing = sourcePathsOf(source);
  for (const change of prepared) {
    if (SEGMENT_PATH.test(change.path)) {
      if (change.after === null) continue;
      // Страница по содержимому: уже существующая с тем же содержимым не меняется.
      if (existing.has(change.path))
        try {
          const hash = change.path.slice(-".json".length - 64, -".json".length);
          if (digest(await readJsonBytes(join(source.root, change.path))) === hash) continue;
        } catch {
          // Повреждённая страница переписывается.
        }
      changes.push(change);
      continue;
    }
    // Неизменённое содержимое не публикуется заново.
    if (change.after !== null && change.before && change.before === digest(change.after)) continue;
    if (change.after === null && change.before === null) continue;
    changes.push(change);
  }
  // Индексы перестраиваются полностью: прежние страницы и производный кеш удаляются в том же WAL.
  const changed = new Set(changes.map((change) => change.path));
  for (const entry of source.entries) {
    if (entry.area !== "config-root" || entry.type !== "file") continue;
    // Производные индексы любой раскладки (кроме новых страниц и состояния) удаляются.
    if (
      entry.category !== "indexes" ||
      pages.has(entry.path) ||
      entry.path === ".indexes/state.json"
    )
      continue;
    if (changed.has(entry.path)) continue;
    owned();
    try {
      changed.add(entry.path);
      changes.push({
        path: entry.path,
        after: null,
        before: digest(await readJsonBytes(join(source.root, entry.path))),
      });
    } catch {
      blockers.push("STORAGE_DATA_CORRUPT", "Страница прежнего индекса повреждена", {
        path: entry.path,
      });
    }
  }
  // Последним публикуется маркер целевого профиля реестра (фаза manifest WAL).
  let manifestBefore: string | null = null;
  if (sourcePathsOf(source).has(MANIFEST_PATH))
    try {
      manifestBefore = digest(await readJsonBytes(join(source.root, MANIFEST_PATH)));
    } catch {
      blockers.push("STORAGE_DATA_CORRUPT", "Маркер хранилища повреждён", { path: MANIFEST_PATH });
    }
  changes.push({
    path: MANIFEST_PATH,
    before: manifestBefore,
    after: jsonValue({
      ...currentManifest(model.productId ?? undefined),
      dataModelVersion: registry.profile.version,
    }),
  });
  blockers.throwIfAny("Подготовленный результат не прошёл проверку");
  return { changes, pages };
}

/** Комментарии исключены из предметного бюджета записи, как в WAL. */
function budgetValue(path: string, value: JsonValue | null): JsonValue | null {
  if (
    path.startsWith("entities/") &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === 3
  ) {
    const { comments: _comments, ...data } = value;
    return data;
  }
  return value;
}

function categoryOf(path: string, registry: TransitionRegistry, configName: string): string {
  if (path === configName) return "config";
  if (path === MANIFEST_PATH) return "manifest";
  if (path.startsWith(".indexes/")) return "indexes";
  const parts = path.split("/");
  if (parts[0] === "entities" && parts.length === 3)
    return `entities/${registry.catalog.kindOfCollection(parts[1]!) ?? "unknown"}`;
  if (parts[0] === "relations") return "relations";
  if (parts[0] === "keyspaces") return "keyspaces";
  return "other";
}

/** Пути итогового набора, допустимые в формате 4 (полный состав файлов после публикации). */
function allowedFinal(path: string, configName: string, registry: TransitionRegistry): boolean {
  if (path === configName || path === MANIFEST_PATH) return true;
  const parts = path.split("/");
  const name = parts[parts.length - 1]!;
  if ([".gitignore", ".gitkeep", ".DS_Store", "Thumbs.db"].includes(name)) return true;
  if (parts[0] === "runtime" || path === "transactions/pending.json") return true;
  if (path === ".indexes/state.json" || SEGMENT_PATH.test(path)) return true;
  if (parts[0] === "entities" || parts[0] === "relations")
    return registry.catalog.kindOfCollection(parts[1] ?? "") !== undefined;
  if (parts[0] === "keyspaces") return parts.length === 2 && name.endsWith(".json");
  return false;
}

// ------------------------------------------------------------------------------------------
// Вход
// ------------------------------------------------------------------------------------------

export async function prepareMigration(input: PrepareInput): Promise<PreparedMigration> {
  const { source, target, registry, steps, owned } = input;
  const blockers = new Blockers();
  const configName = source.configPath.slice(source.root.length + 1);
  const sourcePaths = new Map<string, number>(
    source.entries
      .filter((entry) => entry.area === "config-root" && entry.type === "file" && entry.managed)
      .map((entry) => [entry.path, entry.size]),
  );

  // 1. Модель источника.
  let model: MigrationModel;
  let relationFiles = new Map<string, string[]>();
  const removals: Removal[] = [];
  const nested: Record<string, number> = {};
  const outcomes: StorageMigrationStep[] = [];
  const physical = steps.find((step) => step.type === "physical");
  if (physical) {
    const read = await readPhysicalModel(source, target, registry, physical, owned, blockers);
    const snapshot = read.snapshot;
    model = read.model;
    for (const removal of snapshot.removeSources) {
      if (removal.area !== "config-root") continue;
      removals.push({
        path: removal.path,
        category: removal.category,
        bytes: sourcePaths.get(removal.path) ?? 0,
      });
    }
    // Прежние файлы отношений исходной раскладки, если физический шаг их не удалил.
    for (const [kind, count] of Object.entries(snapshot.removed))
      nested[kind] = (nested[kind] ?? 0) + count;
    outcomes.push(
      describeStep(
        physical,
        {
          checked: snapshot.records.length,
          changed: snapshot.records.length,
          removed: snapshot.removeSources.length,
        },
        [...new Set(snapshot.records.map((record) => record.kind))],
      ),
    );
  } else {
    const read = await readUnifiedModel(source, registry, owned, blockers);
    model = read.model;
    relationFiles = read.relationFiles;
  }
  blockers.throwIfAny("Источник не прочитан");
  const initialRelations = new Map(
    [...model.relations].map(([address, set]) => [address, structuredClone(set.value)]),
  );

  // 2. Предметные шаги в порядке плана.
  for (const step of steps) {
    if (step.type === "physical") continue;
    owned();
    if (step.type === "record") {
      let checked = 0,
        changed = 0;
      for (const [address, record] of [...model.records].sort(([a], [b]) => byText(a, b))) {
        if (record.kind !== step.owner || record.dataVersion !== step.from) continue;
        checked++;
        try {
          const next = applyRecordTransition(step, record);
          if (!sameEnvelope(record, next))
            throw storageError(
              "STORAGE_TRANSITION_OUTPUT_INVALID",
              "Шаг изменил идентичность записи",
              { step: step.id, owner: record.kind, id: record.id.slice(0, 256) },
            );
          if (digest(jsonValue(next)) !== digest(jsonValue(record))) changed++;
          model.records.set(address, next);
        } catch (error) {
          absorb(blockers, error, step.id);
        }
      }
      outcomes.push(describeStep(step, { checked, changed, removed: 0 }));
    } else {
      try {
        const outcome = applySnapshot(step, registry, model, source, sourcePaths, blockers);
        removals.push(...outcome.removals);
        outcomes.push(describeStep(step, outcome.counts));
      } catch (error) {
        absorb(blockers, error, step.id);
      }
    }
    blockers.throwIfAny(`Шаг ${step.id} неприменим`);
  }

  if (input.profileStep)
    outcomes.push({
      id: input.profileStep.id,
      version: input.profileStep.version,
      type: "profile",
      owners: [],
      records: { checked: model.records.size, changed: 0, removed: 0 },
    });

  // 3. Итоговые версии, адреса, комментарии.
  for (const record of model.records.values()) {
    const goal = registry.target(record.kind);
    if (goal !== record.dataVersion)
      blockers.push(
        "STORAGE_TRANSITION_OUTPUT_INVALID",
        goal === "removed"
          ? "Исторический вид не удалён шагами плана"
          : "Версия записи после шагов не равна целевой",
        {
          owner: record.kind,
          id: record.id.slice(0, 256),
          current: record.dataVersion,
          ...(goal === "removed" ? {} : { expected: goal }),
        },
      );
  }
  // Итоговая конфигурация: результат обязан открываться обычным Workspace.
  let finalConfig: unknown = model.config;
  if (finalConfig === null)
    try {
      finalConfig = await readJsonBytes(source.configPath);
    } catch {
      finalConfig = undefined; // отсутствие и повреждение уже диагностирует reader источника
    }
  if (finalConfig !== undefined && !registry.validConfig(finalConfig))
    blockers.push(
      "STORAGE_DATA_CORRUPT",
      "Конфигурация проекта не соответствует схеме целевой версии",
      { path: configName },
    );
  // Та же полная проверка, что у status и no-op текущей базы: адреса, комментарии, ссылки
  // владельцев и их взаимность, пространства ключей, концы и ID рёбер, идентичность проекта.
  blockers.items.push(
    ...integrityBlockers(
      {
        records: [...model.records.values()].map((record) =>
          recordFacts(record, recordPath(registry, record), registry),
        ),
        relations: model.relations.values(),
        keyspaces: model.keyspaces.values(),
        config:
          finalConfig === undefined
            ? null
            : { path: configName, projectId: configProjectId(finalConfig) },
      },
      registry,
    ),
  );
  blockers.throwIfAny("Подготовленный результат не прошёл проверку");

  // 4. Публикация в память: сессия над пустым снимком индексов строит индексы заново.
  const built = await buildChanges(model, input, relationFiles, removals, blockers);
  const changes = built.changes;

  // Полный состав после публикации: каждый исходный файл перенесён, удалён по правилу или допустим.
  const final = new Set(sourcePaths.keys());
  for (const change of changes)
    if (change.after === null) final.delete(change.path);
    else final.add(change.path);
  const recordPaths = new Set(
    [...model.records.values()].map(
      (record) => `entities/${registry.catalog.entry(record.kind)?.collection}/${record.id}.json`,
    ),
  );
  const rootEntries = new Map(
    source.entries
      .filter((item) => item.area === "config-root")
      .map((item) => [item.path, item] as const),
  );
  for (const path of [...final].sort()) {
    const entry = rootEntries.get(path);
    if (entry && !entry.persistent) continue;
    const stray =
      !allowedFinal(path, configName, registry) ||
      (path.startsWith("entities/") && !recordPaths.has(path));
    if (stray)
      blockers.push(
        "STORAGE_MIGRATION_CONFLICT",
        "Файл исходной раскладки не перенесён и не удалён правилом перехода",
        { path },
      );
  }

  // Файлы, от которых зависит результат, но которые публикация не меняет: их отпечатки
  // входят в WAL, чтобы recovery обнаружил удаление или правку после intent.
  const touched = new Set(changes.map((change) => change.path));
  const unchanged = source.entries
    .filter(
      (entry) =>
        entry.area === "config-root" &&
        entry.type === "file" &&
        entry.managed &&
        entry.persistent &&
        entry.sha256 !== null &&
        !touched.has(entry.path) &&
        !entry.path.startsWith("runtime/") &&
        !entry.path.startsWith("transactions/") &&
        persistentPathSchema.safeParse(entry.path).success,
    )
    .map((entry) => ({ path: entry.path, sha256: entry.sha256! }))
    .sort((a, b) => byText(a.path, b.path));

  // 5. Бюджеты до любых изменений базы (16 МиБ записи без комментариев, 128 МиБ WAL).
  const recordLimit = Math.min(input.limits?.recordBytes ?? RECORD_BYTES, RECORD_BYTES);
  const walLimit = Math.min(input.limits?.walBytes ?? WAL_BYTES, WAL_BYTES);
  const published = changes.filter((change) => !SEGMENT_PATH.test(change.path));
  // Те же ограничения путей, что у публикации WAL: dry-run ловит то же, что apply.
  const seen = new Set<string>();
  for (const change of published) {
    if (
      seen.has(change.path) ||
      change.path.startsWith("transactions/") ||
      change.path.startsWith("runtime/")
    )
      blockers.push(
        "STORAGE_TRANSITION_OUTPUT_INVALID",
        "Повторный или служебный путь в публикации",
        {
          path: change.path,
        },
      );
    seen.add(change.path);
  }
  let maxRecordBytes = 0;
  for (const change of published)
    if (change.after !== null) {
      const bytes = prettyBytes(budgetValue(change.path, change.after));
      maxRecordBytes = Math.max(maxRecordBytes, bytes);
      if (bytes > recordLimit)
        blockers.push(
          "STORAGE_LIMIT_EXCEEDED",
          "Предметные данные записи превышают предел записи",
          {
            path: change.path,
            current: bytes,
            expected: recordLimit,
          },
        );
    }
  const indexBytes = changes
    .filter((change) => SEGMENT_PATH.test(change.path))
    .reduce((sum, change) => sum + prettyBytes(change.after), 0);
  const writtenBytes = published.reduce(
    (sum, change) => sum + (change.after === null ? 0 : prettyBytes(change.after)),
    0,
  );

  // 6. Сводки плана и результата.
  const files: Record<string, { create: number; update: number; delete: number }> = {};
  const owners: PreparedMigration["counts"]["owners"] = {};
  const counter = (key: string) => (owners[key] ??= { checked: 0, changed: 0, removedByRule: 0 });
  const ruleCategory = new Map(removals.map((removal) => [removal.path, removal.category]));
  for (const change of changes) {
    const category = ruleCategory.get(change.path) ?? categoryOf(change.path, registry, configName);
    const bucket = (files[category] ??= { create: 0, update: 0, delete: 0 });
    const existed =
      change.before === undefined ? sourcePaths.has(change.path) : change.before !== null;
    if (change.after === null) bucket.delete++;
    else if (!existed) bucket.create++;
    else bucket.update++;
    counter(category).changed++;
  }
  // Служебные `.gitignore` постоянных каталогов исполнитель создаёт сразу после публикации
  // (вне WAL, A19); они входят в фактическую разность дерева и в счётчики плана.
  const services = SERVICE_IGNORES.filter((path) => !sourcePaths.has(path));
  for (const _path of services) {
    (files.service ??= { create: 0, update: 0, delete: 0 }).create++;
    counter("service").changed++;
  }
  for (const record of model.records.values()) counter(`entities/${record.kind}`).checked++;
  counter("relations").checked += model.relations.size;
  counter("keyspaces").checked += model.keyspaces.size;
  counter("manifest").checked++;
  if (model.config !== null) counter("config").checked++;
  const removedByRule = new Map<string, { count: number; bytes: number }>();
  for (const removal of removals) {
    const item = removedByRule.get(removal.category) ?? { count: 0, bytes: 0 };
    item.count++;
    item.bytes += removal.bytes;
    removedByRule.set(removal.category, item);
    counter(removal.category).removedByRule++;
  }
  for (const [category, count] of Object.entries(nested)) {
    if (!CATEGORY.test(category)) continue;
    const item = removedByRule.get(category) ?? { count: 0, bytes: 0 };
    item.count += count;
    removedByRule.set(category, item);
    counter(category).removedByRule += count;
  }

  let kept = 0,
    revoked = 0,
    created = 0;
  const before = new Map<string, boolean>();
  for (const value of initialRelations.values())
    for (const entry of inlineEntriesSchema.parse(value).entries)
      before.set(entry.edge.id, entry.edge.active);
  for (const set of model.relations.values())
    for (const entry of inlineEntriesSchema.parse(set.value).entries) {
      const prior = before.get(entry.edge.id);
      if (prior === undefined) created++;
      else if (prior && !entry.edge.active) revoked++;
      else kept++;
    }
  let reservedKept = 0,
    relocated = 0,
    entities = 0;
  for (const record of model.records.values()) {
    const codec = registry.storage.definition(record.kind);
    reservedKept += record.reservedKeys?.length ?? 0;
    if (!isLive(record)) {
      if (codec.addressable !== false)
        reservedKept += (record.key === null ? 0 : 1) + record.aliases.length;
      continue;
    }
    if (codec.relocation) relocated++;
    else if (codec.addressable !== false) entities++;
  }
  // Все файлы постоянного набора, созданные, изменённые или удалённые публикацией.
  const changedTotal = changes.length + services.length;
  const checkedTotal = model.records.size + model.relations.size + model.keyspaces.size;
  const removedTotal = [...removedByRule.values()].reduce((sum, item) => sum + item.count, 0);
  const resultDigest = digest(
    jsonValue({
      records: [...model.records.entries()].sort(([a], [b]) => byText(a, b)),
      relations: [...model.relations.entries()]
        .sort(([a], [b]) => byText(a, b))
        .map(([address, set]) => [address, set.value]),
      keyspaces: [...model.keyspaces.entries()].sort(([a], [b]) => byText(a, b)),
      config: model.config,
      productId: model.productId,
      published: published
        .filter((change) => change.path !== ".indexes/state.json")
        .map((change) => [change.path, change.after === null ? null : digest(change.after)])
        .sort(([a], [b]) => byText(String(a), String(b))),
    }),
  );

  // WAL ровно в той форме, что запишет публикация (тот же построитель и та же схема).
  // Неизвестны только UUID и отпечаток плана (фиксированной длины), путь копии (берётся
  // предельная длина) и необязательный отпечаток восстановленного WAL (учитывается всегда).
  const counts = {
    checked: checkedTotal,
    changed: changedTotal,
    removedByRule: removedTotal,
    owners: Object.fromEntries(Object.entries(owners).sort(([a], [b]) => byText(a, b))),
  };
  const zero = "0".repeat(64);
  const { staged, published: logged } = splitMigrationChanges(changes);
  const sizes = intentBytes(
    migrationIntentOf(
      logged.map((change) => ({ ...change, before: change.before ?? zero })),
      {
        id: "00000000-0000-4000-8000-000000000000",
        registryDigest: registry.digest,
        planFingerprint: zero,
        source: {
          layout: source.layout ?? "legacy",
          physical: source.physical,
          profile: source.profile,
        },
        target: { profile: registry.profile.version },
        transitions: [
          ...steps.map((step) => `${step.id}@${step.version}`),
          ...(input.profileStep ? [`${input.profileStep.id}@${input.profileStep.version}`] : []),
        ],
        backup: { path: `/${"x".repeat(4095)}`, manifestSha256: zero },
        report: { entities, steps: outcomes, counts },
        preRecovered: { walSha256: zero },
        unchanged,
      },
      staged,
    ),
  );
  const walBytes = sizes.budget;
  if (walBytes > walLimit)
    blockers.push(
      "STORAGE_LIMIT_EXCEEDED",
      "Предметные данные пакета публикации превышают предел WAL",
      { current: walBytes, expected: walLimit },
    );
  blockers.throwIfAny("Миграция превышает действующие пределы");

  return {
    changes,
    steps: outcomes,
    changesSummary: {
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => byText(a, b))),
      relations: { kept, revoked, created },
      addresses: { reservedKept, relocated },
    },
    removedByRule: [...removedByRule]
      .sort(([a], [b]) => byText(a, b))
      .map(([category, item]) => ({ category, ...item })),
    budgets: {
      maxRecordBytes,
      walBytes,
      indexBytes,
      backupBytes: 0,
      limits: { recordBytes: recordLimit, walBytes: walLimit },
    },
    // Фактический дисковый объём корня: новые файлы, страницы индекса дважды (временная
    // область и постоянные пути) и WAL целиком, вместе с комментариями.
    rootRequired: writtenBytes + 2 * indexBytes + sizes.disk,
    entities,
    counts,
    resultDigest,
    unchanged,
    runtimeRemovals: removals
      .filter((removal) => removal.path.startsWith("runtime/"))
      .map((removal) => removal.path),
  };
}
