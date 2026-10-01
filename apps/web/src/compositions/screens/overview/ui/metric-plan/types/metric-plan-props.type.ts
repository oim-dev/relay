import type { ComponentPropsWithoutRef } from "react";
import type { OverviewMetricEntry } from "domains/product-overview";

/** Параметры плана в списке показателя. */
export type MetricPlanParams = {
  /** План со статусом и фактическим выполнением состава. */
  entry: Extract<OverviewMetricEntry, { kind: "plan" }>;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства плана в списке показателя. */
export type MetricPlanProps = RootAttrs & MetricPlanParams;
