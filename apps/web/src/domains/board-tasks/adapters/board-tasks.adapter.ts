import { z } from "zod";
import { getProjectApi, ApiError } from "infra/tasks-api";
import {
  GOAL_PROGRESS_SCHEMA,
  GOAL_ADDRESS_SCHEMA,
  APPLICATION_BOARD_SCHEMA,
  APPLICATION_PROGRESS_SCHEMA,
  TASK_EXECUTION_SCHEMA,
} from "../config/progress.schema";
import { progressSourcePath } from "../helpers/progress-source-path";
import { CRITERIA_PAGE_SCHEMA, CRITERION_VIEW_SCHEMA } from "../config/acceptance.schema";
import {
  ACTIVITY_PAGE_SCHEMA,
  ACTIVITY_EVENT_SCHEMA,
  COMMENT_SAVED_SCHEMA,
} from "../config/activity.schema";
import type {
  ActivityPage,
  ActivityEvent,
  CommentSaved,
  PublishCommentInput,
} from "../types/activity.type";
import type { CriteriaPage, CriterionView, ChangeCriterionInput } from "../types/acceptance.type";
import {
  BOARD_TASK_SCHEMA,
  TASKS_PAGE_SCHEMA,
  LINKS_PAGE_SCHEMA,
  TASK_SAVED_SCHEMA,
} from "../config/board-tasks.schema";
import type {
  BoardTask,
  TasksPage,
  TaskLinksPage,
  TaskSaved,
  TaskFilters,
  CreateTaskInput,
  EditTaskInput,
  ProductGoalProgress,
  TaskExecutionProgress,
  ApplicationTaskProgress,
  MoveTaskInput,
  LinkTaskInput,
} from "../types/board-tasks.type";

/** Ожидаемый отказ операции канбана, пригодный для показа рядом с сохранённым вводом. */
export class BoardTaskError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
const failure = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
/**
 * Читает страницу стабильного снимка обсуждения задачи.
 */
export const getTaskComments = (
  project: string,
  reference: string,
  cursor?: string,
): Promise<ActivityPage> => {
  const api = getProjectApi(project).kanban;
  return request(() => api.getTaskComments({ reference, cursor, limit: 20 }), ACTIVITY_PAGE_SCHEMA);
};
/**
 * Читает полный Markdown одного комментария.
 */
export const getTaskComment = (
  project: string,
  reference: string,
  entryId: string,
): Promise<ActivityEvent> =>
  request(
    () => getProjectApi(project).kanban.getTaskComment({ reference, entryId }),
    ACTIVITY_EVENT_SCHEMA,
  );
/**
 * Публикует сообщение Web только от имени Оператор.
 */
export const publishTaskComment = (
  project: string,
  reference: string,
  input: PublishCommentInput,
): Promise<CommentSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.publishTaskComment(
        { reference },
        { ...input, actor: "Оператор", actorRole: "operator" },
      ),
    COMMENT_SAVED_SCHEMA,
  );
/**
 * Читает текущий ограниченный объём списка без Markdown.
 */
export const getTaskCriteria = (
  project: string,
  reference: string,
  limit = 20,
): Promise<CriteriaPage> =>
  request(
    () => getProjectApi(project).kanban.getTaskCriteria({ reference, limit }),
    CRITERIA_PAGE_SCHEMA,
  );
/**
 * Читает полное содержание выбранного критерия.
 */
export const getTaskCriterion = (
  project: string,
  reference: string,
  criterionId: string,
): Promise<CriterionView> =>
  request(
    () => getProjectApi(project).kanban.getTaskCriterion({ reference, criterionId }),
    CRITERION_VIEW_SCHEMA,
  );
/**
 * Изменяет критерий через общие правила Core.
 */
export const changeTaskCriterion = (
  project: string,
  reference: string,
  input: ChangeCriterionInput,
): Promise<TaskSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.changeTaskCriterion(
        { reference },
        { ...input, actor: "Оператор" },
      ),
    TASK_SAVED_SCHEMA,
  );
async function request<T>(
  operation: () => Promise<{ data: unknown }>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return schema.parse((await operation()).data);
  } catch (error) {
    if (error instanceof ApiError) {
      const parsed = failure.safeParse(error.error);
      if (parsed.success)
        throw new BoardTaskError(parsed.data.error.message, parsed.data.error.code);
      throw new BoardTaskError(
        "Сервер не подтвердил действие. Проверьте соединение и повторите запрос.",
        "UNAVAILABLE",
      );
    }
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw new BoardTaskError(
        "Не удалось связаться с сервером. Ввод сохранён; повторите после восстановления соединения.",
        "UNAVAILABLE",
      );
    throw error;
  }
}
export const listBoardTasks = (
  project: string,
  filters: TaskFilters,
  offset = 0,
  version?: string,
  limit = 40,
): Promise<TasksPage> =>
  request(
    () => getProjectApi(project).kanban.getBoardTasks({ ...filters, offset, limit, version }),
    TASKS_PAGE_SCHEMA,
  );

/**
 * Читает полные счётчики на одной версии без выгрузки всех задач.
 */
export const getProductTaskProgress = async (
  project: string,
  targetId: string,
  offset = 0,
  version?: string,
): Promise<ProductGoalProgress> => {
  const api = getProjectApi(project);
  const goal = await request(
    () => api.entities.resolveEntity({ ref: targetId }),
    GOAL_ADDRESS_SCHEMA,
  );
  const operations = {
    feature: api.progress.getFeatureProgress,
    scenario: api.progress.getScenarioProgress,
    implementation: api.progress.getImplementationProgress,
  };
  const progress = await request(
    () => operations[goal.ref.kind]({ ref: goal.ref.id, offset, version, limit: 20 }),
    GOAL_PROGRESS_SCHEMA,
  );
  return {
    ...progress.counts,
    isComplete: progress.completed,
    version: progress.version,
    nextOffset: progress.reasons.nextOffset,
    reasonCount: progress.reasons.total,
    reasons: progress.reasons.items.map((reason) => ({
      message: reason.message,
      path: progressSourcePath(reason.source),
    })),
  };
};

/**
 * Читает фактическое выполнение задачи и ограниченную страницу причин с адресами.
 */
export const getTaskExecutionProgress = async (
  project: string,
  reference: string,
  offset = 0,
  version?: string,
): Promise<TaskExecutionProgress> => {
  const progress = await request(
    () =>
      getProjectApi(project).progress.getTaskProgress({
        ref: reference,
        offset,
        version,
        limit: 20,
      }),
    TASK_EXECUTION_SCHEMA,
  );
  return {
    planning: progress.planning ?? null,
    isComplete: progress.completed,
    version: progress.version,
    nextOffset: progress.reasons.nextOffset,
    reasonCount: progress.reasons.total,
    reasons: progress.reasons.items.map((reason) => ({
      message: reason.message,
      path: progressSourcePath(reason.source),
    })),
  };
};

/**
 * Получает полные показатели приложения с сервера, не восстанавливает выполнение по колонкам.
 */
export const getApplicationTaskProgress = async (
  project: string,
  board: string,
): Promise<ApplicationTaskProgress> => {
  const api = getProjectApi(project);
  const owner = await request(
    () => api.boards.getBoardBySlug({ slug: board }),
    APPLICATION_BOARD_SCHEMA,
  );
  const progress = await request(
    () => api.progress.getApplicationProgress({ ref: owner.applicationId, limit: 1 }),
    APPLICATION_PROGRESS_SCHEMA,
  );
  return { business: progress.businessTasks, overall: progress.allTasks };
};

/** Как на прежней доске: единая согласованная проекция запрошенного объёма, с ограниченным повтором версии. */
export const getBoardTaskSlice = async (
  project: string,
  filters: TaskFilters,
  count: number,
): Promise<TasksPage> => {
  for (let attempt = 0; ; attempt++) {
    try {
      let page = await listBoardTasks(project, filters, 0, undefined, Math.min(count, 100));
      const items = [...page.items];
      while (page.nextOffset !== null && items.length < count) {
        page = await listBoardTasks(
          project,
          filters,
          page.nextOffset,
          page.version,
          Math.min(count - items.length, 100),
        );
        items.push(...page.items);
      }
      return { ...page, items };
    } catch (error) {
      if (!(error instanceof BoardTaskError) || error.code !== "BOARD_CHANGED" || attempt >= 2)
        throw error;
    }
  }
};
export const getBoardTask = (project: string, reference: string): Promise<BoardTask> =>
  request(() => getProjectApi(project).kanban.getBoardTask({ reference }), BOARD_TASK_SCHEMA);
export const getTaskLinks = (
  project: string,
  reference: string,
  offset = 0,
  version?: string,
): Promise<TaskLinksPage> =>
  request(
    () =>
      getProjectApi(project).kanban.getBoardTaskLinks({ reference, offset, limit: 40, version }),
    LINKS_PAGE_SCHEMA,
  );
export const createBoardTask = (project: string, input: CreateTaskInput): Promise<TaskSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.createBoardTask({
        ...input,
        includeTask: true,
        actor: "Оператор",
      }),
    TASK_SAVED_SCHEMA,
  );
export const updateBoardTask = (
  project: string,
  reference: string,
  input: EditTaskInput,
): Promise<TaskSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.updateBoardTask({ reference }, { ...input, actor: "Оператор" }),
    TASK_SAVED_SCHEMA,
  );
export const moveBoardTask = (
  project: string,
  reference: string,
  input: MoveTaskInput,
): Promise<TaskSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.moveBoardTask({ reference }, { ...input, actor: "Оператор" }),
    TASK_SAVED_SCHEMA,
  );
export const linkBoardTask = (
  project: string,
  reference: string,
  input: LinkTaskInput,
): Promise<TaskSaved> =>
  request(
    () =>
      getProjectApi(project).kanban.linkBoardTask({ reference }, { ...input, actor: "Оператор" }),
    TASK_SAVED_SCHEMA,
  );
