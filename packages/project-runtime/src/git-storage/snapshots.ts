import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "@relay/core/shared/errors";
import { openWorkspace } from "@relay/core/storage/workspace";
import { StorageService } from "@relay/core/application/storage/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { readSnapshotFiles, persistentPath } from "@relay/core/application/storage/snapshot";
import type { PersistentSnapshot } from "@relay/core/application/storage/snapshot";
import { digest, jsonValue } from "@relay/core/storage/entity-store/format";
import { git, gitText } from "./git.js";
import { gitMetadataDirectory, managedPath } from "@relay/core/storage/access";

export const IGNORE = ".indexes/\nruntime/\ntransactions/\n";

export async function snapshotAt(root: string, commit: string): Promise<PersistentSnapshot> {
  invariant(/^[a-f0-9]{40,64}$/.test(commit), "SYNC_STATE_INVALID", "Некорректный Git commit", 4);
  const entries = (await git(root, ["ls-tree", "-rz", commit])).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const paths: string[] = [];
  const objects: string[] = [];
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    invariant(
      match && match[1] === "100644" && (persistentPath(match[3]!) || match[3] === ".gitignore"),
      "SYNC_UNSAFE_PATH",
      "В служебной ветке найден неизвестный путь, symlink или executable",
      4,
    );
    if (match[3] === ".gitignore") continue;
    paths.push(match[3]!);
    objects.push(match[2]!);
  }
  invariant(
    paths.includes("config.json") && paths.includes("storage.json"),
    "SYNC_INVALID_DATABASE",
    "Служебная ветка не содержит базу Relay",
    4,
  );
  const raw = (await git(root, ["cat-file", "--batch"], { input: objects.join("\n") + "\n" }))
    .stdout;
  let offset = 0;
  const result: PersistentSnapshot = {};
  for (const path of paths) {
    const end = raw.indexOf(10, offset);
    const header = raw.subarray(offset, end).toString("utf8");
    const size = Number(header.split(" ")[2]);
    invariant(
      end >= offset && Number.isSafeInteger(size) && size >= 0 && end + 1 + size < raw.length,
      "SYNC_INVALID_DATABASE",
      "Некорректный ответ git cat-file",
      4,
    );
    result[path] = jsonValue(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(end + 1, end + 1 + size)),
      ),
    );
    offset = end + size + 2;
  }
  return result;
}

export async function writeSnapshot(root: string, files: PersistentSnapshot) {
  for (const [path, data] of Object.entries(files)) {
    invariant(persistentPath(path), "SYNC_UNSAFE_PATH", "Недопустимый путь Git-снимка", 4, {
      path,
    });
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(data, null, 2) + "\n");
  }
  await writeFile(join(root, ".gitignore"), IGNORE);
}

export async function prepareSnapshot(root: string, files: PersistentSnapshot, projectId: string) {
  const directory = await mkdtemp(await managedPath(root, "relay-candidate-"));
  try {
    await writeSnapshot(directory, files);
    const workspace = await openWorkspace(directory, join(directory, "config.json"));
    invariant(
      workspace.config.projectId === projectId,
      "SYNC_PROJECT_MISMATCH",
      "Ветка содержит другую базу Relay",
      4,
    );
    await new StorageService(workspace).reindex();
    await validateWorkspace(workspace);
    return await readSnapshotFiles(directory, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Изолированный индекс: ни файлы рабочей базы, ни индекс исходного проекта не меняются. */
export async function commitSnapshot(root: string, files: PersistentSnapshot, parents: string[]) {
  const gitDir = await gitMetadataDirectory(root);
  const directory = await mkdtemp(join(gitDir, "relay-tree-"));
  const index = join(gitDir, `relay-index-${randomUUID()}`);
  const env = { GIT_WORK_TREE: directory, GIT_INDEX_FILE: index, GIT_DIR: gitDir };
  try {
    await writeSnapshot(directory, files);
    await git(root, ["read-tree", "--empty"], { env });
    await git(root, ["add", "--all", "--", "."], { env });
    const tree = await gitText(root, ["write-tree"], { env });
    return await gitText(root, [
      "commit-tree",
      tree,
      ...[...new Set(parents)].flatMap((parent) => ["-p", parent]),
      "-m",
      "Relay: синхронизация состояния базы",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

const equal = (a: unknown, b: unknown) =>
  digest(jsonValue(a ?? null)) === digest(jsonValue(b ?? null));
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function mergeTextFields(base: unknown, local: unknown, remote: unknown): unknown | undefined {
  const b = object(base),
    l = object(local),
    r = object(remote);
  if (!b || !l || !r || "deleted" in l || "deleted" in r) return;
  const allowedKinds = new Set([
    "task",
    "document",
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
  ]);
  if (!allowedKinds.has(String(b.kind)) || b.kind !== l.kind || b.kind !== r.kind) return;
  const content = (entry: Record<string, unknown>) => {
    const { data: _data, revision: _revision, updatedAt: _at, updatedBy: _by, ...rest } = entry;
    return rest;
  };
  if (!equal(content(b), content(l)) || !equal(content(b), content(r))) return;
  const bd = object(b.data),
    ld = object(l.data),
    rd = object(r.data);
  if (!bd || !ld || !rd) return;
  const fields = new Set(["name", "title", "summary", "description", "body"]);
  const data = { ...bd };
  for (const key of new Set([...Object.keys(bd), ...Object.keys(ld), ...Object.keys(rd)])) {
    const lc = !equal(bd[key], ld[key]),
      rc = !equal(bd[key], rd[key]);
    if (((lc || rc) && !fields.has(key)) || (lc && rc && !equal(ld[key], rd[key]))) return;
    if (lc) data[key] = ld[key];
    if (rc) data[key] = rd[key];
  }
  if (typeof l.revision !== "number" || typeof r.revision !== "number") return;
  return {
    ...l,
    data,
    revision: Math.max(l.revision, r.revision) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "relay-sync",
  };
}

export function mergeSnapshots(
  base: PersistentSnapshot,
  local: PersistentSnapshot,
  remote: PersistentSnapshot,
  options: { publishedDescendant?: boolean } = {},
) {
  const files: PersistentSnapshot = {},
    conflicts: string[] = [];
  for (const path of [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
  ].sort()) {
    const b = base[path],
      l = local[path],
      r = remote[path];
    let value: unknown;
    if (
      path.startsWith("entities/") &&
      [l, r].some((next) => invalidEvolution(b, next, options.publishedDescendant))
    ) {
      conflicts.push(path);
      continue;
    }
    if (b !== undefined && path.startsWith("entities/") && (l === undefined || r === undefined)) {
      conflicts.push(path);
      continue;
    }
    if (equal(l, r)) value = l;
    else if (equal(b, l)) value = r;
    else if (equal(b, r)) value = l;
    else value = path.startsWith("entities/") ? mergeTextFields(b, l, r) : undefined;
    if (
      (value === undefined && l !== undefined && r !== undefined) ||
      (value === undefined && !equal(b, l) && !equal(b, r) && !equal(l, r))
    )
      conflicts.push(path);
    else if (value !== undefined) files[path] = jsonValue(value);
  }
  return { files, conflicts };
}

/** Структурно корректный JSON не разрешает переписать неизменяемый материал. */
function invalidEvolution(before: unknown, after: unknown, publishedDescendant = false): boolean {
  const b = object(before),
    a = object(after);
  if (!b || !a || equal(b, a)) return false;
  const bd = object(b.data),
    ad = object(a.data);
  if (!publishedDescendant && b.kind === "work-checkpoint") return true;
  if (
    !publishedDescendant &&
    bd &&
    ((b.kind === "work-plan" && ["completed", "cancelled"].includes(String(bd.status))) ||
      (b.kind === "release" && bd.status === "released") ||
      (b.kind === "work-session" && ["completed", "cancelled"].includes(String(bd.status))))
  )
    return true;
  if (
    bd &&
    ad &&
    !equal(bd, ad) &&
    typeof b.revision === "number" &&
    typeof a.revision === "number" &&
    a.revision <= b.revision
  )
    return true;
  return false;
}
