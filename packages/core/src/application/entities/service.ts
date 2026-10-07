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
    return this.read(async (catalog) => {
      // Полный адрес прежнего этапа плана (запись совместимости) не входит в публичный
      // каталог и не роняет адресное чтение: такой ref пропускается, остальные читаются.
      // Узнать план-владельца можно чтением графа/контекста от этого адреса.
      const relocated = new Set<string>();
      const session = this.workspace.storageSession;
      if (session)
        for (const ref of refs ?? []) {
          const [refKind, refId, extra] = ref.split(":");
          if (extra !== undefined || refId === undefined) continue;
          const definition = session.store.registry
            .definitions()
            .find((entry) => entry.kind === refKind);
          if (definition?.relocation && (await session.indexGet("cards", ref)) !== undefined)
            relocated.add(ref);
        }
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
          .map(([name, value]) => [name, resolveEntity(catalog, value!, expected[name]).ref.id]),
      );
      const selected =
        refs === undefined
          ? undefined
          : new Set(
              refs
                .filter((ref) => !relocated.has(ref))
                .map((ref) => entityAddress(resolveEntity(catalog, ref, kind).ref)),
            );
      const needle = q?.trim().toLocaleLowerCase();
      const items = catalog.entries
        .filter(
          (entry) =>
            (!kind || entry.ref.kind === kind) &&
            (!selected || selected.has(entityAddress(entry.ref))) &&
            (!needle ||
              `${entry.key} ${entry.aliases.join(" ")} ${entityAddress(entry.ref)} ${entry.title} ${entry.summary} ${entry.context ?? ""} ${entry.data.kind === "document" ? entry.data.body : ""}`
                .toLocaleLowerCase()
                .includes(needle)) &&
            (status === undefined || entry.status === status) &&
            (active === undefined || entry.active === (active === "true")) &&
            (section === undefined || (entry.document?.sectionId ?? "none") === section) &&
            (documentKind === undefined || entry.document?.kind === documentKind) &&
            (pinned === undefined || entry.document?.pinned === (pinned === "true")) &&
            (archived === undefined ||
              (entry.document?.status === "archived") === (archived === "true")) &&
            Object.entries(resolved).every(([name, value]) =>
              Array.isArray(entry.filters[name])
                ? entry.filters[name].includes(value)
                : entry.filters[name] === value,
            ),
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
}
