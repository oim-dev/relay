import type { ComponentPropsWithoutRef } from "react";
import type { ProductOverview } from "domains/product-overview";

/** Параметры сводных показателей обзора. */
export type OverviewMetricsParams = {
  /** Статистика задач. */
  tasks: ProductOverview["tasks"];
  /** Доски проекта. */
  boards: ProductOverview["boards"];
  /** Библиотека документов. */
  documents: ProductOverview["documents"];
  /** Продуктовые знания. */
  knowledge: ProductOverview["knowledge"];
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"ul">, "children">;
/** Свойства сводных показателей обзора. */
export type OverviewMetricsProps = RootAttrs & OverviewMetricsParams;
