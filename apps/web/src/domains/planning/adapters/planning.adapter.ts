import { z } from "zod";
import {
  plansPageSchema,
  planSummarySchema,
  stagesPageSchema,
  planningTasksPageSchema,
  planningCandidatesPageSchema,
  planningSavedSchema,
  planningScopeSchema,
  createPlanSchema,
  updatePlanSchema,
  changeStageSchema,
  changePlanTasksSchema,
  transitionPlanSchema,
  transferPlanTaskSchema,
} from "@relay/contracts/planning";
import { getProjectApi, ApiError, readApiPages } from "infra/tasks-api";
import { planningView, stageView, planningTaskView } from "../helpers/planning-view";
import type {
  PlanningPlan,
  PlanStage,
  PlanningTask,
  PlanningPage,
  PlanFilters,
  PlanningTaskFilters,
} from "../types/planning.type";

const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
/** Предусмотренный отказ планирования с сохранением ввода. */
export class PlanningError extends Error {
  /**
   * Сохраняет машинный код для отличения неизвестной записи и конфликта.
   */
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Валидирует ответ и различает недоступность чтения и неподтверждённую запись.
 */
const request = async <Result>(
  schema: z.ZodType<Result>,
  operation: () => Promise<{ data: unknown }>,
  isWrite = false,
): Promise<Result> => {
  try {
    return schema.parse((await operation()).data);
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = FAILURE_SCHEMA.safeParse(error.error);
      if (failure.success && error.status < 500)
        throw new PlanningError(failure.data.error.message, failure.data.error.code);
    }
    if (
      error instanceof TypeError ||
      (error instanceof ApiError && error.status >= 500) ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw new PlanningError(
        isWrite
          ? "Исход сохранения неизвестен. Ввод сохранён. Перечитайте состояние перед новой отправкой: повтор может создать дубликат."
          : "Не удалось загрузить данные планирования. Проверьте соединение и повторите загрузку.",
        "UNAVAILABLE",
      );
    throw error;
  }
};

/**
 * Читает запрошенную порцию каталога, сохраняя полные счётчики состояний.
 */
export const getPlans = async (
  project: string,
  filters: PlanFilters,
  count = 12,
): Promise<PlanningPage<PlanningPlan> & { statusCounts: Record<string, number> }> => {
  const page = await readApiPages(count, (offset, limit, version) =>
    request(plansPageSchema, () =>
      getProjectApi(project).plans.getPlans({
        ...filters,
        offset,
        limit,
        ...(version === undefined ? {} : { version }),
      }),
    ),
  );
  return { ...page, items: page.items.map(planningView) };
};

/**
 * Читает план отдельно от каталога и вложенных страниц.
 */
export const getPlan = async (project: string, reference: string): Promise<PlanningPlan> =>
  planningView(
    await request(planSummarySchema, () => getProjectApi(project).plans.getPlan({ reference })),
  );

/**
 * Получает только раскрытый объём этапов.
 */
export const getPlanStages = async (
  project: string,
  reference: string,
  count = 12,
): Promise<PlanningPage<PlanStage> & { planRevision: number }> => {
  const page = await readApiPages(count, (offset, limit, version) =>
    request(stagesPageSchema, () =>
      getProjectApi(project).plans.getPlanStages({
        reference,
        offset,
        limit,
        ...(version === undefined ? {} : { version }),
      }),
    ),
  );
  return { ...page, items: page.items.map(stageView) };
};

/**
 * Получает актуальные карточки задач одного этапа с независимым продолжением.
 */
export const getPlanStageTasks = async (
  project: string,
  reference: string,
  stage: string,
  count = 12,
): Promise<PlanningPage<PlanningTask>> => {
  const page = await readApiPages(count, (offset, limit, version) =>
    request(planningTasksPageSchema, () =>
      getProjectApi(project).plans.getPlanStageTasks({
        reference,
        stage,
        offset,
        limit,
        ...(version === undefined ? {} : { version }),
      }),
    ),
  );
  return {
    ...page,
    items: page.items.map((task) => planningTaskView({ ...task, assignment: null })),
  };
};

/**
 * Применяет поиск, доску и доступность на сервере до пагинации.
 */
export const getPlanningCandidates = async (
  project: string,
  filters: PlanningTaskFilters,
  count = 12,
): Promise<PlanningPage<PlanningTask>> => {
  const { isAvailableOnly, ...query } = filters;
  const page = await readApiPages(count, (offset, limit, version) =>
    request(planningCandidatesPageSchema, () =>
      getProjectApi(project).plans.getPlanningCandidates({
        ...query,
        availableOnly: isAvailableOnly ? "true" : "false",
        offset,
        limit,
        ...(version === undefined ? {} : { version }),
      }),
    ),
  );
  return { ...page, items: page.items.map(planningTaskView) };
};

/** Квитанция успешного предметного действия. */
export type PlanningSaved = z.infer<typeof planningSavedSchema>;

/**
 * Сохраняет форму по её исходной ревизии без автоматического повтора.
 */
export const savePlan = async (project: string, plan: PlanningPlan): Promise<PlanningSaved> => {
  const fields = {
    title: plan.title,
    summary: plan.summary,
    goal: plan.goal,
    rationale: plan.rationale,
    boundaries: plan.boundaries,
    expectedResult: plan.expectedResult,
    participants: plan.participants,
    scope: plan.scope.map((value) => {
      const [kind, id] = value.split(":");
      return planningScopeSchema.parse({ kind, id });
    }),
    actor: "Оператор",
  };
  const isNew = plan.revision === 0;
  const payload = { ...fields, ...(isNew ? {} : { ifRevision: plan.revision }) };
  const requestId = crypto.randomUUID();
  return request(
    planningSavedSchema,
    () =>
      isNew
        ? getProjectApi(project).plans.createPlan(createPlanSchema.parse({ ...payload, requestId }))
        : getProjectApi(project).plans.updatePlan(
            { reference: plan.id },
            updatePlanSchema.parse({ ...payload, requestId }),
          ),
    true,
  );
};

/**
 * Изменяет содержание или положение одного этапа, сохраняя остальные страницы.
 */
export const changePlanStage = async (
  project: string,
  planId: string,
  revision: number,
  action: "create" | "update" | "remove" | "move",
  stage: PlanStage,
  before?: string | null,
  direction?: "up" | "down",
): Promise<PlanningSaved> => {
  const payload = {
    actor: "Оператор",
    ifRevision: revision,
    action,
    ...(action === "create" ? {} : { stage: stage.id }),
    ...(action === "create" || action === "update"
      ? {
          fields: {
            title: stage.title,
            summary: stage.summary,
            outcome: stage.outcome,
            completionConditions: stage.completionConditions,
          },
        }
      : {}),
    ...(action === "move"
      ? direction === undefined
        ? { before: before ?? null }
        : { direction }
      : {}),
  };
  return request(
    planningSavedSchema,
    () =>
      getProjectApi(project).plans.changePlanStage(
        { reference: planId },
        changeStageSchema.parse({ ...payload, requestId: crypto.randomUUID() }),
      ),
    true,
  );
};

/**
 * Применяет разницу полного выбора, не удаляя скрытые поиском включения.
 */
export const changePlanTasks = async (
  project: string,
  planId: string,
  revision: number,
  stage: PlanStage,
  selectedIds: string[],
): Promise<PlanningSaved | null> => {
  const add = selectedIds.filter((id) => !stage.taskIds.includes(id));
  const remove = stage.taskIds.filter((id) => !selectedIds.includes(id));
  if (add.length + remove.length === 0) return null;
  const payload = { actor: "Оператор", ifRevision: revision, stage: stage.id, add, remove };
  return request(
    planningSavedSchema,
    () =>
      getProjectApi(project).plans.changePlanTasks(
        { reference: planId },
        changePlanTasksSchema.parse({ ...payload, requestId: crypto.randomUUID() }),
      ),
    true,
  );
};

/**
 * Выполняет явный переход; сервер повторно проверяет готовность под блокировкой.
 */
export const transitionPlan = async (
  project: string,
  planId: string,
  revision: number,
  action: "start" | "complete" | "cancel",
  result = "",
): Promise<PlanningSaved> => {
  const payload = { actor: "Оператор", ifRevision: revision, action, result };
  return request(
    planningSavedSchema,
    () =>
      getProjectApi(project).plans.transitionPlan(
        { reference: planId },
        transitionPlanSchema.parse({ ...payload, requestId: crypto.randomUUID() }),
      ),
    true,
  );
};

/**
 * Переносит существующую задачу с ревизиями обеих сторон и причиной.
 */
export const transferPlanTask = async (
  project: string,
  source: PlanningPlan,
  target: PlanningPlan,
  task: string,
  targetStage: string,
  reason: string,
): Promise<PlanningSaved> => {
  const payload = {
    actor: "Оператор",
    ifRevision: source.revision,
    targetRevision: target.revision,
    targetPlan: target.id,
    task,
    targetStage,
    reason,
  };
  return request(
    planningSavedSchema,
    () =>
      getProjectApi(project).plans.transferPlanTask(
        { reference: source.id },
        transferPlanTaskSchema.parse({ ...payload, requestId: crypto.randomUUID() }),
      ),
    true,
  );
};
