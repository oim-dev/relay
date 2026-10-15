import type { WorkCheckpointKind, WorkSessionStatus } from "@relay/contracts/work-history";

/** Подписи сохранённых состояний, не сетевые эвристики. */
export const WORK_STATUS_LABELS: Record<WorkSessionStatus, string> = {
  pending: "Ожидает агента",
  open: "Открыта",
  paused: "Приостановлена",
  completed: "Завершена",
  cancelled: "Отменена",
};

/** Семантика неизменяемой точки, без изменения исходного intent. */
export const WORK_CHECKPOINT_LABELS: Record<WorkCheckpointKind, string> = {
  intent: "Намерение",
  progress: "Промежуточный материал",
  result: "Результат намерения",
  cancel: "Отмена намерения",
};

/**
 * Представляет сохранённое время в локальной зоне браузера, включая дату и секунды.
 */
export const formatWorkTime = (at: string): string => new Date(at).toLocaleString("ru-RU");
