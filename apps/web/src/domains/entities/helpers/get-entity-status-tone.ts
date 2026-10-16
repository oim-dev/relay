import type { StatusBadgeTone } from "ui/status-badge";

/**
 * Визуальный тон известных предметных состояний: завершённое — успех, проверка
 * и черновик — внимание, блокировка — опасность, текущая работа — сведения.
 * Не начатое, отменённое и архивное остаются нейтральными и не выдают себя за успех.
 */
const ENTITY_STATUS_TONES: Record<string, StatusBadgeTone> = {
  partial: "info",
  active: "info",
  "in-progress": "info",
  in_progress: "info",
  progress: "info",
  draft: "warning",
  review: "warning",
  outdated: "warning",
  done: "success",
  completed: "success",
  released: "success",
  blocked: "danger",
};

/**
 * Возвращает тон бейджа состояния; неизвестное состояние остаётся нейтральным.
 */
export const getEntityStatusTone = (status: string): StatusBadgeTone =>
  ENTITY_STATUS_TONES[status] ?? "neutral";
