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
import * as history from "@relay/contracts/work-history";
import { WorkHistoryService } from "@relay/core/application/work-history/service";
import { parse } from "@relay/core/domain/validation";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";
import { WorkHistoryGraphController } from "./graph.controller.js";
import {
  WorkHistoryQueryPipe,
  workSessionHistoryHttpQuerySchema,
  workOpenIntentsHttpQuerySchema,
} from "./transport.js";

const sessionParameter = {
  name: "ref",
  type: String,
  description: history.workSessionQuerySchema.shape.ref.description!,
};
const checkpointParameter = {
  name: "ref",
  type: String,
  description: history.workCheckpointQuerySchema.shape.ref.description!,
};

@ApiTags("workHistory")
@Controller("work-history")
class WorkHistoryController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async service() {
    return new WorkHistoryService(await this.workspace.open());
  }

  private async changed(
    operation: (service: WorkHistoryService) => Promise<history.WorkHistoryMutation>,
  ) {
    const workspace = await this.workspace.open();
    const result = history.workHistoryMutationSchema.parse(
      await operation(new WorkHistoryService(workspace)),
    );
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get("sessions")
  @ApiEndpoint({
    id: "listWorkSessions",
    summary: history.workSessionsQuerySchema.description!,
    query: "WorkSessionsQuery",
    response: "WorkSessionsPage",
  })
  async list(
    @Query(new WorkHistoryQueryPipe(history.workSessionsQuerySchema))
    input: history.WorkSessionsQuery,
  ) {
    return success(history.workSessionsPageSchema.parse(await (await this.service()).list(input)));
  }

  @Get("sessions/:ref")
  @ApiParam(sessionParameter)
  @ApiEndpoint({
    id: "getWorkSession",
    summary: history.workSessionQuerySchema.description!,
    response: "WorkSessionDetail",
  })
  async get(@Param("ref") ref: string) {
    const input = parse(history.workSessionQuerySchema, { ref }, "ветка работы");
    return success(history.workSessionDetailSchema.parse(await (await this.service()).get(input)));
  }

  @Get("sessions/:ref/tree")
  @ApiParam(sessionParameter)
  @ApiEndpoint({
    id: "getWorkSessionTree",
    summary: history.workTreeQuerySchema.description!,
    query: "WorkHistoryPageQuery",
    response: "WorkTreePage",
  })
  async tree(
    @Param("ref") ref: string,
    @Query(new WorkHistoryQueryPipe(history.workHistoryPageQuerySchema))
    query: history.WorkHistoryPageQuery,
  ) {
    const input = parse(history.workTreeQuerySchema, { ...query, ref }, "дерево работы");
    return success(history.workTreePageSchema.parse(await (await this.service()).tree(input)));
  }

  @Get("sessions/:ref/history")
  @ApiParam(sessionParameter)
  @ApiEndpoint({
    id: "getWorkSessionHistory",
    summary: history.workHistoryQuerySchema.description!,
    query: "WorkHistoryQuery",
    response: "WorkHistoryPage",
  })
  async sessionHistory(
    @Param("ref") ref: string,
    @Query(new WorkHistoryQueryPipe(workSessionHistoryHttpQuerySchema))
    query: Omit<history.WorkHistoryQuery, "ref">,
  ) {
    const input = parse(history.workHistoryQuerySchema, { ...query, ref }, "история ветки");
    return success(
      history.workHistoryPageSchema.parse(await (await this.service()).history(input)),
    );
  }

  @Get("history")
  @ApiEndpoint({
    id: "getWorkHistory",
    summary: "Прочитать страницу истории всего выбранного проекта",
    query: "WorkHistoryQuery",
    response: "WorkHistoryPage",
  })
  async history(
    @Query(new WorkHistoryQueryPipe(workSessionHistoryHttpQuerySchema))
    input: Omit<history.WorkHistoryQuery, "ref">,
  ) {
    return success(
      history.workHistoryPageSchema.parse(await (await this.service()).history(input)),
    );
  }

  @Get("sessions/:ref/context")
  @ApiParam(sessionParameter)
  @ApiEndpoint({
    id: "getWorkSessionContext",
    summary: history.workContextQuerySchema.description!,
    query: "WorkHistoryPageQuery",
    response: "WorkContext",
  })
  async context(
    @Param("ref") ref: string,
    @Query(new WorkHistoryQueryPipe(history.workHistoryPageQuerySchema))
    query: history.WorkHistoryPageQuery,
  ) {
    const input = parse(history.workContextQuerySchema, { ...query, ref }, "контекст ветки");
    return success(history.workContextSchema.parse(await (await this.service()).context(input)));
  }

  @Get("sessions/:ref/intents")
  @ApiParam(sessionParameter)
  @ApiEndpoint({
    id: "getWorkSessionOpenIntents",
    summary: history.workOpenIntentsQuerySchema.description!,
    query: "WorkOpenIntentsQuery",
    response: "WorkOpenIntentsPage",
  })
  async openIntents(
    @Param("ref") ref: string,
    @Query(new WorkHistoryQueryPipe(workOpenIntentsHttpQuerySchema))
    query: Omit<history.WorkOpenIntentsQuery, "ref">,
  ) {
    const input = parse(
      history.workOpenIntentsQuerySchema,
      { ...query, ref },
      "открытые намерения",
    );
    return success(
      history.workOpenIntentsPageSchema.parse(await (await this.service()).openIntents(input)),
    );
  }

  @Get("checkpoints/:ref")
  @ApiParam(checkpointParameter)
  @ApiEndpoint({
    id: "getWorkCheckpoint",
    summary: history.workCheckpointQuerySchema.description!,
    response: "WorkCheckpoint",
  })
  async checkpoint(@Param("ref") ref: string) {
    const input = parse(history.workCheckpointQuerySchema, { ref }, "точка работы");
    return success(
      history.workCheckpointSchema.parse(await (await this.service()).checkpoint(input)),
    );
  }

  @Post("sessions/start")
  @HttpCode(200)
  @ApiEndpoint({
    id: "startWorkSession",
    summary: history.workSessionStartSchema.description!,
    body: "WorkSessionStart",
    response: "WorkHistoryMutation",
  })
  async start(
    @Body(new ZodValidationPipe(history.workSessionStartSchema)) input: history.WorkSessionStart,
  ) {
    return this.changed((service) => service.start(input, this.workspace.actor()));
  }

  @Post("sessions/fork")
  @HttpCode(200)
  @ApiEndpoint({
    id: "forkWorkSession",
    summary: history.workSessionForkSchema.description!,
    body: "WorkSessionFork",
    response: "WorkHistoryMutation",
  })
  async fork(
    @Body(new ZodValidationPipe(history.workSessionForkSchema)) input: history.WorkSessionFork,
  ) {
    return this.changed((service) => service.fork(input, this.workspace.actor()));
  }

  @Post("sessions/attach")
  @HttpCode(200)
  @ApiEndpoint({
    id: "attachWorkSession",
    summary: history.workSessionAttachSchema.description!,
    body: "WorkSessionAttach",
    response: "WorkHistoryMutation",
  })
  async attach(
    @Body(new ZodValidationPipe(history.workSessionAttachSchema)) input: history.WorkSessionAttach,
  ) {
    return this.changed((service) => service.attach(input, this.workspace.actor()));
  }

  @Post("sessions/pause")
  @HttpCode(200)
  @ApiEndpoint({
    id: "pauseWorkSession",
    summary: history.workSessionPauseSchema.description!,
    body: "WorkSessionPause",
    response: "WorkHistoryMutation",
  })
  async pause(
    @Body(new ZodValidationPipe(history.workSessionPauseSchema)) input: history.WorkSessionPause,
  ) {
    return this.changed((service) => service.pause(input, this.workspace.actor()));
  }

  @Post("sessions/resume")
  @HttpCode(200)
  @ApiEndpoint({
    id: "resumeWorkSession",
    summary: history.workSessionResumeSchema.description!,
    body: "WorkSessionResume",
    response: "WorkHistoryMutation",
  })
  async resume(
    @Body(new ZodValidationPipe(history.workSessionResumeSchema)) input: history.WorkSessionResume,
  ) {
    return this.changed((service) => service.resume(input, this.workspace.actor()));
  }

  @Post("sessions/takeover")
  @HttpCode(200)
  @ApiEndpoint({
    id: "takeoverWorkSession",
    summary: history.workSessionTakeoverSchema.description!,
    body: "WorkSessionTakeover",
    response: "WorkHistoryMutation",
  })
  async takeover(
    @Body(new ZodValidationPipe(history.workSessionTakeoverSchema))
    input: history.WorkSessionTakeover,
  ) {
    return this.changed((service) => service.takeover(input, this.workspace.actor()));
  }

  @Post("sessions/complete")
  @HttpCode(200)
  @ApiEndpoint({
    id: "completeWorkSession",
    summary: history.workSessionCompleteSchema.description!,
    body: "WorkSessionComplete",
    response: "WorkHistoryMutation",
  })
  async complete(
    @Body(new ZodValidationPipe(history.workSessionCompleteSchema))
    input: history.WorkSessionComplete,
  ) {
    return this.changed((service) => service.complete(input, this.workspace.actor()));
  }

  @Post("sessions/cancel")
  @HttpCode(200)
  @ApiEndpoint({
    id: "cancelWorkSession",
    summary: history.workSessionCancelSchema.description!,
    body: "WorkSessionCancel",
    response: "WorkHistoryMutation",
  })
  async cancel(
    @Body(new ZodValidationPipe(history.workSessionCancelSchema)) input: history.WorkSessionCancel,
  ) {
    return this.changed((service) => service.cancel(input, this.workspace.actor()));
  }

  @Post("checkpoints/open")
  @HttpCode(200)
  @ApiEndpoint({
    id: "openWorkCheckpoint",
    summary: history.workCheckpointOpenSchema.description!,
    body: "WorkCheckpointOpen",
    response: "WorkHistoryMutation",
  })
  async openCheckpoint(
    @Body(new ZodValidationPipe(history.workCheckpointOpenSchema))
    input: history.WorkCheckpointOpen,
  ) {
    return this.changed((service) => service.openCheckpoint(input, this.workspace.actor()));
  }

  @Post("checkpoints/save")
  @HttpCode(200)
  @ApiEndpoint({
    id: "saveWorkCheckpoint",
    summary: history.workCheckpointSaveSchema.description!,
    body: "WorkCheckpointSave",
    response: "WorkHistoryMutation",
  })
  async saveCheckpoint(
    @Body(new ZodValidationPipe(history.workCheckpointSaveSchema))
    input: history.WorkCheckpointSave,
  ) {
    return this.changed((service) => service.saveCheckpoint(input, this.workspace.actor()));
  }

  @Post("checkpoints/complete")
  @HttpCode(200)
  @ApiEndpoint({
    id: "completeWorkCheckpoint",
    summary: history.workCheckpointCompleteSchema.description!,
    body: "WorkCheckpointComplete",
    response: "WorkHistoryMutation",
  })
  async completeCheckpoint(
    @Body(new ZodValidationPipe(history.workCheckpointCompleteSchema))
    input: history.WorkCheckpointComplete,
  ) {
    return this.changed((service) => service.completeCheckpoint(input, this.workspace.actor()));
  }

  @Post("checkpoints/cancel")
  @HttpCode(200)
  @ApiEndpoint({
    id: "cancelWorkCheckpoint",
    summary: history.workCheckpointCancelSchema.description!,
    body: "WorkCheckpointCancel",
    response: "WorkHistoryMutation",
  })
  async cancelCheckpoint(
    @Body(new ZodValidationPipe(history.workCheckpointCancelSchema))
    input: history.WorkCheckpointCancel,
  ) {
    return this.changed((service) => service.cancelCheckpoint(input, this.workspace.actor()));
  }
}

@Module({
  imports: [EventsModule],
  controllers: [WorkHistoryController, WorkHistoryGraphController],
})
export class WorkHistoryModule {}
