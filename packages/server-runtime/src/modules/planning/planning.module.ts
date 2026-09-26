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
import {
  plansQuerySchema,
  planningPageQuerySchema,
  createPlanSchema,
  updatePlanSchema,
  transitionPlanSchema,
  changeStageSchema,
  changePlanTasksSchema,
  transferPlanTaskSchema,
  planningCandidatesQuerySchema,
} from "@relay/contracts/planning";
import type {
  PlansQuery,
  PlanningPageQuery,
  CreatePlan,
  UpdatePlan,
  TransitionPlan,
  ChangeStage,
  ChangePlanTasks,
  TransferPlanTask,
  PlanningCandidatesQuery,
} from "@relay/contracts/planning";
import { PlanningService } from "@relay/core/application/planning/service";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";

@ApiTags("plans")
@Controller("plans")
class PlanningController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}
  private async write<T>(operation: (service: PlanningService, actor: string) => Promise<T>) {
    const workspace = await this.workspace.open();
    const result = await operation(new PlanningService(workspace), this.workspace.actor());
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }
  @Get()
  @ApiEndpoint({
    id: "getPlans",
    summary: "Каталог планов с полным прогрессом, поиском и продолжением",
    query: "PlansQuery",
    response: "PlansPage",
  })
  async list(@Query(new ZodValidationPipe(plansQuerySchema)) query: PlansQuery) {
    return success(await new PlanningService(await this.workspace.open()).list(query));
  }
  @Get("task-memberships/:reference")
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiEndpoint({
    id: "getTaskPlanMemberships",
    summary: "Текущее участие задачи в планах",
    query: "PlanningPageQuery",
    response: "PlanMemberships",
  })
  async memberships(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(planningPageQuerySchema)) query: PlanningPageQuery,
  ) {
    return success(
      await new PlanningService(await this.workspace.open()).memberships(reference, query),
    );
  }
  @Get("task-candidates")
  @ApiEndpoint({
    id: "getPlanningCandidates",
    summary: "Найти задачи для этапа с текущей принадлежностью и серверной фильтрацией доступности",
    query: "PlanningCandidatesQuery",
    response: "PlanningCandidatesPage",
  })
  async candidates(
    @Query(new ZodValidationPipe(planningCandidatesQuerySchema)) query: PlanningCandidatesQuery,
  ) {
    return success(await new PlanningService(await this.workspace.open()).candidates(query));
  }
  @Get(":reference")
  @ApiParam({ name: "reference", description: "ID или ключ плана работ" })
  @ApiEndpoint({
    id: "getPlan",
    summary: "Содержание плана и полные показатели состава",
    response: "PlanSummary",
  })
  async get(@Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string) {
    return success(await new PlanningService(await this.workspace.open()).get(reference));
  }
  @Get(":reference/stages")
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiEndpoint({
    id: "getPlanStages",
    summary: "Этапы плана в предметном порядке с полным прогрессом",
    query: "PlanningPageQuery",
    response: "StagesPage",
  })
  async stages(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(planningPageQuerySchema)) query: PlanningPageQuery,
  ) {
    return success(await new PlanningService(await this.workspace.open()).stages(reference, query));
  }
  @Get(":reference/stages/:stage/tasks")
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiParam({ name: "stage", description: "Внутренний ID этапа этого плана" })
  @ApiEndpoint({
    id: "getPlanStageTasks",
    summary: "Страница актуальных задач этапа; описание задачи читается адресно",
    query: "PlanningPageQuery",
    response: "PlanningTasksPage",
  })
  async tasks(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Param("stage", new ZodValidationPipe(entityReferenceSchema)) stage: string,
    @Query(new ZodValidationPipe(planningPageQuerySchema)) query: PlanningPageQuery,
  ) {
    return success(
      await new PlanningService(await this.workspace.open()).tasks(reference, stage, query),
    );
  }
  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: "createPlan",
    summary: "Создать черновик плана и атомарно согласовать его связи",
    body: "CreatePlan",
    response: "PlanningSaved",
  })
  async create(@Body(new ZodValidationPipe(createPlanSchema)) input: CreatePlan) {
    return this.write((service, actor) => service.create(input, actor));
  }
  @Post(":reference/update")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiEndpoint({
    id: "updatePlan",
    summary: "Изменить только заданные поля плана с проверкой ревизии",
    body: "UpdatePlan",
    response: "PlanningSaved",
  })
  async update(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) input: UpdatePlan,
  ) {
    return this.write((service, actor) => service.update(reference, input, actor));
  }
  @Post(":reference/transition")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiEndpoint({
    id: "transitionPlan",
    summary: "Начать, завершить с итогом или отменить план; готовность повторно проверяется Core",
    body: "TransitionPlan",
    response: "PlanningSaved",
  })
  async transition(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(transitionPlanSchema)) input: TransitionPlan,
  ) {
    return this.write((service, actor) => service.transition(reference, input, actor));
  }
  @Post(":reference/stages")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiEndpoint({
    id: "changePlanStage",
    summary:
      "Создать, изменить, удалить пустой этап или переместить его относительно полного списка",
    body: "ChangePlanStage",
    response: "PlanningSaved",
  })
  async stage(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(changeStageSchema)) input: ChangeStage,
  ) {
    return this.write((service, actor) => service.changeStage(reference, input, actor));
  }
  @Post(":reference/tasks")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ плана" })
  @ApiEndpoint({
    id: "changePlanTasks",
    summary: "Включить или исключить задачи этапа; незатронутые включения сохраняются",
    body: "ChangePlanTasks",
    response: "PlanningSaved",
  })
  async tasksChange(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(changePlanTasksSchema)) input: ChangePlanTasks,
  ) {
    return this.write((service, actor) => service.changeTasks(reference, input, actor));
  }
  @Post(":reference/transfer")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ исходного плана" })
  @ApiEndpoint({
    id: "transferPlanTask",
    summary: "Перенести задачу с причиной и проверкой ревизий обоих планов",
    body: "TransferPlanTask",
    response: "PlanningSaved",
  })
  async transfer(
    @Param("reference", new ZodValidationPipe(entityReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(transferPlanTaskSchema)) input: TransferPlanTask,
  ) {
    return this.write((service, actor) => service.transfer(reference, input, actor));
  }
}
@Module({ imports: [EventsModule], controllers: [PlanningController] })
export class PlanningModule {}
