import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { registerWorkspaceAccess, withWorkspaceMaintenance } from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { invariant } from "@relay/core/shared/errors";
import { marker, readState, saveState } from "./state.js";
import { normalizeOrigin } from "./identity.js";
import { gitText } from "./git.js";
import { synchronize, recoverPublication, withSyncLock, withDataLock } from "./service.js";
import { ensureWorker } from "./launcher.js";

export async function attachManagedStorage(path: string): Promise<boolean> {
  const info = await marker(path);
  if (!info) return false;
  const root = await realpath(path);
  const origin = await gitText(root, ["remote", "get-url", "origin"]);
  invariant(
    normalizeOrigin(origin, root).identity === info.identity,
    "SYNC_IDENTITY_MISMATCH",
    "Origin служебной копии не соответствует сохранённой идентичности",
    4,
  );
  if (await exists(join(root, ".git/relay-publication.json")))
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
