import { z } from "zod";
import { actorSchema, singleLine, timestampSchema } from "@relay/contracts/primitives";
import { taskActivityIdSchema, taskActorRoleSchema } from "@relay/contracts/entities/task-comments";
export const taskActivityQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Размер страницы, по умолчанию 20, максимум 100"),
  cursor: z
    .string()
    .max(2048)
    .optional()
    .describe("Непрозрачный курсор следующей страницы; сохраняйте фильтры"),
  after: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Только события после известного последовательного номера"),
  actor: actorSchema.optional().describe("Точное имя автора для фильтрации"),
  action: singleLine(128).optional().describe("Тип действия, например update или comment-publish"),
});
export const taskHistoryChangeSchema = z.strictObject({
  field: z.string().describe("Постоянный адрес изменённого поля"),
  label: z.string().describe("Русское название изменения"),
  format: z.enum(["text", "markdown"]).describe("Обычный текст или Markdown"),
  before: z
    .string()
    .nullable()
    .describe("Прежнее значение; null при добавлении или сокращённом содержании"),
  after: z
    .string()
    .nullable()
    .describe("Новое значение; null при удалении или сокращённом содержании"),
  contentOmitted: z
    .literal(true)
    .optional()
    .describe("Сохранён факт изменения текста; прежняя и новая редакции не записываются в историю"),
});
export const taskHistorySummarySchema = z.strictObject({
  id: taskActivityIdSchema,
  taskId: z.string().describe("Постоянный ID задачи"),
  sequence: z.number().int().positive().describe("Последовательный номер в ленте задачи"),
  at: timestampSchema,
  actor: actorSchema,
  actorRole: taskActorRoleSchema.optional(),
  action: z.string().describe("Сохранённое действие"),
  title: z.string().describe("Читаемое название события или заголовок сообщения"),
  operationId: z.string().describe("Общий идентификатор составной операции"),
  revision: z.number().int().positive().describe("Ревизия содержания задачи на момент события"),
  legacy: z.boolean().describe("У старой записи отсутствуют подробности изменений"),
  fields: z.array(z.string()).describe("Названия изменённых полей без полных значений"),
});
export const taskHistoryEventSchema = taskHistorySummarySchema.extend({
  changes: z
    .array(taskHistoryChangeSchema)
    .describe("Изменения полей; Markdown отмечается фактом изменения без копий текста"),
  description: z.string().optional().describe("Полный Markdown опубликованного сообщения"),
});
export const taskActivityPageSchema = z.strictObject({
  items: z.array(taskHistorySummarySchema),
  nextCursor: z.string().nullable().describe("Курсор продолжения или null"),
  snapshot: z
    .number()
    .int()
    .nonnegative()
    .describe("Верхняя граница снимка; новые события читаются через after"),
});
export type TaskActivityQuery = z.input<typeof taskActivityQuerySchema>;
export type TaskHistoryChange = z.infer<typeof taskHistoryChangeSchema>;
export type TaskHistorySummary = z.infer<typeof taskHistorySummarySchema>;
export type TaskHistoryEvent = z.infer<typeof taskHistoryEventSchema>;
export type TaskActivityPage = z.infer<typeof taskActivityPageSchema>;
