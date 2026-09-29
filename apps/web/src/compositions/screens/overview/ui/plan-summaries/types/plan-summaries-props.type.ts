import type { ComponentPropsWithoutRef } from "react";
import type { OverviewPlans } from "domains/product-overview";

/** Параметры сводки планов. */
export type PlanSummariesParams = {
  /** Планы работ проекта. */
  plans: OverviewPlans;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сводки планов. */
export type PlanSummariesProps = RootAttrs & PlanSummariesParams;
