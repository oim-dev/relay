import { z } from "zod";
import {
  actorSchema,
  entityReferenceSchema,
  requestIdSchema,
  singleLine,
  text,
  timestampSchema,
} from "./primitives.js";
import { boardTaskSummarySchema } from "./entities/board-task.js";

/** Постоянные предметные данные планирования; транспорт передаёт Markdown строками. */
export const planStatusSchema = z
  .enum(["draft", "active", "completed", "cancelled"])
  .describe("Состояние плана: черновик, в работе, завершён или отменён");
export const planningIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe("Постоянный ID записи выбранного проекта");
export const planningScopeSchema = z.strictObject({
  kind: z
    .enum(["project", "product", "application", "feature", "scenario", "implementation"])
    .describe("Вид области воздействия; не является целью реализации задачи"),
  id: planningIdSchema,
});
export const workPlanFieldsSchema = z.strictObject({
  title: singleLine(160).describe("Однострочное название плана"),
  summary: text(16 * 1024)
    .default("")
    .describe("Краткое описание обычным многострочным текстом"),
  goal: text(256 * 1024)
    .default("")
    .describe("Цель плана в Markdown"),
  rationale: text(256 * 1024)
    .default("")
    .describe("Обоснование начала работы в Markdown"),
  boundaries: text(256 * 1024)
    .default("")
    .describe("Границы изменения в Markdown"),
  expectedResult: text(256 * 1024)
    .default("")
    .describe("Ожидаемый результат в Markdown"),
  scope: z
    .array(planningScopeSchema)
    .max(100)
    .default([])
    .describe("Области воздействия по постоянным адресам"),
  participants: z
    .array(actorSchema)
    .max(100)
    .default([])
    .describe("Участники плана; не определяют права исполнения"),
});
export const stageFieldsSchema = z.strictObject({
  title: singleLine(160).describe("Однострочное название этапа"),
  summary: text(16 * 1024)
    .default("")
    .describe("Краткое описание этапа обычным текстом"),
  outcome: text(256 * 1024)
    .default("")
    .describe("Ожидаемый результат этапа в Markdown"),
  completionConditions: text(256 * 1024)
    .default("")
    .describe("Условия завершения в Markdown; не исполняемая формула"),
});
// Отсутствующие поля изменения не получают значения по умолчанию создания.
export const stageChangesSchema = z.strictObject({
  title: stageFieldsSchema.shape.title.optional(),
  summary: stageFieldsSchema.shape.summary
    .removeDefault()
    .optional()
    .describe("Новое краткое описание обычным текстом; пустая строка очищает поле"),
  outcome: stageFieldsSchema.shape.outcome
    .removeDefault()
    .optional()
    .describe("Новый ожидаемый результат в Markdown; пустая строка очищает поле"),
  completionConditions: stageFieldsSchema.shape.completionConditions
    .removeDefault()
    .optional()
    .describe("Новые условия завершения в Markdown; пустая строка очищает поле"),
});
export const planStageSchema = stageFieldsSchema.extend({
  id: planningIdSchema.describe("Внутренний ID этапа в плане; не ключ сущности"),
  taskIds: z
    .array(planningIdSchema)
    .max(2000)
    .describe("Только явно выбранные ID задач; потомки автоматически не записываются"),
});
export const workPlanDataSchema = workPlanFieldsSchema.extend({
  kind: z.literal("work-plan").describe("План работ"),
  projectId: planningIdSchema.describe("Постоянный ID проекта-владельца"),
  stages: z.array(planStageSchema).max(200).describe("Этапы внутри плана в порядке отображения"),
  status: planStatusSchema,
  result: text(256 * 1024).describe("Итог завершения либо причина отмены в Markdown"),
  startedAt: timestampSchema.nullable().describe("Фактическое время начала либо null"),
  closedAt: timestampSchema.nullable().describe("Фактическое время закрытия либо null"),
});
export const planningMetadata = {
  id: planningIdSchema,
  key: z.string().describe("Читаемый ключ записи"),
  revision: z.number().int().positive().describe("Ревизия записи"),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema,
  updatedBy: actorSchema,
};
export const workPlanSchema = workPlanDataSchema.extend(planningMetadata);
export const planningCountsSchema = z.strictObject({
  total: z.number().int().nonnegative().describe("Все уникальные задачи собственного состава"),
  completed: z
    .number()
    .int()
    .nonnegative()
    .describe("Фактически выполненные задачи с учётом обязательств"),
  active: z.number().int().nonnegative().describe("Задачи в колонке in-progress"),
  review: z.number().int().nonnegative().describe("Задачи в колонке review"),
  blocked: z
    .number()
    .int()
    .nonnegative()
    .describe("Задачи с невыполненными внешними или дочерними обязательствами"),
  percent: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Процент фактического выполнения; пустой состав — 0"),
});
export const planningPageQuerySchema = z.strictObject({
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение страницы"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(12)
    .describe("Размер страницы: 12 по умолчанию, максимум 100"),
  version: z
    .string()
    .max(128)
    .optional()
    .describe("Версия первой страницы; обязательна для продолжения"),
});
export const plansQuerySchema = planningPageQuerySchema.extend({
  q: z.string().max(1024).optional().describe("Поиск по ключу, названию, цели и краткому описанию"),
  status: planStatusSchema.optional().describe("Фильтр состояния плана"),
});
export const planningPage = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).describe("Записи текущей страницы"),
    total: z.number().int().nonnegative().describe("Полное число записей выбранной области"),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Смещение следующей страницы либо null"),
    version: z.string().describe("Версия согласованного состава и фильтров"),
  });
export const planSummarySchema = workPlanSchema.omit({ stages: true }).extend({
  scopeLabels: z
    .array(
      z.strictObject({
        ref: z.string().describe("Постоянный адрес kind:ID"),
        label: z.string().describe("Актуальные ключ и название области"),
      }),
    )
    .describe("Подписи выбранной области для человека"),
  stageCount: z.number().int().nonnegative().describe("Полное количество этапов"),
  counts: planningCountsSchema,
  ready: z.boolean().describe("Весь непустой состав фактически выполнен"),
  nextStage: z
    .strictObject({
      id: planningIdSchema,
      title: z.string().describe("Название ближайшего незавершённого этапа"),
    })
    .nullable()
    .describe("Ближайший этап либо null"),
  stagePreview: z
    .array(
      z.strictObject({
        id: planningIdSchema,
        completed: z.boolean().describe("Фактическое выполнение непустого этапа"),
      }),
    )
    .max(12)
    .describe("До 12 индикаторов этапов для карточки; полный каталог читается отдельно"),
});
export const stageSummarySchema = planStageSchema.extend({ counts: planningCountsSchema });
export const plansPageSchema = planningPage(planSummarySchema).extend({
  statusCounts: z
    .record(z.string(), z.number().int().nonnegative())
    .describe("Полные счётчики состояний проекта без поисковых фильтров, включая all"),
});
export const stagesPageSchema = planningPage(stageSummarySchema).extend({
  planRevision: planningMetadata.revision.describe(
    "Ревизия плана на момент чтения этой страницы этапов",
  ),
});
export const planningTasksPageSchema = planningPage(
  boardTaskSummarySchema.extend({
    completed: z.boolean().describe("Фактическое выполнение с учётом всех обязательств"),
  }),
);
export const planningWrite = {
  actor: actorSchema.optional().describe("Автор действия; по умолчанию автор интерфейса"),
  requestId: requestIdSchema.describe(
    "Идентификатор корреляции; повтор исполняется заново с проверкой текущей ревизии",
  ),
};
export const planningRevision = z
  .number()
  .int()
  .positive()
  .describe("Прочитанная ревизия плана или релиза");
export const createPlanSchema = workPlanFieldsSchema.extend(planningWrite);
// Значения по умолчанию создания нельзя применять к частичному изменению.
export const updatePlanSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision,
  title: workPlanFieldsSchema.shape.title.optional(),
  summary: workPlanFieldsSchema.shape.summary
    .removeDefault()
    .optional()
    .describe("Новое краткое описание обычным текстом"),
  goal: workPlanFieldsSchema.shape.goal
    .removeDefault()
    .optional()
    .describe("Новая цель в Markdown"),
  rationale: workPlanFieldsSchema.shape.rationale
    .removeDefault()
    .optional()
    .describe("Новое обоснование в Markdown"),
  boundaries: workPlanFieldsSchema.shape.boundaries
    .removeDefault()
    .optional()
    .describe("Новые границы в Markdown"),
  expectedResult: workPlanFieldsSchema.shape.expectedResult
    .removeDefault()
    .optional()
    .describe("Новый ожидаемый результат в Markdown"),
  scope: workPlanFieldsSchema.shape.scope
    .removeDefault()
    .optional()
    .describe("Новый полный набор областей; пустой массив очищает его"),
  participants: workPlanFieldsSchema.shape.participants
    .removeDefault()
    .optional()
    .describe("Новый полный набор участников"),
});
export const transitionPlanSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision,
  action: z.enum(["start", "complete", "cancel"]).describe("Начать, завершить либо отменить план"),
  result: text(256 * 1024)
    .default("")
    .describe("Итог завершения или причина отмены; обязателен для закрытия"),
});
export const changeStageSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision.describe("Ревизия плана, защищающая весь состав этапов"),
  action: z
    .enum(["create", "update", "remove", "move"])
    .describe("Создать, изменить, удалить пустой этап или переместить"),
  stage: planningIdSchema
    .optional()
    .describe("Внутренний ID этапа плана; обязателен кроме создания"),
  fields: stageChangesSchema
    .optional()
    .describe("Поля этапа: создание требует title, изменение — непустой набор переданных полей"),
  before: planningIdSchema
    .nullable()
    .optional()
    .describe("ID следующего этапа; null — конец полного списка"),
  direction: z
    .enum(["up", "down"])
    .optional()
    .describe("Переместить на одну позицию полного списка; взаимоисключается с before"),
});
export const changePlanTasksSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision,
  stage: planningIdSchema.describe("Внутренний ID этапа выбранного плана"),
  add: z
    .array(entityReferenceSchema)
    .max(2000)
    .default([])
    .describe("Задачи для включения, ключи или ID, максимум 2000; остальные сохраняются"),
  remove: z
    .array(entityReferenceSchema)
    .max(2000)
    .default([])
    .describe("Задачи для исключения, ключи или ID, максимум 2000"),
});
export const transferPlanTaskSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision.describe("Ревизия исходного плана"),
  task: entityReferenceSchema.describe("Переносимая задача, ключ или ID"),
  targetPlan: entityReferenceSchema.describe("Ключ или ID целевого плана"),
  targetStage: planningIdSchema.describe("Внутренний ID этапа целевого плана"),
  targetRevision: planningRevision.describe("Ревизия целевого плана"),
  reason: text(16 * 1024)
    .min(1)
    .describe("Причина явного переноса в Markdown"),
});
export const planningSavedSchema = z.strictObject({
  id: planningIdSchema,
  key: z.string().describe("Ключ на момент операции"),
  revision: planningRevision,
  action: z.string().describe("Выполненное предметное действие"),
  requestId: requestIdSchema,
  stageId: planningIdSchema.optional().describe("ID затронутого этапа"),
  targetRevision: planningRevision
    .optional()
    .describe("Новая ревизия целевого плана после переноса"),
});
export const planMembershipSchema = z.strictObject({
  planId: planningIdSchema,
  planKey: z.string().describe("Текущий ключ плана"),
  planTitle: z.string().describe("Название плана"),
  stageId: planningIdSchema,
  stageTitle: z.string().describe("Название этапа"),
  status: planStatusSchema,
  current: z.boolean().describe("Текущее участие в черновом или начатом плане"),
});
export const planMembershipsSchema = planningPage(planMembershipSchema);
export const planningCandidatesQuerySchema = planningPageQuerySchema.extend({
  q: z.string().max(1024).optional().describe("Поиск задач по ключу и названию"),
  board: entityReferenceSchema.optional().describe("Доска: ключ, slug или ID"),
  plan: entityReferenceSchema.optional().describe("План редактируемого этапа, ключ или ID"),
  stage: planningIdSchema
    .optional()
    .describe("Внутренний ID редактируемого этапа; требует plan, сохраняет его задачи в выборе"),
  availableOnly: z
    .enum(["true", "false"])
    .default("true")
    .describe("Оставить свободные задачи и текущий состав выбранного этапа"),
});
export const planningCandidatesPageSchema = planningPage(
  boardTaskSummarySchema.extend({
    completed: z.boolean().describe("Фактическое выполнение задачи"),
    assignment: planMembershipSchema.nullable().describe("Текущая принадлежность либо null"),
  }),
);
export type PlanningCandidatesQuery = z.input<typeof planningCandidatesQuerySchema>;
export type WorkPlan = z.infer<typeof workPlanSchema>;
export type PlanStage = z.infer<typeof planStageSchema>;
export type PlanSummary = z.infer<typeof planSummarySchema>;
export type PlanningCounts = z.infer<typeof planningCountsSchema>;
export type PlanningPageQuery = z.input<typeof planningPageQuerySchema>;
export type PlansQuery = z.input<typeof plansQuerySchema>;
export type CreatePlan = z.input<typeof createPlanSchema>;
export type UpdatePlan = z.input<typeof updatePlanSchema>;
export type TransitionPlan = z.input<typeof transitionPlanSchema>;
export type ChangeStage = z.input<typeof changeStageSchema>;
export type ChangePlanTasks = z.input<typeof changePlanTasksSchema>;
export type TransferPlanTask = z.input<typeof transferPlanTaskSchema>;
export type PlanningSaved = z.infer<typeof planningSavedSchema>;
