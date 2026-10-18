import { mkdir, mkdtemp, rename, rm, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError, invariant } from "@relay/core/shared/errors";
import { atomicJson, exists, readJson, syncDirectory } from "@relay/core/storage/files";
import { withStorageLock } from "@relay/core/storage/lock";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { withWorkspaceMaintenance, managedMarker } from "@relay/core/storage/access";
import { readSnapshotFiles } from "@relay/core/application/storage/snapshot";
import { StorageService } from "@relay/core/application/storage/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { discoverRepository, repositoryDirectory, normalizeOrigin } from "./identity.js";
import type { RepositoryIdentity } from "./identity.js";
import { git, gitText } from "./git.js";
import { DATA_BRANCH, marker, initialState, saveState } from "./state.js";
import { snapshotAt, writeSnapshot, commitSnapshot } from "./snapshots.js";
import { attachManagedStorage } from "./access.js";

async function remoteBranch(cwd: string, origin: string) {
  const result = await git(
    cwd,
    ["ls-remote", "--exit-code", "--heads", origin, `refs/heads/${DATA_BRANCH}`],
    { allowFailure: true },
  );
  if (result.code === 2) return false;
  invariant(
    result.code === 0,
    "SYNC_NETWORK_UNAVAILABLE",
    "Не удалось проверить origin. Ошибка сети или доступа не означает отсутствие базы",
    4,
  );
  return true;
}

async function install(
  repository: RepositoryIdentity,
  root: string,
  create: boolean,
): Promise<string> {
  const home = dirname(root),
    control = join(home, ".runtime", repository.hash);
  await mkdir(control, { recursive: true });
  return withStorageLock(
    control,
    async () => {
      if (await exists(root)) {
        const info = await marker(root);
        invariant(
          info && info.identity === repository.identity,
          "SYNC_IDENTITY_MISMATCH",
          "Каталог занят другой или неполной базой; автоматическая замена запрещена",
          4,
          { root },
        );
        invariant(
          (await exists(join(root, "config.json"))) && (await exists(join(root, "storage.json"))),
          "SYNC_INVALID_DATABASE",
          "Существующая Git-база неполна; сохраните данные и восстановите отсутствующие файлы",
          4,
          { root },
        );
        await attachManagedStorage(root);
        await atomicJson(join(control, "repository.json"), repository, control);
        return join(root, "config.json");
      }
      const remoteExists = await remoteBranch(home, repository.origin);
      invariant(
        remoteExists || create,
        "RELAY_NOT_INITIALIZED",
        "В origin нет базы Relay. Создайте её: npx @oim-dev/relay-cli init",
        4,
        { identity: repository.identity, branch: DATA_BRANCH },
      );
      const stage = await mkdtemp(join(home, ".install-"));
      try {
        await git(stage, ["init", "--initial-branch", DATA_BRANCH]);
        await git(stage, ["remote", "add", "origin", repository.origin]);
        let commit: string;
        if (remoteExists) {
          await git(stage, [
            "fetch",
            "--no-tags",
            "origin",
            `refs/heads/${DATA_BRANCH}:refs/remotes/origin/${DATA_BRANCH}`,
          ]);
          commit = await gitText(stage, ["rev-parse", `refs/remotes/origin/${DATA_BRANCH}`]);
          await writeSnapshot(stage, await snapshotAt(stage, commit));
        } else {
          const created = await initialize(stage, "tasks", join(stage, "config.json"));
          const settings = await created.locked(async () => created.config.projectSettings!);
          await saveProjectSettings(created, {
            name: repository.name,
            slug: settings.slug,
            ifRevision: settings.revision,
          });
          commit = await commitSnapshot(stage, await readSnapshotFiles(stage), []);
        }
        const workspace = await openWorkspace(stage, join(stage, "config.json"));
        await new StorageService(workspace).reindex();
        await validateWorkspace(workspace);
        await git(stage, ["update-ref", `refs/heads/${DATA_BRANCH}`, commit]);
        await git(stage, ["read-tree", commit]);
        if (!remoteExists) {
          // Создание ветки — CAS отсутствующего ref; конкурирующий init не перезаписывается.
          const pushed = await git(
            stage,
            ["push", "origin", `${commit}:refs/heads/${DATA_BRANCH}`],
            { allowFailure: true },
          );
          invariant(
            !pushed.code,
            "SYNC_INIT_RACE",
            "Origin отклонил создание ветки; проверьте доступ или подключитесь к базе другого участника повторным вызовом",
            4,
          );
        }
        invariant(
          workspace.config.projectId,
          "SYNC_INVALID_DATABASE",
          "У базы отсутствует постоянный projectId",
          4,
        );
        await atomicJson(
          managedMarker(stage),
          {
            version: 1,
            identity: repository.identity,
            origin: repository.origin,
            branch: DATA_BRANCH,
            projectId: workspace.config.projectId,
          },
          join(stage, ".git"),
        );
        const state = initialState();
        state.remote = commit;
        state.lastFetch = Date.now();
        await saveState(stage, state);
        await atomicJson(join(control, "repository.json"), repository, control);
        await rename(stage, root);
        await syncDirectory(home);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      await attachManagedStorage(root);
      return join(root, "config.json");
    },
    control,
  );
}

/** Отсутствующий каталог восстанавливается только из подтверждённой служебной ветки. */
export async function managedConfiguration(
  cwd: string,
  options: { create?: boolean; home?: string } = {},
): Promise<string | undefined> {
  const repository = await discoverRepository(cwd);
  if (!repository) return undefined;
  const root = repositoryDirectory(repository, options.home);
  return withWorkspaceMaintenance(() => install(repository, root, options.create ?? false));
}

export async function managedRoot(cwd: string, explicit?: string, home?: string) {
  if (explicit) {
    await restoreManagedConfiguration(explicit);
    const root = await realpath(dirname(explicit));
    invariant(await marker(root), "SYNC_NOT_MANAGED", "Выбранная база не подключена к Git", 4);
    return root;
  }
  const config = await managedConfiguration(cwd, home === undefined ? {} : { home });
  if (!config) throw new AppError("SYNC_NOT_MANAGED", "Не найден Git-репозиторий с origin", 4);
  return dirname(config);
}

/** Восстановление уже известного Server/реестру адреса после удаления локальной копии. */
export async function restoreManagedConfiguration(config: string): Promise<boolean> {
  if (await exists(config)) return false;
  const root = dirname(config),
    home = dirname(root);
  const match = /-([a-f0-9]{32})$/.exec(root);
  if (!match || basename(config) !== "config.json") return false;
  const metadata = join(home, ".runtime", match[1]!, "repository.json");
  if (!(await exists(metadata))) return false;
  const saved = (await readJson(metadata)) as RepositoryIdentity;
  invariant(
    typeof saved.origin === "string",
    "SYNC_STATE_INVALID",
    "Повреждена регистрация Git-базы",
    4,
  );
  const repository = normalizeOrigin(saved.origin);
  invariant(
    repository.identity === saved.identity && repositoryDirectory(repository, home) === root,
    "SYNC_IDENTITY_MISMATCH",
    "Адрес восстановления не совпадает с идентичностью базы",
    4,
  );
  await withWorkspaceMaintenance(() => install(repository, root, false));
  return true;
}
