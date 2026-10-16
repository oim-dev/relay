import type { ComponentPropsWithoutRef } from "react";
import type { WorkGraphPoint, WorkGraphRun } from "domains/work-history";

/** Содержание подсказки из уже загруженной точки и её сохранённого автора. */
export type PointPreviewParams = {
  /** Краткое событие без полного Markdown. */
  point: WorkGraphPoint;
  /** Автор именно этой точки; null, если участие неизвестно. */
  run: WorkGraphRun | null;
  /** Название поручения, которому принадлежит точка. */
  workTitle: string;
  /** Предметная подпись вида события. */
  eventLabel: string;
  /** Место продолжения; null у остальных точек. */
  continuationLabel: string | null;
  /** Последняя точка находится вне основной страницы истории. */
  isOutsidePage: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства карточки-подсказки точки истории. */
export type PointPreviewProps = RootAttrs & PointPreviewParams;
