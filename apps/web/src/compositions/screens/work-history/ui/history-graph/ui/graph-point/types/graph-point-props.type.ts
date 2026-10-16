import type { ComponentPropsWithoutRef } from "react";
import type { HistoryPointData } from "../../../types/history-flow.type";

/** Локальная проекция внутри уже размещённой ELK ноды, не собственная раскладка мира. */
type GraphPointRow = Pick<HistoryPointData, "point" | "branch" | "run" | "color"> & {
  /** Центр маркера внутри bbox движка. */
  x: number;
  /** Центр маркера внутри bbox движка. */
  y: number;
};

/** Параметры визуальной области. */
export type GraphPointParams = {
  /** Компактная точка, сохранённый автор и координата линии. */
  row: GraphPointRow;
  /** Последняя реальная точка незавершённой ветки. */
  isOpenEnd: boolean;
  /** Точка передана вне основной страницы. */
  isOutsidePage: boolean;
  /** Выделение выбранного адреса. */
  isSelected: boolean;
  /** Подсветка прежнего session-параметра без сужения области. */
  isHighlighted: boolean;
  /** Открывает точку и запоминает реальный элемент для возврата фокуса. */
  onSelectPoint: (ref: string, source: HTMLButtonElement) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"button">, "children" | "onClick" | "style">;
/** Свойства визуальной области. */
export type GraphPointProps = RootAttrs & GraphPointParams;
