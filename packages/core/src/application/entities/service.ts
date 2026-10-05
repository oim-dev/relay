import { z } from "zod";
import {
  entityKindSchema,
  entityDefinitions,
  entityDataSchemas,
  entityCreateDataSchemas,
  entityUpdateDataSchemas,
  entityPageQuerySchema,
  entitiesQuerySchema,
  entityGetQuerySchema,
  entityKeysQuerySchema,
  entityKeySpacesQuerySchema,
  entityCreateSchema,
  entityUpdateSchema,
  entityRenameSchema,
  entityMoveTaskSchema,
  entityLinkTaskSchema,
  entityDetailSchema,
  entityTypeDetailSchema,
  entitySummarySchema,
} from "@relay/contracts/entities";
import type {
  EntityKind,
  EntityRef,
  EntityPageQuery,
  EntitiesQuery,
  EntityGetQuery,
  CreateEntity,
  UpdateEntity,
  RenameEntity,
  MoveEntityTask,
  LinkEntityTask,
  EntityDetail,
} from "@relay/contracts/entities";
import { actorSchema } from "@relay/contracts/primitives";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { parse } from "../../domain/validation.js";
import { BoardTasksService } from "../board-tasks/service.js";
import {
  entityAddress,
  entityDigest,
  entitySummary,
  readEntityCatalog,
  resolveEntity,
} from "./catalog.js";
import type { EntityCatalog } from "./catalog.js";
import { entityHandlers, entitySaved } from "./handlers.js";
import {
  changeDocumentRelation,
  documentAxes,
  documentFacets,
  entityDocuments,
  matchesTarget,
  matchesText,
} from "./document-library.js";
import {
  documentBulkSchema,
  documentFacetsQuerySchema,
  documentRelationChangeSchema,
  entityDocumentsQuerySchema,
} from "@relay/contracts/entities/document-catalog";
import type {
  DocumentBulk,
  DocumentBulkResult,
  DocumentFacets,
  DocumentFacetsQuery,
  DocumentRelationChange,
  EntityDocumentsPage,
  EntityDocumentsQuery,
} from "@relay/contracts/entities/document-catalog";
import { productMutationSchema } from "../../domain/product.js";
import { ProductQueries } from "../product/queries.js";
import { AppError } from "../../shared/errors.js";
import { documentTagKey, normalizeDocumentTags } from "../../domain/document-library.js";
import type { EntityOperationContext } from "./handlers.js";

/** Общий движок адресации, чтения и исполнения зарегистрированных предметных операций. */
export class EntityEngine {
  constructor(readonly workspace: Workspace) {}

  private page<T>(items: readonly T[], input: EntityPageQuery, version: string) {
    const query = parse(entityPageQuerySchema, input, "страница сущностей");
    invariant(
      query.version === undefined || query.version === version,
      "ENTITIES_CHANGED",
      "Сущности изменились. Начните чтение с первой страницы",
      4,
    );
    const next = query.offset + query.limit;
    return {
      items: items.slice(query.offset, next),
      total: items.length,
      nextOffset: next < items.length ? next : null,
      version,
    };
  }
  private read<T>(operation: (catalog: EntityCatalog) => T | Promise<T>) {
    return this.workspace.locked(async (owned) =>
      operation(await readEntityCatalog(this.workspace, owned)),
    );
  }
  private write<T>(
    input: { actor?: string | undefined; requestId: string },
    actor: string,
    operation: (context: EntityOperationContext) => Promise<T>,
  ) {
    const author = parse(actorSchema, input.actor ?? actor, "автор операции");
    return this.workspace.mutate("entity", { ...input }, author, async (owned) =>
      operation({
        workspace: this.workspace,
        catalog: await readEntityCatalog(this.workspace, owned),
        actor: author,
        requestId: input.requestId,
        owned,
      }),
    );
  }

  /** Девять видов доступны независимо от наличия записей в конкретном проекте. */
  async types(input: EntityPageQuery = {}) {
    return this.page(structuredClone(entityDefinitions), input, entityDigest(entityDefinitions));
  }
  async describe(input: { kind: EntityKind }): Promise<z.infer<typeof entityTypeDetailSchema>> {
    const kind = parse(entityKindSchema, input.kind, "вид сущности");
    const definition = entityDefinitions.find((entry) => entry.kind === kind)!;
    const create =
      kind in entityCreateDataSchemas
        ? entityCreateDataSchemas[kind as keyof typeof entityCreateDataSchemas]
        : undefined;
    const update =
      kind in entityUpdateDataSchemas
        ? entityUpdateDataSchemas[kind as keyof typeof entityUpdateDataSchemas]
        : undefined;
    return {
      ...structuredClone(definition),
      schema: z.toJSONSchema(entityDataSchemas[kind]),
      createSchema: create ? z.toJSONSchema(create, { io: "input" }) : null,
      updateSchema: update ? z.toJSONSchema(update, { io: "input" }) : null,
    };
  }
  async list(input: EntitiesQuery = {}) {
    const query = parse(entitiesQuerySchema, input, "каталог сущностей");
    const {
      kind,
      q,
      refs,
      board,
      application,
      feature,
      scenario,
      target,
      parent,
      status,
      active,
      sort,
      section,
      documentKind,
      documentFormat,
      tags,
      unattached,
      pinned,
      archived,
      ...pagination
    } = query;
    const filters = {
      board,
      application,
      feature,
      scenario,
      target,
      parent,
      status,
      active,
      section,
      documentKind,
      documentFormat,
      tags,
      unattached,
      pinned,
      archived,
    };
    if (kind) {
      const available = entityDefinitions.find((entry) => entry.kind === kind)!.filters;
      for (const [name, value] of Object.entries(filters))
        invariant(
          value === undefined || available.includes(name),
          "UNSUPPORTED_ENTITY_FILTER",
          `Вид ${kind} не поддерживает фильтр ${name}`,
          2,
        );
    }
    return this.read((catalog) => {
      const expected: Record<string, EntityKind | readonly EntityKind[] | undefined> = {
        board: "board",
        application: "application",
        feature: "feature",
        scenario: "scenario",
        parent: "task",
        target: undefined,
      };
      const resolved = Object.fromEntries(
        Object.entries({ board, application, feature, scenario, target, parent })
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, resolveEntity(catalog, value!, expected[name]).ref]),
      );
      const selected =
        refs === undefined
          ? undefined
          : new Set(refs.map((ref) => entityAddress(resolveEntity(catalog, ref, kind).ref)));
      const needle = q?.trim().toLocaleLowerCase() || undefined;
      const axes = documentAxes(query, undefined);
      const items = catalog.entries
        .filter(
          (entry) =>
            (!kind || entry.ref.kind === kind) &&
            (!selected || selected.has(entityAddress(entry.ref))) &&
            matchesText(entry, needle) &&
            (status === undefined || entry.status === status) &&
            (active === undefined || entry.active === (active === "true")) &&
            axes.section(entry) &&
            axes.documentKind(entry) &&
            axes.documentFormat(entry) &&
            axes.tags(entry) &&
            axes.unattached(entry) &&
            axes.pinned(entry) &&
            axes.archived(entry) &&
            Object.entries(resolved).every(([name, ref]) => matchesTarget(entry, name, ref)),
        )
        .sort(
          (a, b) =>
            (sort === "updated"
              ? (b.document?.updatedAt ?? "").localeCompare(a.document?.updatedAt ?? "")
              : a[sort].localeCompare(b[sort], "ru", { numeric: true })) ||
            entityAddress(a.ref).localeCompare(entityAddress(b.ref)),
        )
        .map((entry) => {
          const summary = entitySummary(entry);
          if (needle && entry.data.kind === "document" && summary.document) {
            const match = entry.data.body.toLocaleLowerCase().indexOf(needle);
            if (match >= 0)
              summary.document.excerpt = entry.data.body.slice(
                Math.max(0, match - 50),
                match + needle.length + 100,
              );
          }
          return summary;
        });
      const page = this.page(items, pagination, catalog.version);
      if (kind !== "document") return page;
      const counts: Record<string, number> = { all: 0, draft: 0, pinned: 0, archived: 0, none: 0 };
      for (const entry of catalog.entries) {
        const document = entry.document;
        if (!document) continue;
        if (document.status === "archived") {
          counts.archived!++;
          continue;
        }
        counts.all!++;
        if (document.status === "draft") counts.draft!++;
        if (document.pinned) counts.pinned!++;
        const section = document.sectionId === null ? "none" : `section:${document.sectionId}`;
        counts[section] = (counts[section] ?? 0) + 1;
      }
      return { ...page, libraryCounts: counts };
    });
  }
  async get(input: EntityGetQuery): Promise<EntityDetail> {
    const query = parse(entityGetQuerySchema, input, "адрес сущности");
    return this.read((catalog) => {
      const entry = resolveEntity(catalog, query.ref, query.kind);
      const refs: { kind: string; id: string }[] = [];
      const data = entry.data;
      if (data.kind === "work-plan")
        refs.push(
          { kind: "project", id: data.projectId },
          ...data.scope,
          ...data.stages.flatMap((stage) => stage.taskIds).map((id) => ({ kind: "task", id })),
        );
      if (data.kind === "release")
        refs.push(
          { kind: "project", id: data.projectId },
          ...data.planIds.map((id) => ({ kind: "work-plan", id })),
        );
      if (data.kind === "product")
        refs.push({ kind: "project", id: this.workspace.config.projectId ?? "project" });
      if (data.kind === "feature") refs.push({ kind: "product", id: "passport" });
      if (data.kind === "scenario") refs.push({ kind: "feature", id: data.featureId });
      if (data.kind === "implementation") {
        refs.push(
          { kind: "application", id: data.applicationId },
          { kind: "feature", id: data.featureId },
        );
        if (data.scenarioId) refs.push({ kind: "scenario", id: data.scenarioId });
      }
      if (data.kind === "board" && data.applicationId)
        refs.push({ kind: "application", id: data.applicationId });
      if (data.kind === "document")
        refs.push(
          ...(data.relations ?? []).map((relation) => relation.target),
          ...data.links.map((link) =>
            link.kind === "product" ? { kind: "product", id: "passport" } : link,
          ),
        );
      if (data.kind === "task") {
        refs.push(
          { kind: "board", id: data.boardId },
          ...data.productLinks,
          ...[...data.dependencies, ...data.related, ...(data.parentId ? [data.parentId] : [])].map(
            (id) => ({ kind: "task", id }),
          ),
        );
      }
      const addresses = new Set(refs.map(entityAddress));
      const references = catalog.entries
        .filter((item) => addresses.has(entityAddress(item.ref)))
        .map(entitySummary);
      return parse(
        entityDetailSchema,
        { ...entitySummary(entry), data: entry.data, references },
        "данные сущности",
        true,
      );
    });
  }
  async resolve(input: EntityGetQuery) {
    const query = parse(entityGetQuerySchema, input, "адрес сущности");
    return this.workspace.locked(async (owned) => {
      if (this.workspace.storageSession) {
        const {
          aliases: _aliases,
          selectors: _selectors,
          ...summary
        } = await this.workspace.storageSession.resolve(query.ref, query.kind);
        return entitySummarySchema.parse({ ...summary, status: summary.status || null });
      }
      return entitySummary(
        resolveEntity(await readEntityCatalog(this.workspace, owned), query.ref, query.kind),
      );
    });
  }
  async keys(input: z.input<typeof entityKeysQuerySchema>) {
    const { ref, kind, ...page } = parse(entityKeysQuerySchema, input, "ключи сущности");
    return this.read((catalog) => {
      const entry = resolveEntity(catalog, ref, kind);
      const items = [...new Set([entry.key, ...entry.aliases])].map((key) => ({
        ref: entry.ref,
        key,
        current: key === entry.key,
      }));
      return this.page(items, page, entityDigest(items));
    });
  }
  async keySpaces(input: z.input<typeof entityKeySpacesQuerySchema>) {
    const { kind, ...page } = parse(entityKeySpacesQuerySchema, input, "пространства ключей");
    return this.read((catalog) => {
      const dynamic =
        kind === "task" || kind === "board" || kind === "implementation" || kind === "application";
      const scopeKind =
        kind === "implementation" || kind === "application" ? "application" : "board";
      const items: { scope: EntityRef | null; title: string; prefix: string; pattern: string }[] =
        dynamic
          ? catalog.entries
              .filter((entry) => entry.ref.kind === scopeKind)
              .map((entry) => {
                const prefix =
                  entry.data.kind === "board" || entry.data.kind === "application"
                    ? (entry.data.prefix ?? entry.key)
                    : "";
                return {
                  scope: entry.ref,
                  title: entry.title,
                  prefix: kind === "board" ? `BOARD-${prefix}` : prefix,
                  pattern:
                    kind === "implementation"
                      ? `${prefix}-FI/SI-<номер>`
                      : kind === "application"
                        ? prefix
                        : kind === "board"
                          ? `BOARD-${prefix}`
                          : `${prefix}-<номер>`,
                };
              })
          : [
              {
                scope: null,
                title: entityDefinitions.find((entry) => entry.kind === kind)!.title,
                prefix: {
                  project: "PROJECT",
                  product: "PRODUCT",
                  feature: "FEATURE",
                  scenario: "SCENARIO",
                  document: "DOC",
                  "work-plan": "PLN",
                  release: "REL",
                }[
                  kind as
                    | "project"
                    | "product"
                    | "feature"
                    | "scenario"
                    | "document"
                    | "work-plan"
                    | "release"
                ],
                pattern:
                  kind === "project"
                    ? "PROJECT"
                    : kind === "product"
                      ? "PRODUCT"
                      : `${kind === "document" ? "DOC" : kind === "work-plan" ? "PLN" : kind === "release" ? "REL" : kind.toUpperCase()}-<номер>`,
              },
            ];
      return this.page(items, page, entityDigest(items));
    });
  }
  async create(input: CreateEntity, actor: string) {
    const command = parse(entityCreateSchema, input, "создание сущности");
    return this.write(command, actor, async (context) => {
      const handler = entityHandlers[command.data.kind].create;
      invariant(
        handler,
        "UNSUPPORTED_ENTITY_ACTION",
        "Этот вид создаётся другим предметным действием",
        2,
      );
      return entitySaved(
        command.data.kind,
        await handler(command.data, context),
        "create",
        command.requestId,
      );
    });
  }
  async update(input: UpdateEntity, actor: string) {
    const command = parse(entityUpdateSchema, input, "изменение сущности");
    invariant(
      Object.keys(command.changes).length > 1,
      "INVALID_ARGUMENT",
      "Изменения не заданы",
      2,
    );
    return this.write(command, actor, async (context) => {
      const entry = resolveEntity(context.catalog, command.ref, command.changes.kind);
      invariant(
        entry.status !== "uninitialized",
        "UNSUPPORTED_ENTITY_ACTION",
        "Сначала заполните паспорт операцией создания продукта",
        2,
      );
      const handler = entityHandlers[entry.ref.kind].update;
      invariant(
        handler,
        "UNSUPPORTED_ENTITY_ACTION",
        "Содержание этого вида изменяется у его владельца",
        2,
      );
      return entitySaved(
        entry.ref.kind,
        await handler(entry, command.changes, command.ifRevision, context),
        "update",
        command.requestId,
      );
    });
  }
  async rename(input: RenameEntity, actor: string) {
    const command = parse(entityRenameSchema, input, "смена ключа сущности");
    return this.write(command, actor, async (context) => {
      const entry = resolveEntity(context.catalog, command.ref);
      invariant(
        entry.status !== "uninitialized",
        "UNSUPPORTED_ENTITY_ACTION",
        "Сначала заполните паспорт операцией создания продукта",
        2,
      );
      return entitySaved(
        entry.ref.kind,
        await entityHandlers[entry.ref.kind].rename(
          entry,
          command.key,
          command.ifRevision,
          context,
        ),
        "rename",
        command.requestId,
      );
    });
  }
  async moveTask(input: MoveEntityTask, actor: string) {
    const command = parse(entityMoveTaskSchema, input, "перемещение задачи");
    return this.write(command, actor, async (context) => {
      const ref = resolveEntity(context.catalog, command.ref, "task").ref;
      const saved = await new BoardTasksService(this.workspace).move(
        ref.id,
        {
          actor: context.actor,
          requestId: command.requestId,
          ifRevision: command.ifRevision,
          column: command.column,
          beforeId:
            command.before === null
              ? null
              : resolveEntity(context.catalog, command.before, "task").ref.id,
          ...(command.board === undefined
            ? {}
            : { board: resolveEntity(context.catalog, command.board, "board").ref.id }),
        },
        context.actor,
      );
      return entitySaved("task", saved, "move", command.requestId);
    });
  }
  async linkTask(input: LinkEntityTask, actor: string) {
    const command = parse(entityLinkTaskSchema, input, "связь задач");
    return this.write(command, actor, async (context) => {
      const ref = resolveEntity(context.catalog, command.ref, "task").ref;
      const saved = await new BoardTasksService(this.workspace).link(
        ref.id,
        {
          actor: context.actor,
          requestId: command.requestId,
          ifRevision: command.ifRevision,
          target: resolveEntity(context.catalog, command.target, "task").ref.id,
          relation: command.relation,
          remove: command.remove,
        },
        context.actor,
      );
      return entitySaved("task", saved, "link", command.requestId);
    });
  }
  /** Счётчики библиотеки по полным данным; область каждой оси описана в контракте. */
  async documentFacets(input: DocumentFacetsQuery = {}): Promise<DocumentFacets> {
    const query = parse(documentFacetsQuerySchema, input, "счётчики библиотеки");
    return this.read((catalog) => documentFacets(catalog, query));
  }
  /** Материалы, прикреплённые непосредственно к сущности, с признаком архива. */
  async entityDocuments(input: EntityDocumentsQuery): Promise<EntityDocumentsPage> {
    const { ref, archived, ...pagination } = parse(
      entityDocumentsQuerySchema,
      input,
      "материалы сущности",
    );
    return this.read((catalog) => {
      const { target, items } = entityDocuments(catalog, ref, archived);
      return { target, ...this.page(items, pagination, catalog.version) };
    });
  }
  /** Одна связь документа под его ревизией; прочие relations и links сохраняются. */
  async relateDocument(input: DocumentRelationChange, actor: string) {
    const command = parse(documentRelationChangeSchema, input, "связь документа");
    invariant(
      command.nextType === undefined || command.action === "update",
      "INVALID_ARGUMENT",
      "Новый тип задаётся только при изменении связи",
      2,
    );
    invariant(
      command.description === undefined || command.action !== "detach",
      "INVALID_ARGUMENT",
      "Открепление не принимает пояснение",
      2,
    );
    return this.write(command, actor, async (context) => {
      const entry = resolveEntity(context.catalog, command.ref, "document");
      invariant(entry.data.kind === "document", "ENTITY_KIND_MISMATCH", "Ожидается документ", 4);
      invariant(
        entry.revision === command.ifRevision,
        "REVISION_CONFLICT",
        "Запись изменилась после чтения",
        4,
        { actual: entry.revision, expected: command.ifRevision },
      );
      const target = resolveEntity(context.catalog, command.target).ref;
      const { relations, links } = changeDocumentRelation(entry.data, target, command);
      const saved = await new ProductQueries(this.workspace).mutate(
        productMutationSchema.parse({
          action: "update",
          id: entry.ref.id,
          fields: { ...entry.data, relations, links },
          ifRevision: command.ifRevision,
          actor: context.actor,
          requestId: command.requestId,
        }),
        context.actor,
      );
      return entitySaved("document", saved, "link", command.requestId);
    });
  }
  /**
   * Массовое изменение: каждый документ записывается отдельной операцией под своей ревизией.
   * Отказ элемента не откатывает уже сохранённые; повторов нет.
   */
  async documentBulk(input: DocumentBulk, actor: string): Promise<DocumentBulkResult> {
    const command = parse(documentBulkSchema, input, "массовое изменение документов");
    const operation = command.operation;
    const items: DocumentBulkResult["items"] = [];
    for (const item of command.items) {
      let found: { ref: EntityRef; key: string } | undefined;
      try {
        const entry = await this.read((catalog) => resolveEntity(catalog, item.ref, "document"));
        invariant(entry.data.kind === "document", "ENTITY_KIND_MISMATCH", "Ожидается документ", 4);
        found = { ref: entry.ref, key: entry.key };
        invariant(
          entry.revision === item.ifRevision,
          "REVISION_CONFLICT",
          "Запись изменилась после чтения",
          4,
          { actual: entry.revision, expected: item.ifRevision },
        );
        const data = entry.data;
        const tags = data.tags ?? [];
        let changes: Record<string, unknown> | undefined;
        if (operation.type === "move") {
          if ((data.sectionId ?? null) !== operation.sectionId)
            changes = { sectionId: operation.sectionId };
        } else if (operation.type === "addTags") {
          const next = normalizeDocumentTags([...tags, ...operation.tags]);
          invariant(next.length <= 20, "VALIDATION_ERROR", "У материала не более 20 тегов", 2);
          if (next.length !== tags.length) changes = { tags: next };
        } else if (operation.type === "removeTags") {
          const removed = new Set(operation.tags.map(documentTagKey));
          const next = tags.filter((tag) => !removed.has(documentTagKey(tag)));
          if (next.length !== tags.length) changes = { tags: next };
        } else if (operation.type === "setStatus") {
          if ((entry.document?.status ?? "active") !== operation.documentStatus)
            changes = { documentStatus: operation.documentStatus };
        } else if ((entry.document?.pinned ?? false) !== operation.pinned)
          changes = { pinned: operation.pinned };
        if (!changes) {
          items.push({
            ref: item.ref,
            status: "unchanged",
            target: entry.ref,
            key: entry.key,
            revision: entry.revision,
          });
          continue;
        }
        const saved = await this.update(
          {
            ref: entityAddress(entry.ref),
            ifRevision: item.ifRevision,
            requestId: command.requestId,
            ...(command.actor === undefined ? {} : { actor: command.actor }),
            changes: { kind: "document", ...changes },
          },
          actor,
        );
        items.push({
          ref: item.ref,
          status: "applied",
          target: saved.ref,
          key: saved.key,
          revision: saved.revision,
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const status =
          error.code === "REVISION_CONFLICT"
            ? "conflict"
            : ["ENTITY_NOT_FOUND", "ENTITY_KIND_MISMATCH", "PRODUCT_RECORD_NOT_FOUND"].includes(
                  error.code,
                )
              ? "not_found"
              : ["VALIDATION_ERROR", "INVALID_REFERENCE", "INVALID_ARGUMENT"].includes(error.code)
                ? "invalid"
                : "error";
        const actual = (error.details as { actual?: unknown } | undefined)?.actual;
        items.push({
          ref: item.ref,
          status,
          ...(found ? { target: found.ref, key: found.key } : {}),
          ...(status === "conflict" && typeof actual === "number" ? { revision: actual } : {}),
          error: { code: error.code, message: error.message },
        });
      }
    }
    const applied = items.filter((item) => item.status === "applied").length;
    return {
      requestId: command.requestId,
      items,
      applied,
      failed: items.filter((item) => !["applied", "unchanged"].includes(item.status)).length,
    };
  }
}
