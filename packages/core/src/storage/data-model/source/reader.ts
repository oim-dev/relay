import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  StorageBlocker,
  StorageLayout,
  StorageMaintenanceErrorCode,
  StorageStatus,
  StorageStatusKind,
  StorageWarning,
} from "@relay/contracts/storage-maintenance";
import { storageStatusSchema } from "@relay/contracts/storage-maintenance";
import { AppError, isErrno } from "../../../shared/errors.js";
import { digest, hashSchema, keyHash } from "../../entity-store/format.js";
import { indexSegmentSchema } from "../../entity-store/hash-index.js";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import { PRE_RELEASE_WAL_NEXT, STORAGE_NEXT, storageCommand, storageError } from "../errors.js";
export { PRE_RELEASE_WAL_NEXT };
import { CURRENT_PHYSICAL_FORMAT, MANIFEST_PATH, parseStorageManifest } from "../manifest.js";
import type { StorageManifest } from "../manifest.js";
import { UNMARKED_DATA_MODEL } from "../profiles.js";
import { runtimeDirectory } from "../../lock.js";
import { edgeIndexRoots } from "../../entity-store/relations.js";
import type { TransitionRegistry } from "../registry.js";
import type { DataTransition, PhysicalTransition } from "../types.js";
import { withMaintenanceLock } from "./maintenance-lock.js";
import { readUnifiedSets } from "./unified-sets.js";
import { integrityBlockers, recordFacts } from "../plan/integrity.js";
import type { RecordFacts } from "../plan/integrity.js";
import type { MaintenanceLockOptions } from "./maintenance-lock.js";

/**
 * Минимальный диагностический reader постоянного набора для status и dry-run.
 *
 * Читает сырую конфигурацию (без текущей схемы проекта) и manifest, определяет раскладку,
 * инвентаризирует все файлы с размерами и sha256, классифицирует их и считает записи по видам
 * и версиям. Не открывает Workspace/EntityStore, не выполняет recovery, reindex, mkdir и cleanup;
 * ничего не пишет. Замок обслуживания берёт вызывающий (`inspectStorageSource` или исполнитель).
 */

export type SourceArea = "config-root" | "storage-root";
export type SourceCategory =
  | "config"
  | "manifest"
  | "entities"
  | "relations"
  | "keyspaces"
  | "indexes"
  | "transactions"
  | "service-journal"
  | "runtime"
  | "lock"
  | "service"
  | "legacy-source"
  | "legacy-derived"
  | "legacy-transactions"
  | "unknown"
  | "outside";

export type SourceEntry = {
  readonly area: SourceArea;
  /** POSIX-путь относительно корня области. */
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "other";
  /** Размер файла в байтах; 0 для каталогов. */
  readonly size: number;
  /** sha256 байтов файла; null для каталогов и не прочитанных объектов. */
  readonly sha256: string | null;
  readonly category: SourceCategory;
  /** Внутри управляемой области базы. */
  readonly managed: boolean;
  /** Входит в постоянный набор и в planFingerprint (runtime и замки — нет). */
  readonly persistent: boolean;
  /** Вид записи или владельца набора отношений. */
  readonly owner?: string;
};

export type SourceRecord = {
  readonly path: string;
  readonly kind: string;
  readonly id: string;
  readonly dataVersion: number;
  readonly envelope: number;
  readonly deleted: boolean;
};

export type StoragePendingKind = NonNullable<StorageStatus["pending"]>["kind"];

export type SourcePending = {
  readonly kind: StoragePendingKind;
  readonly path: string;
  readonly area: SourceArea;
};

export type SourceConfig = {
  readonly version: number;
  readonly projectId: string | null;
  readonly storageDir: string | null;
};

export type StorageSource = {
  /** Абсолютный путь конфигурации: реальный каталог + исходное имя файла. */
  readonly configPath: string;
  /** Реальный корень базы (каталог конфигурации). */
  readonly root: string;
  /** Реальный каталог legacy-данных, если он вне корня; иначе null. */
  readonly storageRoot: string | null;
  /** Сырые поля конфигурации для раскладки и идентичности; null — файла нет или он повреждён. */
  readonly config: SourceConfig | null;
  /** Раскладка; null — не распознана (формат новее, неизвестный или повреждённый маркер). */
  readonly layout: StorageLayout | null;
  /** storage.json.schemaVersion; null — маркера нет. */
  readonly physical: number | null;
  /** Значение поля dataModelVersion; null — поля нет. */
  readonly dataModel: number | null;
  /** Профиль: 1 для формата 4 без поля; null — до формата 4 или не распознан. */
  readonly profile: number | null;
  readonly manifest: StorageManifest | null;
  readonly pending: readonly SourcePending[];
  readonly entries: readonly SourceEntry[];
  readonly records: readonly SourceRecord[];
  /** Вид → найденные версии данных; вход `registry.plan`. */
  readonly present: ReadonlyMap<string, ReadonlySet<number>>;
  /** Вид → версия → количества. */
  readonly counts: ReadonlyMap<string, ReadonlyMap<number, { live: number; tombstones: number }>>;
  readonly envelopes: readonly number[];
  readonly blockers: readonly StorageBlocker[];
  readonly warnings: readonly StorageWarning[];
  /**
   * Потерянные или повреждённые страницы рабочих индексов (кроме `file-hashes`) при целых
   * источниках истины. Для базы без шагов — блокеры с действием `storage reindex`; перенос
   * перестраивает индексы сам, поэтому для него это предупреждения.
   */
  readonly indexIssues: readonly StorageBlocker[];
};

export type ReadSourceOptions = {
  readonly registry: TransitionRegistry;
  /** Проверка владения замком перед каждым чтением. */
  readonly owned?: () => void;
};

export type SourceTarget = {
  readonly configPath: string;
  readonly root: string;
  /** Каталог legacy-данных из storageDir (для замка legacy-writers); null — не legacy. */
  readonly legacyStorage: string | null;
  /** Тот же каталог, если он вне корня и инвентаризируется отдельной областью. */
  readonly storageRoot: string | null;
  readonly config: SourceConfig | null;
};

const CONFIG_NAME = "config.json";
const UNIFIED_NAMES = new Set([
  MANIFEST_PATH,
  "entities",
  "relations",
  "keyspaces",
  ".indexes",
  "transactions",
  "runtime",
  "operations",
  "history",
]);
/** Каталоги и файлы прежних legacy-репозиториев в каталоге конфигурации. */
const LEGACY_NAMES = new Set([
  "product",
  "boards",
  "task-activity",
  "relations",
  "entity-deletions",
  "relations.json",
  "kanban-pending.json",
  "tasks",
  "operations",
  "history",
  "runtime",
]);
/** Незавершённые журналы legacy-репозиториев. */
const LEGACY_PENDING = [
  /^product\/\.transactions\/pending\.json$/,
  /^product\/\.transactions\/document-links\.json$/,
  /^relations\/transactions\/pending\.json$/,
  /^relations\/transactions\/migration\.json$/,
  /^kanban-pending\.json$/,
  /^boards\/\.pending-applications\/[^/]+\.json$/,
  /^entity-deletions\/pending\.json$/,
];
const LEGACY_DERIVED = new Set(["product/.indexes/catalog.json"]);
/** Служебные файлы VCS/ОС: сохраняются, в fingerprint входят, блокером не являются. */
const SERVICE_NAMES = new Set([".gitignore", ".gitkeep", ".DS_Store", "Thumbs.db"]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OPERATION_PATH = new RegExp(`^operations/${UUID}\\.json$`);
const HISTORY_PATH = new RegExp(`^history/${UUID}/[0-9]{16}\\.json$`);
const SEGMENT_PATH = /^\.indexes\/segments\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/;
const UNSUPPORTED_CODES = new Set<StorageMaintenanceErrorCode>([
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_TRANSITION_MISSING",
  "UNKNOWN_ENTITY_KIND",
  "STORAGE_FORMAT_UNKNOWN",
]);
const LIST_LIMIT = 50;
/** Следующее действие при WAL миграции предварительной сборки (без итога плана). */
const STATE_FILE = ".indexes/state.json";
const INDEX_STALE_PATH = "runtime/index-stale.json";

const configShape = z.looseObject({
  version: z.number(),
  projectId: z.string().optional(),
  storageDir: z.string().optional(),
});
const envelopeShape = z.looseObject({
  schemaVersion: z.number().int(),
  dataVersion: z.number().int(),
  kind: z.string(),
  id: z.string(),
});
const segmentShape = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("leaf"),
    entries: z.array(z.tuple([z.string(), z.json()])),
  }),
  z.looseObject({
    type: z.literal("branch"),
    children: z.record(z.string(), hashSchema),
  }),
]);
const stateShape = z.looseObject({ roots: z.record(z.string(), hashSchema.nullable()) });

/**
 * Блокер несовместимого маркера: повреждённый, неизвестный или более новый `storage.json`,
 * либо версия новее поддерживаемой (конфигурация, записи). Такую базу нельзя ни восстанавливать,
 * ни переносить этой сборкой, даже при незавершённом WAL.
 */
export const incompatibleMarker = (blocker: StorageBlocker) =>
  blocker.path === MANIFEST_PATH ||
  (blocker.code === "STORAGE_VERSION_UNSUPPORTED" && blocker.path !== "transactions/pending.json");

/** Блокер по общей форме details ошибок хранилища. */
export function sourceBlocker(
  code: StorageMaintenanceErrorCode,
  message: string,
  details: Partial<
    Pick<StorageBlocker, "owner" | "step" | "path" | "id" | "current" | "expected">
  > & {
    next?: string;
  } = {},
): StorageBlocker {
  return blockerOf(storageError(code, message, details));
}

/** Блокер из AppError хранилища; прочие ошибки пробрасываются. */
export function blockerOf(error: unknown): StorageBlocker {
  if (!(error instanceof AppError)) throw error;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const pick = <K extends string>(key: K) =>
    details[key] === undefined ? {} : { [key]: details[key] };
  const code = (
    typeof details.code === "string" ? details.code : error.code
  ) as StorageBlocker["code"];
  return {
    code,
    message: error.message.slice(0, 1024),
    ...pick("owner"),
    ...pick("step"),
    ...pick("path"),
    ...pick("id"),
    ...pick("current"),
    ...pick("expected"),
    next: typeof details.next === "string" ? details.next : STORAGE_NEXT.status,
  } as StorageBlocker;
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const toPosix = (path: string) => path.split(sep).join("/");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safePath = (path: string) =>
  path.length <= 1024 &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function decodeJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

/**
 * Определяет конфигурацию и корень без чтения текущей схемы проекта.
 * Путь к файлу конфигурации любого имени или к каталогу корня (тогда ожидается config.json).
 */
export async function resolveSourceTarget(path: string): Promise<SourceTarget> {
  const absolute = resolve(path);
  let configPath: string;
  const info = await stat(absolute).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  });
  if (info?.isDirectory()) configPath = join(await realpath(absolute), CONFIG_NAME);
  else {
    const directory = await realpath(dirname(absolute)).catch((error: unknown) => {
      if (isErrno(error, "ENOENT"))
        throw new AppError("CONFIG_NOT_FOUND", "Каталог конфигурации не найден", 2);
      throw error;
    });
    configPath = join(directory, basename(absolute));
  }
  const root = dirname(configPath);
  const config = await readSourceConfig(configPath);
  const marker =
    (await exists(join(root, MANIFEST_PATH))) ||
    (await exists(join(root, "transactions/pending.json")));
  if (config === undefined && !marker)
    throw new AppError(
      "CONFIG_NOT_FOUND",
      "Конфигурация не найдена. Передайте --config с путём к файлу проекта",
      2,
    );
  let storageRoot: string | null = null;
  let legacyStorage: string | null = null;
  if (!marker && config?.storageDir) {
    const storage = resolve(root, config.storageDir);
    legacyStorage = await realpath(storage).catch(() => storage);
    const inside = legacyStorage === root || legacyStorage.startsWith(`${root}${sep}`);
    storageRoot = inside ? null : legacyStorage;
  }
  return { configPath, root, legacyStorage, storageRoot, config: config ?? null };
}

/** undefined — файла нет; null — повреждён или не похож на конфигурацию проекта. */
async function readSourceConfig(configPath: string): Promise<SourceConfig | null | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(configPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const decoded = decodeJson(bytes);
  if (!decoded.ok) return null;
  if (
    decoded.value !== null &&
    typeof decoded.value === "object" &&
    "projects" in decoded.value &&
    !("storageDir" in decoded.value)
  )
    throw storageError(
      "STORAGE_UNSAFE_PATH",
      "Передана конфигурация рабочего пространства; укажите конфигурацию проекта",
      { reason: "workspace-config" },
    );
  const parsed = configShape.safeParse(decoded.value);
  if (!parsed.success) return null;
  return {
    version: parsed.data.version,
    projectId: parsed.data.projectId ?? null,
    storageDir: parsed.data.storageDir ?? null,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

type Walked = { path: string; type: SourceEntry["type"]; size: number; bytes: Uint8Array | null };

/**
 * lstat-обход без перехода по symlink; каталоги замка не раскрываются. Каждый объект
 * передаётся `take` сразу после чтения: байты файла не удерживаются после его обработки,
 * поэтому в памяти одновременно находится один файл, а не всё дерево.
 */
async function walk(
  base: string,
  owned: () => void,
  descend: (path: string) => boolean,
  take: (item: Walked) => Promise<void>,
): Promise<void> {
  const visit = async (path: string) => {
    owned();
    const absolute = path ? join(base, path) : base;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return take({ path, type: "symlink", size: 0, bytes: null });
    if (info.isDirectory()) {
      if (path) await take({ path, type: "dir", size: 0, bytes: null });
      if (path && !descend(path)) return;
      for (const name of (await readdir(absolute)).sort())
        await visit(path ? `${path}/${name}` : name);
      return;
    }
    if (!info.isFile()) return take({ path, type: "other", size: 0, bytes: null });
    owned();
    const bytes = await readFile(absolute);
    await take({ path, type: "file", size: bytes.byteLength, bytes });
  };
  await visit("");
}

type Classified = { category: SourceCategory; managed: boolean; owner?: string; unknown?: string };

/** Классификация пути единого хранилища по раскладке. */
function classifyUnified(
  path: string,
  type: SourceEntry["type"],
  physical: number | null,
  configName: string,
  registry: TransitionRegistry,
): Classified {
  const parts = path.split("/");
  const top = parts[0]!;
  const name = parts[parts.length - 1]!;
  if (path === configName) return { category: "config", managed: true };
  if (!UNIFIED_NAMES.has(top) && !LEGACY_NAMES.has(top))
    return { category: "outside", managed: false };
  if (type === "dir") {
    if (top === "runtime" && parts[1] === "write.lock") return { category: "lock", managed: true };
    return { category: categoryOfTop(top), managed: true };
  }
  if (top === "runtime")
    return parts[1] === "write.lock"
      ? { category: "lock", managed: true }
      : { category: "runtime", managed: true };
  if (SERVICE_NAMES.has(name)) return { category: "service", managed: true };
  if (path === MANIFEST_PATH) return { category: "manifest", managed: true };
  if (top === "entities") {
    if (parts.length !== 3 || !name.endsWith(".json"))
      return unknown("entities", "Неизвестный файл в каталоге записей");
    const kind = kindOf(registry, parts[1]!);
    if (!kind) return { category: "entities", managed: true, unknown: "kind" };
    return { category: "entities", managed: true, owner: kind };
  }
  if (top === "relations") {
    if (parts[1] === ".indexes") return { category: "indexes", managed: true };
    const shape =
      (parts.length === 3 && name.endsWith(".json")) ||
      (parts.length === 4 && /^[0-9a-f]{1,64}\.json$/.test(name));
    if (!shape) return unknown("relations", "Неизвестный файл в каталоге отношений");
    const kind = kindOf(registry, parts[1]!);
    if (!kind) return { category: "relations", managed: true, unknown: "kind" };
    return { category: "relations", managed: true, owner: kind };
  }
  if (top === "keyspaces")
    return parts.length === 2 && name.endsWith(".json")
      ? { category: "keyspaces", managed: true }
      : unknown("keyspaces", "Неизвестный файл в каталоге пространств ключей");
  if (top === ".indexes")
    return path === ".indexes/state.json" ||
      path === ".indexes/product-catalog.json" ||
      SEGMENT_PATH.test(path)
      ? { category: "indexes", managed: true }
      : unknown("indexes", "Неизвестный файл в каталоге индексов");
  if (top === "transactions")
    return path === "transactions/pending.json"
      ? { category: "transactions", managed: true }
      : unknown("transactions", "Неизвестный файл в каталоге транзакций");
  if (top === "operations")
    return physical === 1 && OPERATION_PATH.test(path)
      ? { category: "service-journal", managed: true }
      : unknown("service-journal", "Журнал операций не соответствует формату базы");
  if (top === "history")
    return physical === 2 && HISTORY_PATH.test(path)
      ? { category: "service-journal", managed: true }
      : unknown("service-journal", "История операций не соответствует формату базы");
  if (LEGACY_DERIVED.has(path)) return { category: "legacy-derived", managed: true };
  if (LEGACY_PENDING.some((pattern) => pattern.test(path)))
    return { category: "legacy-transactions", managed: true };
  return unknown("legacy-source", "Файл прежнего формата рядом с единым хранилищем");
}

function classifyLegacy(
  path: string,
  type: SourceEntry["type"],
  configName: string,
  extra: string | null,
  runtime: string | null,
): Classified {
  const parts = path.split("/");
  const top = parts[0]!;
  const name = parts[parts.length - 1]!;
  if (path === configName) return { category: "config", managed: true };
  for (const directory of ["runtime", runtime])
    if (directory && (path === directory || path.startsWith(`${directory}/`)))
      return {
        category:
          path === `${directory}/write.lock` || path.startsWith(`${directory}/write.lock/`)
            ? "lock"
            : "runtime",
        managed: true,
      };
  if (!LEGACY_NAMES.has(top) && top !== extra) return { category: "outside", managed: false };
  if (type === "dir") return { category: "legacy-source", managed: true };
  if (SERVICE_NAMES.has(name)) return { category: "service", managed: true };
  if (LEGACY_DERIVED.has(path)) return { category: "legacy-derived", managed: true };
  if (LEGACY_PENDING.some((pattern) => pattern.test(path)))
    return { category: "legacy-transactions", managed: true };
  if (!name.endsWith(".json"))
    return unknown("legacy-source", "Неизвестный файл в каталоге прежних данных");
  return { category: "legacy-source", managed: true };
}

function categoryOfTop(top: string): SourceCategory {
  switch (top) {
    case "entities":
      return "entities";
    case "relations":
      return "relations";
    case "keyspaces":
      return "keyspaces";
    case ".indexes":
      return "indexes";
    case "transactions":
      return "transactions";
    case "runtime":
      return "runtime";
    case "operations":
    case "history":
      return "service-journal";
    default:
      return "legacy-source";
  }
}

function unknown(category: SourceCategory, reason: string): Classified {
  return { category, managed: true, unknown: reason };
}

function kindOf(registry: TransitionRegistry, collection: string): string | undefined {
  try {
    return registry.kindOfCollection(collection);
  } catch {
    return undefined;
  }
}

/** Чтение постоянного набора по уже определённой цели; вызывать под замком обслуживания. */
export async function readStorageSource(
  target: SourceTarget,
  options: ReadSourceOptions,
): Promise<StorageSource> {
  const owned = options.owned ?? (() => {});
  const { registry } = options;
  const blockers: StorageBlocker[] = [];
  const warnings: StorageWarning[] = [];
  const configName = toPosix(relative(target.root, target.configPath));
  const root = target.root;

  // Раскладка: manifest (исторические схемы через parseStorageManifest) или legacy.
  let manifest: StorageManifest | null = null;
  let physical: number | null = null;
  let dataModel: number | null = null;
  let layout: StorageLayout | null = null;
  let manifestFailed = false;
  const manifestPresent = await exists(join(root, MANIFEST_PATH));
  const pendingPresent = await exists(join(root, "transactions/pending.json"));
  if (manifestPresent) {
    owned();
    const decoded = decodeJson(await readFile(join(root, MANIFEST_PATH)));
    if (!decoded.ok) {
      manifestFailed = true;
      blockers.push(
        sourceBlocker("STORAGE_DATA_CORRUPT", "Маркер хранилища: некорректный JSON или UTF-8", {
          path: MANIFEST_PATH,
        }),
      );
    } else {
      const raw = decoded.value as Record<string, unknown> | null;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if (Number.isInteger(raw.schemaVersion)) physical = raw.schemaVersion as number;
        if (Number.isInteger(raw.dataModelVersion)) dataModel = raw.dataModelVersion as number;
      }
      try {
        manifest = parseStorageManifest(decoded.value, registry.profile.version);
        physical = manifest.schemaVersion;
        dataModel = manifest.dataModelVersion ?? null;
        layout = `unified-${manifest.schemaVersion}` as StorageLayout;
      } catch (error) {
        manifestFailed = true;
        blockers.push(blockerOf(error));
      }
    }
  } else if (!pendingPresent && (await exists(join(root, "entities/projects"))))
    blockers.push(
      sourceBlocker("STORAGE_FORMAT_MISSING", "Маркер storage.json потерян при наличии записей", {
        path: MANIFEST_PATH,
      }),
    );
  else if (!pendingPresent) layout = "legacy";
  // Без маркера и с WAL раскладку определит recovery, а не диагностика.
  const profile =
    physical === CURRENT_PHYSICAL_FORMAT && !manifestFailed
      ? (dataModel ?? UNMARKED_DATA_MODEL)
      : null;
  const unified = layout !== "legacy";

  // Конфигурация: только раскладка и идентичность; текущая схема проекта не применяется.
  if (target.config === null && (await exists(target.configPath)))
    blockers.push(
      sourceBlocker(
        "STORAGE_DATA_CORRUPT",
        "Конфигурация проекта: некорректный JSON или структура",
        { path: configName },
      ),
    );
  else if (target.config === null && !pendingPresent)
    blockers.push(
      sourceBlocker("STORAGE_RECORD_MISSING", "Файл конфигурации проекта отсутствует", {
        path: configName,
      }),
    );
  else if (target.config && target.config.version !== 1)
    blockers.push(
      target.config.version > 1
        ? sourceBlocker("STORAGE_VERSION_UNSUPPORTED", "Версия конфигурации новее поддерживаемой", {
            path: configName,
            current: target.config.version,
            expected: 1,
          })
        : sourceBlocker("STORAGE_FORMAT_UNKNOWN", "Неизвестная версия конфигурации", {
            path: configName,
          }),
    );

  // Каталоги legacy-writers внутри корня: storageDir и его runtime.
  const insideRoot = (path: string | null): string | null => {
    if (!path) return null;
    const rel = toPosix(relative(root, path));
    return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : null;
  };
  const legacyExtra = unified ? null : (insideRoot(target.legacyStorage)?.split("/")[0] ?? null);
  const legacyRuntime =
    unified || !target.legacyStorage ? null : insideRoot(runtimeDirectory(target.legacyStorage));
  const classify = (path: string, type: SourceEntry["type"]): Classified =>
    unified
      ? classifyUnified(path, type, physical, configName, registry)
      : classifyLegacy(path, type, configName, legacyExtra, legacyRuntime);

  const entries: SourceEntry[] = [];
  const records: SourceRecord[] = [];
  const counts = new Map<string, Map<number, { live: number; tombstones: number }>>();
  const present = new Map<string, Set<number>>();
  const envelopes = new Set<number>();
  const pending: SourcePending[] = [];
  const indexIssues: StorageBlocker[] = [];
  /** Разобранные служебные файлы (индексы, WAL); значения записей не удерживаются. */
  const service = new Map<string, unknown>();
  /** Канонический digest постоянных файлов для сверки с индексом file-hashes. */
  const digests = new Map<string, string>();

  // Полная инвентаризация, включая посторонние каталоги; замки не раскрываются.
  /** Компактные факты записей формата 4 для общей проверки согласованности (без данных). */
  const facts: RecordFacts[] = [];
  const take = async (area: SourceArea, item: Walked): Promise<void> => {
    const kind: Classified =
      area === "storage-root"
        ? { category: "legacy-source", managed: true }
        : classify(item.path, item.type);
    if (kind.category === "lock") return;
    const persistent = kind.category !== "runtime" || item.path === INDEX_STALE_PATH;
    entries.push({
      area,
      path: item.path,
      type: item.type,
      size: item.size,
      sha256: item.bytes ? sha256(item.bytes) : null,
      category: kind.category,
      managed: kind.managed,
      persistent,
      ...(kind.owner ? { owner: kind.owner } : {}),
    });
    const at = safePath(item.path) ? { path: item.path } : {};
    if (!kind.managed) {
      warnings.push({
        code: "STORAGE_FOREIGN_FILE",
        message: "Посторонний объект вне управляемой области сохраняется без изменений",
        ...at,
      });
      return;
    }
    if (item.type === "symlink" || item.type === "other") {
      blockers.push(
        sourceBlocker(
          "STORAGE_UNSAFE_PATH",
          "Символическая ссылка или специальный файл в управляемой области базы",
          at,
        ),
      );
      return;
    }
    if (item.type === "dir") return;
    if (kind.unknown === "kind") {
      blockers.push(
        sourceBlocker("UNKNOWN_ENTITY_KIND", "Коллекция неизвестна реестру хранения", at),
      );
      return;
    }
    if (kind.unknown) {
      blockers.push(sourceBlocker("STORAGE_FORMAT_UNKNOWN", kind.unknown, at));
      return;
    }
    if (!persistent || kind.category === "service" || !item.path.endsWith(".json") || !item.bytes)
      return;
    // Конфигурация проверяется отдельно сырым reader; повторный блокер не нужен.
    if (kind.category === "config" || item.path === MANIFEST_PATH) return;
    const decoded = decodeJson(item.bytes);
    if (!decoded.ok) {
      blockers.push(
        sourceBlocker("STORAGE_DATA_CORRUPT", "Некорректный JSON или UTF-8 в постоянном файле", at),
      );
      return;
    }
    if (area === "config-root") {
      if (kind.category === "indexes" || kind.category === "transactions")
        service.set(item.path, decoded.value);
      if (
        kind.category === "entities" ||
        kind.category === "relations" ||
        kind.category === "keyspaces" ||
        kind.category === "service-journal"
      )
        digests.set(item.path, digest(decoded.value as JsonValue));
    }
    if (kind.category === "legacy-transactions")
      pending.push({ kind: "legacy", path: item.path, area });
    if (item.path === INDEX_STALE_PATH)
      warnings.push({
        code: "STORAGE_INDEX_STALE",
        message: "Обнаружена отметка внешних изменений; индексы будут построены заново",
        path: item.path,
      });
    if (kind.category === "entities" && kind.owner) {
      const record = readRecord(item.path, kind.owner, decoded.value, physical, registry, blockers);
      if (!record) return;
      records.push(record);
      // Согласованность проверяется после полного обхода; значения записей не удерживаются.
      if (physical === CURRENT_PHYSICAL_FORMAT)
        facts.push(recordFacts(decoded.value as StoredRecord, item.path, registry));
      envelopes.add(record.envelope);
      const byVersion = counts.get(record.kind) ?? new Map();
      counts.set(record.kind, byVersion);
      const count = byVersion.get(record.dataVersion) ?? { live: 0, tombstones: 0 };
      if (record.deleted) count.tombstones++;
      else count.live++;
      byVersion.set(record.dataVersion, count);
      const versions = present.get(record.kind) ?? new Set<number>();
      versions.add(record.dataVersion);
      present.set(record.kind, versions);
    }
  };
  await walk(
    root,
    owned,
    (path) => {
      const kind = classify(path, "dir");
      // Посторонние каталоги тоже раскрываются: их файлы входят в отпечаток и backup.
      return kind.category !== "lock";
    },
    (item) => take("config-root", item),
  );
  if (target.storageRoot && !unified && (await exists(target.storageRoot)))
    await walk(
      target.storageRoot,
      owned,
      () => true,
      (item) => take("storage-root", item),
    );

  // Незавершённый WAL единого хранилища: вид по версии намерения, без recovery.
  if (pendingPresent) {
    const raw = service.get("transactions/pending.json");
    const value =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const migration =
      value?.schemaVersion === 2 && value.migration && typeof value.migration === "object"
        ? (value.migration as Record<string, unknown>)
        : null;
    // WAL v2 без итога плана записан предварительной сборкой: продолжить его нельзя.
    if (migration && !("report" in migration))
      blockers.push(
        sourceBlocker(
          "STORAGE_VERSION_UNSUPPORTED",
          "Незавершённая миграция записана предварительной сборкой Relay без итога плана",
          { path: "transactions/pending.json", next: PRE_RELEASE_WAL_NEXT },
        ),
      );
    // Без маркера recovery допустим только для WAL, который сам публикует совместимый
    // маркер (инициализация): та же проверка, что выполняет recovery до записи.
    if (!manifestPresent && value) {
      const changes = Array.isArray(value.changes) ? (value.changes as unknown[]) : [];
      const marker = changes.find(
        (change): change is { after: unknown } =>
          change !== null &&
          typeof change === "object" &&
          (change as { path?: unknown }).path === MANIFEST_PATH &&
          (change as { after?: unknown }).after != null,
      );
      if (!marker)
        blockers.push(
          sourceBlocker(
            "STORAGE_FORMAT_MISSING",
            "Маркер storage.json отсутствует, а незавершённая операция его не создаёт",
            { path: MANIFEST_PATH },
          ),
        );
      else
        try {
          parseStorageManifest(marker.after, registry.profile.version);
        } catch (error) {
          blockers.push(blockerOf(error));
        }
    }
    pending.unshift({
      kind:
        value?.schemaVersion === 1
          ? "operation"
          : migration && "report" in migration
            ? "migration"
            : "unknown",
      path: "transactions/pending.json",
      area: "config-root",
    });
  }

  // Потерянные ожидаемые файлы: индекс file-hashes перечисляет постоянные записи.
  if (layout !== null && layout !== "legacy")
    checkExpectedFiles(
      entries,
      service,
      digests,
      blockers,
      warnings,
      indexIssues,
      layout === "unified-4",
    );

  // Полная проверка постоянного набора формата 4: отношения и пространства ключей строгими
  // замороженными схемами (записи проверены выше). Без WAL: незавершённую публикацию
  // проверяет recovery, а не диагностика.
  if (layout === "unified-4" && !pendingPresent) {
    const seen = new Set(blockers.map((blocker) => `${blocker.code}\0${blocker.path ?? ""}`));
    const add = (blocker: StorageBlocker) => {
      const key = `${blocker.code}\0${blocker.path ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      blockers.push(blocker);
    };
    const sets = await readUnifiedSets({ root, configPath: target.configPath }, registry, owned);
    for (const blocker of sets.blockers) add(blocker);
    // Та же полная проверка, что у подготовки переноса: no-op текущего профиля не обходит
    // уникальность адресов, концы активных рёбер, ссылки владельцев и идентичность проекта.
    for (const blocker of integrityBlockers(
      {
        records: facts,
        relations: sets.relations,
        keyspaces: sets.keyspaces,
        config: target.config ? { path: configName, projectId: target.config.projectId } : null,
      },
      registry,
    ))
      add(blocker);
    // Используемые корни рабочих индексов обязаны быть в состоянии индексов.
    const state = stateShape.safeParse(service.get(STATE_FILE));
    if (state.success) {
      const edgeRoots = new Set<string>();
      for (const set of sets.relations) {
        const value = set.value as { entries?: { edge?: { active?: unknown } }[] } | null;
        for (const entry of Array.isArray(value?.entries) ? value.entries : [])
          for (const name of edgeIndexRoots(entry.edge?.active === true)) edgeRoots.add(name);
      }
      for (const name of requiredRoots(facts, edgeRoots, registry))
        if (!state.data.roots[name])
          indexIssues.push(
            indexStale(STATE_FILE, `Корень индекса ${name} отсутствует; источники записей целы`),
          );
    }
  }

  // Конфигурация единого хранилища (физический перенос её не переписывает) должна
  // открываться обычным Workspace. Все исторические формы с 1efc794 только добавляли
  // необязательные поля, а встроенный аудит настроек (bf95518…1afe138) текущая схема
  // принимает, поэтому несоответствие текущей схеме — повреждение, а не прежняя версия.
  if (unified && layout !== null && target.config) {
    const decoded = decodeJson(await readFile(target.configPath).catch(() => new Uint8Array()));
    if (decoded.ok && !registry.validConfig(decoded.value))
      blockers.push(
        sourceBlocker(
          "STORAGE_DATA_CORRUPT",
          "Конфигурация проекта не соответствует ни текущей, ни исторической схеме",
          { path: configName },
        ),
      );
  }

  return {
    configPath: target.configPath,
    root,
    storageRoot: target.storageRoot,
    config: target.config,
    layout,
    physical,
    dataModel,
    profile,
    manifest,
    pending,
    entries,
    records,
    present,
    counts,
    envelopes: [...envelopes].sort((a, b) => a - b),
    blockers,
    warnings,
    indexIssues,
  };
}

function readRecord(
  path: string,
  collectionKind: string,
  value: unknown,
  physical: number | null,
  registry: TransitionRegistry,
  blockers: StorageBlocker[],
): SourceRecord | null {
  const parsed = envelopeShape.safeParse(value);
  if (!parsed.success) {
    blockers.push(
      sourceBlocker("STORAGE_DATA_CORRUPT", "Оболочка записи повреждена", {
        path,
        owner: collectionKind,
      }),
    );
    return null;
  }
  const raw = parsed.data;
  const fileId = path.slice(path.lastIndexOf("/") + 1, -".json".length);
  if (raw.kind !== collectionKind || raw.id !== fileId) {
    blockers.push(
      sourceBlocker("STORAGE_DATA_CORRUPT", "Вид или ID записи не соответствует её пути", {
        path,
        owner: collectionKind,
      }),
    );
    return null;
  }
  if (physical === CURRENT_PHYSICAL_FORMAT) {
    // Полная проверка оболочки и данных версии; исторические раскладки проверяет физический шаг.
    try {
      registry.validateRecord(value);
    } catch (error) {
      const blocker = blockerOf(error);
      blockers.push({ ...blocker, path, id: blocker.id ?? fileId.slice(0, 256) });
      return null;
    }
  }
  return {
    path,
    kind: raw.kind,
    id: raw.id,
    dataVersion: raw.dataVersion,
    envelope: raw.schemaVersion,
    deleted: "deleted" in raw,
  };
}

/** Потеря производного индекса при целых источниках: действие — явный `storage reindex`. */
function indexStale(path: string, message: string): StorageBlocker {
  return sourceBlocker("STORAGE_INDEX_STALE", message, {
    path,
    next: `Остановите процессы Relay и перестройте индексы из записей: ${storageCommand("storage reindex")}`,
  });
}

/**
 * Корни рабочих индексов, без которых обычная работа с этими данными невозможна:
 * их отсутствие в `state.json` — потеря индекса, а не пустой индекс.
 */
function requiredRoots(
  facts: readonly RecordFacts[],
  edgeRoots: ReadonlySet<string>,
  registry: TransitionRegistry,
): string[] {
  const roots = new Set<string>();
  if (facts.length) roots.add("records").add("file-hashes");
  if (facts.some((fact) => fact.addressable)) roots.add("addresses");
  if (facts.some((fact) => fact.addressable && fact.live)) roots.add("cards");
  // Корни рёбер — по правилу построителя (`edgeIndexRoots`, entity-store/relations.ts).
  for (const name of edgeRoots) roots.add(name);
  // Индекс настроек строит только кодек проекта, объявивший свои индексы (Workspace).
  let projectIndexes = false;
  try {
    projectIndexes = registry.storage.definition("project").indexes !== undefined;
  } catch {
    projectIndexes = false;
  }
  if (projectIndexes && facts.some((fact) => fact.kind === "project" && fact.live))
    roots.add("configuration");
  return [...roots].sort();
}

function checkExpectedFiles(
  entries: readonly SourceEntry[],
  service: ReadonlyMap<string, unknown>,
  digests: ReadonlyMap<string, string>,
  blockers: StorageBlocker[],
  warnings: StorageWarning[],
  indexIssues: StorageBlocker[],
  strict: boolean,
): void {
  if (!entries.some((entry) => entry.path === STATE_FILE && entry.type === "file")) {
    warnings.push({
      code: "STORAGE_INDEX_MISSING",
      message: "Индекс ожидаемых файлов отсутствует; потерю записей проверить нельзя",
    });
    indexIssues.push(
      indexStale(STATE_FILE, "Состояние индексов отсутствует; источники записей целы"),
    );
    return;
  }
  const state = stateShape.safeParse(service.get(STATE_FILE));
  if (!state.success) {
    if (service.has(STATE_FILE))
      blockers.push(
        sourceBlocker("STORAGE_DATA_CORRUPT", "Состояние индексов повреждено", {
          path: STATE_FILE,
        }),
      );
    return;
  }
  /** Обход дерева страниц корня; `leaf` получает записи листьев; первая потеря — в `lost`. */
  const tree = (
    rootHash: string,
    leaf: (entries: [string, unknown][]) => void,
    lost: (path: string) => void,
  ): boolean => {
    // Обход по правилу HashIndex: каждая страница занимает ровно одну позицию (префикс
    // хеша ключа) и проверяется один раз, поэтому работа ограничена числом страниц на диске;
    // ключи листа уникальны и принадлежат префиксу его ветви. Повторная ссылка на страницу,
    // чужой префикс или нестрогая форма — нарушение структуры (формат 4).
    const positions = new Map<string, string>();
    const visit = (hash: string, prefix: string): boolean => {
      const path = `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;
      const seen = positions.get(hash);
      if (seen !== undefined) {
        if (strict) lost(path);
        return !strict;
      }
      positions.set(hash, prefix);
      const raw = service.get(path);
      const segment = (strict ? indexSegmentSchema : segmentShape).safeParse(raw);
      if (
        prefix.length > 64 ||
        raw === undefined ||
        !segment.success ||
        digest(raw as JsonValue) !== hash
      ) {
        lost(path);
        return false;
      }
      if (segment.data.type === "branch")
        return Object.entries(segment.data.children as Record<string, string>).every(
          ([nibble, child]) => visit(child, prefix + nibble),
        );
      const entries = segment.data.entries as [string, unknown][];
      if (
        strict &&
        (new Set(entries.map(([key]) => key)).size !== entries.length ||
          entries.some(([key]) => !keyHash(key).startsWith(prefix)))
      ) {
        lost(path);
        return false;
      }
      leaf(entries);
      return true;
    };
    return visit(rootHash, "");
  };
  // Рабочие индексы (карточки, адреса, рёбра…) производны от записей: их потеря не теряет
  // данные, но и не даёт права объявить индексы проверенными.
  for (const [name, hash] of Object.entries(state.data.roots).sort(([a], [b]) => byName(a, b)))
    if (name !== "file-hashes" && hash)
      tree(
        hash,
        () => {},
        (path) =>
          indexIssues.push(
            indexStale(
              path,
              `Страница индекса ${name.slice(0, 64)} потеряна, повреждена или нарушает структуру дерева; источники записей целы`,
            ),
          ),
      );
  const rootHash = state.data.roots["file-hashes"];
  if (!rootHash) return;
  const expected = new Map<string, string>();
  const complete = tree(
    rootHash,
    (items) => {
      for (const [key, value] of items) if (typeof value === "string") expected.set(key, value);
    },
    (path) =>
      blockers.push(
        sourceBlocker(
          "STORAGE_DATA_CORRUPT",
          "Страница индекса ожидаемых файлов повреждена или потеряна",
          { path },
        ),
      ),
  );
  if (!complete) return;
  const files = new Set(
    entries.filter((entry) => entry.type === "file").map((entry) => entry.path),
  );
  let stale = 0;
  for (const [path, hash] of [...expected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!files.has(path)) {
      blockers.push(
        sourceBlocker(
          "STORAGE_RECORD_MISSING",
          "Потерян ожидаемый постоянный файл; он не считается удалением",
          safePath(path) ? { path } : {},
        ),
      );
      continue;
    }
    const actual = digests.get(path);
    if (actual !== undefined && actual !== hash) stale++;
  }
  for (const path of digests.keys())
    if (/^(entities|relations|keyspaces)\//.test(path) && !expected.has(path)) stale++;
  if (stale)
    warnings.push({
      code: "STORAGE_INDEX_STALE",
      message: `Индекс расходится с постоянными файлами (${stale}); индексы будут построены заново из записей`,
    });
}

/** Шаги, нужные источнику: физический перенос раскладки и упорядоченные предметные переходы. */
export type SourceSteps = {
  readonly physical: PhysicalTransition | null;
  readonly data: readonly DataTransition[];
  /** Профиль manifest ниже целевого: нужен маркер-переход (без изменения данных). */
  readonly marker: boolean;
};

export type SourceDiagnosis = {
  readonly status: StorageStatus;
  /** null — план не построен из-за блокеров или recovery. */
  readonly steps: SourceSteps | null;
  /** Все блокеры (status содержит первые 50). */
  readonly blockers: readonly StorageBlocker[];
};

/**
 * Статус по §5.3 без recovery и без применения шагов: recovery-required при любом WAL,
 * unsupported — версия/формат/вид/переход, invalid — повреждение, migration-required — есть
 * применимые шаги или маркер профиля, current — шагов нет.
 */
export function diagnoseStorageSource(
  source: StorageSource,
  registry: TransitionRegistry,
): SourceDiagnosis {
  const blockers = [...source.blockers];
  const target = registry.profile;
  let steps: SourceSteps | null = null;
  const versionsReady = !blockers.some((blocker) => blocker.code === "STORAGE_VERSION_UNSUPPORTED");
  if (source.layout !== null && versionsReady) {
    let physical: PhysicalTransition | null = null;
    if (source.layout !== "unified-4") {
      physical = registry.physicalFrom(source.layout) ?? null;
      if (!physical)
        blockers.push(
          sourceBlocker(
            "STORAGE_TRANSITION_MISSING",
            "Для исходной раскладки не зарегистрирован переход",
            {
              current: source.layout,
              expected: "unified-4",
            },
          ),
        );
    }
    let ready = true;
    for (const [kind, versions] of [...source.present].sort(([a], [b]) => (a < b ? -1 : 1)))
      for (const version of [...versions].sort((a, b) => a - b))
        try {
          if (registry.target(kind) !== version) registry.validator(kind, version);
        } catch (error) {
          ready = false;
          blockers.push(blockerOf(error));
        }
    if (source.profile === target.version)
      for (const record of source.records)
        if (registry.target(record.kind) !== record.dataVersion && ready) {
          blockers.push(
            sourceBlocker(
              "STORAGE_DATA_CORRUPT",
              "Версия данных записи не соответствует профилю manifest",
              {
                path: record.path,
                owner: record.kind,
                current: record.dataVersion,
                expected: String(registry.target(record.kind)),
              },
            ),
          );
        }
    if (ready)
      try {
        const data = source.layout === "legacy" ? [] : registry.plan(source.present);
        steps = {
          physical,
          data,
          marker: source.profile === null || source.profile < target.version,
        };
      } catch (error) {
        blockers.push(blockerOf(error));
      }
  }
  // Потерянные страницы рабочих индексов: базе без шагов нужен явный reindex (не passed),
  // перенос строит индексы заново из целых источников — для него это предупреждение.
  const rebuilds = steps !== null && (steps.physical || steps.data.length > 0 || steps.marker);
  const indexWarnings: StorageWarning[] = [];
  for (const issue of source.indexIssues ?? [])
    if (rebuilds)
      indexWarnings.push({
        code: "STORAGE_INDEX_STALE",
        message: "Страница рабочего индекса потеряна; перенос построит индексы заново",
        ...(issue.path ? { path: issue.path } : {}),
      });
    else blockers.push(issue);
  const unknownPending = source.pending.some((entry) => entry.kind === "unknown");
  let status: StorageStatusKind;
  // Несовместимый маркер важнее незавершённого WAL: recovery этой сборкой запрещён.
  const marker = source.blockers.some(incompatibleMarker);
  if (unknownPending) status = "unsupported";
  else if (source.pending.length && !marker) status = "recovery-required";
  else if (blockers.some((blocker) => UNSUPPORTED_CODES.has(blocker.code))) status = "unsupported";
  else if (blockers.length || source.layout === null) status = "invalid";
  else if (steps && (steps.physical || steps.data.length || steps.marker))
    status = "migration-required";
  else status = "current";
  if (status !== "migration-required" && status !== "current") steps = null;

  const owners: StorageStatus["current"]["owners"] = {};
  for (const [kind, versions] of [...source.counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let ownerTarget: number | "removed";
    try {
      ownerTarget = registry.target(kind);
    } catch {
      continue;
    }
    owners[kind] = {
      versions: Object.fromEntries(
        [...versions]
          .sort(([a], [b]) => a - b)
          .map(([version, count]) => [String(version), { ...count }]),
      ),
      target: ownerTarget,
    };
  }
  const persistent = source.entries.filter(
    (entry) => entry.managed && entry.persistent && entry.type === "file",
  );
  const firstPending = source.pending[0];
  const value: StorageStatus = {
    status,
    project: {
      id: source.config?.projectId ? source.config.projectId.slice(0, 256) : null,
      configPath: source.configPath,
      root: source.root,
      ...(source.storageRoot ? { storageRoot: source.storageRoot } : {}),
    },
    layout: source.layout,
    current: {
      physical: source.physical !== null && source.physical > 0 ? source.physical : null,
      dataModel: source.dataModel !== null && source.dataModel > 0 ? source.dataModel : null,
      envelope: source.envelopes.filter((version) => version > 0),
      owners,
    },
    target: { dataModel: target.version, owners: { ...target.owners } },
    counts: {
      files: persistent.length,
      bytes: persistent.reduce((sum, entry) => sum + entry.size, 0),
    },
    pending: firstPending ? { kind: firstPending.kind, path: firstPending.path } : null,
    blockers: blockers.slice(0, LIST_LIMIT),
    blockersTotal: blockers.length,
    warnings: [...source.warnings, ...indexWarnings].slice(0, LIST_LIMIT),
  };
  return { status: storageStatusSchema.parse(value), steps, blockers };
}

/**
 * Диагностический вход: разрешить цель, взять замок обслуживания, прочитать набор и вычислить
 * статус. Ничего не создаёт в постоянном наборе; замок оставляет только временные следы.
 */
export async function inspectStorageSource(
  path: string,
  options: { registry: TransitionRegistry; lock?: MaintenanceLockOptions },
): Promise<{ source: StorageSource; diagnosis: SourceDiagnosis }> {
  const target = await resolveSourceTarget(path);
  return withMaintenanceLock(
    { root: target.root, storageRoot: target.legacyStorage },
    async (owned) => {
      // Конфигурация перечитывается под замком: каталог legacy-данных не должен измениться.
      const locked = await resolveSourceTarget(target.configPath);
      if (locked.legacyStorage !== target.legacyStorage || locked.root !== target.root)
        throw storageError("STORAGE_BUSY", "Конфигурация изменилась во время получения замка", {
          reason: "config-changed",
        });
      const source = await readStorageSource(locked, { registry: options.registry, owned });
      owned();
      return { source, diagnosis: diagnoseStorageSource(source, options.registry) };
    },
    options.lock,
  );
}
