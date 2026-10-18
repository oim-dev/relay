import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { exists, readJson } from "./files.js";
import { AppError, isErrno } from "../shared/errors.js";

/** Runtime подключает Git без зависимости предметного ядра от транспорта подключения. */
export interface WorkspaceAccess {
  before(write: boolean): Promise<void>;
  published(): Promise<void>;
  after(): Promise<void>;
}

const access = new Map<string, WorkspaceAccess>();
const maintenance = new AsyncLocalStorage<boolean>();
export const managedMarker = (root: string) => join(root, ".git/relay.json");
export const syncStatePath = (root: string) => join(root, ".git/relay-sync.json");

export async function readSyncStateFile(root: string): Promise<unknown> {
  try {
    return await readJson(syncStatePath(root), 128 * 1024 * 1024);
  } catch (error) {
    throw new AppError(
      "SYNC_STATE_INVALID",
      "Состояние синхронизации отсутствует или повреждено; предметная работа приостановлена",
      4,
      { cause: error instanceof AppError ? error.code : "IO_ERROR" },
    );
  }
}

export async function hasManagedMetadata(root: string): Promise<boolean> {
  try {
    if (!(await lstat(join(root, ".git"))).isDirectory()) return false;
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return false;
    throw error;
  }
  return exists(managedMarker(root));
}

export function registerWorkspaceAccess(root: string, hooks: WorkspaceAccess): void {
  access.set(resolve(root), hooks);
}

/** Только внутреннее обслуживание; не параметр предметной команды или HTTP-запроса. */
export function withWorkspaceMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  return maintenance.run(true, operation);
}

export async function workspaceAccess(root: string): Promise<WorkspaceAccess | undefined> {
  if (maintenance.getStore() || !(await hasManagedMetadata(root))) return undefined;
  const hooks = access.get(resolve(root));
  if (!hooks)
    throw new AppError(
      "SYNC_RUNTIME_REQUIRED",
      "Git-базу откройте через общий runtime Relay: требуется подключение синхронизации",
      4,
    );
  return hooks;
}

/** Guard читается под тем же замком, что защищает предметную операцию. */
export async function assertWorkspaceAvailable(root: string): Promise<void> {
  if (maintenance.getStore() || !(await hasManagedMetadata(root))) return;
  if (await exists(join(root, ".git/relay-publication.json")))
    throw new AppError("SYNC_RECOVERY_REQUIRED", "Требуется завершить применение Git-снимка", 4);
  const state = z
    .object({
      conflict: z.object({ id: z.string(), paths: z.array(z.string()) }).nullable(),
    })
    .safeParse(await readSyncStateFile(root));
  if (!state.success)
    throw new AppError("SYNC_STATE_INVALID", "Состояние синхронизации повреждено", 4);
  if (state.data.conflict)
    throw new AppError(
      "SYNC_CONFLICT",
      "Работа с базой приостановлена: разрешите конфликт синхронизации",
      4,
      {
        conflictId: state.data.conflict.id,
        paths: state.data.conflict.paths.slice(0, 20),
        total: state.data.conflict.paths.length,
      },
    );
}
