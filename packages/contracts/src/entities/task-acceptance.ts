import { z } from "zod";
import { actorSchema, requestIdSchema, singleLine, text, timestampSchema } from "../primitives.js";

export const criterionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{8}$/)
  .describe("Постоянный ID критерия приёмки");
export const criterionContentSchema = z.strictObject({
  title: singleLine(1024).describe("Обязательный однострочный заголовок критерия"),
  summary: text(4096)
    .default("")
    .describe("Краткое описание обычным многострочным текстом, до 4 КиБ"),
  description: text(64 * 1024)
    .default("")
    .describe("Полное описание критерия в Markdown, до 64 КиБ"),
});
export const acceptanceCriterionSchema = criterionContentSchema.extend({
  id: criterionIdSchema,
  completed: z.boolean().describe("Критерий отмечен выполненным"),
  completedAt: timestampSchema.nullable().describe("Время отметки выполнения или null"),
  completedBy: actorSchema.nullable().describe("Автор отметки выполнения или null"),
});
export const criteriaProgressSchema = z.strictObject({
  total: z.number().int().nonnegative().describe("Общее число критериев"),
  completed: z.number().int().nonnegative().describe("Число выполненных критериев"),
});
export const criteriaQuerySchema = z.strictObject({
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение страницы критериев"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Размер страницы, по умолчанию 20, максимум 100"),
  version: z
    .string()
    .optional()
    .describe("Версия первой страницы; после изменения перечитайте список"),
});
export const criteriaPageSchema = z.strictObject({
  items: z
    .array(acceptanceCriterionSchema.omit({ description: true }))
    .describe("Критерии без полного Markdown"),
  total: z.number().describe("Общее число критериев"),
  nextOffset: z.number().nullable().describe("Смещение продолжения или null"),
  version: z.string().describe("Версия списка критериев"),
  revision: z.number().int().positive().describe("Ревизия задачи для изменения критериев"),
});
export const criterionViewSchema = z.strictObject({
  criterion: acceptanceCriterionSchema.describe("Полное содержание критерия"),
  revision: z.number().int().positive().describe("Ревизия задачи на момент чтения"),
});
const write = {
  ifRevision: z.number().int().positive().describe("Прочитанная ревизия задачи"),
  requestId: requestIdSchema,
  actor: actorSchema.optional().describe("Автор изменения; по умолчанию автор интерфейса"),
};
export const addCriterionSchema = criterionContentSchema.extend(write);
export const editCriterionSchema = z.strictObject({
  ...write,
  criterionId: criterionIdSchema,
  title: criterionContentSchema.shape.title.optional(),
  summary: text(4096).optional().describe("Новое краткое описание обычным многострочным текстом"),
  description: text(64 * 1024)
    .optional()
    .describe("Новое полное описание в Markdown"),
});
export const completeCriterionSchema = z.strictObject({
  ...write,
  criterionId: criterionIdSchema,
  completed: z.boolean().describe("Явное состояние: true — выполнено, false — снять отметку"),
});
export const removeCriterionSchema = z.strictObject({ ...write, criterionId: criterionIdSchema });
export const changeCriterionSchema = z.discriminatedUnion("action", [
  addCriterionSchema.extend({ action: z.literal("add").describe("Добавить критерий") }),
  editCriterionSchema.extend({
    action: z
      .literal("update")
      .describe("Изменить содержание и сбросить выполнение при изменении текста"),
  }),
  completeCriterionSchema.extend({
    action: z.literal("complete").describe("Установить состояние выполнения"),
  }),
  removeCriterionSchema.extend({ action: z.literal("remove").describe("Удалить критерий") }),
]);
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type ChangeCriterion = z.input<typeof changeCriterionSchema>;
export type CriteriaQuery = z.input<typeof criteriaQuerySchema>;
