import type { ComponentPropsWithoutRef } from "react";
import type { ProductOverviewFreshness } from "domains/product-overview";

/** Параметры предупреждения об актуальности обзора. */
export type SyncNoticeParams = {
  /** Актуальность показанных данных. */
  freshness: ProductOverviewFreshness;
  /** Сообщение сервера об ошибке хранилища. */
  storageMessage?: string;
  /** Причина неудачного обновления при сохранённых прежних данных. */
  refreshError: string | null;
  /** Выполняется повторное чтение. */
  isRetrying: boolean;
  /** Повторяет чтение обзора. */
  onRetry: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства предупреждения об актуальности обзора. */
export type SyncNoticeProps = RootAttrs & SyncNoticeParams;
