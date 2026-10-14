import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  configSchema,
  DEFAULT_SERVER_PORT,
  mcpConfigSchema,
  serverUrlSchema,
} from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { exists, readJson } from "@relay/core/storage/files";
import { CONFIG_NAME, readWorkspaceConfig } from "@relay/core/storage/workspace";

export const REGISTRY_NAME = "relay.workspace.json";
export const projectNameSchema = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u);
const pathSchema = z.string().trim().min(1);
export const projectEntrySchema = z
  .strictObject({
    path: pathSchema.optional(),
    config: pathSchema.optional(),
  })
  .refine((entry) => entry.path || entry.config, {
    message: "Укажите локальный path или config проекта",
  });
export const registrySchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal("workspace").default("workspace"),
  projects: z.record(projectNameSchema, projectEntrySchema),
  server: z
    .strictObject({
      port: z.number().int().min(0).max(65535).default(DEFAULT_SERVER_PORT),
      url: serverUrlSchema.optional(),
    })
    .default({ port: DEFAULT_SERVER_PORT }),
  mcp: mcpConfigSchema.optional(),
});
export type Registry = z.infer<typeof registrySchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type Configuration =
  | { kind: "project"; path: string; value: z.infer<typeof configSchema> }
  | { kind: "registry"; path: string; value: Registry };

/** Режим относится к конфигурации, а не к количеству зарегистрированных проектов. */
export function configurationMode(source: Configuration): "local" | "workspace" {
  return source.kind === "project" ? "local" : "workspace";
}

export function serverAddress(source: Configuration): string {
  const server = source.value.server;
  if (server.url) return server.url;
  invariant(
    server.port !== 0,
    "SERVER_URL_REQUIRED",
    "Для динамического порта укажите server.url или --server-url",
  );
  return `http://127.0.0.1:${server.port}`;
}

export async function locateConfiguration(cwd: string, explicit?: string, registryOnly = false) {
  if (explicit !== undefined) return resolve(cwd, explicit);
  let directory = resolve(cwd);
  while (true) {
    for (const name of registryOnly ? [REGISTRY_NAME] : [REGISTRY_NAME, CONFIG_NAME]) {
      const candidate = join(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new AppError(
        "CONFIG_NOT_FOUND",
        `Не найден ${registryOnly ? REGISTRY_NAME : `${CONFIG_NAME} или ${REGISTRY_NAME}`}. Укажите --config или выполните ${registryOnly ? "projects init" : "init"}.`,
      );
    directory = parent;
  }
}

/** Общий поиск и классификация файла; проектная база здесь не открывается. */
async function readConfigurationFile(cwd: string, explicit?: string, registryOnly = false) {
  const path = await locateConfiguration(cwd, explicit, registryOnly);
  const value = await readJson(path);
  const localPath = basename(path) === "config.json" && basename(dirname(path)) === ".relay";
  if (
    basename(path) === REGISTRY_NAME ||
    (!localPath && typeof value === "object" && value !== null && Object.hasOwn(value, "projects"))
  )
    return { kind: "registry" as const, path, value: parse(registrySchema, value, path) };
  invariant(!registryOnly, "REGISTRY_REQUIRED", `Ожидается конфиг проектов: ${path}`);
  return { kind: "project" as const, path, value };
}

/**
 * Метаданные для init: та же схема и поиск, без проекции PROJECT, открытия Store,
 * блокировки и recovery. Наличие конфигурации не подтверждает готовность самой базы.
 */
export async function readInitializationConfiguration(
  cwd: string,
  explicit?: string,
): Promise<Configuration> {
  const source = await readConfigurationFile(cwd, explicit);
  return source.kind === "registry"
    ? source
    : { ...source, value: parse(configSchema, source.value, source.path) };
}

/** Обычное чтение включает проекцию PROJECT и recovery незавершённого WAL Core. */
export async function readConfiguration(
  cwd: string,
  explicit?: string,
  registryOnly = false,
): Promise<Configuration> {
  const source = await readConfigurationFile(cwd, explicit, registryOnly);
  if (source.kind === "registry") return source;
  const path = source.path;
  const project = await readWorkspaceConfig(cwd, path);
  return { kind: "project", path: project.configPath, value: project.config };
}

export interface ProjectTarget {
  project?: string;
  configPath?: string;
  serverUrl?: string;
}

export function entryTarget(
  registryPath: string,
  project: string,
  entry: ProjectEntry,
): ProjectTarget {
  return {
    project,
    ...(entry.path !== undefined || entry.config !== undefined
      ? {
          configPath: resolve(
            dirname(registryPath),
            entry.path ?? ".",
            entry.config ?? CONFIG_NAME,
          ),
        }
      : {}),
  };
}

/** Имя проверяется на каждом запросе, включая обращения существующих MCP-клиентов. */
export function selectProject(source: Configuration, project?: string): ProjectTarget {
  if (source.kind === "project") {
    invariant(
      project === undefined,
      "REGISTRY_REQUIRED",
      "Для обращения по имени укажите конфиг проектов; в однопроектном режиме опустите project.",
    );
    return {
      configPath: source.path,
      ...(source.value.server.url === undefined ? {} : { serverUrl: source.value.server.url }),
    };
  }
  invariant(
    project !== undefined,
    "PROJECT_REQUIRED",
    `Укажите проект. Доступны: ${Object.keys(source.value.projects).join(", ") || "реестр пуст"}`,
  );
  invariant(
    Object.hasOwn(source.value.projects, project),
    "PROJECT_NOT_FOUND",
    `Проект ${project} не зарегистрирован`,
    3,
  );
  return entryTarget(source.path, project, source.value.projects[project]!);
}

export async function resolveProject(
  source: Configuration,
  project?: string,
): Promise<ProjectTarget> {
  const target = selectProject(source, project);
  if (source.kind === "registry") {
    target.serverUrl = serverAddress(source);
    return target;
  }
  if (target.serverUrl === undefined && target.configPath !== undefined) {
    const config = await readConfiguration(dirname(source.path), target.configPath);
    invariant(
      config.kind === "project",
      "PROJECT_CONFIG_REQUIRED",
      "Запись реестра должна ссылаться на проектный конфиг",
    );
    if (config.value.server.url !== undefined) target.serverUrl = config.value.server.url;
  }
  return target;
}
