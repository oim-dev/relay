import type { ComponentPropsWithoutRef } from "react";

/** Адресное место продолжения в согласованном срезе графа. */
export type UnfinishedSessionItem = {
  /** Адрес последней настоящей точки. */
  pointId: string;
  /** Название поручения ветки. */
  title: string;
  /** Сохранённое состояние, не присутствие online. */
  status: "pending" | "open" | "paused";
  /** Цвет той же линии на холсте. */
  color: string;
};

/** Параметры навигации по незавершённой работе. */
export type UnfinishedSessionsParams = {
  /** Незавершённые ветки от новых к старым. */
  items: UnfinishedSessionItem[];
  /** Подводит реальную точку по вертикали и подсвечивает её, не открывая материал. */
  onRevealPoint: (pointId: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"nav">, "children">;
/** Свойства визуальной области. */
export type UnfinishedSessionsProps = RootAttrs & UnfinishedSessionsParams;
