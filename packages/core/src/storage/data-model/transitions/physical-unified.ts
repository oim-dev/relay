/**
 * Составной физический переход единого хранилища 1/2/3 → 4 (ТЗ 6.1 «составной переход»).
 *
 * Переход — чистая функция над прочитанной исходной раскладкой: читает только через
 * PhysicalSourceIo, не пишет, не берёт текущее время и не создаёт случайных ID. Записи
 * выходят в оболочке 3 с исходными dataVersion (например, план v1 и plan-stage v1 из 43d683b);
 * предметные переходы выполняют следующие шаги реестра.
 *
 * Происхождение форм (замороженные дисковые схемы, не импорт текущих):
 * - оболочка 1: `git show 90d7b26:packages/contracts/src/storage.ts` (без изменений до 43d683b);
 * - оболочка 2: `git show 3875aee:packages/contracts/src/storage.ts` (`receipts`, `reservedKeys?`,
 *   `comments?`, `commentSequence?`, `planningEvents?`);
 * - журнал формата 1 `operations/<uuid>.json` (90d7b26) и сегменты формата 2
 *   `history/<stream>/<first>.json` (68124da), индекс `.indexes` со страницами schemaVersion 1;
 * - наборы отношений inline/segments v1 не менялись (history/primitives-43d683b.ts).
 * Фикстуры: physical1-90d7b26, physical2-plan-v1-43d683b, physical2-v0.6.1-ec4a2cc, physical3-3875aee.
 *
 * Правила удаления (STORAGE «Что хранится и чего нет»): удаляются только распознанные
 * исторические структуры — файлы журнала формата 1/2 (после извлечения комментариев и
 * резервов адресов), квитанции `receipts` и `planningEvents` оболочки 2, производные
 * страницы индекса. Поля данных не очищаются по имени: лишнее поле — блокер.
 */
import { z } from "zod";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { storedCommentSchema, storedKeySpaceSchema } from "@relay/contracts/storage";
import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import type {
  StorageBlocker,
  StorageErrorDetails,
  StorageMaintenanceErrorCode,
} from "@relay/contracts/storage-maintenance";
import { AppError } from "../../../shared/errors.js";
import { digest, hashSchema, keyHash } from "../../entity-store/format.js";
import { storageError } from "../errors.js";
import { relationEntryV1 } from "../history/primitives-43d683b.js";
import type { RelationEntryV1 } from "../history/primitives-43d683b.js";
import type {
  PhysicalArea,
  PhysicalDirEntry,
  PhysicalRemovedSource,
  PhysicalSnapshot,
  PhysicalSourceIo,
  PhysicalTransition,
} from "../types.js";

export const PHYSICAL_UNIFIED_1 = "physical.unified-1-to-4";
export const PHYSICAL_UNIFIED_2 = "physical.unified-2-to-4";
export const PHYSICAL_UNIFIED_3 = "physical.unified-3-to-4";

const MAX_BLOCKERS = 50;
const STEP = { 1: PHYSICAL_UNIFIED_1, 2: PHYSICAL_UNIFIED_2, 3: PHYSICAL_UNIFIED_3 } as const;
const RECORD_BYTES = 16 * 1024 * 1024;

/* ------------------------------------------------------------------------------------------ */
/* Общие помощники физических переходов (используются и legacy-переходом).                    */
/* ------------------------------------------------------------------------------------------ */

type Details = Omit<StorageErrorDetails, "code" | "next"> & { next?: string };
type Reader = Pick<PhysicalSourceIo, "read" | "list">;

/** Ошибка физического шага с полным списком блокеров (первые MAX_BLOCKERS). */
export type PhysicalBlockersError = AppError & { blockers: readonly StorageBlocker[] };

/** Все блокеры ошибки физического шага; для обычной AppError хранилища — она одна. */
export function physicalBlockers(error: unknown): readonly StorageBlocker[] | undefined {
  if (error instanceof AppError && Array.isArray((error as PhysicalBlockersError).blockers))
    return (error as PhysicalBlockersError).blockers;
  return undefined;
}

const safeDetailPath = (path: string) =>
  path.length <= 1024 && path.split("/").every((part) => part && part !== "." && part !== "..");

/** Накопитель блокеров: перенос продолжает чтение, чтобы назвать все причины сразу. */
export class Problems {
  readonly errors: AppError[] = [];
  add(code: StorageMaintenanceErrorCode, message: string, details: Details = {}): void {
    const clean: Details = { ...details };
    if (clean.path !== undefined && !safeDetailPath(clean.path)) delete clean.path;
    if (clean.id !== undefined) clean.id = clean.id.slice(0, 256);
    this.errors.push(storageError(code, message, clean));
  }
  /** Ошибка хранилища добавляется как есть; прочие ошибки пробрасываются. */
  addError(error: unknown, details: Details = {}): void {
    if (!(error instanceof AppError)) throw error;
    const raw = (error.details ?? {}) as Record<string, unknown>;
    if (typeof raw.code === "string" && raw.code === error.code) {
      const merged = { ...raw, ...details } as Details & { code?: string };
      delete merged.code;
      this.add(error.code as StorageMaintenanceErrorCode, error.message, merged);
      return;
    }
    this.add("STORAGE_DATA_CORRUPT", error.message.slice(0, 512) || "Повреждённые данные", details);
  }
  get size(): number {
    return this.errors.length;
  }
  /**
   * Бросает первую причину; details.blockers и поле blockers содержат первые 50 причин.
   * Ничего не делает без причин.
   */
  throwIfAny(step?: string): void {
    if (!this.errors.length) return;
    const blockers = this.errors.slice(0, MAX_BLOCKERS).map((error) => {
      const details = (error.details ?? {}) as Record<string, unknown>;
      const { code: _code, reason: _reason, blockers: _nested, ...rest } = details;
      return {
        code: error.code,
        message: error.message.slice(0, 1024),
        ...(step && rest.step === undefined ? { step } : {}),
        ...rest,
      } as StorageBlocker;
    });
    const first = this.errors[0]!;
    const details = { ...((first.details ?? {}) as Record<string, unknown>) };
    delete details.code;
    const error = storageError(first.code as StorageMaintenanceErrorCode, first.message, {
      ...(details as Details),
      ...(step && details.step === undefined ? { step } : {}),
      blockers,
    } as Details) as PhysicalBlockersError;
    error.blockers = blockers;
    throw error;
  }
}

/** JSON с проверкой UTF-8; undefined — повреждение. */
export function decodeJson(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Чтение JSON через io. missing — файла нет; corrupt — JSON/UTF-8/размер повреждены
 * (блокер уже записан). Символические ссылки и чужие ошибки io пробрасываются как есть.
 */
export async function readJsonFile(
  io: Reader,
  owned: () => void,
  problems: Problems,
  path: string,
  area: PhysicalArea = "config-root",
  maxBytes = RECORD_BYTES,
): Promise<{ state: "ok"; value: unknown } | { state: "missing" } | { state: "corrupt" }> {
  owned();
  const bytes = await io.read(path, area);
  owned();
  if (bytes === null) return { state: "missing" };
  if (bytes.byteLength > maxBytes) {
    problems.add("STORAGE_LIMIT_EXCEEDED", "Исходный файл превышает допустимый размер записи", {
      path,
    });
    return { state: "corrupt" };
  }
  const value = decodeJson(bytes);
  if (value === undefined) {
    problems.add("STORAGE_DATA_CORRUPT", "Некорректный JSON или UTF-8 в исходном файле", { path });
    return { state: "corrupt" };
  }
  return { state: "ok", value };
}

export async function listDir(
  io: Reader,
  owned: () => void,
  path: string,
  area: PhysicalArea = "config-root",
): Promise<readonly PhysicalDirEntry[]> {
  owned();
  const entries = await io.list(path, area);
  owned();
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const recordAddress = (ref: EntityRef) => `${ref.kind}:${ref.id}`;

/** Детерминированный порядок результата: вид, затем ID по кодовым точкам. */
export function sortSnapshot(
  snapshot: Omit<PhysicalSnapshot, "removed"> & { removed: Map<string, number> },
): PhysicalSnapshot {
  return {
    records: [...snapshot.records].sort(
      (a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.id, b.id),
    ),
    relations: [...snapshot.relations].sort((a, b) =>
      byCodePoint(recordAddress(a.owner), recordAddress(b.owner)),
    ),
    keyspaces: [...snapshot.keyspaces].sort((a, b) => byCodePoint(a.id, b.id)),
    config: snapshot.config,
    productId: snapshot.productId,
    removeSources: [...snapshot.removeSources].sort(
      (a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.path, b.path),
    ),
    removed: Object.fromEntries(
      [...snapshot.removed].filter(([, count]) => count > 0).sort(([a], [b]) => byCodePoint(a, b)),
    ),
  };
}

export function count(removed: Map<string, number>, category: string, amount = 1): void {
  removed.set(category, (removed.get(category) ?? 0) + amount);
}

/* ------------------------------------------------------------------------------------------ */
/* Журнал форматов 1/2 и индекс ожидаемых файлов.                                             */
/* ------------------------------------------------------------------------------------------ */

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const entityRef = z.strictObject({ kind: token, id: token });
const relativePath = z
  .string()
  .refine(
    (path) =>
      /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
      path.split("/").every((part) => part !== "." && part !== ".."),
  );
const manifestV12 = z.strictObject({
  format: z.literal("relay-entities"),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  productId: z.string().optional(),
});
const indexedSchema = z.strictObject({
  kind: z.literal("indexed"),
  index: z.string(),
  key: z.string(),
  value: z.json(),
  groups: z.array(
    z.strictObject({
      index: z.string(),
      key: z.string(),
      member: z.string().nullable().optional(),
    }),
  ),
});
const entrySchema = z.strictObject({
  at: z.iso.datetime(),
  actor: z.string().min(1),
  namespace: z.string(),
  requestId: z.string().min(1),
  requestHash: z.string(),
  result: z.json(),
  refs: z.array(entityRef),
  events: z.array(z.json()),
});
const operationSchema = entrySchema.extend({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  changes: z.array(
    z.strictObject({
      path: relativePath,
      before: z.json().nullable(),
      after: z.json().nullable(),
    }),
  ),
});
const segmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  first: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(entrySchema).min(1).max(128),
});
const indexPageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("leaf"),
    entries: z
      .array(z.tuple([z.string(), z.json()]))
      .min(1)
      .max(1024),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("branch"),
    children: z.record(z.string().regex(/^[a-f0-9]$/), hashSchema),
  }),
]);
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  roots: z.record(z.string(), hashSchema.nullable()),
});

export type UnifiedIndexedEvent = z.output<typeof indexedSchema>;
export type UnifiedJournalOperation = z.output<typeof entrySchema> & {
  id: string;
  schemaVersion: 1 | 2;
  sourcePath: string;
  indexed: UnifiedIndexedEvent[];
  changes?: z.output<typeof operationSchema>["changes"];
};
export type UnifiedJournal = {
  version: 1 | 2;
  operations: UnifiedJournalOperation[];
  segments: Array<{ path: string; segment: z.output<typeof segmentSchema> }>;
  /** Все прочитанные файлы, включая маркер и индекс; НЕ список удаления. */
  files: Array<{ path: string; hash: string }>;
  /** Только проверенные операции/сегменты. Неизвестные файлы сюда не включаются. */
  sourceFiles: Array<{ path: string; hash: string }>;
  /** Корни индекса прежнего состояния (для резервов адресов). */
  roots: Record<string, string | null>;
};

const OPERATION_PATH = /^operations\/([a-f0-9-]{36})\.json$/;
const HISTORY_PATH = /^history\/([a-f0-9-]{36})\/([0-9]{16})\.json$/;

class JournalFailure {
  constructor(readonly error: AppError) {}
}
const fail = (code: StorageMaintenanceErrorCode, message: string, details: Details = {}): never => {
  throw new JournalFailure(storageError(code, message, details));
};

/** Чтение одного JSON журнала с отпечатком; повреждение и отсутствие — отказ. */
async function journalRead(
  io: Reader,
  owned: () => void,
  files: Map<string, string>,
  path: string,
): Promise<JsonValue> {
  if (!relativePath.safeParse(path).success)
    fail("STORAGE_UNSAFE_PATH", "Небезопасный путь источника журнала");
  owned();
  const bytes = await io.read(path, "config-root");
  owned();
  if (bytes === null)
    fail("STORAGE_RECORD_MISSING", "Ожидаемый источник миграции отсутствует", { path });
  if (bytes!.byteLength > RECORD_BYTES)
    fail("STORAGE_LIMIT_EXCEEDED", "Источник журнала превышает допустимый размер", { path });
  const value = decodeJson(bytes!);
  const parsed = z.json().safeParse(value);
  if (value === undefined || !parsed.success)
    fail("STORAGE_DATA_CORRUPT", "Некорректный JSON или UTF-8 источника журнала", { path });
  files.set(path, digest(parsed.data!));
  return parsed.data!;
}

/** Все записи индекса (ключ → значение) по корню; страницы проверяются отпечатком. */
async function indexEntries(
  io: Reader,
  owned: () => void,
  files: Map<string, string>,
  rootHash: string,
): Promise<Map<string, JsonValue>> {
  const result = new Map<string, JsonValue>();
  const visit = async (hash: string, prefix: string): Promise<void> => {
    if (prefix.length > 64)
      fail("STORAGE_DATA_CORRUPT", "Слишком глубокий индекс источников", {
        path: ".indexes/state.json",
      });
    const path = `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;
    const raw = await journalRead(io, owned, files, path);
    if (digest(raw) !== hash) fail("STORAGE_DATA_CORRUPT", "Повреждён индекс источников", { path });
    const page = indexPageSchema.safeParse(raw);
    if (!page.success) fail("STORAGE_DATA_CORRUPT", "Страница индекса не распознана", { path });
    const data = page.data!;
    if (data.type === "branch") {
      for (const [nibble, child] of Object.entries(data.children).sort(([a], [b]) =>
        byCodePoint(a, b),
      ))
        await visit(child, prefix + nibble);
      return;
    }
    for (const [key, value] of data.entries) {
      if (result.has(key) || !keyHash(key).startsWith(prefix))
        fail("STORAGE_DATA_CORRUPT", "Неверный адрес или повтор ключа индекса", { path });
      result.set(key, value);
    }
  };
  await visit(rootHash, "");
  return result;
}

/**
 * Журнал операций форматов 1/2: все проиндексированные операции/сегменты с проверкой
 * отпечатков. Неиндексированный файл со служебным именем — STORAGE_INDEX_STALE; посторонние
 * имена не читаются и не становятся кандидатами удаления (их блокирует проверка раскладки).
 */
export async function readUnifiedJournal(io: Reader, owned: () => void): Promise<UnifiedJournal> {
  try {
    return await readJournal(io, owned);
  } catch (error) {
    if (error instanceof JournalFailure) throw error.error;
    throw error;
  }
}

async function readJournal(io: Reader, owned: () => void): Promise<UnifiedJournal> {
  const files = new Map<string, string>();
  const manifest = manifestV12.safeParse(await journalRead(io, owned, files, "storage.json"));
  if (!manifest.success)
    fail("STORAGE_FORMAT_UNKNOWN", "Маркер не соответствует формату 1/2", {
      path: "storage.json",
    });
  const version = manifest.data!.schemaVersion;
  const state = stateSchema.safeParse(await journalRead(io, owned, files, ".indexes/state.json"));
  if (!state.success)
    fail("STORAGE_DATA_CORRUPT", "Состояние индексов повреждено", { path: ".indexes/state.json" });
  const roots = state.data!.roots;
  const fileRoot = roots["file-hashes"];
  if (fileRoot === undefined)
    fail("STORAGE_RECORD_MISSING", "Отсутствует индекс ожидаемых файлов", {
      path: ".indexes/state.json",
    });
  const expected = new Map<string, string>();
  if (fileRoot)
    for (const [key, value] of await indexEntries(io, owned, files, fileRoot)) {
      if (!key.startsWith("operations/") && !key.startsWith("history/")) continue;
      const match = version === 1 ? OPERATION_PATH.exec(key) : HISTORY_PATH.exec(key);
      if (!match || !z.uuid().safeParse(match[1]).success)
        fail("STORAGE_DATA_CORRUPT", "Неожиданный путь источника для версии базы", {
          ...(safeDetailPath(key) ? { path: key } : {}),
        });
      const hash = hashSchema.safeParse(value);
      if (!hash.success)
        fail("STORAGE_DATA_CORRUPT", "Неверный отпечаток источника в индексе", { path: key });
      expected.set(key, hash.data!);
    }

  const discovered = (path: string) => {
    if (!expected.has(path))
      fail("STORAGE_INDEX_STALE", "Обнаружен неиндексированный источник журнала", { path });
  };
  for (const entry of await listDir(io, owned, "operations"))
    if (OPERATION_PATH.test(`operations/${entry.name}`)) discovered(`operations/${entry.name}`);
  for (const stream of await listDir(io, owned, "history"))
    if (stream.type === "dir" && z.uuid().safeParse(stream.name).success)
      for (const entry of await listDir(io, owned, `history/${stream.name}`))
        if (HISTORY_PATH.test(`history/${stream.name}/${entry.name}`))
          discovered(`history/${stream.name}/${entry.name}`);

  const operations: UnifiedJournalOperation[] = [];
  const segments: UnifiedJournal["segments"] = [];
  const sourceFiles: UnifiedJournal["sourceFiles"] = [];
  const ends = new Map<string, number>();
  const add = (
    entry: z.output<typeof entrySchema>,
    id: string,
    path: string,
    schemaVersion: 1 | 2,
    changes?: UnifiedJournalOperation["changes"],
  ) => {
    const indexed: UnifiedIndexedEvent[] = [];
    for (const event of entry.events) {
      // В формате 1 неиндексированные события остаются в events, но не в indexed.
      if (
        schemaVersion === 1 &&
        (event === null ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          event.kind !== "indexed")
      )
        continue;
      const parsed = indexedSchema.safeParse(event);
      if (!parsed.success)
        fail("STORAGE_DATA_CORRUPT", "Событие журнала не распознано", { path, id });
      indexed.push(parsed.data!);
    }
    operations.push({
      ...entry,
      id,
      schemaVersion,
      sourcePath: path,
      indexed,
      ...(changes === undefined ? {} : { changes }),
    });
  };
  for (const [path, hash] of [...expected].sort(([a], [b]) => byCodePoint(a, b))) {
    const raw = await journalRead(io, owned, files, path);
    if (digest(raw) !== hash)
      fail("STORAGE_INDEX_STALE", "Источник журнала изменён вне Core; выполните reindex", { path });
    if (version === 1) {
      const operation = operationSchema.safeParse(raw);
      if (!operation.success || path !== `operations/${operation.data.id}.json`)
        fail("STORAGE_DATA_CORRUPT", "Операция журнала не распознана или не совпадает с путём", {
          path,
        });
      add(operation.data!, operation.data!.id, path, 1, operation.data!.changes);
    } else {
      const segment = segmentSchema.safeParse(raw);
      if (!segment.success) fail("STORAGE_DATA_CORRUPT", "Сегмент истории не распознан", { path });
      const match = HISTORY_PATH.exec(path)!;
      const stream = match[1]!;
      const data = segment.data!;
      const end = data.first + (data.entries.length - 1);
      if (Number(match[2]) !== data.first || !Number.isSafeInteger(end))
        fail("STORAGE_DATA_CORRUPT", "Неверный номер или диапазон сегмента", { path });
      if (data.first <= (ends.get(stream) ?? 0))
        fail("STORAGE_DATA_CORRUPT", "Пересекаются диапазоны сегментов истории", { path });
      ends.set(stream, end);
      segments.push({ path, segment: data });
      data.entries.forEach((entry, offset) =>
        add(entry, `${stream}:${data.first + offset}`, path, 2),
      );
    }
    sourceFiles.push({ path, hash });
  }
  owned();
  return {
    version,
    operations,
    segments,
    sourceFiles,
    files: [...files].map(([path, hash]) => ({ path, hash })),
    roots,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Записи, отношения и пространства ключей.                                                   */
/* ------------------------------------------------------------------------------------------ */

const key = z.string().min(1).max(512);
const timestamp = z.iso.datetime();
const actor = z.string().min(1).max(512);
const identityV1 = {
  dataVersion: z.number().int().positive(),
  kind: token,
  id: token,
  revision: z.number().int().nonnegative(),
  key: key.nullable(),
  aliases: z.array(key),
};
const deleted = z.strictObject({ at: timestamp, actor });
const meta = { createdAt: timestamp, createdBy: actor, updatedAt: timestamp, updatedBy: actor };
const data = z.record(z.string(), z.json());
/** Оболочка 1 (90d7b26…43d683b): live или надгробие, строго. */
const envelopeV1 = z.union([
  z.strictObject({ schemaVersion: z.literal(1), ...identityV1, data, ...meta }),
  z.strictObject({ schemaVersion: z.literal(1), ...identityV1, deleted }),
]);
/** Квитанция оболочки 2 (`storedReceiptSchema` 3875aee). */
const receiptV2 = z.strictObject({
  namespace: z.string(),
  actor,
  requestId: z.string().min(1),
  requestHash: z.string(),
  result: z.json(),
});
/** Предметное событие плана/релиза оболочки 2 (`storedPlanningEventSchema` 3875aee). */
const planningEventV2 = z.strictObject({
  revision: z.number().int().nonnegative(),
  actor,
  at: timestamp,
  action: z.string(),
  description: z.array(z.string()).optional(),
});
const identityV2 = {
  ...identityV1,
  receipts: z.array(receiptV2).optional(),
  reservedKeys: z.array(key).optional(),
  comments: z.array(z.json()).optional(),
  commentSequence: z.number().int().nonnegative().optional(),
  planningEvents: z.array(planningEventV2).optional(),
};
/** Оболочка 2 (3875aee): квитанции и события планирования внутри записи. */
const envelopeV2 = z.union([
  z.strictObject({ schemaVersion: z.literal(2), ...identityV2, data, ...meta }),
  z.strictObject({ schemaVersion: z.literal(2), ...identityV2, deleted }),
]);
const PLANNING_EVENT_OWNERS = new Set(["work-plan", "release"]);

/** Наборы отношений v1 (relations.ts, без изменений 43d683b…HEAD). */
const ownerSetSchema = z.discriminatedUnion("storage", [
  z.strictObject({
    schemaVersion: z.literal(1),
    owner: entityRef,
    storage: z.literal("inline"),
    entries: z.array(relationEntryV1),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    owner: entityRef,
    storage: z.literal("segments"),
    segments: z.record(z.string().regex(/^[0-9a-f]{1,64}$/), hashSchema),
  }),
]);
const shardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: entityRef,
  entries: z.array(relationEntryV1),
});

type Mutable = Record<string, JsonValue> & { comments?: JsonValue[] };

/** Записи entities/*: проверка пути, оболочки исходной версии и перевод в оболочку 3. */
async function readRecords(
  io: PhysicalSourceIo,
  owned: () => void,
  physical: 1 | 2 | 3,
  problems: Problems,
  removed: Map<string, number>,
): Promise<Map<string, Mutable>> {
  const records = new Map<string, Mutable>();
  for (const collection of await listDir(io, owned, "entities")) {
    const at = `entities/${collection.name}`;
    if (collection.type !== "dir") {
      problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в каталоге записей", { path: at });
      continue;
    }
    const kind = io.catalog.kindOfCollection(collection.name);
    if (!kind) {
      problems.add("UNKNOWN_ENTITY_KIND", "Коллекция записей неизвестна реестру", { path: at });
      continue;
    }
    for (const file of await listDir(io, owned, at)) {
      const path = `${at}/${file.name}`;
      if (file.type !== "file" || !file.name.endsWith(".json")) {
        problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в каталоге записей", { path });
        continue;
      }
      // Как обычное чтение Core: файл записи не ограничен целиком, потому что накопленная
      // лента комментариев имеет отдельные правила. Предел 16 МиБ применяется к предметным
      // данным без комментариев ниже и к итоговой записи при подготовке публикации.
      const read = await readJsonFile(
        io,
        owned,
        problems,
        path,
        "config-root",
        Number.POSITIVE_INFINITY,
      );
      if (read.state === "missing") {
        problems.add("STORAGE_RECORD_MISSING", "Запись исчезла во время чтения", { path });
        continue;
      }
      if (read.state !== "ok") continue;
      const raw = read.value as Record<string, unknown> | null;
      const version =
        raw && typeof raw === "object" && !Array.isArray(raw) ? raw.schemaVersion : undefined;
      // Формат 1/2 писал только оболочку 1; формат 3 переписывал записи в оболочку 2,
      // но оставшаяся оболочка 1 однозначно различима литералом schemaVersion.
      const allowed = physical === 3 ? [1, 2] : [1];
      if (typeof version !== "number" || !allowed.includes(version)) {
        problems.add(
          version === 3 ? "STORAGE_DATA_CORRUPT" : "STORAGE_FORMAT_UNKNOWN",
          "Версия оболочки записи не соответствует формату базы",
          {
            path,
            owner: kind,
            ...(typeof version === "number" ? { current: version } : {}),
          },
        );
        continue;
      }
      const { comments: _comments, ...budgeted } = raw as Record<string, unknown>;
      const budget = Buffer.byteLength(`${JSON.stringify(budgeted, null, 2)}\n`);
      if (budget > RECORD_BYTES) {
        problems.add(
          "STORAGE_LIMIT_EXCEEDED",
          "Предметные данные записи без комментариев превышают 16 МиБ",
          { path, owner: kind, current: budget, expected: RECORD_BYTES },
        );
        continue;
      }
      const parsed = (version === 1 ? envelopeV1 : envelopeV2).safeParse(raw);
      if (!parsed.success) {
        problems.add("STORAGE_DATA_CORRUPT", "Оболочка записи не соответствует своей версии", {
          path,
          owner: kind,
        });
        continue;
      }
      const record = parsed.data as Record<string, JsonValue>;
      if (record.kind !== kind || `${String(record.id)}.json` !== file.name) {
        problems.add("STORAGE_DATA_CORRUPT", "Вид или ID записи не соответствует её пути", {
          path,
          owner: kind,
        });
        continue;
      }
      const { receipts, planningEvents, ...rest } = record as Record<string, JsonValue> & {
        receipts?: JsonValue[];
        planningEvents?: JsonValue[];
      };
      if (planningEvents !== undefined && !PLANNING_EVENT_OWNERS.has(kind)) {
        problems.add(
          "STORAGE_FORMAT_UNKNOWN",
          "События планирования у вида, который их не хранил",
          { path, owner: kind },
        );
        continue;
      }
      if (receipts?.length) count(removed, "record-receipts", receipts.length);
      if (planningEvents?.length) count(removed, "planning-events", planningEvents.length);
      records.set(`${kind}:${String(record.id)}`, { ...rest, schemaVersion: 3 });
    }
  }
  return records;
}

/** Комментарий задачи: строгая текущая схема (формы оболочки 2 и журнала совпадают). */
function commentOf(value: unknown): JsonValue | undefined {
  const parsed = storedCommentSchema.safeParse(value);
  return parsed.success ? (parsed.data as unknown as JsonValue) : undefined;
}

function mergeComment(record: Mutable, comment: JsonValue, problems: Problems, path: string): void {
  const id = (comment as { id: string }).id;
  const list = (record.comments ??= []);
  const prior = list.find((entry) => (entry as { id: string }).id === id);
  if (prior && digest(prior) !== digest(comment)) {
    problems.add("STORAGE_MIGRATION_CONFLICT", "Разные комментарии имеют один ID", {
      path,
      owner: "task",
      id: String(record.id),
    });
    return;
  }
  if (!prior) list.push(comment);
}

/** Журнал 1/2: комментарии, последовательности и резервы адресов становятся состоянием. */
function applyJournal(
  journal: UnifiedJournal,
  reserved: readonly string[],
  records: Map<string, Mutable>,
  problems: Problems,
  removed: Map<string, number>,
): void {
  const reserveKeys = new Set<string>();
  for (const operation of journal.operations) {
    for (const event of operation.indexed) {
      if (event.index === "task-activity-event") {
        const value = z
          .looseObject({
            action: z.string(),
            taskId: z.string(),
            sequence: z.number().int().positive(),
          })
          .safeParse(event.value);
        if (!value.success) {
          problems.add("STORAGE_DATA_CORRUPT", "Событие ленты задачи не распознано", {
            path: operation.sourcePath,
          });
          continue;
        }
        const owner = records.get(`task:${value.data.taskId}`);
        // Комментарии и номер ленты переносятся и в надгробие: так же сохраняет их текущее
        // удаление задачи (оболочка надгробия содержит comments/commentSequence).
        if (value.data.action !== "comment-publish") {
          if (owner)
            owner.commentSequence = Math.max(
              Number(owner.commentSequence ?? 0),
              value.data.sequence,
            );
          count(removed, "journal-events");
          continue;
        }
        const comment = commentOf(event.value);
        if (!comment) {
          problems.add("STORAGE_DATA_CORRUPT", "Комментарий в журнале не распознан", {
            path: operation.sourcePath,
          });
          continue;
        }
        if (!owner) {
          problems.add(
            "STORAGE_MIGRATION_CONFLICT",
            "Потерян владелец пользовательского комментария",
            { path: operation.sourcePath, owner: "task", id: value.data.taskId },
          );
          continue;
        }
        owner.commentSequence = Math.max(Number(owner.commentSequence ?? 0), value.data.sequence);
        mergeComment(owner, comment, problems, operation.sourcePath);
      } else if (event.index === "reserved-key") reserveKeys.add(event.key);
      else count(removed, "journal-events");
    }
  }
  for (const key of reserved) reserveKeys.add(key);
  if (reserveKeys.size) reserveInProject(records, [...reserveKeys], problems);
}

/** Резервы адресов без владельца переносятся в запись единственного проекта. */
export function reserveInProject(
  records: Map<string, Mutable>,
  keys: readonly string[],
  problems: Problems,
): void {
  const projects = [...records.values()].filter(
    (record) => record.kind === "project" && !("deleted" in record),
  );
  if (projects.length !== 1) {
    problems.add("STORAGE_MIGRATION_CONFLICT", "Резерв адресов требует единственного проекта", {
      owner: "project",
    });
    return;
  }
  const project = projects[0]!;
  const current = Array.isArray(project.reservedKeys) ? (project.reservedKeys as string[]) : [];
  project.reservedKeys = [...new Set([...current, ...keys])];
}

/** Комментарии по последовательности; проверка оболочки и данных версии каталогом. */
function finishRecords(
  io: PhysicalSourceIo,
  records: Map<string, Mutable>,
  problems: Problems,
): StoredRecord[] {
  const output: StoredRecord[] = [];
  for (const [address, record] of records) {
    if (Array.isArray(record.comments)) {
      for (const comment of record.comments)
        if (!commentOf(comment))
          problems.add("STORAGE_DATA_CORRUPT", "Комментарий задачи не распознан", {
            owner: String(record.kind),
            id: String(record.id),
          });
      const ids = new Set(record.comments.map((entry) => (entry as { id: string }).id));
      if (ids.size !== record.comments.length)
        problems.add("STORAGE_MIGRATION_CONFLICT", "Повтор ID комментария задачи", {
          owner: String(record.kind),
          id: String(record.id),
        });
      record.comments.sort(
        (a, b) => (a as { sequence: number }).sequence - (b as { sequence: number }).sequence,
      );
      const top = Math.max(
        0,
        ...record.comments.map((entry) => (entry as { sequence: number }).sequence),
      );
      if (record.comments.length)
        record.commentSequence = Math.max(Number(record.commentSequence ?? 0), top);
    }
    try {
      output.push(io.catalog.validateRecord(record));
    } catch (error) {
      const [kind, ...rest] = address.split(":");
      const collection = io.catalog.collectionOf(kind!);
      problems.addError(error, {
        owner: kind!,
        id: rest.join(":"),
        ...(collection ? { path: `entities/${collection}/${rest.join(":")}.json` } : {}),
      });
    }
  }
  return output;
}

export async function readKeyspaces(
  io: PhysicalSourceIo,
  owned: () => void,
  problems: Problems,
): Promise<StoredKeySpace[]> {
  const output: StoredKeySpace[] = [];
  for (const entry of await listDir(io, owned, "keyspaces")) {
    const path = `keyspaces/${entry.name}`;
    if (entry.type !== "file" || !entry.name.endsWith(".json")) {
      if (entry.name === ".gitkeep") continue;
      problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в каталоге пространств ключей", {
        path,
      });
      continue;
    }
    const read = await readJsonFile(io, owned, problems, path);
    if (read.state !== "ok") continue;
    const parsed = storedKeySpaceSchema.safeParse(read.value);
    if (!parsed.success || `${parsed.data.id}.json` !== entry.name) {
      problems.add("STORAGE_DATA_CORRUPT", "Пространство ключей повреждено", { path });
      continue;
    }
    output.push(parsed.data);
  }
  return output;
}

/** Наборы отношений: inline как есть, сегменты собираются с проверкой отпечатков и диапазонов. */
export async function readRelationSets(
  io: PhysicalSourceIo,
  owned: () => void,
  problems: Problems,
): Promise<{ owner: EntityRef; value: JsonValue }[]> {
  const output: { owner: EntityRef; value: JsonValue }[] = [];
  const edgeOwners = new Map<string, string>();
  for (const collection of await listDir(io, owned, "relations")) {
    // Производный индекс отношений (в том числе остаток прежней раскладки) не переносится.
    if (collection.name === ".indexes" || collection.name === ".gitignore") continue;
    const at = `relations/${collection.name}`;
    if (collection.type !== "dir") {
      problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в каталоге отношений", {
        path: at,
      });
      continue;
    }
    const kind = io.catalog.kindOfCollection(collection.name);
    if (!kind) {
      problems.add("UNKNOWN_ENTITY_KIND", "Владелец набора связей не зарегистрирован", {
        path: at,
      });
      continue;
    }
    const listing = await listDir(io, owned, at);
    const segmentDirs = new Set(
      listing.filter((entry) => entry.type === "dir").map((entry) => entry.name),
    );
    const usedDirs = new Set<string>();
    for (const file of listing) {
      if (file.type === "dir") continue;
      const path = `${at}/${file.name}`;
      if (file.type !== "file" || !file.name.endsWith(".json")) {
        problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в каталоге отношений", { path });
        continue;
      }
      const id = file.name.slice(0, -".json".length);
      const read = await readJsonFile(io, owned, problems, path);
      if (read.state !== "ok") continue;
      const parsed = ownerSetSchema.safeParse(read.value);
      if (!parsed.success || parsed.data.owner.kind !== kind || parsed.data.owner.id !== id) {
        problems.add("STORAGE_DATA_CORRUPT", "Набор отношений повреждён или чужой", {
          path,
          owner: kind,
        });
        continue;
      }
      const set = parsed.data;
      const owner = { kind, id };
      let entries: RelationEntryV1[];
      if (set.storage === "inline") entries = set.entries;
      else {
        entries = [];
        usedDirs.add(id);
        const shards = new Set<string>();
        for (const [prefix, hash] of Object.entries(set.segments).sort(([a], [b]) =>
          byCodePoint(a, b),
        )) {
          const shardPath = `${at}/${id}/${prefix}.json`;
          shards.add(`${prefix}.json`);
          const shardRead = await readJsonFile(io, owned, problems, shardPath);
          if (shardRead.state === "missing") {
            problems.add("STORAGE_RECORD_MISSING", "Потерян сегмент набора отношений", {
              path: shardPath,
              owner: kind,
            });
            continue;
          }
          if (shardRead.state !== "ok") continue;
          const shard = shardSchema.safeParse(shardRead.value);
          if (
            !shard.success ||
            digest(shard.data as unknown as JsonValue) !== hash ||
            recordAddress(shard.data.owner) !== recordAddress(owner) ||
            !shard.data.entries.every((entry) => keyHash(entry.edge.id).startsWith(prefix))
          ) {
            problems.add("STORAGE_DATA_CORRUPT", "Сегмент набора отношений повреждён", {
              path: shardPath,
              owner: kind,
            });
            continue;
          }
          entries.push(...shard.data.entries);
        }
        if (!segmentDirs.has(id)) continue;
        for (const extra of await listDir(io, owned, `${at}/${id}`))
          if (!shards.has(extra.name) && extra.name !== ".gitkeep")
            problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный файл в сегментах отношений", {
              path: `${at}/${id}/${extra.name}`,
            });
      }
      const ids = new Set<string>();
      for (const entry of entries) {
        if (ids.has(entry.edge.id))
          problems.add("STORAGE_DATA_CORRUPT", "Повтор ID в наборе связей", {
            path,
            id: entry.edge.id,
          });
        ids.add(entry.edge.id);
        const prior = edgeOwners.get(entry.edge.id);
        if (prior !== undefined && prior !== recordAddress(owner))
          problems.add("STORAGE_MIGRATION_CONFLICT", "ID связи занят другим владельцем", {
            path,
            id: entry.edge.id,
          });
        edgeOwners.set(entry.edge.id, recordAddress(owner));
      }
      output.push({
        owner,
        value: {
          schemaVersion: 1,
          owner,
          storage: "inline",
          entries: entries as unknown as JsonValue[],
        },
      });
    }
    for (const directory of segmentDirs)
      if (!usedDirs.has(directory))
        problems.add("STORAGE_FORMAT_UNKNOWN", "Каталог сегментов без манифеста владельца", {
          path: `${at}/${directory}`,
        });
  }
  return output;
}

/** Страницы прежнего индекса — производные; новый индекс строит исполнитель. */
async function derivedIndexPages(
  io: PhysicalSourceIo,
  owned: () => void,
  problems: Problems,
): Promise<PhysicalRemovedSource[]> {
  const output: PhysicalRemovedSource[] = [];
  for (const shard of await listDir(io, owned, ".indexes/segments")) {
    if (shard.type !== "dir" || !/^[0-9a-f]{2}$/.test(shard.name)) {
      problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в страницах индекса", {
        path: `.indexes/segments/${shard.name}`,
      });
      continue;
    }
    for (const page of await listDir(io, owned, `.indexes/segments/${shard.name}`)) {
      const path = `.indexes/segments/${shard.name}/${page.name}`;
      if (page.type !== "file" || !/^[0-9a-f]{64}\.json$/.test(page.name)) {
        problems.add("STORAGE_FORMAT_UNKNOWN", "Неизвестный объект в страницах индекса", { path });
        continue;
      }
      output.push({ path, area: "config-root", category: "derived-index" });
    }
  }
  return output;
}

/** Каталог журнала другой версии формата или постороннее имя внутри него — блокер. */
async function checkJournalLayout(
  io: PhysicalSourceIo,
  owned: () => void,
  physical: 1 | 2 | 3,
  problems: Problems,
): Promise<void> {
  for (const entry of await listDir(io, owned, "operations")) {
    const path = `operations/${entry.name}`;
    if (entry.name === ".gitkeep") continue;
    if (physical !== 1 || entry.type !== "file" || !OPERATION_PATH.test(path))
      problems.add("STORAGE_FORMAT_UNKNOWN", "Журнал операций не соответствует формату базы", {
        path,
      });
  }
  for (const stream of await listDir(io, owned, "history")) {
    const path = `history/${stream.name}`;
    if (physical !== 2 || stream.type !== "dir" || !z.uuid().safeParse(stream.name).success) {
      problems.add("STORAGE_FORMAT_UNKNOWN", "История операций не соответствует формату базы", {
        path,
      });
      continue;
    }
    for (const entry of await listDir(io, owned, path))
      if (entry.type !== "file" || !HISTORY_PATH.test(`${path}/${entry.name}`))
        problems.add("STORAGE_FORMAT_UNKNOWN", "История операций не соответствует формату базы", {
          path: `${path}/${entry.name}`,
        });
  }
}

const manifestFor = (physical: 1 | 2 | 3) =>
  z.strictObject({
    format: z.literal("relay-entities"),
    schemaVersion: z.literal(physical),
    productId: z.string().optional(),
  });

/** Чистое чтение единой раскладки 1/2/3 в снимок формата 4. */
export async function readUnifiedSnapshot(
  io: PhysicalSourceIo,
  owned: () => void,
  physical: 1 | 2 | 3,
): Promise<PhysicalSnapshot> {
  const problems = new Problems();
  const removed = new Map<string, number>();
  const manifestRead = await readJsonFile(io, owned, problems, "storage.json");
  if (manifestRead.state === "missing")
    problems.add("STORAGE_FORMAT_MISSING", "Маркер storage.json отсутствует", {
      path: "storage.json",
    });
  const manifest =
    manifestRead.state === "ok" ? manifestFor(physical).safeParse(manifestRead.value) : undefined;
  if (manifestRead.state === "ok" && !manifest?.success)
    problems.add("STORAGE_FORMAT_UNKNOWN", "Маркер не соответствует исходному формату перехода", {
      path: "storage.json",
      expected: physical,
    });
  problems.throwIfAny(STEP[physical]);

  await checkJournalLayout(io, owned, physical, problems);
  let journal: UnifiedJournal | undefined;
  if (physical < 3)
    try {
      journal = await readUnifiedJournal(io, owned);
    } catch (error) {
      problems.addError(error);
    }
  const records = await readRecords(io, owned, physical, problems, removed);

  // Резервы адресов прежнего индекса (если он их вёл) — постоянное содержание.
  const reserved: string[] = [];
  if (journal?.roots["reserved-key"]) {
    try {
      const entries = await indexEntries(io, owned, new Map(), journal.roots["reserved-key"]);
      reserved.push(...[...entries.keys()].sort(byCodePoint));
    } catch (error) {
      problems.addError(error instanceof JournalFailure ? error.error : error);
    }
  } else if (physical === 3) {
    const state = await readJsonFile(io, owned, problems, ".indexes/state.json");
    const parsed = state.state === "ok" ? stateSchema.safeParse(state.value) : undefined;
    const root = parsed?.success ? parsed.data.roots["reserved-key"] : undefined;
    if (root)
      try {
        reserved.push(...[...(await indexEntries(io, owned, new Map(), root)).keys()].sort());
      } catch (error) {
        problems.addError(error instanceof JournalFailure ? error.error : error);
      }
  }
  if (journal) applyJournal(journal, reserved, records, problems, removed);
  else if (reserved.length) reserveInProject(records, reserved, problems);

  const keyspaces = await readKeyspaces(io, owned, problems);
  const relations = await readRelationSets(io, owned, problems);
  const removeSources: PhysicalRemovedSource[] = [
    ...(journal?.sourceFiles ?? []).map((file) => ({
      path: file.path,
      area: "config-root" as const,
      category: physical === 1 ? "operation-journal" : "history-journal",
    })),
    ...(await derivedIndexPages(io, owned, problems)),
  ];
  for (const entry of await listDir(io, owned, "runtime"))
    if (entry.name === "history-writer.json" && entry.type === "file")
      removeSources.push({
        path: "runtime/history-writer.json",
        area: "config-root",
        category: "journal-writer-state",
      });
  const output = finishRecords(io, records, problems);
  problems.throwIfAny(STEP[physical]);
  return sortSnapshot({
    records: output,
    relations,
    keyspaces,
    config: null,
    productId: manifest?.success ? (manifest.data.productId ?? null) : null,
    removeSources,
    removed,
  });
}

function unifiedTransition(
  id: string,
  layout: "unified-1" | "unified-2" | "unified-3",
  physical: 1 | 2 | 3,
  description: string,
): PhysicalTransition {
  return Object.freeze({
    type: "physical" as const,
    id,
    version: 1,
    description,
    from: layout,
    to: "unified-4" as const,
    read: (io: PhysicalSourceIo, owned: () => void) => readUnifiedSnapshot(io, owned, physical),
  });
}

export const physicalUnified1 = unifiedTransition(
  PHYSICAL_UNIFIED_1,
  "unified-1",
  1,
  "Единое хранилище 1 (90d7b26): оболочка 1 → 3, комментарии и резервы из operations/, журнал удаляется",
);
export const physicalUnified2 = unifiedTransition(
  PHYSICAL_UNIFIED_2,
  "unified-2",
  2,
  "Единое хранилище 2 (68124da…ec4a2cc): оболочка 1 → 3, комментарии и резервы из history/, журнал удаляется",
);
export const physicalUnified3 = unifiedTransition(
  PHYSICAL_UNIFIED_3,
  "unified-3",
  3,
  "Единое хранилище 3 (3875aee): оболочка 2 → 3, квитанции и события планирования записей удаляются",
);
