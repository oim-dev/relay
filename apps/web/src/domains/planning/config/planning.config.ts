import type { StatusBadgeTone } from "ui/status-badge";
import type { PlanStatus, PlanningTask } from "../types/planning.type";
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Запланирован",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
};
/**
 * Тон бейджа собственного состояния плана. Выполнение состава показывается отдельно:
 * «Завершён» не означает, что текущие задачи плана выполнены.
 */
export const PLAN_STATUS_TONES: Record<PlanStatus, StatusBadgeTone> = {
  draft: "neutral",
  active: "info",
  completed: "success",
  cancelled: "neutral",
};
export const PLANNING_TASK_LABELS = {
  inbox: "Входящие",
  ready: "К выполнению",
  "in-progress": "В работе",
  review: "На проверке",
  done: "Готово",
  cancelled: "Отменена",
};
/**
 * Тон бейджа колонки задачи в составе плана: работа — info, проверка — warning, готово — success.
 */
export const PLANNING_TASK_TONES: Record<PlanningTask["status"], StatusBadgeTone> = {
  inbox: "neutral",
  ready: "neutral",
  "in-progress": "info",
  review: "warning",
  done: "success",
  cancelled: "neutral",
};
export const EMPTY_PLAN_SUMMARY = {
  total: 0,
  done: 0,
  active: 0,
  review: 0,
  blocked: 0,
  percent: 0,
};

/**
 * Разбирает фильтр URL без передачи неизвестного состояния в API.
 */
export const planStatusFromValue = (value: string | null): PlanStatus | undefined =>
  (["draft", "active", "completed", "cancelled"] as const).find((status) => status === value);

/**
 * Проверяет устойчивый перечень видов области; существование проверяет Core.
 */
export const isPlanScope = (value: string): boolean =>
  ["project", "product", "application", "feature", "scenario", "implementation"].includes(
    value.split(":")[0] ?? "",
  );
