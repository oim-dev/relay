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
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import {
  boardTaskReferenceSchema,
  boardTasksQuerySchema,
  createBoardTaskSchema,
  updateBoardTaskSchema,
  moveBoardTaskSchema,
  linkBoardTaskSchema,
  criteriaQuerySchema,
  criterionIdSchema,
  changeCriterionSchema,
  taskCommentsQuerySchema,
  taskActivityIdSchema,
  publishTaskCommentSchema,
} from "@relay/core/domain/board-task";
import type {
  BoardTasksQuery,
  CreateBoardTask,
  UpdateBoardTask,
  MoveBoardTask,
  LinkBoardTask,
  CriteriaQuery,
  ChangeCriterion,
  TaskCommentsQuery,
  PublishTaskComment,
} from "@relay/core/domain/board-task";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";

@ApiTags("kanban")
@Controller("board-tasks")
class BoardTasksController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async write<T>(action: (service: BoardTasksService) => Promise<T>) {
    const workspace = await this.workspace.open();
    const result = await action(new BoardTasksService(workspace));
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get()
  @ApiEndpoint({
    id: "getBoardTasks",
    summary: "Задачи досок проекта с поиском, блокерами и постраничным продолжением",
    response: "BoardTasksPage",
    query: "BoardTasksQuery",
  })
  async list(@Query(new ZodValidationPipe(boardTasksQuerySchema)) query: BoardTasksQuery) {
    return success(await new BoardTasksService(await this.workspace.open()).list(query));
  }

  @Get(":reference")
  @ApiParam({ name: "reference", description: "Постоянный ID или текущий/прежний ключ задачи" })
  @ApiEndpoint({
    id: "getBoardTask",
    summary: "Полная задача с Markdown и вычисляемыми блокерами",
    response: "BoardTaskView",
  })
  async get(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
  ) {
    return success(await new BoardTasksService(await this.workspace.open()).get(reference));
  }

  @Get(":reference/links")
  @ApiParam({ name: "reference", description: "ID или ключ задачи для чтения графа" })
  @ApiEndpoint({
    id: "getBoardTaskLinks",
    summary: "Прямые и обратные связи задач с состояниями и продолжением",
    response: "BoardTaskLinksPage",
    query: "BoardTasksQuery",
  })
  async links(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(boardTasksQuerySchema)) query: BoardTasksQuery,
  ) {
    return success(
      await new BoardTasksService(await this.workspace.open()).links(reference, query),
    );
  }

  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: "createBoardTask",
    summary: "Создать задачу доски; повтор requestId возвращает первоначальную квитанцию",
    response: "BoardTaskSaved",
    body: "CreateBoardTask",
  })
  async create(@Body(new ZodValidationPipe(createBoardTaskSchema)) input: CreateBoardTask) {
    return this.write((service) => service.create(input, this.workspace.actor()));
  }

  @Get(":reference/criteria")
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiEndpoint({
    id: "getTaskCriteria",
    summary: "Критерии приёмки без полного Markdown, по 20 с продолжением",
    response: "CriteriaPage",
    query: "CriteriaQuery",
  })
  async criteria(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(criteriaQuerySchema)) query: CriteriaQuery,
  ) {
    return success(
      await new BoardTasksService(await this.workspace.open()).listCriteria(reference, query),
    );
  }

  @Get(":reference/comments")
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiEndpoint({
    id: "getTaskComments",
    summary: "Сообщения обсуждения без полного Markdown, по 20 с курсором",
    response: "TaskCommentsPage",
    query: "TaskCommentsQuery",
  })
  async comments(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Query(new ZodValidationPipe(taskCommentsQuerySchema)) query: TaskCommentsQuery,
  ) {
    return success(
      await new BoardTasksService(await this.workspace.open()).listComments(reference, query),
    );
  }

  @Get(":reference/comments/:entryId")
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiParam({ name: "entryId", description: "Постоянный номер сообщения в ленте задачи" })
  @ApiEndpoint({
    id: "getTaskComment",
    summary: "Полный Markdown сообщения с автором и временем",
    response: "TaskComment",
  })
  async comment(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Param("entryId", new ZodValidationPipe(taskActivityIdSchema)) entryId: string,
  ) {
    return success(
      await new BoardTasksService(await this.workspace.open()).getComment(reference, entryId),
    );
  }

  @Post(":reference/comments")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiEndpoint({
    id: "publishTaskComment",
    summary:
      "Опубликовать сообщение с заданным автором; безопасный повтор, без конфликта ревизии задачи",
    response: "TaskCommentSaved",
    body: "PublishTaskComment",
  })
  async publishComment(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(publishTaskCommentSchema)) input: PublishTaskComment,
  ) {
    return this.write((service) => service.publishComment(reference, input));
  }

  @Get(":reference/criteria/:criterionId")
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiParam({ name: "criterionId", description: "Постоянный ID критерия приёмки" })
  @ApiEndpoint({
    id: "getTaskCriterion",
    summary: "Полное описание критерия приёмки и ревизия задачи",
    response: "CriterionView",
  })
  async criterion(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Param("criterionId", new ZodValidationPipe(criterionIdSchema)) criterionId: string,
  ) {
    return success(
      await new BoardTasksService(await this.workspace.open()).getCriterion(reference, criterionId),
    );
  }

  @Post(":reference/criteria")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ задачи" })
  @ApiEndpoint({
    id: "changeTaskCriterion",
    summary:
      "Добавить, изменить, удалить или отметить критерий; проверка ревизии и безопасный повтор",
    response: "BoardTaskSaved",
    body: "ChangeCriterion",
  })
  async changeCriterion(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(changeCriterionSchema)) input: ChangeCriterion,
  ) {
    return this.write((service) =>
      service.changeCriterion(reference, input, this.workspace.actor()),
    );
  }

  @Post(":reference/update")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ редактируемой задачи" })
  @ApiEndpoint({
    id: "updateBoardTask",
    summary: "Изменить содержание или продуктовые связи с проверкой ревизии",
    response: "BoardTaskSaved",
    body: "UpdateBoardTask",
  })
  async update(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(updateBoardTaskSchema)) input: UpdateBoardTask,
  ) {
    return this.write((service) => service.update(reference, input, this.workspace.actor()));
  }

  @Post(":reference/move")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ перемещаемой задачи" })
  @ApiEndpoint({
    id: "moveBoardTask",
    summary: "Изменить колонку, порядок или доску; ID сохраняется, ключ меняется при переносе",
    response: "BoardTaskSaved",
    body: "MoveBoardTask",
  })
  async move(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(moveBoardTaskSchema)) input: MoveBoardTask,
  ) {
    return this.write((service) => service.move(reference, input, this.workspace.actor()));
  }

  @Post(":reference/links")
  @HttpCode(200)
  @ApiParam({ name: "reference", description: "ID или ключ исходной задачи" })
  @ApiEndpoint({
    id: "linkBoardTask",
    summary: "Добавить или удалить связь, зависимость либо родителя; циклы запрещены",
    response: "BoardTaskSaved",
    body: "LinkBoardTask",
  })
  async link(
    @Param("reference", new ZodValidationPipe(boardTaskReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(linkBoardTaskSchema)) input: LinkBoardTask,
  ) {
    return this.write((service) => service.link(reference, input, this.workspace.actor()));
  }
}

@Module({ imports: [EventsModule], controllers: [BoardTasksController] })
export class BoardTasksModule {}
