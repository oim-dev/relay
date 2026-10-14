import { relative } from "node:path";
import { defaultDocumentSections, entityDetailSchema } from "@relay/contracts/entities";
import type { EntityGetQuery } from "@relay/contracts/entities";
import { configSchema } from "../../domain/config.js";
import type { Config } from "../../domain/config.js";
import { storedProjectSettingsSchema } from "../../domain/project-settings.js";
import { parse } from "../../domain/validation.js";
import { readJson } from "../../storage/files.js";
import { projectSettings } from "../../storage/project-settings.js";
import { settings } from "../../storage/unified-adapter.js";
import type { Workspace } from "../../storage/workspace.js";
import type { EntityEntry } from "./catalog.js";
import { resolveAddress } from "./resolver.js";

/** Конфигурация и её проекция читаются в сессии вызывающей операции. */
export async function readEntityConfig(workspace: Workspace): Promise<Config> {
  const session = workspace.storageSession;
  const config = parse(
    configSchema,
    session
      ? await session.readFile(relative(session.store.root, workspace.configPath))
      : await readJson(workspace.configPath),
    "конфигурация проекта",
  );
  if (session)
    config.projectSettings = storedProjectSettingsSchema.parse(
      await session.indexGet("configuration", "project"),
    );
  Object.assign(workspace.config, config);
  return config;
}

/** Единая проекция PROJECT для полного каталога и адресного чтения. */
export function projectEntityEntry(config: Config, configPath: string): EntityEntry {
  const current = projectSettings(config, configPath);
  return {
    ref: { kind: "project", id: config.projectId ?? "project" },
    key: config.projectSettings?.entityKey ?? "PROJECT",
    title: current.name,
    summary: "Область данных и настроек выбранного проекта",
    revision: current.revision,
    data: {
      kind: "project",
      name: current.name,
      slug: current.slug,
      documentSections: config.projectSettings?.documentSections ?? defaultDocumentSections,
    },
    aliases: config.projectSettings?.aliases ?? [],
    selectors: [current.slug],
    filters: {},
    status: null,
    active: true,
  };
}

/** Только PROJECT: остальные виды и legacy-каталог сохраняют прежний путь чтения. */
export async function readProjectDetail(workspace: Workspace, query: EntityGetQuery) {
  const session = workspace.storageSession;
  if (!session || (query.kind !== undefined && query.kind !== "project")) return undefined;
  const current = projectEntityEntry(workspace.config, workspace.configPath);
  const qualified = query.ref.split(":");
  // Это выбор reader, не разрешение адреса: неоднозначность и вид проверяет общий индекс.
  if (
    query.kind !== "project" &&
    !(qualified.length === 2 && qualified[0] === "project") &&
    ![current.ref.id, current.key, ...current.aliases].includes(query.ref)
  )
    return undefined;

  const config = await readEntityConfig(workspace);
  await session.resolve(query.ref, query.kind);
  // Полное содержание читается из записи, а не из краткой карточки. Кодек проверяет
  // версию и повреждения; разрешение и чтение остаются под тем же замком.
  config.projectSettings = await settings(workspace);
  const entry = resolveAddress(
    [projectEntityEntry(config, workspace.configPath)],
    query.ref,
    query.kind,
  );
  const { aliases: _aliases, selectors: _selectors, filters: _filters, ...detail } = entry;
  return parse(entityDetailSchema, { ...detail, references: [] }, "данные сущности", true);
}
