import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { ContextResponse, RelayProject, ServerContextResponse } from "@relay/contracts";
import { WORK_HISTORY_CAPABILITY } from "@relay/contracts/work-history";
import { WORK_HISTORY_GRAPH_CAPABILITY } from "@relay/contracts/work-history-graph";
import {
  PROJECT_CATALOG_CAPABILITY,
  projectCatalogPageQuerySchema,
} from "@relay/contracts/server-context";
import type { ProjectCatalogPageQuery } from "@relay/contracts/server-context";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { openWorkspace, readWorkspaceConfig } from "@relay/core/storage/workspace";
import { SYNCHRONIZATION_CAPABILITY } from "@relay/contracts/synchronization";
import type { OpenWorkspaceOptions, Workspace } from "@relay/core/storage/workspace";
import { configurationMode, entryTarget, readConfiguration } from "@relay/project-runtime/config";
import { registerProject, unregisterProject } from "@relay/project-runtime/registry";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { projectSettings } from "@relay/core/storage/project-settings";
import type { SaveProjectSettings, ProjectSettings } from "@relay/core/domain/project-settings";
import { withStorageLock } from "@relay/core/storage/lock";
import { readJson } from "@relay/core/storage/files";
import {
  readStorageManifest,
  requireCurrentProfile,
} from "@relay/core/storage/data-model/manifest";
import type { ProjectEntry } from "@relay/project-runtime/config";
import { serverConfiguration } from "./source.js";
import { restoreManagedConfiguration } from "@relay/project-runtime/git-storage/bootstrap";
import { attachManagedStorage } from "@relay/project-runtime/git-storage/access";

export interface WorkspaceOptions {
  cwd: string;
  configPath: string;
  actor: string;
  mode?: "local" | "workspace";
}

/**
 * Ошибка открытия проекта сохраняет причину Core (совместимость, recovery, повреждение).
 * Только отказ схемы сохранённой конфигурации отличается от ошибки аргументов запроса.
 */
function openFailure(error: unknown): unknown {
  if (error instanceof AppError && error.code === "VALIDATION_ERROR")
    return new AppError("INVALID_CONFIG", "Конфигурация проекта некорректна", 5, error.details);
  return error;
}

function derivedProjectId(realConfigPath: string): string {
  return createHash("sha256").update(realConfigPath).digest("hex").slice(0, 24);
}

/**
 * Постоянный ID проекта без разбора текущей схемой, recovery и создания каталогов.
 * Нужен только чтобы сообщить настоящую причину недоступности проекта, выбранного по ID.
 */
async function rawProjectId(configPath: string): Promise<string | undefined> {
  try {
    const path = await realpath(configPath);
    const value = await readJson(path);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const projectId = (value as Record<string, unknown>).projectId;
    if (projectId === undefined) return derivedProjectId(path);
    return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
  } catch {
    return undefined;
  }
}

function availabilityError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Неизменяемый выбор проекта; безопасен для параллельных запросов и наблюдателей. */
export class ProjectContext {
  constructor(
    readonly options: WorkspaceOptions,
    readonly projectId: string,
  ) {}

  async open(options: OpenWorkspaceOptions = {}): Promise<Workspace> {
    try {
      await restoreManagedConfiguration(this.options.configPath);
      await attachManagedStorage(dirname(this.options.configPath));
      return await openWorkspace(this.options.cwd, this.options.configPath, options);
    } catch (error) {
      throw openFailure(error);
    }
  }

  context(workspace: Workspace): ContextResponse {
    return {
      project: projectSettings(workspace.config, workspace.configPath).name,
      capabilities: [
        SYNCHRONIZATION_CAPABILITY,
        "relay-projects-v1",
        "relay-full-context-v1",
        // Детализация метрик оператора обзора и snapshot.operator.
        "relay-overview-metrics-v1",
        "relay-document-library-v1",
        "relay-product-queries-v1",
        "relay-work-read-models-v1",
        "relay-release-refs-v1",
        "relay-entity-search-v2",
        PROJECT_CATALOG_CAPABILITY,
        WORK_HISTORY_CAPABILITY,
        WORK_HISTORY_GRAPH_CAPABILITY,
      ],
      projectId: this.projectId,
      configPath: workspace.configPath,
      storagePath: workspace.dataRoot,
      actor: this.options.actor,
      config: workspace.config,
    };
  }
}

/** Владелец реестра сервера. Каждое разрешение использует актуальную конфигурацию. */
export class ProjectCatalog {
  private readonly contexts = new Map<string, ProjectContext>();
  constructor(readonly options: WorkspaceOptions) {}

  source() {
    return serverConfiguration(this.options.cwd, this.options.configPath);
  }

  async entries() {
    const source = await this.source();
    const entries =
      source.kind === "project"
        ? [{ key: "local", configPath: source.path }]
        : Object.entries(source.value.projects).map(([key, entry]) => {
            const target = entryTarget(source.path, key, entry);
            invariant(
              target.configPath,
              "PROJECT_CONFIG_REQUIRED",
              `Проект ${key}: требуется локальный path или config`,
            );
            return { key, configPath: target.configPath };
          });
    return { source, entries };
  }

  /** Кеш только одного чтения каталога/разрешения: aliases разделяют чтение realpath. */
  private reader() {
    type Loaded = { context: ProjectContext; config: Workspace["config"] };
    const paths = new Map<string, Promise<Loaded>>();
    const configs = new Map<string, Promise<Loaded>>();
    return (configPath: string): Promise<Loaded> => {
      const target = resolve(configPath);
      let pending = paths.get(target);
      if (!pending) {
        pending = (async () => {
          const path = await realpath(target);
          let loaded = configs.get(path);
          if (!loaded) {
            loaded = (async () => {
              let config;
              try {
                // source() может вернуть только метаданные несовместимой local-базы для
                // запуска Server. Они не подтверждают доступность проектной проекции Core.
                config = (await readWorkspaceConfig(dirname(path), path)).config;
              } catch (error) {
                throw openFailure(error);
              }
              const context = new ProjectContext(
                { ...this.options, configPath: path },
                config.projectId ?? derivedProjectId(path),
              );
              return { context, config };
            })();
            configs.set(path, loaded);
          }
          const result = await loaded;
          this.contexts.set(target, result.context);
          return result;
        })();
        paths.set(target, pending);
      }
      return pending;
    };
  }

  async at(configPath: string): Promise<ProjectContext> {
    return (await this.reader()(configPath)).context;
  }

  async context(): Promise<ServerContextResponse> {
    const { source, entries } = await this.entries();
    const read = this.reader();
    const manifests = new Map<string, Promise<void>>();
    const projects: RelayProject[] = await Promise.all(
      entries.map(async ({ key, configPath }) => {
        try {
          const { context: project, config } = await read(configPath);
          // Дешёвая проверка профиля по manifest без скана: база, которой нужна миграция,
          // не объявляется доступной (запросы к ней всё равно получат код совместимости).
          const path = project.options.configPath;
          let manifest = manifests.get(path);
          if (!manifest) {
            manifest = (async () => {
              const value = await readStorageManifest(dirname(path));
              if (value) requireCurrentProfile(value);
            })();
            manifests.set(path, manifest);
          }
          await manifest;
          const settings = projectSettings(config, path);
          return {
            key,
            id: project.projectId,
            name: settings.name,
            slug: settings.slug,
            configPath: project.options.configPath,
            available: true,
          };
        } catch (error) {
          return {
            key,
            id: key,
            name: key,
            configPath,
            available: false,
            error: availabilityError(error),
          };
        }
      }),
    );
    const selectors = new Map<string, Set<string>>();
    const identityPaths = new Map<string, Set<string>>();
    for (const project of projects) {
      for (const selector of [project.key, project.id, project.slug]) {
        if (selector === undefined) continue;
        const ids = selectors.get(selector) ?? new Set<string>();
        ids.add(project.id);
        selectors.set(selector, ids);
      }
      const paths = identityPaths.get(project.id) ?? new Set<string>();
      paths.add(project.configPath);
      identityPaths.set(project.id, paths);
    }
    const ambiguousIds = new Set(
      projects
        .filter((project) => project.slug !== undefined && selectors.get(project.slug)!.size > 1)
        .map((project) => project.id),
    );
    for (const project of projects) {
      if (ambiguousIds.has(project.id)) {
        // Коллизия не закрывает доступ по ID: пользователь может исправить slug в настройках.
        delete project.slug;
      }
      if (identityPaths.get(project.id)!.size > 1) {
        project.available = false;
        project.error = "DUPLICATE_PROJECT_ID: разные базы имеют одинаковый projectId";
      }
    }
    return {
      mode: configurationMode(source),
      configPath: source.path,
      projects,
      defaultProject: source.kind === "project" ? projects[0]!.id : null,
    };
  }

  private async unique(
    context: ProjectContext,
    entries: { configPath: string }[],
    read = this.reader(),
  ) {
    for (const entry of entries) {
      const other = await read(entry.configPath).then(
        (loaded) => loaded.context,
        () => undefined,
      );
      invariant(
        !other ||
          other.projectId !== context.projectId ||
          other.options.configPath === context.options.configPath,
        "DUPLICATE_PROJECT_ID",
        "Разные базы должны иметь разные projectId",
        4,
      );
    }
    return context;
  }

  /** Проверяем весь актуальный каталог, но по сети передаём только страницу. */
  async page(input: ProjectCatalogPageQuery = {}) {
    const query = parse(projectCatalogPageQuerySchema, input, "страница каталога проектов");
    const catalog = await this.context();
    const version = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
    invariant(
      query.version === undefined || query.version === version,
      "VERSION_CONFLICT",
      "Каталог проектов изменился. Начните чтение заново без cursor/version; исторический снимок не хранится.",
      4,
    );
    const total = catalog.projects.length;
    return {
      catalog: {
        ...catalog,
        projects: catalog.projects.slice(query.offset, query.offset + query.limit),
      },
      total,
      nextOffset: query.offset + query.limit < total ? query.offset + query.limit : null,
      version,
    };
  }

  async select(selector?: string, options: OpenWorkspaceOptions = {}): Promise<ProjectContext> {
    if (this.options.mode === "local") {
      const context =
        this.contexts.get(resolve(this.options.configPath)) ??
        (await this.at(this.options.configPath).catch(async (error: unknown) => {
          // Несовместимая база не закрывает сервер: каждый запрос получает причину
          // от open(), SSE сообщает workspace-error и восстанавливается после migrate.
          const id = await rawProjectId(this.options.configPath);
          if (id === undefined) throw error;
          return new ProjectContext(
            { ...this.options, configPath: await realpath(this.options.configPath) },
            id,
          );
        }));
      // SSE по постоянному ID должен сообщать повреждение конфига и уметь переподключаться.
      if (selector === undefined || selector === "local" || selector === context.projectId)
        return context;
      // Выбор по slug тоже открывает проект: сохраняем режим конфигурационного чтения.
      const workspace = await context.open(options);
      const settings = projectSettings(workspace.config, workspace.configPath);
      invariant(
        selector === settings.slug,
        "PROJECT_NOT_FOUND",
        `Проект ${selector} не зарегистрирован`,
        3,
      );
      return context;
    }
    const { source, entries } = await this.entries();
    const read = this.reader();
    invariant(
      selector !== undefined || source.kind === "project",
      "PROJECT_REQUIRED",
      "В workspace укажите проект",
    );
    if (selector === undefined) return (await read(entries[0]!.configPath)).context;
    const direct = entries.find(({ key }) => key === selector);
    if (direct) return this.unique((await read(direct.configPath)).context, entries, read);
    for (const entry of entries) {
      let context: ProjectContext;
      try {
        context = (await read(entry.configPath)).context;
      } catch (error) {
        // Недоступный проект, выбранный по постоянному ID, сообщает свою причину, а не 404.
        if ((await rawProjectId(entry.configPath)) === selector) throw error;
        continue;
      }
      if (context.projectId === selector) return this.unique(context, entries, read);
    }
    const matches: ProjectContext[] = [];
    const matchedIds = new Set<string>();
    for (const entry of entries) {
      const loaded = await read(entry.configPath).catch(() => undefined);
      if (!loaded) continue;
      const { context, config } = loaded;
      if (
        projectSettings(config, entry.configPath).slug === selector &&
        !matchedIds.has(context.projectId)
      ) {
        matches.push(context);
        matchedIds.add(context.projectId);
      }
    }
    invariant(
      matches.length <= 1,
      "PROJECT_SLUG_TAKEN",
      "Этот slug принадлежит нескольким проектам. Откройте проект по ID и измените slug.",
      4,
    );
    if (matches[0]) return this.unique(matches[0], entries, read);
    throw new AppError("PROJECT_NOT_FOUND", `Проект ${selector} не зарегистрирован`, 3);
  }

  /**
   * Сериализует изменения адресов в одном каталоге; ID и ключи регистрации не меняются.
   */
  async saveSettings(
    context: ProjectContext,
    input: SaveProjectSettings,
  ): Promise<ProjectSettings> {
    const source = await this.source();
    const save = async (assertOwned: () => void) => {
      const { entries } = await this.entries();
      const read = this.reader();
      invariant(input.slug !== "local", "PROJECT_SLUG_TAKEN", "Адрес local зарезервирован.", 4);
      for (const entry of entries) {
        const { context: other, config } = await read(entry.configPath);
        if (other.projectId === context.projectId) continue;
        invariant(
          input.slug !== projectSettings(config, entry.configPath).slug &&
            input.slug !== other.projectId &&
            input.slug !== entry.key,
          "PROJECT_SLUG_TAKEN",
          "Этот slug уже занят другим проектом. Выберите другой адрес.",
          4,
        );
      }
      return saveProjectSettings(await context.open(), input, assertOwned);
    };
    // В локальном режиме файл конфигурации и данные используют одну проектную блокировку.
    if (source.kind === "project") return save(() => {});
    return withStorageLock(source.path, save);
  }

  async register(key: string, entry: ProjectEntry, replace: boolean) {
    const source = await this.source();
    invariant(source.kind === "registry", "WORKSPACE_REQUIRED", "Регистрация доступна в workspace");
    const target = entryTarget(source.path, key, entry);
    invariant(
      target.configPath,
      "PROJECT_CONFIG_REQUIRED",
      "Укажите локальный path или config проекта",
    );
    const config = await readConfiguration(dirname(source.path), resolve(target.configPath));
    invariant(
      config.kind === "project",
      "PROJECT_CONFIG_REQUIRED",
      "Запись должна ссылаться на .relay/config.json проекта",
    );
    const { entries } = await this.entries();
    await this.unique(
      await this.at(target.configPath),
      entries.filter((entry) => entry.key !== key),
    );
    return {
      ...(await registerProject(source.path, key, entry, replace)),
      configPath: source.path,
    };
  }

  async unregister(key: string) {
    const source = await this.source();
    invariant(
      source.kind === "registry",
      "WORKSPACE_REQUIRED",
      "Удаление регистрации доступно в workspace",
    );
    return { ...(await unregisterProject(source.path, key)), configPath: source.path };
  }

  actor(override?: string) {
    return parse(actorSchema, override ?? this.options.actor, "автор запроса");
  }
}
