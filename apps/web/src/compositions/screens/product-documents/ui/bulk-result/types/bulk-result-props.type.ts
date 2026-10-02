import type { ComponentPropsWithoutRef } from "react";
import type { BulkOutcome } from "../../../types/bulk.type";

/** Параметры отчёта о массовом действии. */
export type BulkResultParams = {
  /** Фактический результат последнего действия. */
  outcome: BulkOutcome;
  /** В выборе остались неприменённые материалы для повтора. */
  retryCount: number;
  /** Скрытие отчёта. */
  onDismiss: () => void;
};
/** Атрибуты отчёта. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства отчёта о массовом действии. */
export type BulkResultProps = RootAttrs & BulkResultParams;
