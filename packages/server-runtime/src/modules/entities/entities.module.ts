import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import {
  entityPageQuerySchema,
  entityTypeQuerySchema,
  entitiesQuerySchema,
  entityGetQuerySchema,
  entityKeysQuerySchema,
  entityKeySpacesQuerySchema,
  entityCreateSchema,
  entityUpdateSchema,
  entityRenameSchema,
  entityMoveTaskSchema,
  entityLinkTaskSchema,
  entityDeletionQuerySchema,
  deleteEntitySchema,
} from "@relay/contracts/entities";
import {
  documentBulkSchema,
  documentFacetsQuerySchema,
  documentRelationChangeSchema,
  entityDocumentsQuerySchema,
} from "@relay/contracts/entities/document-catalog";
import type {
  DocumentBulk,
  DocumentFacetsQuery,
  DocumentRelationChange,
  EntityDocumentsQuery,
} from "@relay/contracts/entities/document-catalog";
import type { z } from "zod";
import type {
  EntityPageQuery,
  EntityGetQuery,
  EntitiesQuery,
  EntityKind,
  CreateEntity,
  UpdateEntity,
  RenameEntity,
  MoveEntityTask,
  LinkEntityTask,
  EntityDeletionQuery,
  DeleteEntity,
} from "@relay/contracts/entities";
import { EntityEngine } from "@relay/core/application/entities/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";

/** Fastify отдаёт одиночный повторяемый query-параметр строкой; контракт ожидает массив. */
function queryList<T extends object>(input: T, ...names: string[]): T {
  const result = { ...input } as Record<string, unknown>;
  for (const name of names) if (typeof result[name] === "string") result[name] = [result[name]];
  return result as T;
}

@ApiTags("entities")
@Controller("entities")
class EntitiesController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async engine() {
    return new EntityEngine(await this.workspace.open());
  }
  private async changed<T>(operation: (engine: EntityEngine) => Promise<T>) {
    const engine = await this.engine();
    const result = await operation(engine);
    await this.events.apiChanged(engine.workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get("types")
  @ApiEndpoint({
    id: "listEntityTypes",
    summary: "Перечислить основные виды сущностей, их назначение и возможности",
    query: "EntityPageQuery",
    response: "EntityTypes",
  })
  async types(@Query(new ZodValidationPipe(entityPageQuerySchema)) query: EntityPageQuery) {
    return success(await (await this.engine()).types(query));
  }
  @Get("deletion-preview")
  @ApiEndpoint({
    id: "previewEntityDeletion",
    summary:
      "Показать полный каскад удаления и сохраняемые сущности со снимаемыми связями; максимум 1000 записей",
    query: "EntityDeletionQuery",
    response: "EntityDeletionPreview",
  })
  async deletionPreview(
    @Query(new ZodValidationPipe(entityDeletionQuerySchema)) query: EntityDeletionQuery,
  ) {
    return success(await new EntityDeletionService(await this.workspace.open()).preview(query));
  }
  @Post("delete")
  @HttpCode(200)
  @ApiEndpoint({
    id: "deleteEntity",
    summary:
      "Удалить подтверждённый каскад и снять внешние связи с проверкой версии; requestId служит корреляции",
    body: "DeleteEntity",
    response: "EntityDeleted",
  })
  async delete(@Body(new ZodValidationPipe(deleteEntitySchema)) input: DeleteEntity) {
    return this.changed((engine) =>
      new EntityDeletionService(engine.workspace).delete(input, this.workspace.actor()),
    );
  }
  @Get("type")
  @ApiEndpoint({
    id: "describeEntityType",
    summary: "Прочитать поля, схемы операций, фильтры и правила ключей вида",
    query: "EntityTypeQuery",
    response: "EntityTypeDetail",
  })
  async describe(@Query(new ZodValidationPipe(entityTypeQuerySchema)) query: { kind: EntityKind }) {
    return success(await (await this.engine()).describe(query));
  }
  @Get()
  @ApiEndpoint({
    id: "listEntities",
    summary: "Найти сущности по виду, ключу и предметным фильтрам; до 100 карточек со снимком",
    query: "EntitiesQuery",
    response: "EntitiesPage",
  })
  async list(@Query() input: EntitiesQuery) {
    const query = new ZodValidationPipe(entitiesQuerySchema).transform(
      queryList(input, "refs", "tags"),
    );
    return success(await (await this.engine()).list(query));
  }
  @Get("document-facets")
  @ApiEndpoint({
    id: "getDocumentFacets",
    summary:
      "Посчитать документы библиотеки по разделам, тегам, форматам, типам, состояниям и системным представлениям по полным данным проекта",
    query: "DocumentFacetsQuery",
    response: "DocumentFacets",
  })
  async documentFacets(@Query() input: DocumentFacetsQuery) {
    const query = new ZodValidationPipe(documentFacetsQuerySchema).transform(
      queryList(input, "tags"),
    );
    return success(await (await this.engine()).documentFacets(query));
  }
  @Get("documents")
  @ApiEndpoint({
    id: "getEntityDocuments",
    summary:
      "Прочитать материалы, прикреплённые непосредственно к сущности любого вида: связи relations и совместимые links",
    query: "EntityDocumentsQuery",
    response: "EntityDocumentsPage",
  })
  async entityDocuments(
    @Query(new ZodValidationPipe(entityDocumentsQuerySchema)) query: EntityDocumentsQuery,
  ) {
    return success(await (await this.engine()).entityDocuments(query));
  }
  @Post("document-bulk")
  @HttpCode(200)
  @ApiEndpoint({
    id: "bulkChangeDocuments",
    summary:
      "Изменить до 100 документов одним действием; каждый записывается отдельно под своей ревизией, отказ одного не откатывает остальные",
    body: "DocumentBulk",
    response: "DocumentBulkResult",
  })
  async documentBulk(@Body(new ZodValidationPipe(documentBulkSchema)) input: DocumentBulk) {
    const engine = await this.engine();
    const result = await engine.documentBulk(input, this.workspace.actor());
    // Частичный результат: событие нужно, если сохранён хотя бы один документ.
    if (result.applied > 0)
      await this.events.apiChanged(engine.workspace.config.projectId).catch(() => {});
    return success(result);
  }
  @Post("relate-document")
  @HttpCode(200)
  @ApiEndpoint({
    id: "relateDocument",
    summary:
      "Прикрепить, изменить или открепить одну связь документа с проверкой ревизии; прочие связи и links сохраняются",
    body: "DocumentRelationChange",
    response: "EntitySaved",
  })
  async relateDocument(
    @Body(new ZodValidationPipe(documentRelationChangeSchema)) input: DocumentRelationChange,
  ) {
    return this.changed((engine) => engine.relateDocument(input, this.workspace.actor()));
  }
  @Get("get")
  @ApiEndpoint({
    id: "getEntity",
    summary: "Прочитать все данные сущности по ключу либо постоянному ID",
    query: "EntityGetQuery",
    response: "EntityDetail",
  })
  async get(@Query(new ZodValidationPipe(entityGetQuerySchema)) query: EntityGetQuery) {
    return success(await (await this.engine()).get(query));
  }
  @Get("resolve")
  @ApiEndpoint({
    id: "resolveEntity",
    summary: "Разрешить текущий ключ, алиас или ID в постоянный адрес и краткую карточку",
    query: "EntityGetQuery",
    response: "EntitySummary",
  })
  async resolve(@Query(new ZodValidationPipe(entityGetQuerySchema)) query: EntityGetQuery) {
    return success(await (await this.engine()).resolve(query));
  }
  @Get("keys")
  @ApiEndpoint({
    id: "getEntityKeys",
    summary: "Прочитать текущий и прежние ключи сущности с продолжением",
    query: "EntityKeysQuery",
    response: "EntityKeysPage",
  })
  async keys(
    @Query(new ZodValidationPipe(entityKeysQuerySchema))
    query: z.input<typeof entityKeysQuerySchema>,
  ) {
    return success(await (await this.engine()).keys(query));
  }
  @Get("key-spaces")
  @ApiEndpoint({
    id: "getEntityKeySpaces",
    summary: "Найти актуальные области нумерации и префиксы ключей выбранного вида",
    query: "EntityKeySpacesQuery",
    response: "EntityKeySpaces",
  })
  async keySpaces(
    @Query(new ZodValidationPipe(entityKeySpacesQuerySchema))
    query: z.input<typeof entityKeySpacesQuerySchema>,
  ) {
    return success(await (await this.engine()).keySpaces(query));
  }
  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: "createEntity",
    summary: "Создать типизированную сущность и её обязательные связи одной предметной операцией",
    body: "CreateEntity",
    response: "EntitySaved",
  })
  async create(@Body(new ZodValidationPipe(entityCreateSchema)) input: CreateEntity) {
    return this.changed((engine) => engine.create(input, this.workspace.actor()));
  }
  @Post("update")
  @HttpCode(200)
  @ApiEndpoint({
    id: "updateEntity",
    summary: "Изменить содержание сущности по ключу или ID с проверкой ревизии",
    body: "UpdateEntity",
    response: "EntitySaved",
  })
  async update(@Body(new ZodValidationPipe(entityUpdateSchema)) input: UpdateEntity) {
    return this.changed((engine) => engine.update(input, this.workspace.actor()));
  }
  @Post("rename")
  @HttpCode(200)
  @ApiEndpoint({
    id: "renameEntityKey",
    summary: "Изменить читаемый ключ, сохранив ID, связи и прежние алиасы",
    body: "RenameEntity",
    response: "EntitySaved",
  })
  async rename(@Body(new ZodValidationPipe(entityRenameSchema)) input: RenameEntity) {
    return this.changed((engine) => engine.rename(input, this.workspace.actor()));
  }
  @Post("move-task")
  @HttpCode(200)
  @ApiEndpoint({
    id: "moveEntityTask",
    summary: "Переместить задачу; задача, доска и позиция принимают ключи или ID",
    body: "MoveEntityTask",
    response: "EntitySaved",
  })
  async move(@Body(new ZodValidationPipe(entityMoveTaskSchema)) input: MoveEntityTask) {
    return this.changed((engine) => engine.moveTask(input, this.workspace.actor()));
  }
  @Post("link-task")
  @HttpCode(200)
  @ApiEndpoint({
    id: "linkEntityTask",
    summary:
      "Установить или снять зависимость, контекстную связь либо родительство задач по ключам или ID",
    body: "LinkEntityTask",
    response: "EntitySaved",
  })
  async link(@Body(new ZodValidationPipe(entityLinkTaskSchema)) input: LinkEntityTask) {
    return this.changed((engine) => engine.linkTask(input, this.workspace.actor()));
  }
}

@Module({ imports: [EventsModule], controllers: [EntitiesController] })
export class EntitiesModule {}
