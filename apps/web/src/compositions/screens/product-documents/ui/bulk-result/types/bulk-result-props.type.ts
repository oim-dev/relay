import type { ComponentPropsWithoutRef } from "react";
import type { BulkOutcome } from "../../../types/bulk.type";

/** Параметры отчёта о массовом действии. */
export type BulkResultParams = {
  /** Фактический результат последнего действия. */
  outcome: BulkOutcome;
  /** Скрытие отчёта. */
  onDismiss: () => void;
  /** Явное перечитывание списка для проверки состояния; без него действие не показывается. */
  onRefresh?: () => void;
  /** Список перечитывается. */
  isRefreshing?: boolean;
};
/** Атрибуты отчёта. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства отчёта о массовом действии. */
export type BulkResultProps = RootAttrs & BulkResultParams;
