import type { ComponentPropsWithoutRef } from "react";
import type { OverviewTask } from "domains/product-overview";

/** Параметры задачи, требующей внимания. */
export type AttentionTaskParams = {
  /** Задача из подборки обзора. */
  task: OverviewTask;
  /** Колонка задачи, если группа объединяет разные колонки. */
  columnLabel?: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства задачи, требующей внимания. */
export type AttentionTaskProps = RootAttrs & AttentionTaskParams;
