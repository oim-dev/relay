import type { ComponentPropsWithoutRef } from "react";
import type { OverviewTasks } from "domains/product-overview";

/** Параметры распределения задач. */
export type TaskStagesParams = {
  /** Статистика задач проекта. */
  tasks: OverviewTasks;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства распределения задач. */
export type TaskStagesProps = RootAttrs & TaskStagesParams;
