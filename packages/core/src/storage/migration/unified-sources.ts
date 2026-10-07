import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isErrno } from "../../shared/errors.js";
import { persistentPathSchema } from "../entity-store/transaction.js";
import { storageError } from "../data-model/errors.js";
import { readUnifiedJournal } from "../data-model/transitions/physical-unified.js";
import type {
  UnifiedIndexedEvent,
  UnifiedJournal,
  UnifiedJournalOperation,
} from "../data-model/transitions/physical-unified.js";
import type {
  PhysicalArea,
  PhysicalDirEntry,
  PhysicalRecordCatalog,
  PhysicalSourceIo,
  StorageLayout,
} from "../data-model/types.js";

/** Проверяет, что внешняя блокировка всё ещё принадлежит вызывающему. */
export type MigrationOwned = () => void;
export type UnifiedMigrationIndexedEvent = UnifiedIndexedEvent;
export type UnifiedMigrationOperation = UnifiedJournalOperation;
export type UnifiedMigrationSources = Omit<UnifiedJournal, "roots">;

export type FsSourceIoOptions = {
  /** Реальный корень базы (каталог конфигурации). */
  readonly root: string;
  /** Реальный каталог данных вне корня (legacy storageDir); null — нет. */
  readonly storageRoot?: string | null;
  readonly layout: StorageLayout;
  /** POSIX-путь конфигурации относительно корня. */
  readonly configName: string;
  /** Абсолютный путь конфигурации. */
  readonly configPath: string;
  readonly catalog: PhysicalRecordCatalog;
};

/**
 * Ввод-вывод исходной раскладки только для чтения поверх файловой системы. Каждый компонент
 * пути проверяется lstat: символическая ссылка — STORAGE_UNSAFE_PATH, а не переход по ней.
 * Ничего не создаёт и не меняет; замок обслуживания держит вызывающий.
 */
export function createFsSourceIo(options: FsSourceIoOptions): PhysicalSourceIo {
  const base = (area: PhysicalArea) => {
    if (area === "config-root") return options.root;
    if (!options.storageRoot)
      throw storageError("STORAGE_UNSAFE_PATH", "Область данных вне корня не задана");
    return options.storageRoot;
  };
  /**
   * false — пути нет; symlink и чужие объекты в цепочке — ошибка. Допустимо любое безопасное
   * относительное имя, в том числе Unicode-имя конфигурации; абсолютные пути, `.`/`..`,
   * пустые компоненты и обратная косая черта отвергаются.
   */
  const walk = async (area: PhysicalArea, path: string, leaf: "file" | "dir") => {
    if (!persistentPathSchema.safeParse(path).success)
      throw storageError("STORAGE_UNSAFE_PATH", "Небезопасный относительный путь источника");
    let current = base(area);
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
        throw error;
      }
      if (info.isSymbolicLink())
        throw storageError(
          "STORAGE_UNSAFE_PATH",
          "Источник миграции не может быть символической ссылкой",
          { path: parts.slice(0, index + 1).join("/") },
        );
      const last = index === parts.length - 1;
      if (!last && !info.isDirectory()) return null;
      if (last && (leaf === "file" ? !info.isFile() : !info.isDirectory())) {
        if (leaf === "dir") return null;
        throw storageError("STORAGE_UNSAFE_PATH", "Источник миграции не является файлом", {
          path,
        });
      }
    }
    return current;
  };
  return {
    layout: options.layout,
    configName: options.configName,
    configPath: options.configPath,
    catalog: options.catalog,
    async read(path, area) {
      const absolute = await walk(area, path, "file");
      if (!absolute) return null;
      try {
        return new Uint8Array(await readFile(absolute));
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async list(path, area) {
      const absolute = path === "" ? base(area) : await walk(area, path, "dir");
      if (!absolute) return [];
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return [];
        throw error;
      }
      return entries
        .map((entry): PhysicalDirEntry => ({
          name: entry.name,
          type: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}

const noCatalog: PhysicalRecordCatalog = {
  kindOfCollection: () => undefined,
  collectionOf: () => undefined,
  validateRecord: () => {
    throw storageError("STORAGE_REGISTRY_INVALID", "Каталог видов не передан");
  },
};

/**
 * Совместимое чтение журнала формата 1/2 по корню базы. Только чтение под внешней
 * блокировкой; результат — тот же, что у физического перехода (readUnifiedJournal).
 */
export async function readUnifiedMigrationSources(
  root: string,
  owned: MigrationOwned,
): Promise<UnifiedMigrationSources> {
  const io = createFsSourceIo({
    root,
    layout: "unified-2",
    configName: "config.json",
    configPath: join(root, "config.json"),
    catalog: noCatalog,
  });
  const { roots: _roots, ...journal } = await readUnifiedJournal(io, owned);
  return journal;
}

/**
 * Ввод-вывод физического шага для прочитанного источника (K3 `readStorageSource`):
 * `registry.physicalFrom(source.layout)!.read(physicalSourceIo(source, catalog), owned)`.
 */
export function physicalSourceIo(
  source: {
    readonly root: string;
    readonly storageRoot: string | null;
    readonly configPath: string;
    readonly layout: StorageLayout | null;
  },
  catalog: PhysicalRecordCatalog,
): PhysicalSourceIo {
  if (!source.layout || source.layout === "unified-4")
    throw storageError("STORAGE_FORMAT_UNKNOWN", "Физический шаг не применим к раскладке");
  const configName = relative(source.root, source.configPath).split(sep).join("/");
  return createFsSourceIo({
    root: source.root,
    storageRoot: source.storageRoot,
    layout: source.layout,
    configName,
    configPath: source.configPath,
    catalog,
  });
}
