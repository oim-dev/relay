import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { ContextResponse, RelayProject, ServerContextResponse } from "@relay/contracts";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { openWorkspace, readWorkspaceConfig } from "@relay/core/storage/workspace";
import type { Workspace } from "@relay/core/storage/workspace";
import { configurationMode, entryTarget, readConfiguration } from "@relay/project-runtime/config";
import { registerProject, unregisterProject } from "@relay/project-runtime/registry";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { projectSettings } from "@relay/core/storage/project-settings";
import type { SaveProjectSettings, ProjectSettings } from "@relay/core/domain/project-settings";
import { withStorageLock } from "@relay/core/storage/lock";
import type { ProjectEntry } from "@relay/project-runtime/config";

export interface WorkspaceOptions {
  cwd: string;
  configPath: string;
  actor: string;
  mode?: "local" | "workspace";
}

/** Неизменяемый выбор проекта; безопасен для параллельных запросов и наблюдателей. */
export class ProjectContext {
  constructor(
    readonly options: WorkspaceOptions,
    readonly projectId: string,
  ) {}

  async open(): Promise<Workspace> {
    try {
      return await openWorkspace(this.options.cwd, this.options.configPath);
    } catch (error) {
      if (error instanceof AppError && error.code === "VALIDATION_ERROR")
        throw new AppError("INVALID_CONFIG", "Конфигурация проекта некорректна", 5, error.details);
      throw error;
    }
  }

  context(workspace: Workspace): ContextResponse {
    return {
      project: projectSettings(workspace.config, workspace.configPath).name,
      capabilities: [
        "relay-projects-v1",
        "relay-full-context-v1",
        // Детализация метрик оператора обзора и snapshot.operator.
        "relay-overview-metrics-v1",
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
    return readConfiguration(this.options.cwd, this.options.configPath);
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

  async at(configPath: string): Promise<ProjectContext> {
    const path = await realpath(configPath);
    const { config } = await readWorkspaceConfig(dirname(path), path);
    const id = config.projectId ?? createHash("sha256").update(path).digest("hex").slice(0, 24);
    const context = new ProjectContext({ ...this.options, configPath: path }, id);
    this.contexts.set(resolve(configPath), context);
    return context;
  }

  async context(): Promise<ServerContextResponse> {
    const { source, entries } = await this.entries();
    const projects: RelayProject[] = await Promise.all(
      entries.map(async ({ key, configPath }) => {
        try {
          const project = await this.at(configPath);
          const { config } = await readWorkspaceConfig(dirname(configPath), configPath);
          const settings = projectSettings(config, configPath);
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
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const ambiguousIds = new Set(
      projects
        .filter(
          (project) =>
            project.slug !== undefined &&
            projects.some(
              (other) =>
                other.id !== project.id &&
                (other.slug === project.slug ||
                  other.key === project.slug ||
                  other.id === project.slug),
            ),
        )
        .map((project) => project.id),
    );
    for (const project of projects) {
      if (ambiguousIds.has(project.id)) {
        // Коллизия не закрывает доступ по ID: пользователь может исправить slug в настройках.
        delete project.slug;
      }
      if (
        projects.some((other) => other.id === project.id && other.configPath !== project.configPath)
      ) {
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

  private async unique(context: ProjectContext, entries: { configPath: string }[]) {
    for (const entry of entries) {
      const other = await this.at(entry.configPath).catch(() => undefined);
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

  async select(selector?: string): Promise<ProjectContext> {
    if (this.options.mode === "local") {
      const context =
        this.contexts.get(resolve(this.options.configPath)) ??
        (await this.at(this.options.configPath));
      // SSE по постоянному ID должен сообщать повреждение конфига и уметь переподключаться.
      if (selector === undefined || selector === "local" || selector === context.projectId)
        return context;
      const workspace = await context.open();
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
    invariant(
      selector !== undefined || source.kind === "project",
      "PROJECT_REQUIRED",
      "В workspace укажите проект",
    );
    if (selector === undefined) return this.at(entries[0]!.configPath);
    const direct = entries.find(({ key }) => key === selector);
    if (direct) return this.unique(await this.at(direct.configPath), entries);
    for (const entry of entries) {
      const context = await this.at(entry.configPath).catch(() => undefined);
      if (context?.projectId === selector) return this.unique(context, entries);
    }
    const matches: ProjectContext[] = [];
    for (const entry of entries) {
      const context = await this.at(entry.configPath).catch(() => undefined);
      if (!context) continue;
      const { config } = await readWorkspaceConfig(dirname(entry.configPath), entry.configPath);
      if (
        projectSettings(config, entry.configPath).slug === selector &&
        !matches.some((match) => match.projectId === context.projectId)
      )
        matches.push(context);
    }
    invariant(
      matches.length <= 1,
      "PROJECT_SLUG_TAKEN",
      "Этот slug принадлежит нескольким проектам. Откройте проект по ID и измените slug.",
      4,
    );
    if (matches[0]) return this.unique(matches[0], entries);
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
      invariant(input.slug !== "local", "PROJECT_SLUG_TAKEN", "Адрес local зарезервирован.", 4);
      for (const entry of entries) {
        const other = await this.at(entry.configPath);
        if (other.projectId === context.projectId) continue;
        const { config } = await readWorkspaceConfig(dirname(entry.configPath), entry.configPath);
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
    return registerProject(source.path, key, entry, replace);
  }

  async unregister(key: string) {
    const source = await this.source();
    invariant(
      source.kind === "registry",
      "WORKSPACE_REQUIRED",
      "Удаление регистрации доступно в workspace",
    );
    return unregisterProject(source.path, key);
  }

  actor(override?: string) {
    return parse(actorSchema, override ?? this.options.actor, "автор запроса");
  }
}
