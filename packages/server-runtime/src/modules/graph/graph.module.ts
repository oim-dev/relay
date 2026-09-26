import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import { GraphService } from "@relay/core/application/graph/service";
import {
  graphQuerySchema,
  graphMutationSchema,
  fullContextQuerySchema,
} from "@relay/core/domain/entity-graph";
import type { GraphQuery, GraphMutation, FullContextQuery } from "@relay/core/domain/entity-graph";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";

@ApiTags("graph")
@Controller("graph")
class GraphController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  @ApiEndpoint({
    id: "getGraph",
    summary: "Граф проекта или контекст сущности с путями и согласованным продолжением",
    response: "GraphPage",
    query: "GraphQuery",
  })
  async read(@Query(new ZodValidationPipe(graphQuerySchema)) query: GraphQuery) {
    return success(await new GraphService(await this.workspace.open()).read(query));
  }

  @Get("context")
  @ApiEndpoint({
    id: "getFullContext",
    summary:
      "Получить все узлы и рёбра достижимой компоненты одним вызовом; превышение бюджета возвращает ошибку",
    response: "FullContext",
    query: "FullContextQuery",
  })
  async context(@Query(new ZodValidationPipe(fullContextQuerySchema)) query: FullContextQuery) {
    return success(await new GraphService(await this.workspace.open()).context(query));
  }

  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: "mutateGraph",
    summary:
      "Атомарно установить, изменить или отозвать отношения; повтор requestId безопасен, устаревшая версия отклоняется",
    response: "GraphSaved",
    body: "GraphMutation",
  })
  async mutate(@Body(new ZodValidationPipe(graphMutationSchema)) input: GraphMutation) {
    const workspace = await this.workspace.open();
    const saved = await new GraphService(workspace).mutate(input, this.workspace.actor());
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(saved);
  }
}

@Module({ imports: [EventsModule], controllers: [GraphController] })
export class GraphModule {}
