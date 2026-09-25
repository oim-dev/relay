import type { PlanStatus } from "../types/planning.type";
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Запланирован",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
};
export const PLAN_STATUS_COLORS: Record<PlanStatus, string> = {
  draft: "gray",
  active: "blue",
  completed: "teal",
  cancelled: "gray",
};
export const PLANNING_TASK_LABELS = {
  inbox: "Входящие",
  ready: "К выполнению",
  "in-progress": "В работе",
  review: "На проверке",
  done: "Готово",
  cancelled: "Отменена",
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
