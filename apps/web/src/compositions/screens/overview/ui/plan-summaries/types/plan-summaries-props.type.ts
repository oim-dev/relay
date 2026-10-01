import type { ComponentPropsWithoutRef } from "react";
import type { OverviewOperator, OverviewPlans } from "domains/product-overview";

/** Параметры сводки планов. */
export type PlanSummariesParams = {
  /** Планы работ проекта. */
  plans: OverviewPlans;
  /** Показатели оператора планирования: работа вне открытых планов и выполненные открытые планы. */
  operator: Pick<OverviewOperator, "unplannedWork" | "openPlansComplete">;
  /** Версия показанного обзора: по ней раскрываются полные списки показателей. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сводки планов. */
export type PlanSummariesProps = RootAttrs & PlanSummariesParams;
