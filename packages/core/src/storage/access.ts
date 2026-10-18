import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { exists, readJson } from "./files.js";
import { AppError, invariant, isErrno } from "../shared/errors.js";

/** Runtime подключает Git без зависимости предметного ядра от транспорта подключения. */
export interface WorkspaceAccess {
  before(write: boolean): Promise<void>;
  published(): Promise<void>;
  after(): Promise<void>;
}

const access = new Map<string, WorkspaceAccess>();
const maintenance = new AsyncLocalStorage<boolean>();
/** Gitfile linked worktree указывает на его собственные метаданные, не на общий индекс. */
export async function gitMetadataDirectory(root: string): Promise<string> {
  const path = join(root, ".git");
  const stat = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!stat || stat.isDirectory()) return path;
  invariant(stat.isFile(), "SYNC_STATE_INVALID", "Недопустимый тип Git-метаданных базы", 4);
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(path, "utf8"));
  invariant(match, "SYNC_STATE_INVALID", "Повреждён указатель Git worktree", 4);
  const directory = resolve(root, match[1]!);
  invariant(
    await exists(directory),
    "SYNC_GIT_OWNER_MISSING",
    "Git-хранилище владельца worktree недоступно; восстановите исходный репозиторий и связь worktree",
    4,
  );
  return directory;
}

export async function managedPath(root: string, ...parts: string[]): Promise<string> {
  return join(await gitMetadataDirectory(root), ...parts);
}
export const managedMarker = (root: string) => managedPath(root, "relay.json");
export const syncStatePath = (root: string) => managedPath(root, "relay-sync.json");

export async function readSyncStateFile(root: string): Promise<unknown> {
  try {
    return await readJson(await syncStatePath(root), 128 * 1024 * 1024);
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
  return exists(await managedMarker(root));
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

/** Локальная целостность проверяется под замком; Git-конфликт не запрещает локальную работу. */
export async function assertWorkspaceAvailable(root: string): Promise<void> {
  if (maintenance.getStore() || !(await hasManagedMetadata(root))) return;
  if (await exists(await managedPath(root, "relay-publication.json")))
    throw new AppError("SYNC_RECOVERY_REQUIRED", "Требуется завершить применение Git-снимка", 4);
  const state = z
    .object({
      conflict: z.object({ id: z.string(), paths: z.array(z.string()) }).nullable(),
    })
    .safeParse(await readSyncStateFile(root));
  if (!state.success)
    throw new AppError("SYNC_STATE_INVALID", "Состояние синхронизации повреждено", 4);
}
