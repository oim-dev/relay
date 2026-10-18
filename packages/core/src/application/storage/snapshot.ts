import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@relay/contracts/storage";
import type { Workspace } from "../../storage/workspace.js";
import { readJson } from "../../storage/files.js";
import { digest, jsonValue } from "../../storage/entity-store/format.js";
import { StorageTransaction } from "../../storage/entity-store/transaction.js";
import { invariant, isErrno } from "../../shared/errors.js";

export type PersistentSnapshot = Record<string, JsonValue>;
export function persistentPath(path: string): boolean {
  return (
    path === "config.json" ||
    path === "storage.json" ||
    (/^(entities|relations|keyspaces)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(path) &&
      path.split("/").every((part) => part !== "." && part !== ".."))
  );
}

/** Полный набор постоянных JSON; символические ссылки не становятся источником базы. */
export async function readSnapshotFiles(
  root: string,
  indexes = false,
): Promise<PersistentSnapshot> {
  const files: PersistentSnapshot = {};
  const visit = async (path: string) => {
    const info = await lstat(join(root, path)).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!info) return;
    invariant(!info.isSymbolicLink(), "SYNC_UNSAFE_PATH", "Символическая ссылка в Git-базе", 4, {
      path,
    });
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(root, path))).sort())
        if (entry !== ".gitignore") await visit(`${path}/${entry}`);
    } else {
      invariant(
        persistentPath(path) ||
          (indexes && /^\.indexes\/(?:segments\/[a-f0-9]{2}\/)?[A-Za-z0-9_.-]+\.json$/.test(path)),
        "SYNC_UNSAFE_PATH",
        "Неизвестный файл в данных Git-базы",
        4,
        { path },
      );
      files[path] = jsonValue(await readJson(join(root, path), Number.POSITIVE_INFINITY));
    }
  };
  for (const path of [
    "config.json",
    "storage.json",
    "entities",
    "relations",
    "keyspaces",
    ...(indexes ? [".indexes"] : []),
  ])
    await visit(path);
  return files;
}

export const snapshotVersion = (files: PersistentSnapshot) => digest(files);

export async function captureSnapshot(workspace: Workspace) {
  return workspace.locked(async () => {
    const files = await readSnapshotFiles(workspace.dataRoot);
    return { files, version: snapshotVersion(files) };
  });
}

/** Кандидат уже проверен Core вне рабочей базы; публикация данных и индексов — один WAL. */
export async function applySnapshot(
  workspace: Workspace,
  candidate: PersistentSnapshot,
  ifVersion: string,
): Promise<void> {
  await workspace.withEntityStorage(async (store, owned) => {
    const current = await readSnapshotFiles(store.root, true);
    const permanent = Object.fromEntries(
      Object.entries(current).filter(([path]) => persistentPath(path)),
    );
    invariant(
      snapshotVersion(permanent) === ifVersion,
      "SYNC_SNAPSHOT_CHANGED",
      "База изменилась во время подготовки синхронизации; требуется новый снимок",
      4,
    );
    const paths = new Set([...Object.keys(current), ...Object.keys(candidate)]);
    const changes = [...paths].sort().flatMap((path) => {
      const before = current[path] ?? null;
      const after = candidate[path] ?? null;
      return digest(before) === digest(after)
        ? []
        : [{ path, before: before === null ? null : digest(before), after }];
    });
    if (changes.length) await new StorageTransaction(store.root).publish(changes, owned);
  });
}
