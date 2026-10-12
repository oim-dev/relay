import type { StatusBadgeTone } from "ui/status-badge";
import type { ReleaseStatus } from "../types/release.type";
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Запланирован",
  released: "Выпущен",
  cancelled: "Отменён",
};
/**
 * Тон бейджа собственного статуса выпуска; готовность состава показывается отдельно.
 */
export const RELEASE_STATUS_TONES: Record<ReleaseStatus, StatusBadgeTone> = {
  planned: "info",
  released: "success",
  cancelled: "neutral",
};
export const RELEASE_STATUS_OPTIONS = [
  { value: "planned", label: "Запланирован" },
  { value: "released", label: "Выпущен" },
  { value: "cancelled", label: "Отменён" },
];

/**
 * Разбирает собственное состояние выпуска из URL.
 */
export const releaseStatusFromValue = (value: string | null): ReleaseStatus | undefined =>
  (["planned", "released", "cancelled"] as const).find((status) => status === value);
