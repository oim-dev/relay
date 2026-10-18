import { mkdir, mkdtemp, rename, rm, realpath, writeFile, readFile, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AppError, invariant } from "@relay/core/shared/errors";
import { atomicJson, exists, readJson, syncDirectory } from "@relay/core/storage/files";
import { withStorageLock } from "@relay/core/storage/lock";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import {
  withWorkspaceMaintenance,
  managedMarker,
  gitMetadataDirectory,
  managedPath,
} from "@relay/core/storage/access";
import {
  readSnapshotFiles,
  captureSnapshot,
  snapshotVersion,
  persistentPath,
} from "@relay/core/application/storage/snapshot";
import type { PersistentSnapshot } from "@relay/core/application/storage/snapshot";
import { StorageService } from "@relay/core/application/storage/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import {
  discoverRepository,
  repositoryDirectory,
  repositoryOrigin,
  normalizeOrigin,
} from "./identity.js";
import type { RepositoryContext } from "./identity.js";
import { git, gitText } from "./git.js";
import { DATA_BRANCH, marker, initialState, saveState, readState } from "./state.js";
import { snapshotAt, writeSnapshot, commitSnapshot, prepareSnapshot } from "./snapshots.js";
import { attachManagedStorage } from "./access.js";
import { synchronize } from "./service.js";
import { assertInitializationTarget } from "@relay/core/storage/initialization";
import { templateOriginSchema, templateRequest, loadTemplate } from "./template.js";
import type { TemplateOptions, TemplateRequest, TemplateOrigin } from "./template.js";

const bindingSchema = z.strictObject({
  version: z.literal(2),
  identity: z.string(),
  sourceRoot: z.string(),
  commonDir: z.string(),
  root: z.string(),
  gitDir: z.string(),
  projectId: z.string(),
  migratedFrom: z.string().optional(),
});
type Binding = z.infer<typeof bindingSchema>;
const bindingPath = (repository: RepositoryContext) =>
  join(repository.commonDir, "relay-worktree.json");
const installIntentSchema = z.strictObject({
  identity: z.string(),
  root: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  remote: z.string().nullable(),
  migratedFrom: z.string().optional(),
  template: templateOriginSchema.optional(),
});
type InstallIntent = z.infer<typeof installIntentSchema>;
const migratedCopySchema = z.strictObject({
  version: z.literal(1),
  sourceVersion: z.string(),
  worktreeConfig: z.string(),
});

async function isMigratedCopy(root: string): Promise<boolean> {
  const path = await managedPath(root, "relay-migrated.json");
  if (!(await exists(path))) return false;
  const record = migratedCopySchema.parse(await readJson(path));
  return record.sourceVersion === snapshotVersion(await readSnapshotFiles(root));
}

export async function registeredWorktree(cwd: string): Promise<Binding | undefined> {
  // Обычная файловая база не должна требовать Git из-за поиска необязательной регистрации.
  let directory = resolve(cwd);
  while (!(await exists(join(directory, ".git")))) {
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
  let commonDir = join(directory, ".git");
  if ((await lstat(commonDir)).isFile()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(commonDir, "utf8"));
    if (!match) return;
    const gitDir = resolve(directory, match[1]!);
    if (!(await exists(join(gitDir, "commondir")))) return;
    commonDir = resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim());
  }
  const path = join(commonDir, "relay-worktree.json");
  if (!(await exists(path))) return;
  const binding = bindingSchema.parse(await readJson(path));
  const repository = await discoverRepository(cwd);
  invariant(
    binding.identity === repository?.identity,
    "SYNC_IDENTITY_MISMATCH",
    "Регистрация относится к другому Git-хранилищу",
    4,
  );
  return binding;
}

async function remoteHead(repository: RepositoryContext): Promise<string | undefined> {
  if (!repository.origin) return;
  const found = await git(
    repository.root,
    ["ls-remote", "--exit-code", "--heads", repository.origin, `refs/heads/${DATA_BRANCH}`],
    { allowFailure: true },
  );
  if (found.code === 2) return;
  invariant(
    !found.code,
    "SYNC_NETWORK_UNAVAILABLE",
    "Не удалось проверить origin; ошибка сети не означает отсутствие базы",
    4,
  );
  await git(repository.root, [
    "fetch",
    "--no-tags",
    repository.origin,
    `refs/heads/${DATA_BRANCH}:refs/relay/remote`,
  ]);
  return gitText(repository.root, ["rev-parse", "refs/relay/remote"]);
}

async function validateBranch(repository: RepositoryContext, commit: string) {
  const files = await snapshotAt(repository.root, commit);
  // Ветка с чистым текущим деревом тоже не должна наследовать историю исходного кода.
  for (const first of (
    await gitText(repository.root, ["rev-list", "--max-parents=0", commit])
  ).split("\n"))
    await snapshotAt(repository.root, first);
  return files;
}

async function saveBinding(
  repository: RepositoryContext,
  root: string,
  projectId: string,
  migratedFrom?: string,
) {
  const binding: Binding = {
    version: 2,
    identity: repository.identity,
    sourceRoot: repository.root,
    commonDir: repository.commonDir,
    root,
    gitDir: await gitMetadataDirectory(root),
    projectId,
    ...(migratedFrom ? { migratedFrom } : {}),
  };
  const control = join(dirname(root), ".runtime", repository.hash);
  await mkdir(control, { recursive: true });
  await atomicJson(join(control, "repository.json"), binding, control);
  await atomicJson(bindingPath(repository), binding, repository.commonDir);
  return binding;
}

/** Восстанавливает удалённые файлы; Git-метаданные и локальные коммиты принадлежат исходному clone. */
async function restoreWorktree(binding: Binding) {
  invariant(
    (await exists(binding.commonDir)) && (await exists(binding.gitDir)),
    "SYNC_GIT_OWNER_MISSING",
    "Git-хранилище владельца worktree недоступно; восстановите исходный репозиторий",
    4,
  );
  const source = await discoverRepository(binding.sourceRoot);
  invariant(
    source?.identity === binding.identity,
    "SYNC_IDENTITY_MISMATCH",
    "Владелец worktree изменился",
    4,
  );
  const commit = await gitText(binding.sourceRoot, ["rev-parse", `refs/heads/${DATA_BRANCH}`]);
  const stage = await mkdtemp(join(dirname(binding.root), ".restore-"));
  try {
    await writeSnapshot(stage, await validateBranch(source, commit));
    const candidate = await openWorkspace(stage, join(stage, "config.json"));
    invariant(
      candidate.config.projectId === binding.projectId,
      "SYNC_PROJECT_MISMATCH",
      "Ветка содержит другую базу Relay",
      4,
    );
    await new StorageService(candidate).reindex();
    await validateWorkspace(candidate);
    await writeFile(join(stage, ".git"), `gitdir: ${binding.gitDir}\n`);
    await rename(stage, binding.root);
    await syncDirectory(dirname(binding.root));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

type InstallOptions = {
  create?: boolean;
  home?: string;
  imported?: { files: PersistentSnapshot; sourceConfig: string; parent?: string };
  template?: TemplateRequest;
};
type Installation = {
  configPath: string;
  template?: TemplateOrigin;
  validation?: Awaited<ReturnType<typeof validateWorkspace>>;
  synchronization?: {
    status: "local" | "synchronized" | "pending";
    error?: { code: string; message: string };
  };
};
async function finishInstall(
  repository: RepositoryContext,
  intent: InstallIntent,
  options: InstallOptions,
  journal: string,
) {
  const { root, commit, remote } = intent;
  const files = await validateBranch(repository, commit);
  invariant(
    (await gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) ===
      repository.commonDir &&
      (await gitText(root, ["symbolic-ref", "--short", "HEAD"])) === DATA_BRANCH &&
      (await gitText(root, ["rev-parse", "HEAD"])) === commit,
    "SYNC_IDENTITY_MISMATCH",
    "Создаваемый worktree не принадлежит исходному репозиторию",
    4,
  );
  if (!(await marker(root)))
    invariant(
      snapshotVersion(await readSnapshotFiles(root)) === snapshotVersion(files),
      "SYNC_RECOVERY_CONFLICT",
      "Файлы незавершённой установки изменились; автоматическая замена запрещена",
      4,
    );
  if (options.imported)
    invariant(
      intent.migratedFrom === options.imported.sourceConfig &&
        snapshotVersion(options.imported.files) === snapshotVersion(files),
      "SYNC_SNAPSHOT_CHANGED",
      "Исходная база изменилась после начала переноса",
      4,
    );
  const workspace = await openWorkspace(root, join(root, "config.json"));
  await new StorageService(workspace).reindex();
  const validation = await validateWorkspace(workspace);
  const projectId = workspace.config.projectId;
  invariant(
    projectId && projectId === (files["config.json"] as { projectId?: string }).projectId,
    "SYNC_INVALID_DATABASE",
    "У базы отсутствует постоянная идентичность",
    4,
  );
  if (intent.template)
    invariant(
      projectId === intent.template.projectId &&
        workspace.config.projectSettings?.name === intent.template.name &&
        workspace.config.projectSettings.slug === intent.template.slug,
      "SYNC_RECOVERY_CONFLICT",
      "Подготовленная база не соответствует идентичности установки шаблона",
      4,
    );
  const origin = await repositoryOrigin(repository.root);
  if (!(await marker(root)))
    await atomicJson(
      await managedMarker(root),
      {
        version: 2,
        identity: repository.identity,
        sourceRoot: repository.root,
        commonDir: repository.commonDir,
        branch: DATA_BRANCH,
        projectId,
      },
      await gitMetadataDirectory(root),
    );
  const statePath = join(await gitMetadataDirectory(root), "relay-sync.json");
  if (!(await exists(statePath))) {
    const state = initialState();
    state.remote = remote;
    state.origin = origin?.identity ?? null;
    await saveState(root, state);
  } else await readState(root);
  await saveBinding(repository, root, projectId, intent.migratedFrom);
  await rm(journal, { force: true });
  await syncDirectory(dirname(journal));
  await attachManagedStorage(root);
  let synchronization: Installation["synchronization"] = { status: "local" };
  if ((options.create || intent.template) && origin) {
    try {
      const state = await synchronize(root);
      synchronization = { status: state.origin === null ? "local" : "synchronized" };
    } catch (error) {
      if (!intent.template) throw error;
      synchronization = {
        status: "pending",
        error: {
          code: error instanceof AppError ? error.code : "SYNC_FAILED",
          message: error instanceof Error ? error.message : "Ошибка синхронизации",
        },
      };
    }
  }
  return {
    configPath: join(root, "config.json"),
    validation,
    synchronization,
    ...(intent.template ? { template: intent.template } : {}),
  };
}

async function install(
  repository: RepositoryContext,
  options: InstallOptions,
): Promise<Installation> {
  const control = join(repository.commonDir, "relay-install");
  await mkdir(control, { recursive: true });
  return withStorageLock(
    control,
    async () => {
      const journal = join(control, "pending.json");
      const pending = (await exists(journal))
        ? installIntentSchema.parse(await readJson(journal))
        : undefined;
      const binding = await registeredWorktree(repository.root);
      if (options.template) {
        invariant(
          !binding || pending?.template,
          "ALREADY_INITIALIZED",
          "У проекта уже есть база Relay; шаблон не заменяет её",
          4,
          { configPath: binding && join(binding.root, "config.json") },
        );
        invariant(
          !pending || pending.template,
          "ALREADY_INITIALIZED",
          "У проекта есть другая незавершённая установка базы",
          4,
        );
        if (pending?.template) {
          const source = pending.template;
          invariant(
            source.repository === options.template.repository &&
              source.ref === options.template.ref &&
              (options.template.name === undefined || source.name === options.template.name) &&
              (options.template.slug === undefined || source.slug === options.template.slug),
            "TEMPLATE_INSTALL_MISMATCH",
            "Продолжите установку с тем же шаблоном, именем и slug",
            4,
          );
        }
      }
      if (binding && !pending?.template) {
        invariant(
          !options.imported || binding.migratedFrom === options.imported.sourceConfig,
          "SYNC_ALREADY_MANAGED",
          "У проекта уже есть worktree базы; новая база не заменяет его",
          4,
        );
        invariant(
          !options.home || dirname(binding.root) === resolve(options.home),
          "SYNC_HOME_MISMATCH",
          "Worktree этого Git-хранилища уже зарегистрирован в другом RELAY_HOME",
          4,
          { root: binding.root },
        );
        if (!(await exists(binding.root))) await restoreWorktree(binding);
        invariant(
          (await exists(join(binding.root, "config.json"))) &&
            (await exists(join(binding.root, "storage.json"))),
          "SYNC_INVALID_DATABASE",
          "Существующая Git-база неполна; восстановите файлы из проверенной копии",
          4,
        );
        await attachManagedStorage(binding.root);
        return { configPath: join(binding.root, "config.json") };
      }
      invariant(
        !pending || pending.identity === repository.identity,
        "SYNC_IDENTITY_MISMATCH",
        "Незавершённая установка принадлежит другому Git-хранилищу",
        4,
      );
      const root = pending?.root ?? repositoryDirectory(repository, options.home);
      invariant(
        !options.home || dirname(root) === resolve(options.home),
        "SYNC_HOME_MISMATCH",
        "Установка базы начата в другом RELAY_HOME",
        4,
      );
      if (!options.imported && repository.origin) {
        const legacy = repositoryDirectory(
          normalizeOrigin(repository.origin, repository.root),
          options.home,
        );
        if (
          legacy !== root &&
          (await marker(legacy))?.version === 1 &&
          !(await isMigratedCopy(legacy))
        )
          throw new AppError(
            "SYNC_WORKTREE_MIGRATION_REQUIRED",
            "Найдена прежняя самостоятельная Git-база. Перенесите её через sync migrate --from-config, чтобы сохранить локальные данные",
            4,
            { configPath: join(legacy, "config.json") },
          );
      }
      await mkdir(dirname(root), { recursive: true });
      if (pending) {
        if (pending.template) {
          const local = await git(
            repository.root,
            ["rev-parse", "--verify", `refs/heads/${DATA_BRANCH}`],
            { allowFailure: true },
          );
          invariant(
            local.code || local.stdout.toString("utf8").trim() === pending.commit,
            "SYNC_RECOVERY_CONFLICT",
            "Ветка незавершённой установки изменена извне",
            4,
          );
          if (local.code)
            await git(repository.root, [
              "update-ref",
              `refs/heads/${DATA_BRANCH}`,
              pending.commit,
              "",
            ]);
        }
        if (!(await exists(root))) {
          // Только точный адрес собственного намерения; чужие worktree не очищаются.
          await git(repository.root, ["worktree", "remove", "--force", "--force", root], {
            allowFailure: true,
          });
          await git(repository.root, [
            "worktree",
            "add",
            "--lock",
            "--reason",
            "Relay: база проекта",
            root,
            DATA_BRANCH,
          ]);
        }
        return finishInstall(repository, pending, options, journal);
      }
      if (options.template) {
        const target = await lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        invariant(
          !target,
          "ALREADY_INITIALIZED",
          "Каталог целевой базы уже существует; шаблон не заменяет его",
          4,
          { root },
        );
      }
      if (await exists(root)) {
        const info = await marker(root);
        invariant(
          info?.version === 2 && info.identity === repository.identity,
          "SYNC_IDENTITY_MISMATCH",
          "Каталог занят другой или неполной базой; автоматическая замена запрещена",
          4,
          { root },
        );
        await saveBinding(repository, root, info.projectId);
        await attachManagedStorage(root);
        return { configPath: join(root, "config.json") };
      }
      const local = await git(
        repository.root,
        ["rev-parse", "--verify", `refs/heads/${DATA_BRANCH}`],
        { allowFailure: true },
      );
      let commit = local.code ? undefined : local.stdout.toString("utf8").trim();
      let remote: string | undefined;
      let template: TemplateOrigin | undefined;
      if (options.template) {
        const codeBranch = await git(repository.root, ["symbolic-ref", "--quiet", "HEAD"], {
          allowFailure: true,
        });
        invariant(
          codeBranch.code ||
            codeBranch.stdout.toString("utf8").trim() !== `refs/heads/${DATA_BRANCH}`,
          "TEMPLATE_BRANCH_IN_USE",
          "Ветка relay-data предназначена для базы; выберите другую ветку кода перед установкой шаблона",
          4,
        );
        invariant(
          !commit,
          "ALREADY_INITIALIZED",
          "Локальная ветка relay-data уже существует; шаблон не заменяет её",
          4,
        );
        if (repository.origin) {
          const found = await git(
            repository.root,
            ["ls-remote", "--exit-code", "--heads", repository.origin, `refs/heads/${DATA_BRANCH}`],
            { allowFailure: true },
          );
          invariant(
            found.code !== 0,
            "ALREADY_INITIALIZED",
            "Origin уже содержит базу Relay; шаблон не заменяет её",
            4,
          );
          invariant(
            found.code === 2,
            "SYNC_NETWORK_UNAVAILABLE",
            "Не удалось проверить origin; ошибка сети не означает отсутствие базы",
            4,
          );
        }
        const prepared = await loadTemplate(dirname(root), options.template, repository.name);
        template = prepared.template;
        commit = await commitSnapshot(repository.root, prepared.files, []);
      } else remote = await remoteHead(repository);
      if (options.imported) {
        invariant(
          !commit,
          "SYNC_ALREADY_MANAGED",
          "Ветка relay-data уже существует локально; перенос не заменяет её",
          4,
        );
        const { files, parent } = options.imported;
        if (remote) {
          const remoteFiles = await validateBranch(repository, remote);
          invariant(
            (remoteFiles["config.json"] as { projectId?: string }).projectId ===
              (files["config.json"] as { projectId?: string }).projectId,
            "SYNC_PROJECT_MISMATCH",
            "Origin содержит другую базу Relay; перенос не заменяет её",
            4,
          );
          if (parent)
            invariant(
              !(await git(repository.root, ["merge-base", parent, remote], { allowFailure: true }))
                .code,
              "SYNC_UNRELATED_HISTORY",
              "Истории исходной базы и origin не связаны",
              4,
            );
          else
            invariant(
              snapshotVersion(files) === snapshotVersion(remoteFiles),
              "SYNC_REMOTE_DATABASE_EXISTS",
              "В origin уже есть отличающаяся база; сначала согласуйте данные",
              4,
            );
        }
        commit = await commitSnapshot(
          repository.root,
          files,
          parent ? [parent] : remote ? [remote] : [],
        );
      }
      if (!commit) commit = remote;
      invariant(
        commit || options.create,
        "RELAY_NOT_INITIALIZED",
        "База Relay ещё не создана. Выполните: npx @oim-dev/relay-cli init",
        4,
      );
      if (!commit) {
        const stage = await mkdtemp(join(dirname(root), ".prepare-"));
        try {
          const created = await initialize(stage, "tasks", join(stage, "config.json"));
          const settings = await created.locked(async () => created.config.projectSettings!);
          await saveProjectSettings(created, {
            name: repository.name,
            slug: settings.slug,
            ifRevision: settings.revision,
          });
          await validateWorkspace(created);
          commit = await commitSnapshot(repository.root, await readSnapshotFiles(stage), []);
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }
      await validateBranch(repository, commit);
      const intent: InstallIntent = {
        identity: repository.identity,
        root,
        commit,
        remote: remote ?? null,
        ...(options.imported ? { migratedFrom: options.imported.sourceConfig } : {}),
        ...(template ? { template } : {}),
      };
      // Шаблон фиксирует точный новый коммит до создания ref: сбой не создаёт вторую копию.
      if (template) await atomicJson(journal, intent, control);
      if (local.code)
        await git(repository.root, ["update-ref", `refs/heads/${DATA_BRANCH}`, commit, ""]);
      if (!template) await atomicJson(journal, intent, control);
      await git(repository.root, [
        "worktree",
        "add",
        "--lock",
        "--reason",
        "Relay: база проекта",
        root,
        DATA_BRANCH,
      ]);
      return finishInstall(repository, intent, options, journal);
    },
    control,
  );
}

/** Явный перенос копирует согласованный снимок и сохраняет исходную базу для восстановления. */
export async function migrateToWorktree(cwd: string, sourceConfig: string, home?: string) {
  const repository = await discoverRepository(cwd);
  invariant(repository, "SYNC_NOT_MANAGED", "Для переноса нужен Git-репозиторий проекта", 4);
  const source = await realpath(resolve(cwd, sourceConfig));
  const existing = await registeredWorktree(cwd);
  if (existing) {
    invariant(
      existing.migratedFrom === source,
      "SYNC_ALREADY_MANAGED",
      "У проекта уже есть worktree другой базы",
      4,
    );
    return managedConfiguration(cwd, home === undefined ? {} : { home });
  }
  return withWorkspaceMaintenance(async () => {
    const workspace = await openWorkspace(dirname(source), source);
    const info = await marker(workspace.dataRoot);
    invariant(
      info?.version !== 2,
      "SYNC_ALREADY_MANAGED",
      "Исходная база уже является worktree",
      4,
    );
    if (info) {
      const state = await readState(workspace.dataRoot);
      invariant(
        !state.conflict && !state.resolution,
        "SYNC_CONFLICT",
        "Сначала разрешите конфликт исходной базы",
        4,
      );
    }
    const snapshot = await captureSnapshot(workspace);
    const projectId = workspace.config.projectId;
    invariant(projectId, "SYNC_INVALID_DATABASE", "У исходной базы нет projectId", 4);
    const prepared = await prepareSnapshot(repository.root, snapshot.files, projectId);
    const files = Object.fromEntries(
      Object.entries(prepared).filter(([path]) => persistentPath(path)),
    );
    let parent: string | undefined;
    if (info) {
      await git(repository.root, [
        "fetch",
        "--no-tags",
        workspace.dataRoot,
        "HEAD:refs/relay/import",
      ]);
      parent = await gitText(repository.root, ["rev-parse", "refs/relay/import"]);
      await validateBranch(repository, parent);
    }
    await workspace.locked(async () => {
      invariant(
        snapshotVersion(await readSnapshotFiles(workspace.dataRoot)) === snapshot.version,
        "SYNC_SNAPSHOT_CHANGED",
        "Исходная база изменилась во время подготовки переноса",
        4,
      );
    });
    const { configPath: config } = await install(repository, {
      create: true,
      ...(home ? { home } : {}),
      imported: { files, sourceConfig: source, ...(parent ? { parent } : {}) },
    });
    if (info?.version === 1)
      await atomicJson(
        await managedPath(workspace.dataRoot, "relay-migrated.json"),
        {
          version: 1,
          sourceVersion: snapshot.version,
          worktreeConfig: config,
        },
        await gitMetadataDirectory(workspace.dataRoot),
      );
    return config;
  });
}

export async function managedConfiguration(
  cwd: string,
  options: { create?: boolean; home?: string } = {},
): Promise<string | undefined> {
  const repository = await discoverRepository(cwd);
  if (!repository) return;
  return (await withWorkspaceMaintenance(() => install(repository, options))).configPath;
}

/** Новая независимая база: источник используется однократно и не регистрируется как remote. */
export async function initializeFromTemplate(cwd: string, input: TemplateOptions) {
  const request = templateRequest(cwd, input);
  const repository = await discoverRepository(cwd);
  invariant(
    repository,
    "TEMPLATE_GIT_REQUIRED",
    "Для установки шаблона сначала выполните git init в новом проекте",
    4,
  );
  const { locateConfiguration } = await import("../config.js");
  const configuration = await locateConfiguration(cwd).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "CONFIG_NOT_FOUND") return undefined;
    throw error;
  });
  invariant(
    !configuration,
    "ALREADY_INITIALIZED",
    "Найдена конфигурация Relay; шаблон устанавливается только в новый Git-проект",
    4,
  );
  await assertInitializationTarget(join(repository.root, ".relay/config.json"));
  return withWorkspaceMaintenance(async () => {
    const result = await install(repository, {
      create: true,
      template: request,
      ...(input.home ? { home: input.home } : {}),
    });
    invariant(
      result.template && result.validation && result.synchronization,
      "SYNC_STATE_INVALID",
      "Установка шаблона не вернула проверенный результат",
      4,
    );
    return {
      configPath: result.configPath,
      storageDir: dirname(result.configPath),
      projectId: result.template.projectId,
      name: result.template.name,
      slug: result.template.slug,
      template: result.template,
      validation: result.validation,
      synchronization: result.synchronization,
    };
  });
}

export async function managedRoot(cwd: string, explicit?: string, home?: string) {
  if (explicit) {
    await restoreManagedConfiguration(explicit);
    const root = await realpath(dirname(explicit));
    invariant(await marker(root), "SYNC_NOT_MANAGED", "Выбранная база не подключена к Git", 4);
    return root;
  }
  const config = await managedConfiguration(cwd, home === undefined ? {} : { home });
  if (!config) throw new AppError("SYNC_NOT_MANAGED", "Не найден Git-репозиторий проекта", 4);
  return dirname(config);
}

export async function restoreManagedConfiguration(config: string): Promise<boolean> {
  if (await exists(config)) return false;
  const root = dirname(config),
    home = dirname(root);
  const match = /-([a-f0-9]{32})$/.exec(root);
  if (!match || basename(config) !== "config.json") return false;
  const metadata = join(home, ".runtime", match[1]!, "repository.json");
  if (!(await exists(metadata))) return false;
  const saved = bindingSchema.safeParse(await readJson(metadata));
  invariant(
    saved.success,
    "SYNC_WORKTREE_MIGRATION_REQUIRED",
    "Прежнюю самостоятельную Git-базу нужно перенести в worktree из каталога исходного проекта",
    4,
  );
  invariant(
    saved.data.root === root,
    "SYNC_IDENTITY_MISMATCH",
    "Адрес восстановления не соответствует зарегистрированному worktree",
    4,
  );
  const repository = await discoverRepository(saved.data.sourceRoot);
  invariant(
    repository?.identity === saved.data.identity,
    "SYNC_GIT_OWNER_MISSING",
    "Исходный Git-репозиторий worktree недоступен",
    4,
  );
  await withWorkspaceMaintenance(() => install(repository, { home }));
  return true;
}
