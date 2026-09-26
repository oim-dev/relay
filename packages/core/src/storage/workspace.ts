import { mkdir, realpath } from "node:fs/promises";
import { shortId } from "../shared/ids.js";
import { basename, dirname, join, resolve } from "node:path";
import { configSchema, defaultConfig } from "../domain/config.js";
import type { Config } from "../domain/config.js";
import { parse } from "../domain/validation.js";
import { AppError, invariant } from "../shared/errors.js";
import { exists, readJson } from "./files.js";
import { prepareRuntime, runtimeDirectory, withStorageLock } from "./lock.js";
import { BoardRepository } from "./boards.js";
import { BoardTaskRepository } from "./board-tasks.js";
import { createProjectSlug, defaultProjectName } from "./project-settings.js";
import { ProductTransaction } from "./product-transaction.js";
import { GraphTransaction } from "./graph-transaction.js";
import { recoverGraphMigration } from "./graph-migration.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { EntityDeletionRepository } from "./entity-deletion.js";
import { DocumentLinksRepository } from "./document-links.js";
import { EntityStore } from "./entity-store/store.js";
import type { StorageSession } from "./entity-store/store.js";
import {
  workspaceStorageRegistry,
  json,
  encodeCommandResult,
  decodeCommandResult,
} from "./unified-adapter.js";
import { storedProjectSettingsSchema } from "../domain/project-settings.js";
import { storageManifestSchema } from "@relay/contracts/storage";
import { HashIndex } from "./entity-store/hash-index.js";
import { stateSchema, STATE_PATH } from "./entity-store/format.js";

const lockContext = new AsyncLocalStorage<{
  root: string;
  runtime: string;
  assertOwned: () => void;
  active: boolean;
  recoveringDocumentLinks?: boolean;
  session?: StorageSession;
}>();

export const CONFIG_NAME = ".relay/config.json";

export class Workspace {
  readonly runtime: string;
  storageProductId: string | undefined;
  constructor(
    readonly configPath: string,
    readonly root: string,
    readonly config: Config,
  ) {
    this.runtime = root === dirname(configPath) ? join(root, "runtime") : runtimeDirectory(root);
  }
  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }
  get dataRoot(): string {
    return this.storageProductId === undefined ? this.root : dirname(this.configPath);
  }
  get storageSession(): StorageSession | undefined {
    const context = lockContext.getStore();
    return context?.active && context.root === this.root ? context.session : undefined;
  }
  async hasUnifiedStorage(): Promise<boolean> {
    const root = dirname(this.configPath);
    if (
      (await exists(join(root, "storage.json"))) ||
      (await exists(join(root, "transactions/pending.json")))
    )
      return true;
    invariant(
      !(await exists(join(root, "entities/projects"))),
      "STORAGE_FORMAT_MISSING",
      "Маркер storage.json потерян; восстановите его до открытия базы",
      5,
    );
    return false;
  }
  async inStorageSession<T>(
    session: StorageSession,
    owned: () => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    const context = {
      root: this.root,
      runtime: join(session.store.root, "runtime"),
      assertOwned: owned,
      active: true,
      session,
    };
    return lockContext.run(context, async () => {
      try {
        return await operation();
      } finally {
        context.active = false;
      }
    });
  }
  async mutate<T>(
    namespace: string,
    input: { requestId: string; [key: string]: unknown },
    actor: string,
    operation: (owned: () => void) => Promise<T>,
  ): Promise<T> {
    invariant(
      (namespace === "graph" && this.recoveringDocumentLinks) || (await this.hasUnifiedStorage()),
      "STORAGE_MIGRATION_REQUIRED",
      "Запись прежнего формата запрещена. Выполните relay-cli --local storage migrate",
      4,
    );
    return this.locked(async (owned) => {
      const session = this.storageSession;
      // Завершение уже записанного намерения не является новой публичной legacy-командой.
      if (!session && namespace === "graph" && this.recoveringDocumentLinks)
        return operation(owned);
      this.assertWritableStorage();
      invariant(session, "STORAGE_MIGRATION_REQUIRED", "Для записи выполните storage migrate", 4);
      const request: Record<string, unknown> = { ...input, actor };
      if (request.includeTask === false) delete request.includeTask;
      const result = await session.execute(
        { namespace, actor, requestId: input.requestId, request: json(request) },
        async () => {
          const value = await operation(owned);
          return encodeCommandResult(namespace, value);
        },
      );
      return decodeCommandResult<T>(namespace, result);
    });
  }
  /** Публичные изменения допустимы только внутри общей сессии актуального формата. */
  assertWritableStorage(): void {
    invariant(
      this.storageSession?.store.formatVersion === 4,
      "STORAGE_MIGRATION_REQUIRED",
      "Запись прежнего формата запрещена. Выполните relay-cli --local storage migrate",
      4,
    );
  }
  get recoveringDocumentLinks(): boolean {
    const context = lockContext.getStore();
    return (
      context?.active === true &&
      context.root === this.root &&
      context.recoveringDocumentLinks === true
    );
  }
  /** Формат привязывает блокировку к реальному каталогу данных, независимо от прежнего storageDir. */
  async withEntityStorage<T>(
    operation: (store: EntityStore, owned: () => void) => Promise<T>,
    initialize = false,
  ): Promise<T> {
    const root = await realpath(dirname(this.configPath));
    const runtime = join(root, "runtime");
    await mkdir(runtime, { recursive: true });
    const parent = lockContext.getStore();
    const active = parent?.active && parent.root === this.root ? parent : undefined;
    const run = async (owned: () => void) => {
      const assertOwned = () => {
        active?.assertOwned();
        owned();
      };
      const store = await EntityStore.underLock(
        root,
        workspaceStorageRegistry(),
        assertOwned,
        initialize,
      );
      if (!initialize)
        this.storageProductId = storageManifestSchema.parse(
          await readJson(join(root, "storage.json")),
        ).productId;
      return operation(store, assertOwned);
    };
    if (active && (await realpath(active.runtime)) === runtime) return run(active.assertOwned);
    return withStorageLock(root, run, runtime);
  }

  async locked<T>(operation: (assertOwned: () => void) => Promise<T>): Promise<T> {
    const context = lockContext.getStore();
    if (context?.active && context.root === this.root && context.session) {
      context.assertOwned();
      return operation(context.assertOwned);
    }
    if (await this.hasUnifiedStorage())
      return this.withEntityStorage(async (store, assertOwned) => {
        invariant(
          !(await exists(join(store.root, "runtime/index-stale.json"))),
          "STORAGE_INDEX_STALE",
          "Обнаружены внешние изменения данных. Выполните storage reindex и перечитайте записи",
          4,
        );
        return store.transaction(assertOwned, (session) =>
          this.inStorageSession(session, assertOwned, async () => {
            const settings = await session.indexGet("configuration", "project");
            invariant(settings, "STORAGE_INDEX_CORRUPT", "Отсутствует индекс настроек проекта", 5);
            this.config.projectSettings = storedProjectSettingsSchema.parse(settings);
            const result = await operation(assertOwned);
            if ([...session.files.keys()].some((path) => path.startsWith("entities/"))) {
              const { refreshEntityCards } =
                await import("../application/entities/storage-projection.js");
              await refreshEntityCards(this, assertOwned);
            }
            return result;
          }),
        );
      });
    if (context?.active && context.root === this.root) {
      context.assertOwned();
      return operation(context.assertOwned);
    }
    return withStorageLock(this.root, async (assertOwned) => {
      const owned = {
        root: this.root,
        runtime: this.runtime,
        assertOwned,
        active: true,
        recoveringDocumentLinks: false,
      };
      return lockContext.run(owned, async () => {
        try {
          if (await this.hasUnifiedStorage()) return this.locked(operation);
          await new EntityDeletionRepository(this).recover(assertOwned);
          await new ProductTransaction(this).recover(assertOwned);
          await new GraphTransaction(this).recover(assertOwned);
          await recoverGraphMigration(this, assertOwned);
          await new BoardRepository(this).recover(assertOwned);
          await new BoardTaskRepository(this).recover(assertOwned);
          if (await new DocumentLinksRepository(this).readPending()) {
            const { recoverDocumentLinks } =
              await import("../application/documents/link-workflow.js");
            owned.recoveringDocumentLinks = true;
            try {
              await recoverDocumentLinks(this, assertOwned);
            } finally {
              owned.recoveringDocumentLinks = false;
            }
          }
          return await operation(assertOwned);
        } finally {
          owned.active = false;
        }
      });
    });
  }
}

async function locateConfig(cwd: string, explicit?: string): Promise<string> {
  if (explicit) return resolve(cwd, explicit);
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, CONFIG_NAME);
    if (
      (await exists(candidate)) ||
      (await exists(join(dirname(candidate), "transactions/pending.json")))
    )
      return candidate;
    const parent = dirname(current);
    if (parent === current)
      throw new AppError(
        "CONFIG_NOT_FOUND",
        "Конфигурация не найдена. Выполните init или передайте --config",
        2,
      );
    current = parent;
  }
}

/** Обычное чтение настроек не пишет данные; незавершённый переход восстанавливается до чтения. */
export async function readWorkspaceConfig(cwd: string, explicit?: string) {
  const located = await locateConfig(cwd, explicit);
  if (
    !(await exists(located)) &&
    (await exists(join(dirname(located), "transactions/pending.json")))
  )
    await EntityStore.open(dirname(located), workspaceStorageRegistry());
  let config = parse(configSchema, await readJson(located), located);
  const configPath = join(await realpath(dirname(located)), basename(located));
  const directory = await realpath(dirname(configPath));
  if (await exists(join(directory, "transactions/pending.json"))) {
    const anchor = resolve(directory, config.storageDir);
    const temporary = new Workspace(
      configPath,
      (await exists(anchor)) ? await realpath(anchor) : anchor,
      config,
    );
    await temporary.withEntityStorage(async () => {});
    config = parse(configSchema, await readJson(configPath), configPath);
  }
  if (await exists(join(directory, "storage.json"))) {
    storageManifestSchema.parse(await readJson(join(directory, "storage.json")));
    try {
      const state = stateSchema.parse(await readJson(join(directory, STATE_PATH)));
      const projection = await new HashIndex(directory).get(
        state.roots.configuration ?? null,
        "project",
      );
      config.projectSettings = storedProjectSettingsSchema.parse(projection);
    } catch {
      // Доступ к обслуживанию сохраняется при потере индекса: читается только запись настроек.
      const record = workspaceStorageRegistry().decode(
        await readJson(
          join(directory, "entities/projects", `${config.projectId ?? "project"}.json`),
        ),
      );
      config.projectSettings = storedProjectSettingsSchema.parse({
        ...record.data,
        version: 3,
        revision: record.revision,
        entityKey: record.key,
        aliases: record.aliases,
      });
    }
  }
  return { configPath, config };
}

export async function openWorkspace(cwd: string, explicit?: string): Promise<Workspace> {
  const { configPath, config } = await readWorkspaceConfig(cwd, explicit);
  const dataRoot = dirname(configPath);
  if (await exists(join(dataRoot, "storage.json"))) {
    const workspace = new Workspace(configPath, dataRoot, config);
    workspace.storageProductId = storageManifestSchema.parse(
      await readJson(join(dataRoot, "storage.json")),
    ).productId;
    return workspace;
  }
  const storage = resolve(dirname(configPath), config.storageDir);
  await mkdir(dirname(storage), { recursive: true });
  const root = (await exists(storage))
    ? await realpath(storage)
    : join(await realpath(dirname(storage)), basename(storage));
  await prepareRuntime(root);
  // Git не хранит пустые каталоги.
  if (!(await exists(root)))
    // Несколько запросов и наблюдатель могут впервые открыть один каталог одновременно.
    await mkdir(root, { recursive: true });
  const workspace = new Workspace(configPath, root, config);
  if (await exists(join(dirname(configPath), "storage.json")))
    workspace.storageProductId = storageManifestSchema.parse(
      await readJson(join(dirname(configPath), "storage.json")),
    ).productId;
  return workspace;
}

export async function initialize(
  cwd: string,
  storageDir: string,
  explicit?: string,
): Promise<Workspace> {
  const configPath = resolve(cwd, explicit ?? CONFIG_NAME);
  invariant(!(await exists(configPath)), "ALREADY_INITIALIZED", "Конфигурация уже существует", 4);
  invariant(
    !(await exists(join(dirname(configPath), "storage.json"))) &&
      !(await exists(join(dirname(configPath), "transactions/pending.json"))),
    "ALREADY_INITIALIZED",
    "В каталоге уже есть хранилище; восстановите его конфигурацию",
    4,
  );
  const config = parse(
    configSchema,
    {
      ...structuredClone(defaultConfig),
      projectId: shortId(),
      storageDir,
      projectSettings: {
        version: 1,
        name: defaultProjectName(configPath),
        slug: createProjectSlug(),
        revision: 1,
      },
    },
    "конфигурация",
  );
  await mkdir(dirname(configPath), { recursive: true });
  const directory = await realpath(dirname(configPath));
  const workspace = new Workspace(join(directory, basename(configPath)), directory, config);
  const { StorageService } = await import("../application/storage/service.js");
  await new StorageService(workspace).initialize();
  return workspace;
}
