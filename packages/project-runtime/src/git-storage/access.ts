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
import { synchronize, recoverPublication, withSyncLock, withDataLock } from "./service.js";
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
    await withWorkspaceMaintenance(() => withSyncLock(root, () => recoverPublication(root)));
  registerWorkspaceAccess(root, {
    async before(write) {
      if (write) await synchronize(root, { publish: false, requestedAt: Date.now() });
      else
        await withDataLock(root, async () => {
          const state = await readState(root);
          state.requested++;
          await saveState(root, state);
        });
      if (!write) await ensureWorker(root);
    },
    async published() {
      // Вызывается после WAL, пока ещё удерживается общий замок данных.
      const state = await readState(root);
      const now = Date.now();
      if (state.firstDirty === null || state.generation === state.sendingGeneration)
        state.firstDirty = now;
      state.lastDirty = now;
      state.generation++;
      state.requested++;
      await saveState(root, state);
    },
    after: () => ensureWorker(root),
  });
  return true;
}
