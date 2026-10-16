import { z } from "zod";
import type { StatusBadgeTone } from "ui/status-badge";

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

/**
 * Колонки новой модели отделены от настроек прежнего числового канбана.
 * `tone` — визуальный тон бейджа статуса задачи: «Готово» — положительный, «На проверке» —
 * требующий внимания, «В работе» — информационный; остальные нейтральны и различаются подписью.
 * Тон колонки не означает фактического выполнения задачи.
 */
export const KANBAN_COLUMNS = [
  { value: "inbox", label: "Входящие", tone: "neutral" },
  { value: "ready", label: "К выполнению", tone: "neutral" },
  { value: "in-progress", label: "В работе", tone: "info" },
  { value: "review", label: "На проверке", tone: "warning" },
  { value: "done", label: "Готово", tone: "success" },
] as const satisfies readonly { value: string; label: string; tone: StatusBadgeTone }[];
export const TASK_COLUMNS = [
  ...KANBAN_COLUMNS,
  { value: "cancelled", label: "Отменено", tone: "neutral" },
] as const satisfies readonly { value: string; label: string; tone: StatusBadgeTone }[];
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
