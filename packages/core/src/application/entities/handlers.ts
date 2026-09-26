import { dirname, join } from "node:path";
import type { z } from "zod";
import type {
  EntityKind,
  EntitySaved,
  entityCreateSchema,
  entityUpdateSchema,
} from "@relay/contracts/entities";
import { productMutationSchema } from "../../domain/product.js";
import type { ProductReference } from "../../domain/product.js";
import { taskProductLinkSchema } from "../../domain/board-task.js";
import { boardSchema } from "../../domain/board.js";
import { configSchema } from "../../domain/config.js";
import { storedProjectSettingsSchema } from "../../domain/project-settings.js";
import { ProductQueries } from "../product/queries.js";
import { BoardTasksService } from "../board-tasks/service.js";
import { BoardRepository } from "../../storage/boards.js";
import { atomicJson, readJson } from "../../storage/files.js";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { assertEntityKeyAvailable, resolveEntity } from "./catalog.js";
import type { EntityCatalog, EntityEntry } from "./catalog.js";
import * as unified from "../../storage/unified-adapter.js";

type CreateData = z.infer<typeof entityCreateSchema>["data"];
type Changes = z.infer<typeof entityUpdateSchema>["changes"];
export type EntityOperationContext = {
  workspace: Workspace;
  catalog: EntityCatalog;
  actor: string;
  requestId: string;
  owned: () => void;
};
type Saved = { id: string; key?: string | undefined; revision: number };
export type EntityHandler = {
  create?: (data: CreateData, context: EntityOperationContext) => Promise<Saved>;
  update?: (
    entry: EntityEntry,
    changes: Changes,
    revision: number,
    context: EntityOperationContext,
  ) => Promise<Saved>;
  rename: (
    entry: EntityEntry,
    key: string,
    revision: number,
    context: EntityOperationContext,
  ) => Promise<Saved>;
};
const metadata = (context: EntityOperationContext) => ({
  actor: context.actor,
  requestId: context.requestId,
});

/** Публичные цели преобразуются в единственные предметные отношения по постоянным ID. */
export function productTargets(refs: readonly string[], context: EntityOperationContext) {
  return refs.map((ref) =>
    taskProductLinkSchema.parse(
      resolveEntity(context.catalog, ref, ["feature", "scenario", "implementation"]).ref,
    ),
  );
}
function documentTargets(
  refs: readonly string[],
  context: EntityOperationContext,
): ProductReference[] {
  return refs.map((ref) => {
    const target = resolveEntity(context.catalog, ref, [
      "product",
      "feature",
      "scenario",
      "application",
      "implementation",
    ]);
    if (target.ref.kind === "product") return { kind: "product" };
    if (target.data.kind === "implementation")
      return {
        kind: "implementation",
        id: target.ref.id,
        applicationId: target.data.applicationId,
      };
    invariant(
      target.ref.kind === "feature" ||
        target.ref.kind === "scenario" ||
        target.ref.kind === "application",
      "ENTITY_KIND_MISMATCH",
      "Неверная область документа",
      4,
    );
    return { kind: target.ref.kind, id: target.ref.id };
  });
}

const productHandler: EntityHandler = {
  create: async (data, context) => {
    const fields =
      data.kind === "product"
        ? { ...data, kind: "passport" }
        : data.kind === "document"
          ? (({ targets, ...rest }) => ({ ...rest, links: documentTargets(targets, context) }))(
              data,
            )
          : data.kind === "scenario"
            ? {
                ...data,
                featureId: resolveEntity(context.catalog, data.featureId, "feature").ref.id,
              }
            : data;
    return new ProductQueries(context.workspace).mutate(
      productMutationSchema.parse({ action: "create", fields, ...metadata(context) }),
      context.actor,
    );
  },
  update: async (entry, changes, revision, context) => {
    invariant(
      changes.kind === entry.ref.kind,
      "ENTITY_KIND_MISMATCH",
      "Вид изменения не соответствует записи",
      4,
    );
    let fields: unknown = { ...entry.data, ...changes };
    if (changes.kind === "product") fields = { ...entry.data, ...changes, kind: "passport" };
    if (changes.kind === "document" && entry.data.kind === "document") {
      const { targets, ...rest } = changes;
      fields = {
        ...entry.data,
        ...rest,
        ...(targets === undefined ? {} : { links: documentTargets(targets, context) }),
      };
    }
    return new ProductQueries(context.workspace).mutate(
      productMutationSchema.parse({
        action: "update",
        id: entry.ref.id,
        fields,
        ifRevision: revision,
        ...metadata(context),
      }),
      context.actor,
    );
  },
  rename: async (entry, key, revision, context) =>
    new ProductQueries(context.workspace).mutate(
      productMutationSchema.parse({
        action: "update",
        id: entry.ref.id,
        key,
        ifRevision: revision,
        ...metadata(context),
        fields: entry.data.kind === "product" ? { ...entry.data, kind: "passport" } : entry.data,
      }),
      context.actor,
    ),
};
const taskHandler: EntityHandler = {
  create: async (data, context) => {
    invariant(data.kind === "task", "ENTITY_KIND_MISMATCH", "Ожидается задача", 4);
    return new BoardTasksService(context.workspace).create(
      {
        ...metadata(context),
        board: resolveEntity(context.catalog, data.board, "board").ref.id,
        ...(data.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: data.acceptanceCriteria }),
        title: data.title,
        description: data.description,
        column: data.column,
        productLinks: productTargets(data.targets, context),
        dependencies: data.dependencies.map(
          (ref) => resolveEntity(context.catalog, ref, "task").ref.id,
        ),
        related: data.related.map((ref) => resolveEntity(context.catalog, ref, "task").ref.id),
        ...(data.parent === null
          ? {}
          : { parentId: resolveEntity(context.catalog, data.parent, "task").ref.id }),
      },
      context.actor,
    );
  },
  update: async (entry, changes, revision, context) => {
    invariant(changes.kind === "task", "ENTITY_KIND_MISMATCH", "Ожидается изменение задачи", 4);
    return new BoardTasksService(context.workspace).update(
      entry.ref.id,
      {
        ...metadata(context),
        ifRevision: revision,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.targets === undefined
          ? {}
          : { productLinks: productTargets(changes.targets, context) }),
      },
      context.actor,
    );
  },
  rename: (entry, key, revision, context) =>
    new BoardTasksService(context.workspace).rename(
      entry.ref.id,
      { key, ifRevision: revision, ...metadata(context) },
      context.actor,
    ),
};
const implementationHandler: EntityHandler = {
  create: async (data, context) => {
    invariant(data.kind === "implementation", "ENTITY_KIND_MISMATCH", "Ожидается реализация", 4);
    const applicationId = resolveEntity(context.catalog, data.application, "application").ref.id;
    const target = resolveEntity(context.catalog, data.target, ["feature", "scenario"]);
    const featureId = target.data.kind === "scenario" ? target.data.featureId : target.ref.id;
    return new ProductQueries(context.workspace).mutate(
      {
        action: "create",
        ...metadata(context),
        fields: {
          kind: "implementation",
          applicationId,
          featureId,
          scenarioId: target.ref.kind === "scenario" ? target.ref.id : null,
          title: data.title,
          description: data.description,
          status: data.status,
        },
      },
      context.actor,
    );
  },
  update: async (entry, changes, revision, context) => {
    invariant(
      changes.kind === "implementation",
      "ENTITY_KIND_MISMATCH",
      "Ожидается изменение реализации",
      4,
    );
    const { kind: _kind, ...fields } = changes;
    return new ProductQueries(context.workspace).updateImplementation(
      { ...fields, ...metadata(context), ref: entry.ref.id, ifRevision: revision },
      context.actor,
    );
  },
  rename: (entry, key, revision, context) =>
    new ProductQueries(context.workspace).updateImplementation(
      { ...metadata(context), ref: entry.ref.id, key, ifRevision: revision },
      context.actor,
    ),
};

/** Настройки и доски сохраняют ключ и квитанцию в одной атомарной записи владельца. */
async function saveMetadata(
  entry: EntityEntry,
  input: {
    key?: string;
    name?: string | undefined;
    documentSections?: { id: string; name: string }[] | undefined;
  },
  revision: number,
  context: EntityOperationContext,
): Promise<Saved> {
  return context.workspace.mutate(
    "entity-metadata",
    { ref: entry.ref, input, revision, requestId: context.requestId },
    context.actor,
    () => saveMetadataRecord(entry, input, revision, context),
  );
}

async function saveMetadataRecord(
  entry: EntityEntry,
  input: {
    key?: string;
    name?: string | undefined;
    documentSections?: { id: string; name: string }[] | undefined;
  },
  revision: number,
  context: EntityOperationContext,
): Promise<Saved> {
  const at = new Date().toISOString();
  if (entry.ref.kind === "project") {
    const config = context.workspace.storageSession
      ? { ...context.workspace.config, projectSettings: await unified.settings(context.workspace) }
      : configSchema.parse(await readJson(context.workspace.configPath));
    const previous = config.projectSettings ?? {
      version: 1 as const,
      revision: entry.revision,
      name: entry.title,
      slug: entry.data.kind === "project" ? entry.data.slug : "project",
    };
    invariant(
      previous.revision === revision,
      "REVISION_CONFLICT",
      "Проект изменился. Перечитайте запись",
      4,
    );
    const key = input.key ?? entry.key;
    assertEntityKeyAvailable(context.catalog, key, entry.ref);
    const result = { id: entry.ref.id, key, revision: previous.revision + 1 };
    config.projectSettings = storedProjectSettingsSchema.parse({
      ...previous,
      version: 3,
      revision: result.revision,
      name: input.name ?? previous.name,
      ...(input.documentSections === undefined ? {} : { documentSections: input.documentSections }),
      entityKey: key,
      aliases: [
        ...new Set([...(previous.aliases ?? []), ...(key === entry.key ? [] : [entry.key])]),
      ],
      events: [
        ...(previous.events ?? []),
        {
          revision: result.revision,
          at,
          actor: context.actor,
          action: input.key ? "rename" : "update",
        },
      ],
    });
    if (context.workspace.storageSession)
      await unified.saveSettings(context.workspace, config.projectSettings);
    else
      await atomicJson(
        context.workspace.configPath,
        config,
        context.workspace.runtime,
        false,
        context.owned,
      );
    Object.assign(context.workspace.config, config);
    return result;
  }
  invariant(entry.ref.kind === "board", "ENTITY_KIND_MISMATCH", "Ожидается доска", 4);
  const previous = (await new BoardRepository(context.workspace).all()).find(
    (board) => board.id === entry.ref.id,
  )!;
  invariant(
    previous.revision === revision,
    "REVISION_CONFLICT",
    "Доска изменилась. Перечитайте запись",
    4,
  );
  const key = input.key ?? entry.key;
  assertEntityKeyAvailable(context.catalog, key, entry.ref);
  const result = { id: previous.id, key, revision: previous.revision + 1 };
  const next = boardSchema.parse({
    ...previous,
    version: 2,
    key,
    revision: result.revision,
    aliases: [...new Set([...(previous.aliases ?? []), ...(key === entry.key ? [] : [entry.key])])],
    events: [
      ...(previous.events ?? []),
      { revision: result.revision, at, actor: context.actor, action: "rename" },
    ],
  });
  if (context.workspace.storageSession) await unified.saveBoard(context.workspace, next);
  else
    await atomicJson(
      join(dirname(context.workspace.configPath), "boards", previous.slug, "board.json"),
      next,
      context.workspace.runtime,
      false,
      context.owned,
    );
  return result;
}

/** Явная регистрация предметных обработчиков; движок исполняет общий контракт по виду. */
const planningHandler: EntityHandler = {
  rename: async () => {
    invariant(
      false,
      "UNSUPPORTED_ENTITY_ACTION",
      "Используйте предметные операции планов и релизов; их ключи назначаются при создании",
      2,
    );
  },
};
export const entityHandlers: Readonly<Record<EntityKind, EntityHandler>> = {
  "work-plan": planningHandler,
  release: planningHandler,
  project: {
    update: (entry, changes, revision, context) => {
      invariant(
        changes.kind === "project",
        "ENTITY_KIND_MISMATCH",
        "Ожидается изменение проекта",
        4,
      );
      return saveMetadata(
        entry,
        { name: changes.name, documentSections: changes.documentSections },
        revision,
        context,
      );
    },
    rename: (entry, key, revision, context) => saveMetadata(entry, { key }, revision, context),
  },
  product: productHandler,
  feature: productHandler,
  scenario: productHandler,
  application: productHandler,
  implementation: implementationHandler,
  task: taskHandler,
  document: productHandler,
  board: {
    rename: (entry, key, revision, context) => saveMetadata(entry, { key }, revision, context),
  },
};

export function entitySaved(
  kind: EntityKind,
  result: Saved,
  action: EntitySaved["action"],
  requestId: string,
): EntitySaved {
  invariant(result.key, "INVALID_DATA", "Обработчик не вернул читаемый ключ сущности", 5);
  return {
    ref: { kind, id: result.id },
    key: result.key,
    revision: result.revision,
    requestId,
    action,
  };
}
