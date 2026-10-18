import { invariant } from "@relay/core/shared/errors";
import { exists } from "@relay/core/storage/files";
import { marker } from "./state.js";
import { repositoryOrigin } from "./identity.js";

/** Origin читается из общего Git-конфига при каждом цикле, а не копируется при установке. */
export async function currentOrigin(root: string) {
  const info = await marker(root);
  invariant(info, "SYNC_NOT_MANAGED", "База не подключена к Git", 4);
  if (info.version === 2) {
    invariant(
      await exists(info.commonDir),
      "SYNC_GIT_OWNER_MISSING",
      "Git-хранилище владельца worktree недоступно",
      4,
    );
    return repositoryOrigin(info.sourceRoot);
  }
  return repositoryOrigin(root);
}
