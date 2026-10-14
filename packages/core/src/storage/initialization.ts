import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError, invariant, isErrno } from "../shared/errors.js";
import { relativePathSchema } from "./entity-store/format.js";

/** Имена постоянных владельцев единой и прежней раскладки в корне базы. */
const STORAGE_NAMES = new Set([
  "storage.json",
  "entities",
  "keyspaces",
  "relations",
  ".indexes",
  "transactions",
  "operations",
  "history",
  "product",
  "boards",
  "tasks",
  "task-activity",
  "entity-deletions",
  "relations.json",
  "kanban-pending.json",
]);
const RESERVED_CONFIG_NAMES = new Set([
  ...STORAGE_NAMES,
  "runtime",
  "relay.workspace.json",
  ".gitignore",
  ".gitkeep",
]);

/** Ограничение WAL v1 касается basename, но не абсолютного пути каталога базы. */
export function assertInitializationConfigName(configPath: string): void {
  const name = basename(configPath);
  invariant(
    relativePathSchema.safeParse(name).success && !RESERVED_CONFIG_NAMES.has(name),
    "INVALID_ARGUMENT",
    `Недопустимое имя конфигурации ${JSON.stringify(name)}. Используйте латинские буквы, цифры, «_», «-» и «.» (например, config.json), кроме служебных имён Relay и relay.workspace.json`,
    2,
    { configPath, basename: name },
  );
}

/** lstat учитывает в том числе оборванные symlink: init не заменяет существующий путь. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/** Только чтение; повторяется под общим замком до открытия Store и любого recovery. */
export async function assertInitializationTarget(configPath: string): Promise<void> {
  assertInitializationConfigName(configPath);
  const dataRoot = dirname(configPath);
  const reject = (reason: string, message: string, paths: string[]): never => {
    throw new AppError("ALREADY_INITIALIZED", message, 4, {
      configPath,
      dataRoot,
      reason,
      paths,
    });
  };
  if (await present(configPath))
    reject("config", "Конфигурация уже существует; инициализация не заменяет её", [
      basename(configPath),
    ]);
  if (await present(join(dataRoot, "storage.json")))
    reject("storage", "В каталоге уже есть хранилище; восстановите его конфигурацию", [
      "storage.json",
    ]);
  if (await present(join(dataRoot, "transactions/pending.json")))
    reject(
      "pending",
      "В каталоге есть незавершённая запись; сначала проверьте состояние хранилища",
      ["transactions/pending.json"],
    );
  let entries: string[];
  try {
    entries = await readdir(dataRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const paths = entries.filter((name) => STORAGE_NAMES.has(name)).sort();
  if (paths.length)
    reject(
      "incomplete",
      "В каталоге остались данные хранилища без конфигурации и storage.json. Инициализация не восстанавливает и не заменяет существующую базу; сначала проверьте её состояние",
      paths,
    );
}
