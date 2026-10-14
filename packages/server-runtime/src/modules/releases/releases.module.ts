import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiParam, ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import { entityReferenceSchema } from "@relay/contracts/primitives";
import { planningPageQuerySchema } from "@relay/contracts/planning";
import type { PlanningPageQuery } from "@relay/contracts/planning";
import {
  releasesQuerySchema,
  releasesCompactQuerySchema,
  releaseCompositionCompactQuerySchema,
  saveReleaseSchema,
  updateReleaseSchema,
  releaseActionSchema,
  releasePreviewSchema,
  saveReleaseByRefsSchema,
  updateReleaseByRefsSchema,
} from "@relay/contracts/releases";
import type {
  ReleasesQuery,
  ReleasesCompactQuery,
  ReleaseCompositionCompactQuery,
  SaveRelease,
  UpdateRelease,
  ReleaseAction,
  ReleasePreview,
  SaveReleaseByRefs,
  UpdateReleaseByRefs,
} from "@relay/contracts/releases";
import { ReleasesService } from "@relay/core/application/releases/service";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { releasePreviewProjectionQuerySchema } from "./transport.js";

@ApiTags("releases")
@Controller("releases")
class ReleasesController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}
  private async write<T>(operation: (service: ReleasesService, actor: string) => Promise<T>) {
    const workspace = await this.workspace.open();
    const result = await operation(new ReleasesService(workspace), this.workspace.actor());
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }
  @Get()
  @ApiEndpoint({
    id: "getReleases",
    summary: "Каталог самостоятельных релизов с готовностью и продолжением",
    query: "ReleasesQuery",
    response: "ReleasesPage",
  })
  async list(@Query(new ZodValidationPipe(releasesQuerySchema)) query: ReleasesQuery) {
    return success(await new ReleasesService(await this.workspace.open()).list(query));
  }
  @Get("compact")
  @ApiEndpoint({
    id: "getReleasesCompact",
    summary: "Компактный каталог релизов без полного описания и planIds; projection=compact",
    query: "ReleasesCompactQuery",
    response: "ReleasesCompactPage",
  })
  async listCompact(
    @Query(new ZodValidationPipe(releasesCompactQuerySchema)) query: ReleasesCompactQuery,
  ) {
    return success(await new ReleasesService(await this.workspace.open()).listCompact(query));
  }
  @Post("preview")
  @HttpCode(200)
  @ApiEndpoint({
    id: "previewRelease",
    summary: "Прочитать готовность выбранных планов без записи релиза",
    body: "ReleasePreview",
    response: "ReleaseComposition",
  })
  async preview(@Body(new ZodValidationPipe(releasePreviewSchema)) input: ReleasePreview) {
    return success(await new ReleasesService(await this.workspace.open()).preview(input));
  }
  @Post("preview/compact")
  @HttpCode(200)
  @ApiEndpoint({
    id: "previewReleaseCompact",
    summary:
      "Предпросмотр готовности выбранных планов без записи и полного Markdown; projection=compact",
    body: "ReleasePreview",
    query: "ReleasePreviewProjectionQuery",
    response: "ReleaseCompositionCompact",
  })
  async previewCompact(
    @Body(new ZodValidationPipe(releasePreviewSchema)) input: ReleasePreview,
    @Query(new ZodValidationPipe(releasePreviewProjectionQuerySchema))
    query: { projection: "compact" },
  ) {
    return success(
      await new ReleasesService(await this.workspace.open()).previewCompact({
        ...input,
        projection: query.projection,
      }),
    );
  }
  @Get(":reference")
  @ApiParam({ name: "reference", description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "getRelease",
    summary: "Реквизиты релиза и текущая готовность выбранных планов",
    response: "ReleaseSummary",
  })
  async get(@Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string) {
    return success(await new ReleasesService(await this.workspace.open()).get(reference));
  }
  @Get(":reference/plans")
  @ApiParam({ name: "reference", description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "getReleasePlans",
    summary: "Актуальные планы состава независимо от состояния выпуска",
    query: "PlanningPageQuery",
    response: "ReleaseComposition",
  })
  async composition(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(planningPageQuerySchema)) query: PlanningPageQuery,
  ) {
    return success(
      await new ReleasesService(await this.workspace.open()).composition(reference, query),
    );
  }
  @Get(":reference/plans/compact")
  @ApiParam({ name: "reference", type: String, description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "getReleasePlansCompact",
    summary: "Компактный актуальный состав релиза без полных текстов планов; projection=compact",
    query: "ReleaseCompositionCompactQuery",
    response: "ReleaseCompositionCompact",
  })
  async compositionCompact(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(releaseCompositionCompactQuerySchema))
    query: ReleaseCompositionCompactQuery,
  ) {
    return success(
      await new ReleasesService(await this.workspace.open()).compositionCompact(reference, query),
    );
  }
  @Post("by-refs")
  @HttpCode(200)
  @ApiEndpoint({
    id: "createReleaseByRefs",
    summary: "Создать релиз, разрешая ссылки планов в одной записи Core",
    body: "SaveReleaseByRefs",
    response: "PlanningSaved",
  })
  async createByRefs(
    @Body(new ZodValidationPipe(saveReleaseByRefsSchema)) input: SaveReleaseByRefs,
  ) {
    return this.write((service, actor) => service.createByRefs(input, actor));
  }
  @Post(":reference/update-by-refs")
  @HttpCode(200)
  @ApiParam({ name: "reference", type: String, description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "updateReleaseByRefs",
    summary: "Изменить релиз, разрешая ссылки планов под исходной ревизией в одной записи",
    body: "UpdateReleaseByRefs",
    response: "PlanningSaved",
  })
  async updateByRefs(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(updateReleaseByRefsSchema)) input: UpdateReleaseByRefs,
  ) {
    return this.write((service, actor) => service.updateByRefs(reference, input, actor));
  }
  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: "createRelease",
    summary:
      "Создать релиз с выбранными планами; статус released проверяет готовность и фиксирует выпуск",
    body: "SaveRelease",
    response: "PlanningSaved",
  })
  async create(@Body(new ZodValidationPipe(saveReleaseSchema)) input: SaveRelease) {
    return this.write((service, actor) => service.create(input, actor));
  }
  @Post(":reference/update")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "updateRelease",
    summary: "Изменить реквизиты, состав и выбранное состояние одной согласованной операцией",
    body: "UpdateRelease",
    response: "PlanningSaved",
  })
  async update(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(updateReleaseSchema)) input: UpdateRelease,
  ) {
    return this.write((service, actor) => service.update(reference, input, actor));
  }
  @Post(":reference/transition")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ релиза" })
  @ApiEndpoint({
    id: "transitionRelease",
    summary: "Перепланировать, отменить либо явно выпустить релиз с проверкой всего состава",
    body: "ReleaseAction",
    response: "PlanningSaved",
  })
  async transition(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(releaseActionSchema)) input: ReleaseAction,
  ) {
    return this.write((service, actor) => service.transition(reference, input, actor));
  }
}
@Module({ imports: [EventsModule], controllers: [ReleasesController] })
export class ReleasesModule {}
