import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@relay/contracts/storage";
import {
  projectDisplayNameSchema,
  projectSlugSchema,
} from "@relay/contracts/entities/project-settings";
import { configSchema, defaultConfig, DEFAULT_MCP_PORT } from "../../domain/config.js";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import { shortId } from "../../shared/ids.js";
import { openWorkspace } from "../../storage/workspace.js";
import { createProjectSlug } from "../../storage/project-settings.js";
import { workspaceStorageRegistry } from "../../storage/unified-adapter.js";
import { digest, jsonValue } from "../../storage/entity-store/format.js";
import { validateWorkspace } from "../validate.js";
import { StorageService } from "./service.js";
import { readSnapshotFiles, writeSnapshotFiles, type PersistentSnapshot } from "./snapshot.js";

type ObjectValue = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): ObjectValue => {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_DATA",
    "Ожидается объект постоянного снимка",
    5,
  );
  return value;
};

export interface TemplateProjectOptions {
  name: string;
  slug?: string;
}

/** Только типизированные адреса: совпадающий ID продукта и тексты не заменяются. */
function remapAddresses(value: JsonValue, previous: string, next: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => remapAddresses(entry, previous, next));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "id" && value.kind === "project" && entry === previous
        ? next
        : remapAddresses(entry, previous, next),
    ]),
  );
}

function instantiate(files: PersistentSnapshot, input: TemplateProjectOptions) {
  const config = parse(configSchema, files["config.json"], "конфигурация шаблона");
  const previous = config.projectId ?? "project";
  const registry = workspaceStorageRegistry();
  const projectPath = registry.path({ kind: "project", id: previous });
  const project = registry.decode(files[projectPath]);
  const name = parse(projectDisplayNameSchema, input.name, "имя нового проекта");
  let slug = input.slug ?? createProjectSlug();
  while (input.slug === undefined && slug === project.data.slug) slug = createProjectSlug();
  slug = parse(projectSlugSchema, slug, "slug нового проекта");
  const occupied = new Set(
    Object.entries(files)
      .filter(([path]) => path.startsWith("entities/"))
      .map(([, value]) => object(value).id),
  );
  let projectId = shortId();
  while (occupied.has(projectId) || projectId === previous) projectId = shortId();
  const output: PersistentSnapshot = {};
  for (const [path, raw] of Object.entries(files)) {
    let target = path;
    let value = structuredClone(raw);
    if (path === "config.json") {
      const { projectSettings: _settings, ...configuration } = config;
      value = jsonValue({
        ...configuration,
        projectId,
        storageDir: defaultConfig.storageDir,
        server: defaultConfig.server,
        ...(config.mcp ? { mcp: { port: DEFAULT_MCP_PORT } } : {}),
      });
    } else if (path.startsWith("entities/")) {
      const record = registry.validate(value);
      if (!("deleted" in record)) {
        record.data = object(remapAddresses(record.data, previous, projectId));
        if (["work-plan", "release"].includes(record.kind) && record.data.projectId === previous)
          record.data.projectId = projectId;
        // Сохраняемые снимки прежних выпусков также принадлежат новой копии проекта.
        if (record.kind === "release-snapshot-entry" && record.data.plan) {
          const plan = object(record.data.plan);
          if (plan.projectId === previous) plan.projectId = projectId;
          if (Array.isArray(plan.scopeLabels))
            for (const label of plan.scopeLabels) {
              const entry = object(label);
              if (entry.ref === `project:${previous}`) entry.ref = `project:${projectId}`;
            }
        }
        if (path === projectPath) {
          record.id = projectId;
          record.data.name = name;
          record.data.slug = slug;
          record.revision = 1;
          record.createdAt = record.updatedAt = new Date().toISOString();
          record.createdBy = record.updatedBy = "relay-template";
          target = registry.path({ kind: "project", id: projectId });
        }
      }
      value = jsonValue(record);
    } else if (path.startsWith("relations/") || path.startsWith("keyspaces/")) {
      value = remapAddresses(value, previous, projectId);
      const ownerPath = `relations/projects/${previous}`;
      if (path === `${ownerPath}.json` || path.startsWith(`${ownerPath}/`))
        target = `relations/projects/${projectId}${path.slice(ownerPath.length)}`;
    }
    invariant(output[target] === undefined, "INVALID_DATA", "Совпали адреса новой базы", 5, {
      path: target,
    });
    output[target] = value;
  }
  // Сегменты отношений — постоянные данные, их manifest хранит хеш преобразованного тела.
  for (const [path, value] of Object.entries(output)) {
    if (!path.startsWith("relations/")) continue;
    const record = object(value);
    if (record.storage !== "segments") continue;
    const segments = object(record.segments);
    for (const prefix of Object.keys(segments)) {
      const shard = output[`${path.slice(0, -5)}/${prefix}.json`];
      invariant(shard !== undefined, "INVALID_DATA", "Потерян сегмент отношений шаблона", 5);
      segments[prefix] = digest(shard);
    }
  }
  return { files: output, projectId, name, slug, sourceProjectId: previous };
}

/** Полная проверка источника и самостоятельной копии до публикации в целевую базу. */
export async function prepareTemplateSnapshot(
  files: PersistentSnapshot,
  temporaryRoot: string,
  input: TemplateProjectOptions,
) {
  // Проверяем пользовательский ввод до создания каталогов и чтения данных.
  parse(projectDisplayNameSchema, input.name, "имя нового проекта");
  if (input.slug !== undefined) parse(projectSlugSchema, input.slug, "slug нового проекта");
  const directory = await mkdtemp(join(temporaryRoot, "relay-template-"));
  try {
    const check = async (root: string, snapshot: PersistentSnapshot) => {
      await writeSnapshotFiles(root, snapshot);
      const workspace = await openWorkspace(root, join(root, "config.json"));
      await new StorageService(workspace).reindex();
      const validation = await validateWorkspace(workspace);
      return { files: await readSnapshotFiles(root), validation };
    };
    const source = await check(join(directory, "source"), files);
    const prepared = instantiate(source.files, input);
    const target = await check(join(directory, "target"), prepared.files);
    return { ...prepared, files: target.files, validation: target.validation };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
