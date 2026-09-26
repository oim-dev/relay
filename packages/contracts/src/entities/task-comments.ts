import { z } from "zod";
import { actorSchema, requestIdSchema, singleLine, text, timestampSchema } from "../primitives.js";

export const taskActivityIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/)
  .describe("Постоянный номер комментария; прежние номера сохраняются, пропуски допустимы");
export const taskActorRoleSchema = z
  .enum(["operator", "orchestrator", "worker"])
  .describe("Роль автора: оператор, оркестратор или воркер");
export const publishTaskCommentSchema = z.strictObject({
  title: singleLine(1024).describe("Обязательный однострочный заголовок сообщения"),
  description: text(256 * 1024)
    .refine((value) => value.trim().length > 0, "Описание обязательно")
    .describe("Полное сообщение в Markdown, до 256 КиБ"),
  actor: actorSchema.describe("Имя автора: Web передаёт Оператор, агент задаёт своё имя"),
  actorRole: taskActorRoleSchema,
  requestId: requestIdSchema,
});
export const taskCommentsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Размер страницы комментариев, по умолчанию 20, максимум 100"),
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
    .describe("Только комментарии после известного последовательного номера"),
  actor: actorSchema.optional().describe("Точное имя автора для фильтрации"),
  action: z
    .literal("comment-publish")
    .optional()
    .describe("Совместимый фильтр; допустима только публикация комментария"),
});
export const taskCommentSummarySchema = z.strictObject({
  id: taskActivityIdSchema,
  taskId: z.string().describe("Постоянный ID задачи"),
  sequence: z
    .number()
    .int()
    .positive()
    .describe("Последовательный номер комментария; возможны пропуски"),
  at: timestampSchema.describe("Время публикации комментария"),
  actor: actorSchema,
  actorRole: taskActorRoleSchema
    .optional()
    .describe("Роль автора, если сохранена в исходном сообщении"),
  action: z.literal("comment-publish").describe("Комментарий опубликован"),
  title: z.string().describe("Заголовок сообщения"),
  operationId: z.string().describe("Сохранённый идентификатор операции публикации"),
  revision: z.number().int().positive().describe("Ревизия содержания задачи на момент публикации"),
  legacy: z.boolean().describe("Сохранённый признак прежней записи; у новых комментариев false"),
  fields: z.tuple([]).describe("Совместимое пустое поле; комментарий не изменяет поля задачи"),
});
export const taskCommentSchema = taskCommentSummarySchema.extend({
  changes: z.tuple([]).describe("Совместимое пустое поле; комментарий не содержит аудит изменений"),
  description: z.string().describe("Полный Markdown сообщения без нормализации содержания"),
});
export const taskCommentsPageSchema = z.strictObject({
  items: z.array(taskCommentSummarySchema).describe("Краткие комментарии без полного Markdown"),
  nextCursor: z.string().nullable().describe("Курсор продолжения того же снимка или null"),
  snapshot: z
    .number()
    .int()
    .nonnegative()
    .describe("Верхний последовательный номер снимка; новые комментарии читаются через after"),
});
export const taskCommentSavedSchema = z.strictObject({
  id: z.string().describe("Постоянный ID задачи"),
  commentId: taskActivityIdSchema,
  action: z.literal("comment-publish").describe("Сообщение опубликовано"),
  revision: z
    .number()
    .int()
    .positive()
    .describe("Последовательный номер комментария, не ревизия содержания задачи"),
  requestId: requestIdSchema,
});
export type PublishTaskComment = z.infer<typeof publishTaskCommentSchema>;
export type TaskCommentsQuery = z.input<typeof taskCommentsQuerySchema>;
export type TaskCommentSummary = z.infer<typeof taskCommentSummarySchema>;
export type TaskComment = z.infer<typeof taskCommentSchema>;
export type TaskCommentsPage = z.infer<typeof taskCommentsPageSchema>;
export type TaskCommentSaved = z.infer<typeof taskCommentSavedSchema>;
