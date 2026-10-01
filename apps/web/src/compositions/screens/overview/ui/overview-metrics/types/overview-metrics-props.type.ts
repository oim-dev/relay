import type { ComponentPropsWithoutRef } from "react";
import type { ProductOverview } from "domains/product-overview";

/** Параметры операционных показателей обзора. */
export type OverviewMetricsParams = {
  /** Статистика задач проекта из среза обзора. */
  tasks: ProductOverview["tasks"];
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"ul">, "children">;
/** Свойства операционных показателей обзора. */
export type OverviewMetricsProps = RootAttrs & OverviewMetricsParams;
