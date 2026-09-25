import { z } from "zod";
import { entityReferenceSchema } from "./primitives.js";
import { kanbanColumnSchema } from "./entities/board-task.js";
import { planMembershipSchema, planStatusSchema, planningCountsSchema } from "./planning.js";
import { releaseStatusSchema, releaseReadinessSchema } from "./releases.js";

export const progressKindSchema = z
  .enum([
    "task",
    "implementation",
    "scenario",
    "feature",
    "application",
    "product",
    "work-plan",
    "release",
  ])
  .describe("Вид предметного прогресса");
export const progressPageQuerySchema = z.strictObject({
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Смещение каждого списка составляющих и причин"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Размер страницы каждого списка: 20 по умолчанию, максимум 100"),
  version: z
    .string()
    .optional()
    .describe("Версия первой страницы этого прогресса; обязательна при offset > 0"),
});
export const progressQuerySchema = progressPageQuerySchema.extend({
  ref: entityReferenceSchema.describe("Ключ, ID или kind:ID сущности выбранного проекта"),
});
export const progressAddressSchema = z.strictObject({
  kind: progressKindSchema,
  id: z.string().describe("Постоянный ID сущности"),
  key: z.string().nullable().describe("Читаемый ключ, если назначен"),
  title: z.string().describe("Однострочное название"),
});
const count = z.number().int().nonnegative();
export const progressCountSchema = z.strictObject({
  total: count.describe("Полный уникальный состав, независимо от страницы"),
  completed: count.describe("Фактически выполненная часть полного состава"),
});
export const progressReasonSchema = z.strictObject({
  code: z
    .enum([
      "NOT_DONE",
      "CRITERION_INCOMPLETE",
      "CHILD_INCOMPLETE",
      "DEPENDENCY_INCOMPLETE",
      "COMPONENT_INCOMPLETE",
      "NO_WORK",
      "INACTIVE",
      "PLAN_NOT_COMPLETED",
      "PLAN_CANCELLED",
      "STATE_DIVERGED",
      "MISSING_PLAN",
    ])
    .describe("Машинный код причины"),
  message: z.string().describe("Понятное объяснение причины"),
  source: progressAddressSchema.describe("Сущность, чей прогресс следует раскрыть"),
  criterionId: z.string().optional().describe("ID невыполненного критерия задачи"),
});
/** Каждый список имеет собственное продолжение; итоги относятся ко всему составу. */
const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).describe("Строки текущей страницы"),
    total: count.describe("Полное число строк списка"),
    nextOffset: count.nullable().describe("Следующее смещение или null"),
  });
export const progressItemSchema = progressAddressSchema.extend({
  completed: z.boolean().describe("Фактическое выполнение с учётом всех обязательств"),
});
export const progressTaskItemSchema = progressItemSchema.extend({
  column: kanbanColumnSchema.describe("Сохранённая колонка; не заменяет фактическое выполнение"),
});
const base = {
  entity: progressAddressSchema.describe("Адрес выбранной сущности"),
  completed: z.boolean().describe("Фактически выполнен весь обязательный состав"),
  version: z.string().describe("Версия согласованного чтения для продолжения этого запроса"),
  reasons: page(progressReasonSchema).describe("Причины невыполнения или отсутствия работ"),
};
const aggregate = {
  ...base,
  counts: progressCountSchema.describe(
    "Уникальные задачи собственного продуктового состава; внешние обязательства не добавляются",
  ),
};
const tasks = page(progressTaskItemSchema).describe(
  "Прямые собственные задачи; вложенные обязательства раскрываются через прогресс задачи",
);
const implementations = page(progressItemSchema).describe(
  "Обязательные активные реализации; прогресс каждой читается отдельно",
);
export const taskProgressSchema = z.strictObject({
  planning: planMembershipSchema
    .nullable()
    .optional()
    .describe(
      "Текущее участие в плане; null — задача свободна, поле отсутствует у старого сервера",
    ),
  ...base,
  kind: z.literal("task").describe("Прогресс задачи"),
  column: kanbanColumnSchema,
  canComplete: z.boolean().describe("Выполнены обязательства; колонка может ещё не быть done"),
  acceptance: progressCountSchema.describe("Полный состав критериев приёмки"),
  criteria: page(
    z.strictObject({
      id: z.string().describe("ID критерия"),
      title: z.string().describe("Название критерия"),
      completed: z.boolean().describe("Отметка выполнения критерия"),
    }),
  ).describe("Критерии без полного Markdown"),
  children: page(progressTaskItemSchema).describe("Прямые подзадачи"),
  dependencies: page(progressTaskItemSchema).describe(
    "Прямые обязательные зависимости любых досок проекта",
  ),
});
export const implementationProgressSchema = z.strictObject({
  ...aggregate,
  kind: z.literal("implementation").describe("Прогресс реализации"),
  implementationKind: z.enum(["FI", "SI"]).describe("Вклад в фичу либо сценарий"),
  application: progressAddressSchema.describe("Приложение-владелец"),
  target: progressAddressSchema.describe("Проектная фича либо сценарий"),
  active: z.boolean().describe("Участие реализации в текущем составе"),
  tasks,
  implementations: implementations.describe(
    "Для FI — активные SI той же фичи и приложения; для SI — пустой список",
  ),
});
export const scenarioProgressSchema = z.strictObject({
  ...aggregate,
  kind: z.literal("scenario").describe("Прогресс сценария"),
  tasks,
  implementations,
});
export const featureProgressSchema = z.strictObject({
  ...aggregate,
  kind: z.literal("feature").describe("Прогресс фичи"),
  tasks,
  implementations: implementations.describe("Активные FI фичи"),
  scenarios: page(progressItemSchema).describe(
    "Все проектные сценарии фичи, включая не выбранные приложениями",
  ),
});
export const applicationProgressSchema = z.strictObject({
  ...aggregate,
  kind: z
    .literal("application")
    .describe("Прогресс заявленного состава приложения, не подтверждение поставки"),
  implementations,
  businessTasks: progressCountSchema.describe("Задачи досок приложения с продуктовыми целями"),
  allTasks: progressCountSchema.describe(
    "Все задачи досок приложения, включая работу без продуктовой цели",
  ),
});
export const productProgressSchema = z.strictObject({
  ...aggregate,
  kind: z.literal("product").describe("Прогресс продукта по его фичам"),
  features: page(progressItemSchema).describe("Фичи продукта с адресами и готовностью"),
});
export const workPlanProgressSchema = z.strictObject({
  ...base,
  kind: z.literal("work-plan").describe("Прогресс плана работ"),
  status: planStatusSchema,
  counts: planningCountsSchema,
  canStart: z.boolean().describe("Черновик имеет цель и непустой состав"),
  canComplete: z.boolean().describe("Открытый план имеет фактически выполненный непустой состав"),
  diverged: z.boolean().describe("Сохранённое завершение расходится с текущим выполнением задач"),
  stages: page(
    z.strictObject({
      id: z.string().describe("ID этапа"),
      title: z.string().describe("Название этапа"),
      counts: planningCountsSchema,
      completed: z.boolean().describe("Все задачи непустого этапа фактически выполнены"),
    }),
  ).describe("Страница этапов в предметном порядке"),
  tasks,
});
export const releaseProgressSchema = z.strictObject({
  ...base,
  kind: z.literal("release").describe("Текущая готовность планов выбранного релиза"),
  status: releaseStatusSchema,
  readiness: releaseReadinessSchema,
  plans: page(progressItemSchema.extend({ status: planStatusSchema })).describe(
    "Актуальные выбранные планы независимо от состояния выпуска",
  ),
});
export type ProgressKind = z.infer<typeof progressKindSchema>;
export type ProgressQuery = z.input<typeof progressQuerySchema>;
export type ProgressPageQuery = z.input<typeof progressPageQuerySchema>;
export type ProgressAddress = z.infer<typeof progressAddressSchema>;
export type ProgressReason = z.infer<typeof progressReasonSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type ImplementationProgress = z.infer<typeof implementationProgressSchema>;
export type ScenarioProgress = z.infer<typeof scenarioProgressSchema>;
export type FeatureProgress = z.infer<typeof featureProgressSchema>;
export type ApplicationProgress = z.infer<typeof applicationProgressSchema>;
export type ProductProgress = z.infer<typeof productProgressSchema>;
export type WorkPlanProgress = z.infer<typeof workPlanProgressSchema>;
export type ReleaseProgress = z.infer<typeof releaseProgressSchema>;
/** Только для представлений: публичные операции сохраняют отдельные строгие схемы. */
export type Progress =
  | TaskProgress
  | ImplementationProgress
  | ScenarioProgress
  | FeatureProgress
  | ApplicationProgress
  | ProductProgress
  | WorkPlanProgress
  | ReleaseProgress;
