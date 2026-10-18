import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  synchronizationStatusSchema,
  type SynchronizationStatus,
} from "@relay/contracts/synchronization";
import { gitMetadataDirectory } from "@relay/core/storage/access";
import { isErrno } from "@relay/core/shared/errors";
import { marker, readState } from "./state.js";
import { currentOrigin } from "./remote.js";
import { git, gitText } from "./git.js";

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

/** Только локальные файлы и Git: чтение статуса никогда не выполняет fetch/push. */
export async function synchronizationStatus(root: string): Promise<SynchronizationStatus> {
  if (!(await marker(root)))
    return {
      mode: "file",
      status: "local",
      origin: null,
      queuedCommits: 0,
      uncommittedChanges: false,
      localHead: null,
      remoteHead: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
      conflictId: null,
      error: null,
    };
  const state = await readState(root);
  const origin = await currentOrigin(root);
  const localHead = await gitText(root, ["rev-parse", "HEAD"]);
  const known = state.lastFetch !== null && state.origin === origin?.identity;
  let queuedCommits: number | null = origin ? null : 0;
  if (origin && known) {
    const count = await git(
      root,
      ["rev-list", "--count", localHead, ...(state.remote ? ["--not", state.remote] : [])],
      { allowFailure: true },
    );
    if (!count.code) queuedCommits = Number(count.stdout.toString("utf8").trim());
  }
  const dirty = await git(
    root,
    [
      "diff",
      "--quiet",
      "HEAD",
      "--",
      "config.json",
      "storage.json",
      "entities",
      "relations",
      "keyspaces",
    ],
    { allowFailure: true },
  );
  const untracked = await gitText(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "entities",
    "relations",
    "keyspaces",
  ]);
  const uncommittedChanges =
    dirty.code !== 0 || untracked.length > 0 || state.generation > state.committedGeneration;
  const gitDir = await gitMetadataDirectory(root);
  const active = async (name: string) => {
    const info = await stat(join(gitDir, name, "write.lock")).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    return info !== undefined && Date.now() - info.mtimeMs < 10000;
  };
  const syncing = (await active("relay-sync-lock")) || (await active("relay-push-lock"));
  const status = !origin
    ? "local"
    : state.conflict && !state.resolution
      ? "conflict"
      : syncing
        ? "syncing"
        : state.error
          ? "offline"
          : !known
            ? "unknown"
            : queuedCommits !== 0 || uncommittedChanges
              ? "pending"
              : "synced";
  return synchronizationStatusSchema.parse({
    mode: "git",
    status,
    origin: origin?.origin ?? null,
    queuedCommits,
    uncommittedChanges,
    localHead,
    remoteHead: known ? state.remote : null,
    lastSuccessAt: known ? iso(state.lastSuccess) : null,
    lastAttemptAt: iso(state.lastAttempt),
    nextAttemptAt: origin ? iso(state.retryAt) : null,
    conflictId: state.conflict?.id ?? null,
    error: state.error,
  });
}
