import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { atomicJson, exists, readJson, syncDirectory } from "@relay/core/storage/files";
import { withStorageLock } from "@relay/core/storage/lock";
import { openWorkspace } from "@relay/core/storage/workspace";
import {
  withWorkspaceMaintenance,
  managedPath,
  gitMetadataDirectory,
} from "@relay/core/storage/access";
import {
  captureSnapshot,
  applySnapshot,
  readSnapshotFiles,
  snapshotVersion,
  persistentPath,
} from "@relay/core/application/storage/snapshot";
import type { PersistentSnapshot } from "@relay/core/application/storage/snapshot";
import { git, gitText } from "./git.js";
import { marker, readState, saveState, publicationSchema, DATA_BRANCH } from "./state.js";
import { snapshotAt, prepareSnapshot, commitSnapshot, mergeSnapshots } from "./snapshots.js";
import { currentOrigin } from "./remote.js";
import type { RepositoryIdentity } from "./identity.js";

export async function withSyncLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  invariant(await marker(root), "SYNC_NOT_MANAGED", "Git-база удалена или больше недоступна", 4);
  const directory = await managedPath(root, "relay-sync-lock");
  await mkdir(directory, { recursive: true });
  return withStorageLock(directory, operation, directory);
}
export async function withDataLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  invariant(await marker(root), "SYNC_NOT_MANAGED", "Git-база удалена или больше недоступна", 4);
  await mkdir(join(root, "runtime"), { recursive: true });
  return withStorageLock(root, operation, join(root, "runtime"));
}

async function fetchRemote(root: string, origin: RepositoryIdentity | undefined) {
  if (!origin) return;
  const found = await git(
    root,
    ["ls-remote", "--exit-code", "--heads", origin.origin, `refs/heads/${DATA_BRANCH}`],
    { allowFailure: true },
  );
  if (found.code === 2) return;
  invariant(
    !found.code,
    "SYNC_NETWORK_UNAVAILABLE",
    "Не удалось проверить origin; локальные данные сохранены",
    4,
  );
  const result = await git(
    root,
    ["fetch", "--no-tags", origin.origin, `refs/heads/${DATA_BRANCH}:refs/relay/remote`],
    { allowFailure: true },
  );
  invariant(
    !result.code,
    "SYNC_NETWORK_UNAVAILABLE",
    "Не удалось получить служебную ветку origin; проверьте сеть и доступ. Локальные данные сохранены",
    4,
  );
  return gitText(root, ["rev-parse", "refs/relay/remote"]);
}
const head = (root: string) => gitText(root, ["rev-parse", "HEAD"]);
const workspaceAt = (root: string) => openWorkspace(root, join(root, "config.json"));
const permanent = (files: PersistentSnapshot) =>
  Object.fromEntries(Object.entries(files).filter(([path]) => persistentPath(path)));

/** Git ref и WAL имеют разные владельцы; локальное намерение позволяет завершить оба шага. */
async function finishPublication(root: string, oldHead: string, newHead: string) {
  const current = await head(root);
  invariant(
    current === oldHead || current === newHead,
    "SYNC_RECOVERY_CONFLICT",
    "Git HEAD изменён вне синхронизатора; публикация остановлена",
    4,
  );
  if (current !== newHead)
    await git(root, ["update-ref", `refs/heads/${DATA_BRANCH}`, newHead, oldHead]);
  await git(root, ["read-tree", newHead]);
  const publication = publicationSchema.parse(
    await readJson(await managedPath(root, "relay-publication.json")),
  );
  if (publication.resolution) {
    const state = await readState(root);
    state.resolution = newHead;
    await saveState(root, state);
  }
  await rm(await managedPath(root, "relay-publication.json"), { force: true });
  await syncDirectory(await gitMetadataDirectory(root));
}

export async function recoverPublication(root: string) {
  const path = await managedPath(root, "relay-publication.json");
  if (!(await exists(path))) return;
  const record = publicationSchema.parse(await readJson(path));
  const info = await marker(root);
  invariant(info, "SYNC_NOT_MANAGED", "База не подключена к Git", 4);
  const workspace = await workspaceAt(root);
  const prepared = await prepareSnapshot(
    root,
    await snapshotAt(root, record.newHead),
    info.projectId,
  );
  await workspace.locked(async () => {
    const current = snapshotVersion(await readSnapshotFiles(root));
    invariant(
      current === record.source || current === record.target,
      "SYNC_RECOVERY_CONFLICT",
      "Данные изменились вне незавершённой публикации; версии сохранены",
      4,
    );
    if (current === record.source) await applySnapshot(workspace, prepared, current);
    await finishPublication(root, record.oldHead, record.newHead);
  });
}

async function publishLocal(
  root: string,
  files: PersistentSnapshot,
  prepared: PersistentSnapshot,
  source: string,
  oldHead: string,
  newHead: string,
  resolution = false,
) {
  const workspace = await workspaceAt(root);
  await workspace.locked(async () => {
    invariant(
      snapshotVersion(await readSnapshotFiles(root)) === source,
      "SYNC_SNAPSHOT_CHANGED",
      "Локальные данные изменились; снимок нужно подготовить заново",
      4,
    );
    await git(root, ["update-ref", "refs/relay/pending", newHead]);
    await atomicJson(
      await managedPath(root, "relay-publication.json"),
      { oldHead, newHead, source, target: snapshotVersion(files), resolution },
      await gitMetadataDirectory(root),
    );
    try {
      await applySnapshot(workspace, prepared, source);
    } catch (error) {
      // Отказ до durable WAL (например, бюджет) не оставляет невыполнимое намерение.
      // Начатая публикация и изменённые данные всегда сохраняют журнал восстановления.
      if (
        !(await exists(join(root, "transactions/pending.json"))) &&
        snapshotVersion(await readSnapshotFiles(root)) === source
      ) {
        await rm(await managedPath(root, "relay-publication.json"), { force: true });
        await syncDirectory(await gitMetadataDirectory(root));
      }
      throw error;
    }
    await finishPublication(root, oldHead, newHead);
  });
}

async function block(
  root: string,
  input: {
    base: string;
    local: string;
    remote: string;
    paths: string[];
    reason: string;
    fingerprint: string;
  },
) {
  await withDataLock(root, async () => {
    invariant(
      snapshotVersion(await readSnapshotFiles(root)) === input.fingerprint,
      "SYNC_SNAPSHOT_CHANGED",
      "Данные изменились до установки блокировки",
      4,
    );
    const state = await readState(root);
    const id = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
    await git(root, ["update-ref", "refs/relay/conflict-local", input.local]);
    await git(root, ["update-ref", "refs/relay/conflict-remote", input.remote]);
    state.conflict = { id, ...input };
    state.resolution = null;
    await saveState(root, state);
  });
  throw new AppError(
    "SYNC_CONFLICT",
    "Работа с базой приостановлена: разрешите конфликт синхронизации",
    4,
    { paths: input.paths },
  );
}

async function send(
  root: string,
  commit: string,
  generation: number,
  request: number,
  origin: RepositoryIdentity,
) {
  invariant(
    (await currentOrigin(root))?.identity === origin.identity,
    "SYNC_ORIGIN_CHANGED",
    "Origin изменился во время подготовки отправки; повторите sync now",
    4,
  );
  const sentVersion = snapshotVersion(await snapshotAt(root, commit));
  const sent = await git(root, ["push", origin.origin, `${commit}:refs/heads/${DATA_BRANCH}`], {
    allowFailure: true,
  });
  let remote = commit;
  if (sent.code) {
    const received = await withSyncLock(root, () => fetchRemote(root, origin));
    invariant(received, "SYNC_PUSH_REJECTED", "Origin отклонил создание служебной ветки", 4);
    remote = received;
    const included = await git(root, ["merge-base", "--is-ancestor", commit, remote], {
      allowFailure: true,
    });
    invariant(
      included.code === 0,
      "SYNC_PUSH_REJECTED",
      "Origin изменился или отклонил отправку; требуется новая синхронизация",
      4,
    );
  }
  invariant(
    (await currentOrigin(root))?.identity === origin.identity,
    "SYNC_ORIGIN_CHANGED",
    "Origin изменился во время отправки; результат нового подключения требует проверки",
    4,
  );
  await withDataLock(root, async () => {
    const state = await readState(root);
    if (
      state.generation === generation &&
      snapshotVersion(await readSnapshotFiles(root)) === sentVersion
    ) {
      state.firstDirty = null;
      state.lastDirty = null;
    } else if (state.firstDirty === null) state.firstDirty = state.lastDirty = Date.now();
    state.remote = remote;
    state.origin = origin.identity;
    state.checked = Math.max(state.checked, request);
    state.error = null;
    if (state.resolution === commit) {
      state.conflict = null;
      state.resolution = null;
    }
    await saveState(root, state);
  });
}

type Outgoing = { commit: string; generation: number; request: number; origin: RepositoryIdentity };

async function synchronizeOnce(
  root: string,
  publish: boolean,
  requestedAt?: number,
): Promise<Outgoing | undefined> {
  await recoverPublication(root);
  const info = await marker(root);
  invariant(info, "SYNC_NOT_MANAGED", "Эта база не подключена к Git-синхронизации", 4);
  let state = await readState(root);
  const origin = await currentOrigin(root);
  invariant(
    !state.conflict || state.resolution,
    "SYNC_CONFLICT",
    "База заблокирована конфликтом; сначала изучите и согласуйте обе версии",
    4,
    state.conflict ? { conflictId: state.conflict.id, paths: state.conflict.paths } : undefined,
  );
  if (
    !publish &&
    state.origin === (origin?.identity ?? null) &&
    requestedAt !== undefined &&
    state.lastFetch !== null &&
    state.lastFetch >= requestedAt
  )
    return;
  const request = state.requested;
  const remote = await fetchRemote(root, origin);
  const workspace = await workspaceAt(root);
  const source = await captureSnapshot(workspace);
  const oldHead = await head(root);
  const localHead = await snapshotAt(root, oldHead);
  if (!remote) {
    const dirty = source.version !== snapshotVersion(localHead);
    let nextHead = oldHead;
    if (publish && dirty) {
      const prepared = await prepareSnapshot(root, source.files, info.projectId);
      nextHead = await commitSnapshot(root, source.files, [oldHead]);
      await publishLocal(root, source.files, prepared, source.version, oldHead, nextHead);
    }
    const generation = await withDataLock(root, async () => {
      const current = await readState(root);
      invariant(
        snapshotVersion(await readSnapshotFiles(root)) === source.version,
        "SYNC_SNAPSHOT_CHANGED",
        "База изменилась во время подготовки локального снимка",
        4,
      );
      current.origin = origin?.identity ?? null;
      current.remote = null;
      current.lastFetch = origin ? Date.now() : null;
      current.checked = Math.max(current.checked, request);
      current.error = null;
      if (publish) current.sendingGeneration = current.generation;
      if (!origin && publish) current.firstDirty = current.lastDirty = null;
      else if (origin && current.firstDirty === null)
        current.firstDirty = current.lastDirty = Date.now();
      await saveState(root, current);
      return current.generation;
    });
    if (publish && origin) return { commit: nextHead, generation, request, origin };
    return;
  }
  const remoteFiles = await snapshotAt(root, remote);
  const remoteConfig = remoteFiles["config.json"] as Record<string, unknown>;
  invariant(
    remoteConfig.projectId === info.projectId,
    "SYNC_PROJECT_MISMATCH",
    "Origin содержит другую базу Relay",
    4,
  );
  const generation = await withDataLock(root, async () => {
    const current = await readState(root);
    invariant(
      snapshotVersion(await readSnapshotFiles(root)) === source.version,
      "SYNC_SNAPSHOT_CHANGED",
      "Данные изменились во время проверки origin",
      4,
    );
    if (publish) current.sendingGeneration = current.generation;
    await saveState(root, current);
    return current.generation;
  });
  const baseResult = await git(root, ["merge-base", oldHead, remote], { allowFailure: true });
  invariant(
    !baseResult.code,
    "SYNC_UNRELATED_HISTORY",
    "Истории базы не имеют общего предка; автоматическое объединение запрещено",
    4,
  );
  const base = baseResult.stdout.toString("utf8").trim();
  if (state.resolution && state.conflict && state.conflict.remote !== remote)
    await block(root, {
      base,
      local: oldHead,
      remote,
      paths: ["$remote-changed"],
      reason: "Origin изменился после решения конфликта",
      fingerprint: source.version,
    });
  let nextHead = oldHead;
  const remoteChanged = base !== remote;
  const dirty = source.version !== snapshotVersion(localHead);
  if (remoteChanged || (publish && dirty)) {
    const local = dirty ? await commitSnapshot(root, source.files, [oldHead]) : oldHead;
    const merged = remoteChanged
      ? !dirty && base === oldHead
        ? mergeSnapshots(localHead, source.files, remoteFiles, { publishedDescendant: true })
        : mergeSnapshots(await snapshotAt(root, base), source.files, remoteFiles)
      : { files: source.files, conflicts: [] };
    if (merged.conflicts.length)
      await block(root, {
        base,
        local,
        remote,
        paths: merged.conflicts,
        reason: "Обе стороны изменили несовместимые данные",
        fingerprint: source.version,
      });
    let prepared: PersistentSnapshot;
    try {
      prepared = await prepareSnapshot(root, merged.files, info.projectId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await block(root, {
        base,
        local,
        remote,
        paths: ["$integrity"],
        reason: `${error.code}: ${error.message}`,
        fingerprint: source.version,
      });
      throw error;
    }
    const files = permanent(prepared);
    nextHead =
      snapshotVersion(files) === snapshotVersion(remoteFiles) && !dirty && base === oldHead
        ? remote
        : remoteChanged
          ? await commitSnapshot(root, files, [local, remote])
          : local;
    await publishLocal(root, files, prepared, source.version, oldHead, nextHead);
  }
  await withDataLock(root, async () => {
    state = await readState(root);
    state.remote = remote;
    state.origin = origin?.identity ?? null;
    state.lastFetch = Date.now();
    state.checked = Math.max(state.checked, request);
    state.error = null;
    if ((nextHead !== remote || (dirty && !publish)) && state.firstDirty === null)
      state.firstDirty = state.lastDirty = Date.now();
    await saveState(root, state);
  });
  if (publish && nextHead !== remote && origin)
    return { commit: nextHead, generation, request, origin };
  else if (publish)
    await withDataLock(root, async () => {
      const current = await readState(root);
      if (current.generation === generation) {
        current.firstDirty = null;
        current.lastDirty = null;
      }
      await saveState(root, current);
    });
}

/** Повторяются только снимки/доставка Git, никогда предметные команды пользователя. */
export async function synchronize(
  root: string,
  options: { publish?: boolean; requestedAt?: number } = {},
) {
  return withWorkspaceMaintenance(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const outgoing = await withSyncLock(root, () =>
          synchronizeOnce(root, options.publish ?? true, options.requestedAt),
        );
        if (outgoing) {
          const directory = await managedPath(root, "relay-push-lock");
          await mkdir(directory, { recursive: true });
          await withStorageLock(
            directory,
            () =>
              send(root, outgoing.commit, outgoing.generation, outgoing.request, outgoing.origin),
            directory,
          );
        }
        return await readState(root);
      } catch (error) {
        if (
          error instanceof AppError &&
          ["SYNC_SNAPSHOT_CHANGED", "SYNC_PUSH_REJECTED"].includes(error.code) &&
          attempt < 2
        )
          continue;
        await withDataLock(root, async () => {
          const state = await readState(root);
          state.error = {
            code: error instanceof AppError ? error.code : "SYNC_FAILED",
            message: error instanceof Error ? error.message : "Ошибка синхронизации",
          };
          await saveState(root, state);
        });
        throw error;
      }
    }
  });
}

export async function conflicts(root: string) {
  return withSyncLock(root, async () => {
    const state = await readState(root);
    if (!state.conflict) return null;
    return {
      ...state.conflict,
      baseFiles: await snapshotAt(root, state.conflict.base),
      localFiles: await snapshotAt(root, state.conflict.local),
      remoteFiles: await snapshotAt(root, state.conflict.remote),
    };
  });
}

const resolutionSchema = z.union([
  z.enum(["local", "remote"]),
  z.record(
    z.string(),
    z.union([
      z.strictObject({ take: z.enum(["local", "remote"]) }),
      z.strictObject({ value: z.json().nullable() }),
    ]),
  ),
]);

export async function resolveConflict(root: string, conflictId: string, choice: unknown) {
  const decision = parse(resolutionSchema, choice, "решение конфликта синхронизации");
  await withWorkspaceMaintenance(() =>
    withSyncLock(root, async () => {
      await recoverPublication(root);
      const state = await readState(root),
        info = await marker(root);
      const conflict = state.conflict;
      invariant(
        info && conflict && conflict.id === conflictId && !state.resolution,
        "SYNC_RESOLUTION_STALE",
        "Конфликт изменился; перечитайте его материалы",
        4,
      );
      const remote = await fetchRemote(root, await currentOrigin(root));
      invariant(
        remote,
        "SYNC_ORIGIN_REQUIRED",
        "Для разрешения опубликованного конфликта нужен origin с веткой relay-data",
        4,
      );
      if (remote !== conflict.remote) {
        const base = await gitText(root, ["merge-base", conflict.local, remote]);
        try {
          await block(root, {
            base,
            local: conflict.local,
            remote,
            paths: ["$remote-changed"],
            reason: "Origin изменился после просмотра конфликта",
            fingerprint: conflict.fingerprint,
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "SYNC_CONFLICT") throw error;
        }
        throw new AppError(
          "SYNC_RESOLUTION_STALE",
          "Origin изменился; перечитайте обновлённые материалы конфликта",
          4,
        );
      }
      const baseFiles = await snapshotAt(root, conflict.base);
      const localFiles = await snapshotAt(root, conflict.local);
      const remoteFiles = await snapshotAt(root, conflict.remote);
      let selected: PersistentSnapshot;
      if (typeof decision === "string") selected = decision === "local" ? localFiles : remoteFiles;
      else {
        const merged = mergeSnapshots(baseFiles, localFiles, remoteFiles);
        for (const path of merged.conflicts)
          invariant(
            Object.hasOwn(decision, path),
            "SYNC_RESOLUTION_INCOMPLETE",
            "Для конфликтующего файла не задано решение",
            4,
            { path },
          );
        selected = merged.files;
        for (const [path, answer] of Object.entries(decision)) {
          invariant(
            persistentPath(path) &&
              (Object.hasOwn(baseFiles, path) ||
                Object.hasOwn(localFiles, path) ||
                Object.hasOwn(remoteFiles, path)),
            "SYNC_RESOLUTION_INVALID",
            "Решение содержит неизвестный или служебный путь",
            4,
            { path },
          );
          const value =
            "take" in answer
              ? answer.take === "local"
                ? localFiles[path]
                : remoteFiles[path]
              : answer.value;
          if (value === null || value === undefined) delete selected[path];
          else selected[path] = value;
        }
      }
      const files = structuredClone(selected);
      for (const path of Object.keys(baseFiles))
        invariant(
          !path.startsWith("entities/") || files[path] !== undefined,
          "SYNC_RESOLUTION_INVALID",
          "Удаление существующей сущности требует надгробия; файл нельзя просто исключить",
          4,
          { path },
        );
      // Синтезированная версия не совпадает по CAS с прочитанной версией любой стороны.
      for (const side of [localFiles, remoteFiles]) {
        for (const [path, value] of Object.entries(files)) {
          const before = side[path];
          if (
            !path.startsWith("entities/") ||
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            !before ||
            typeof before !== "object" ||
            Array.isArray(before) ||
            typeof value.revision !== "number" ||
            typeof before.revision !== "number" ||
            snapshotVersion({ [path]: value }) === snapshotVersion({ [path]: before })
          )
            continue;
          const revisions = [localFiles[path], remoteFiles[path]].flatMap((record) =>
            record &&
            typeof record === "object" &&
            !Array.isArray(record) &&
            typeof record.revision === "number"
              ? [record.revision]
              : [],
          );
          value.revision = Math.max(value.revision, ...revisions.map((revision) => revision + 1));
          if (
            value.kind === "work-session" &&
            value.data &&
            before.data &&
            typeof value.data === "object" &&
            !Array.isArray(value.data) &&
            typeof before.data === "object" &&
            !Array.isArray(before.data) &&
            typeof value.data.revision === "number" &&
            typeof before.data.revision === "number"
          )
            value.data.revision = Math.max(value.data.revision, before.data.revision + 1);
        }
      }
      const prepared = await prepareSnapshot(root, files, info.projectId);
      const chosen = permanent(prepared);
      const commit = await commitSnapshot(root, chosen, [conflict.local, conflict.remote]);
      await publishLocal(
        root,
        chosen,
        prepared,
        conflict.fingerprint,
        await head(root),
        commit,
        true,
      );
    }),
  );
  return synchronize(root);
}
