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
  saveReleaseSchema,
  updateReleaseSchema,
  releaseActionSchema,
  releasePreviewSchema,
} from "@relay/contracts/releases";
import type {
  ReleasesQuery,
  SaveRelease,
  UpdateRelease,
  ReleaseAction,
  ReleasePreview,
} from "@relay/contracts/releases";
import { ReleasesService } from "@relay/core/application/releases/service";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";

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
