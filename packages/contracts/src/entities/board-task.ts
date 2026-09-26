import { z } from "zod";
import {
  acceptanceCriterionSchema,
  criterionContentSchema,
  criteriaProgressSchema,
  criterionIdSchema,
} from "./task-acceptance.js";
export * from "./task-acceptance.js";
export * from "./task-comments.js";
import {
  actorSchema,
  singleLine,
  text,
  timestampSchema,
  requestIdSchema,
  entityReferenceSchema,
} from "../primitives.js";

export const boardTaskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{8}$/)
  .describe("Постоянный ID задачи: 8 символов");
export const boardTaskReferenceSchema = entityReferenceSchema.describe(
  "ID задачи или ключ, например WEB-24",
);
export const kanbanColumnSchema = z
  .enum(["inbox", "ready", "in-progress", "review", "done", "cancelled"])
  .describe("Колонка: inbox, ready, in-progress, review, done; cancelled — отмена");
export const kanbanColumns = [
  { id: "inbox", label: "Входящие" },
  { id: "ready", label: "К выполнению" },
  { id: "in-progress", label: "В работе" },
  { id: "review", label: "На проверке" },
  { id: "done", label: "Готово" },
] as const;

const title = singleLine(1024, true).describe(
  "Однострочный заголовок без Markdown; может быть пустым",
);
const description = text(256 * 1024).describe("Описание задачи в Markdown; может быть пустым");
const board = z
  .string()
  .min(1)
  .max(128)
  .describe("Slug, префикс или постоянный ID доски выбранного проекта");
const revision = z
  .number()
  .int()
  .positive()
  .describe("Ревизия задачи, прочитанная перед изменением");
export const taskProductLinkSchema = z.strictObject({
  kind: z
    .enum(["feature", "scenario", "implementation"])
    .describe("Цель реализации: общая фича, сценарий или контракт приложения"),
  id: z
    .string()
    .min(1)
    .max(128)
    .describe("ID или ключ продуктовой цели; при записи нормализуется в постоянный ID"),
});
const productLinks = z
  .array(taskProductLinkSchema)
  .max(100)
  .describe("Явные связи «Реализует», максимум 100; пустой массив удаляет все связи");
const write = {
  requestId: requestIdSchema.describe(
    "Идентификатор корреляции; повтор исполняется заново и не возвращает сохранённый результат",
  ),
  actor: actorSchema.optional().describe("Автор изменения; по умолчанию автор текущего интерфейса"),
};
export const boardTaskSchema = z.strictObject({
  id: boardTaskIdSchema,
  key: boardTaskReferenceSchema.describe("Текущий ключ задачи с префиксом доски"),
  boardId: z.string().describe("Постоянный ID текущей доски"),
  title,
  description,
  productLinks: productLinks.default([]),
  column: kanbanColumnSchema,
  rank: z.number().finite().describe("Порядок внутри колонки"),
  revision,
  dependencies: z
    .array(boardTaskIdSchema)
    .max(200)
    .describe(
      "Прямые зависимости по ID; выполнение требует done, критериев и рекурсивного выполнения обязательств",
    ),
  related: z
    .array(boardTaskIdSchema)
    .max(200)
    .describe("Связанные задачи; обратное представление вычисляется"),
  parentId: boardTaskIdSchema
    .nullable()
    .describe(
      "Родительская задача или null; незавершённая подзадача блокирует завершение родителя",
    ),
  createdAt: timestampSchema.describe("Время создания"),
  updatedAt: timestampSchema.describe("Время последнего изменения"),
  createdBy: actorSchema.describe("Автор создания"),
  updatedBy: actorSchema.describe("Автор последнего изменения"),
});
export const boardTaskViewSchema = boardTaskSchema.extend({
  acceptance: criteriaProgressSchema
    .optional()
    .describe("Прогресс критериев приёмки; может отсутствовать в совместимом ответе"),
  canComplete: z
    .boolean()
    .optional()
    .describe("Выполнены критерии, подзадачи и зависимости; можно завершить задачу"),
  boardSlug: z.string().describe("Текущий slug доски для навигации"),
  blockers: z
    .array(boardTaskIdSchema)
    .describe(
      "Невыполненные прямые зависимости и подзадачи без повторов; их блокеры доступны через чтение связей",
    ),
  blocked: z.boolean().describe("Есть невыполненные зависимости"),
  ready: z.boolean().describe("Можно брать в работу: колонка ready и нет блокеров"),
});
export const boardTaskSummarySchema = boardTaskViewSchema.omit({ description: true });
export const boardTaskSavedSchema = z.strictObject({
  id: boardTaskIdSchema,
  key: boardTaskReferenceSchema,
  boardId: z.string().describe("ID доски на момент операции"),
  revision,
  action: z
    .enum([
      "create",
      "update",
      "move",
      "link",
      "rename",
      "criterion-add",
      "criterion-update",
      "criterion-complete",
      "criterion-remove",
    ])
    .describe("Выполненное действие"),
  criterionId: criterionIdSchema.optional().describe("ID изменённого критерия приёмки"),
  requestId: write.requestId,
  task: boardTaskViewSchema
    .optional()
    .describe(
      "Первоначальное состояние при создании для открытия редактора без дополнительного GET",
    ),
});
export const boardTaskRecordSchema = boardTaskSchema.extend({
  version: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  acceptanceCriteria: z
    .array(acceptanceCriterionSchema)
    .max(100)
    .default([])
    .describe("Критерии приёмки в порядке добавления, максимум 100"),
  keys: z.array(boardTaskReferenceSchema).min(1),
});
export const createBoardTaskSchema = z.strictObject({
  ...write,
  acceptanceCriteria: z
    .array(criterionContentSchema)
    .max(100)
    .optional()
    .describe(
      "Критерии приёмки при создании задачи одной атомарной операцией; все первоначально не выполнены",
    ),
  board,
  title: title.default(""),
  description: description.default(""),
  productLinks: productLinks.optional(),
  parentId: boardTaskReferenceSchema
    .optional()
    .describe("Ключ или ID родителя: создание подзадачи одной атомарной операцией"),
  dependencies: z
    .array(boardTaskReferenceSchema)
    .max(100)
    .optional()
    .describe("Ключи или ID зависимостей при создании одной атомарной операцией"),
  related: z
    .array(boardTaskReferenceSchema)
    .max(100)
    .optional()
    .describe("Ключи или ID контекстно связанных задач при создании"),
  column: kanbanColumnSchema.default("inbox"),
  includeTask: z
    .boolean()
    .default(false)
    .describe(
      "Вернуть задачу в ответе для открытия редактора без GET; по умолчанию компактный результат. Ответ не сохраняется для повтора",
    ),
});
export const updateBoardTaskSchema = z.strictObject({
  ...write,
  ifRevision: revision,
  title: title.optional(),
  description: description.optional(),
  productLinks: productLinks.optional(),
});
export const moveBoardTaskSchema = z.strictObject({
  ...write,
  ifRevision: revision,
  board: board.optional().describe("Целевая доска; при переносе меняется ключ, но не ID"),
  column: kanbanColumnSchema,
  beforeId: boardTaskReferenceSchema
    .nullable()
    .default(null)
    .describe("ID карточки, перед которой вставить; null — конец полной колонки"),
  ifVersion: z
    .string()
    .optional()
    .describe("Версия списка до перетаскивания; защищает порядок от параллельных изменений"),
});
export const linkBoardTaskSchema = z.strictObject({
  ...write,
  ifRevision: revision,
  target: boardTaskReferenceSchema.describe("ID или ключ второй задачи того же проекта"),
  relation: z
    .enum(["depends-on", "related", "parent"])
    .describe("Зависит от, связана с или родитель текущей задачи"),
  remove: z.boolean().default(false).describe("Удалить связь вместо добавления"),
});
export const boardTasksQuerySchema = z.strictObject({
  parentId: boardTaskReferenceSchema
    .optional()
    .describe("Только прямые подзадачи родителя с указанным ID или ключом; фильтр до пагинации"),
  productTarget: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Ключ или ID цели: задачи полного состава, включая дочерние сценарии и активные имплементации приложений",
    ),
  board: board.optional(),
  column: kanbanColumnSchema.optional(),
  completion: z
    .enum(["unfinished", "finished"])
    .optional()
    .describe(
      "unfinished исключает done и cancelled; finished возвращает только их; без параметра все задачи",
    ),
  searchIn: z
    .enum(["title", "all"])
    .optional()
    .describe("title — поиск по ключам, ID и заголовку; all или отсутствие — также по Markdown"),
  q: z.string().max(1024).optional().describe("Поиск по ключу, ID, заголовку и Markdown"),
  readiness: z
    .enum(["blocked", "ready"])
    .optional()
    .describe("Заблокированные задачи либо готовые к выполнению для оркестратора"),
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение страницы"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(40)
    .describe("Число задач или связей на странице, максимум 100"),
  version: z
    .string()
    .optional()
    .describe("Версия первой страницы; изменение требует начать чтение заново"),
});
export const boardTasksPageSchema = z.strictObject({
  items: z.array(boardTaskSummarySchema),
  total: z.number(),
  nextOffset: z.number().nullable(),
  version: z.string(),
});
export const boardTaskLinksPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      relation: z
        .enum(["depends-on", "blocks", "related", "parent", "child"])
        .describe("Направление связи относительно запрошенной задачи"),
      task: boardTaskSummarySchema,
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
  version: z.string(),
});
export type BoardTask = z.infer<typeof boardTaskSchema>;
export type BoardTaskRecord = z.infer<typeof boardTaskRecordSchema>;
export type BoardTaskView = z.infer<typeof boardTaskViewSchema>;
export type BoardTaskSaved = z.infer<typeof boardTaskSavedSchema>;
export type BoardTasksQuery = z.input<typeof boardTasksQuerySchema>;
export type CreateBoardTask = z.input<typeof createBoardTaskSchema>;
export type UpdateBoardTask = z.input<typeof updateBoardTaskSchema>;
export type MoveBoardTask = z.input<typeof moveBoardTaskSchema>;
export type LinkBoardTask = z.input<typeof linkBoardTaskSchema>;
