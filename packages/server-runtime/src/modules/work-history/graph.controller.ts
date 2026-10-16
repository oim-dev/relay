import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ApiParam, ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import {
  workHistoryGraphQuerySchema,
  workHistoryGraphPointQuerySchema,
  workHistoryGraphPageSchema,
  workHistoryGraphPointDetailSchema,
} from "@relay/contracts/work-history-graph";
import type { WorkHistoryGraphQuery } from "@relay/contracts/work-history-graph";
import { WorkHistoryGraphService } from "@relay/core/application/work-history/graph";
import { parse } from "@relay/core/domain/validation";
import { ApiEndpoint, jsonSchema } from "../../openapi/endpoint.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { WorkHistoryQueryPipe } from "./transport.js";

const pointHttpQuerySchema = workHistoryGraphPointQuerySchema.omit({ ref: true });

/** Отдельная проекция чтения: не дополняет lifecycle и не создаёт событий истории. */
@ApiTags("workHistory")
@Controller("work-history/graph")
export class WorkHistoryGraphController {
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  @Get()
  @ApiEndpoint({
    id: "getWorkHistoryGraph",
    summary: workHistoryGraphQuerySchema.description!,
    query: "WorkHistoryGraphQuery",
    response: "WorkHistoryGraphPage",
  })
  async graph(
    @Query(new WorkHistoryQueryPipe(workHistoryGraphQuerySchema)) input: WorkHistoryGraphQuery,
  ) {
    const service = new WorkHistoryGraphService(await this.workspace.open());
    return success(
      parse(workHistoryGraphPageSchema, await service.graph(input), "граф истории работы", true),
    );
  }

  @Get("points/:ref")
  @ApiParam({
    name: "ref",
    description: workHistoryGraphPointQuerySchema.shape.ref.description!,
    schema: jsonSchema(workHistoryGraphPointQuerySchema.shape.ref, "input"),
  })
  @ApiEndpoint({
    id: "getWorkHistoryGraphPoint",
    summary: workHistoryGraphPointQuerySchema.description!,
    response: "WorkHistoryGraphPointDetail",
  })
  async point(
    @Param("ref") ref: string,
    @Query(new WorkHistoryQueryPipe(pointHttpQuerySchema)) query: Record<string, never>,
  ) {
    const input = parse(
      workHistoryGraphPointQuerySchema,
      { ...query, ref },
      "точка графа истории работы",
    );
    const service = new WorkHistoryGraphService(await this.workspace.open());
    return success(
      parse(
        workHistoryGraphPointDetailSchema,
        await service.point(input),
        "материал точки графа",
        true,
      ),
    );
  }
}
