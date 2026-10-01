import type { ComponentPropsWithoutRef, ReactNode, RefObject } from "react";
import type { MetricErrorMessage } from "../../../helpers/metric-error";

/** Параметры списка записей метрики с состоянием чтения. */
export type MetricFrameParams = {
  /** Доступное название списка. */
  label: string;
  /** ID записей в порядке отображения: по ним сохраняется фокус. */
  entryIds: string[];
  /** Элементы списка `li` с атрибутом `data-entry-id`. */
  children: ReactNode;
  /** Куда перевести фокус, если запись с фокусом исчезла и записей не осталось. */
  focusFallbackRef: RefObject<HTMLElement | null>;
  /** Идёт чтение: список ещё не полный или обновляется. */
  isBusy?: boolean;
  /** Сообщение о ходе чтения. */
  statusText?: string | null;
  /** Сколько записей показано из полного числа. */
  loadedNote?: string | null;
  /** Пояснение пустого списка. */
  emptyText?: string | null;
  /** Отказ чтения и возможность повтора. */
  error?: MetricErrorMessage | null;
  /** Есть следующая страница того же среза. */
  hasMore?: boolean;
  /** Следующая страница читается. */
  isLoadingMore?: boolean;
  /** Дочитать следующую страницу. */
  onMore?: () => void;
  /** Перечитать уже загруженные страницы. */
  onRetry?: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства списка записей метрики. */
export type MetricFrameProps = RootAttrs & MetricFrameParams;
