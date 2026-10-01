import type { ComponentPropsWithoutRef } from "react";
import type { OverviewMetricEntry } from "domains/product-overview";

/** Параметры задачи в списке показателя. */
export type MetricTaskParams = {
  /** Задача показателя: с основанием включения либо затронутая блокером. */
  entry: Extract<OverviewMetricEntry, { kind: "task" | "affected" }>;
  /** Показывать колонку: список объединяет разные колонки. */
  shouldShowColumn?: boolean;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства задачи в списке показателя. */
export type MetricTaskProps = RootAttrs & MetricTaskParams;
