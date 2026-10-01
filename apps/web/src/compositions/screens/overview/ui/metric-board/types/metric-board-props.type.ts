import type { ComponentPropsWithoutRef } from "react";
import type { OverviewMetricEntry } from "domains/product-overview";

/** Параметры доски в распределении незавершённой работы. */
export type MetricBoardParams = {
  /** Доска с распределением задач. */
  entry: Extract<OverviewMetricEntry, { kind: "board" }>;
  /** Наибольшее число незавершённых задач среди досок: длина полосы — относительно него. */
  scale: number;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства доски в распределении незавершённой работы. */
export type MetricBoardProps = RootAttrs & MetricBoardParams;
