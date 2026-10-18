import { realpath } from "node:fs/promises";
import {
  registerWorkspaceAccess,
  withWorkspaceMaintenance,
  managedPath,
} from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { invariant } from "@relay/core/shared/errors";
import { marker, readState, saveState } from "./state.js";
import { discoverRepository } from "./identity.js";
import { recoverPublication, withDataLock } from "./service.js";
import { ensureWorker } from "./launcher.js";

export async function attachManagedStorage(path: string): Promise<boolean> {
  const info = await marker(path);
  if (!info) return false;
  const root = await realpath(path);
  const repository = await discoverRepository(root);
  invariant(
    info.version === 1 || repository?.identity === info.identity,
    "SYNC_IDENTITY_MISMATCH",
    "Worktree не принадлежит зарегистрированному Git-хранилищу",
    4,
  );
  if (await exists(await managedPath(root, "relay-publication.json")))
    await withWorkspaceMaintenance(() => recoverPublication(root));
  registerWorkspaceAccess(root, {
    // Любое предметное обращение использует только локальные данные.
    async before() {},
    async published() {
      // Вызывается после WAL, пока ещё удерживается общий замок данных.
      const state = await readState(root);
      const now = Date.now();
      if (state.firstDirty === null || state.generation === state.sendingGeneration)
        state.firstDirty = now;
      state.lastDirty = now;
      if (state.commitPendingSince === null) state.commitPendingSince = now;
      state.generation++;
      if (!state.error) state.retryAt = Math.min(state.retryAt ?? now + 2000, now + 2000);
      await saveState(root, state);
    },
    async after() {
      try {
        await ensureWorker(root);
      } catch (error) {
        // Успешный WAL не превращается в ошибку предметной команды из-за запуска доставки.
        await withDataLock(root, async () => {
          const state = await readState(root);
          state.error = {
            code: "SYNC_WORKER_FAILED",
            message:
              error instanceof Error ? error.message : "Не удалось запустить фоновую синхронизацию",
          };
          await saveState(root, state);
        });
      }
    },
  });
  return true;
}
