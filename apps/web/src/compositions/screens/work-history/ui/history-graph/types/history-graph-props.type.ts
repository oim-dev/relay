import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type HistoryGraphParams = {
  /** Неизменяемая область запросов и геометрии. */
  projectId: string;
  /** Адрес выбранной точки; не фильтр графа. */
  selectedPoint: string | null;
  /** Прежняя ссылка на ветку используется только для подсветки. */
  highlightedSession: string | null;
  /** Открывает полную точку, сохраняя холст и элемент возврата. */
  onSelectPoint: (ref: string, source: HTMLButtonElement) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type HistoryGraphProps = RootAttrs & HistoryGraphParams;
