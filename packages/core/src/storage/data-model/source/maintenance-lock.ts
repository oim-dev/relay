import lockfile from "proper-lockfile";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError, isErrno } from "../../../shared/errors.js";
import { runtimeDirectory } from "../../lock.js";
import { withStorageLocks } from "../../entity-store/store.js";
import { storageError } from "../errors.js";

/**
 * Кооперативный замок обслуживания (status, dry-run, migrate).
 *
 * Единый примитив — `withStorageLocks` общего хранилища: те же lockfile-пути и порядок, что у
 * обычных writers и readers. Единое хранилище — `<realpath(корня)>/runtime/write.lock`,
 * legacy — `write.lock` в `runtimeDirectory(storageRoot)`; порядок legacy → unified, одинаковые
 * пути объединяются. Поэтому два пути к одной базе (symlink) и обычный writer видят один замок.
 *
 * Следы: отсутствующий каталог runtime создаётся без `.gitignore` и после освобождения
 * удаляется, только если создан здесь и пуст. Если замок нельзя получить без изменения
 * постоянных данных, возвращается `STORAGE_BUSY`/`STORAGE_UNSAFE_PATH`, без чтения без замка.
 */

export type MaintenanceLockTarget = {
  /** Корень единого хранилища (каталог файла конфигурации). */
  readonly root: string;
  /** Каталог legacy-данных; только для раскладки legacy. */
  readonly storageRoot?: string | null;
};

export type MaintenanceLockOptions = {
  /** 0 — не ждать занятый замок (диагностика); иначе ожидание как у writers (около 10 с). */
  readonly retries?: number;
};

export type MaintenanceLockFile = {
  /** Путь, который передаётся proper-lockfile как защищаемый ресурс. */
  readonly resource: string;
  /** Каталог runtime, где лежит write.lock. */
  readonly runtime: string;
  readonly lockfilePath: string;
};

/** Реальный путь существующего каталога или реальный родитель + имя для отсутствующего. */
async function realPathOrParent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

/** Lockfile-пути в порядке захвата; повторяющиеся пути объединены. */
export async function maintenanceLockFiles(
  target: MaintenanceLockTarget,
): Promise<MaintenanceLockFile[]> {
  const files: MaintenanceLockFile[] = [];
  const root = await realpath(target.root);
  if (target.storageRoot) {
    const storage = await realPathOrParent(target.storageRoot);
    const runtime = storage === root ? join(root, "runtime") : runtimeDirectory(storage);
    files.push({ resource: storage, runtime, lockfilePath: join(runtime, "write.lock") });
  }
  const runtime = join(root, "runtime");
  files.push({ resource: root, runtime, lockfilePath: join(runtime, "write.lock") });
  const unique = new Map<string, MaintenanceLockFile>();
  for (const file of files) {
    const runtimeReal = await realPathOrParent(file.runtime).catch(() => file.runtime);
    const key = join(runtimeReal, "write.lock");
    if (!unique.has(key)) unique.set(key, { ...file, runtime: runtimeReal, lockfilePath: key });
  }
  return [...unique.values()];
}

/** Служебный каталог runtime, если существует, должен быть обычным каталогом. */
async function checkRuntime(runtime: string): Promise<void> {
  try {
    const stat = await lstat(runtime);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw storageError(
        "STORAGE_UNSAFE_PATH",
        "Служебный каталог runtime не является обычным каталогом; замок не получен",
        { reason: "runtime" },
      );
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

const UNAVAILABLE = new Set(["EACCES", "EPERM", "EROFS"]);

function busy(reason: string, message = "Хранилище занято другим процессом Relay") {
  return storageError("STORAGE_BUSY", message, { reason });
}

/**
 * Выполняет операцию под замком обслуживания. `owned()` бросает `LOCK_LOST`, если владение
 * потеряно; вызывайте его перед каждым чтением и записью.
 */
export async function withMaintenanceLock<T>(
  target: MaintenanceLockTarget,
  operation: (owned: () => void) => Promise<T>,
  options: MaintenanceLockOptions = {},
): Promise<T> {
  const files = await maintenanceLockFiles(target);
  for (const file of files) await checkRuntime(file.runtime);
  if (options.retries === 0)
    for (const file of files) {
      const locked = await lockfile
        .check(file.resource, { lockfilePath: file.lockfilePath, realpath: false, stale: 10000 })
        .catch(() => false);
      if (locked) throw busy("locked");
    }
  let legacyRoot: string | undefined;
  if (target.storageRoot) legacyRoot = await realpath(target.storageRoot).catch(() => undefined);
  let entered = false;
  try {
    return await withStorageLocks(
      { root: target.root, ...(legacyRoot ? { legacyRoot } : {}) },
      async (owned) => {
        entered = true;
        const guarded = () => {
          try {
            owned();
          } catch {
            throw storageError(
              "LOCK_LOST",
              "Потерян замок обслуживания хранилища; операция остановлена",
            );
          }
        };
        guarded();
        return operation(guarded);
      },
    );
  } catch (error) {
    if (entered) throw error;
    if (error instanceof AppError) {
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      if (error.code === "STORAGE_UNSAFE_PATH" && reason && UNAVAILABLE.has(reason))
        throw busy(
          "lock-unavailable",
          "Нельзя получить замок обслуживания без изменения постоянных данных: каталог runtime недоступен для записи",
        );
      throw error;
    }
    if (isErrno(error, "ELOCKED")) throw busy("locked");
    throw busy(
      "lock-unavailable",
      "Нельзя получить замок обслуживания без изменения постоянных данных",
    );
  }
}
