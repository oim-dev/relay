import { basename, dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant, isErrno } from "@relay/core/shared/errors";
import { exists } from "@relay/core/storage/files";
import { CONFIG_NAME } from "@relay/core/storage/workspace";
import { storageError } from "@relay/core/storage/data-model/errors";
import { resolveSourceTarget } from "@relay/core/storage/data-model/source/reader";
import type { SourceTarget } from "@relay/core/storage/data-model/source/reader";
import { entryTarget, REGISTRY_NAME, registrySchema } from "./config.js";

/** Явный выбор транспорта; env и флаги разбирает приложение. */
export interface MaintenanceTransport {
  /** `--local`: обслуживание выполняется в этом процессе над файлами базы. */
  local?: boolean;
  /** Адрес Server из `--server-url` или окружения приложения. */
  serverUrl?: string;
}

export interface MaintenanceLookup extends MaintenanceTransport {
  cwd: string;
  /** `--config`: файл проекта любого имени, каталог корня или реестр. */
  config?: string;
  /** `--project`: ключ реестра для обслуживания одного зарегистрированного проекта. */
  project?: string;
}

/** Цель обслуживания: путь для Core и сведения о выборе; файлы не изменялись. */
export interface MaintenanceTarget {
  /** Абсолютный путь файла конфигурации проекта (может отсутствовать при pending WAL). */
  configPath: string;
  source: SourceTarget;
  /** Реестр и ключ, если проект выбран через `--project`. */
  registry?: { path: string; project: string };
}

/**
 * Обслуживание хранилища не выполняется через REST: при выбранном Server возвращает
 * LOCAL_REQUIRED до любого сетевого запроса и без local fallback.
 */
export function requireLocalMaintenance(transport: MaintenanceTransport): void {
  if (!transport.local && transport.serverUrl !== undefined)
    throw localRequired("Обслуживание хранилища выполняется только локально");
}

function localRequired(message: string): AppError {
  return storageError(
    "LOCAL_REQUIRED",
    `${message}. Повторите с --local и --config файла проекта (в workspace — также --project).`,
    { reason: "http" },
  );
}

type RawConfig = { kind: "registry" | "project" | "unknown"; value: unknown };

/** Только JSON без текущей схемы проекта; повреждение оценит reader Core. */
async function readRaw(path: string): Promise<RawConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "EISDIR")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unknown", value: undefined };
  }
  const object =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  const localPath = basename(path) === "config.json" && basename(dirname(path)) === ".relay";
  if (
    basename(path) === REGISTRY_NAME ||
    (!localPath &&
      object &&
      Object.hasOwn(object, "projects") &&
      !Object.hasOwn(object, "storageDir"))
  )
    return { kind: "registry", value };
  return { kind: object ? "project" : "unknown", value };
}

/** Поиск вверх как у обычного CLI, плюс база без конфига с manifest или pending WAL. */
async function locate(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  while (true) {
    for (const name of [REGISTRY_NAME, CONFIG_NAME]) {
      const candidate = join(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const root = join(directory, dirname(CONFIG_NAME));
    if (
      (await exists(join(root, "transactions/pending.json"))) ||
      (await exists(join(root, "storage.json")))
    )
      return join(directory, CONFIG_NAME);
    const parent = dirname(directory);
    if (parent === directory)
      throw new AppError(
        "CONFIG_NOT_FOUND",
        `Не найден ${CONFIG_NAME} или ${REGISTRY_NAME}. Укажите --config файла проекта.`,
        2,
      );
    directory = parent;
  }
}

/**
 * Находит базу для `storage status|migrate` без разбора текущей схемой проекта,
 * recovery, создания каталогов и записи. Проект реестра выбирается точно по `--project`;
 * реестр при этом только читается.
 */
export async function locateMaintenanceTarget(
  lookup: MaintenanceLookup,
): Promise<MaintenanceTarget> {
  requireLocalMaintenance(lookup);
  const located =
    lookup.config === undefined ? await locate(lookup.cwd) : resolve(lookup.cwd, lookup.config);
  const raw = await readRaw(located);
  if (raw?.kind === "registry") {
    // Реестр всегда задаёт адрес Server: без --local это HTTP-режим.
    if (!lookup.local) throw localRequired("В workspace команды по умолчанию идут через Server");
    const registry = parse(registrySchema, raw.value, located);
    invariant(
      lookup.project !== undefined,
      "PROJECT_REQUIRED",
      `Укажите --project. Доступны: ${Object.keys(registry.projects).join(", ") || "реестр пуст"}`,
    );
    invariant(
      Object.hasOwn(registry.projects, lookup.project),
      "PROJECT_NOT_FOUND",
      `Проект ${lookup.project} не зарегистрирован`,
      3,
    );
    const target = entryTarget(located, lookup.project, registry.projects[lookup.project]!);
    invariant(
      target.configPath,
      "PROJECT_CONFIG_REQUIRED",
      `Проект ${lookup.project}: требуется локальный path или config`,
    );
    const source = await resolveSourceTarget(target.configPath);
    return {
      configPath: source.configPath,
      source,
      registry: { path: located, project: lookup.project },
    };
  }
  invariant(
    lookup.project === undefined,
    "REGISTRY_REQUIRED",
    "--project выбирает проект реестра; для конфигурации проекта опустите его.",
  );
  if (!lookup.local && raw?.kind === "project") {
    const server = (raw.value as Record<string, unknown>).server;
    if (typeof server === "object" && server !== null && "url" in server && server.url)
      throw localRequired("Конфигурация проекта направляет команды на Server (server.url)");
  }
  const source = await resolveSourceTarget(located);
  return { configPath: source.configPath, source };
}
