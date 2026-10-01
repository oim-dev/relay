import type { ComponentPropsWithoutRef } from "react";
import type { OverviewMetricEntry } from "domains/product-overview";

/** Параметры прямого блокера незавершённой работы. */
export type MetricBlockerParams = {
  /** Блокер с полным числом затронутых задач и их подборкой. */
  entry: Extract<OverviewMetricEntry, { kind: "blocker" }>;
  /** Версия показанного обзора: полный список затронутых задач читается по ней. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства прямого блокера. */
export type MetricBlockerProps = RootAttrs & MetricBlockerParams;
