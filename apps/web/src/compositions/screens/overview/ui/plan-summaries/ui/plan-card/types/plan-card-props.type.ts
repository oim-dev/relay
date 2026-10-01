import type { ComponentPropsWithoutRef } from "react";
import type { OverviewPlan } from "domains/product-overview";

/** Параметры карточки активного плана. */
export type PlanCardParams = {
  /** Активный план. */
  plan: OverviewPlan;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children">;
/** Свойства карточки активного плана. */
export type PlanCardProps = RootAttrs & PlanCardParams;
