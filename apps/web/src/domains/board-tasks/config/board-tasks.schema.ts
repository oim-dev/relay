import { z } from "zod";

export const COLUMN_SCHEMA = z.enum([
  "inbox",
  "ready",
  "in-progress",
  "review",
  "done",
  "cancelled",
]);
export const TASK_SUMMARY_SCHEMA = z.object({
  acceptance: z
    .object({ total: z.number(), completed: z.number() })
    .default({ total: 0, completed: 0 }),
  canComplete: z.boolean().optional(),
  id: z.string(),
  key: z.string(),
  boardId: z.string(),
  boardSlug: z.string(),
  title: z.string(),
  productLinks: z.array(
    z.object({ kind: z.enum(["feature", "scenario", "implementation"]), id: z.string() }),
  ),
  column: COLUMN_SCHEMA,
  revision: z.number(),
  rank: z.number(),
  dependencies: z.array(z.string()),
  related: z.array(z.string()),
  parentId: z.string().nullable(),
  blockers: z.array(z.string()),
  blocked: z.boolean(),
  ready: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  updatedBy: z.string(),
});
export const BOARD_TASK_SCHEMA = TASK_SUMMARY_SCHEMA.extend({ description: z.string() });
const page = { total: z.number(), version: z.string(), nextOffset: z.number().nullable() };
export const TASKS_PAGE_SCHEMA = z.object({ ...page, items: z.array(TASK_SUMMARY_SCHEMA) });
export const RELATION_SCHEMA = z.enum(["depends-on", "related", "parent"]);
export const LINKS_PAGE_SCHEMA = z.object({
  ...page,
  items: z.array(
    z.object({
      relation: z.enum(["depends-on", "blocks", "related", "parent", "child"]),
      task: TASK_SUMMARY_SCHEMA,
    }),
  ),
});
export const TASK_SAVED_SCHEMA = z.object({
  criterionId: z.string().optional(),
  id: z.string(),
  key: z.string(),
  boardId: z.string(),
  revision: z.number(),
  action: z.string(),
  requestId: z.string(),
  task: BOARD_TASK_SCHEMA.optional(),
});

/** Колонки новой модели отделены от настроек прежнего числового канбана. */
export const KANBAN_COLUMNS = [
  { value: "inbox", label: "Входящие", color: "gray" },
  { value: "ready", label: "К выполнению", color: "grape" },
  { value: "in-progress", label: "В работе", color: "ultramarine" },
  { value: "review", label: "На проверке", color: "orange" },
  { value: "done", label: "Готово", color: "teal" },
] as const;
export const TASK_COLUMNS = [
  ...KANBAN_COLUMNS,
  { value: "cancelled", label: "Отменено", color: "gray" },
] as const;
export const TASK_RELATIONS = [
  { value: "depends-on", label: "Зависит от" },
  { value: "related", label: "Связана с" },
  { value: "parent", label: "Родитель" },
] as const;
export const RELATION_LABELS = {
  "depends-on": "Зависит от",
  blocks: "Блокирует",
  related: "Связана с",
  parent: "Родительская задача",
  child: "Дочерняя задача",
};
