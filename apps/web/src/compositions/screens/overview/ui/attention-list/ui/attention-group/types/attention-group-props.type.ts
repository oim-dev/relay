import type { ComponentPropsWithoutRef } from "react";
import type { TaskFilters } from "domains/board-tasks";
import type { OverviewPreview, OverviewTask } from "domains/product-overview";

/** Параметры группы задач, требующих внимания. */
export type AttentionGroupParams = {
  /** Название группы. */
  title: string;
  /** Пояснение пустой группы. */
  emptyText: string;
  /** Подборка задач группы. */
  preview: OverviewPreview<OverviewTask>;
  /** Фильтр полного списка задач проекта с тем же смыслом, что и подборка. */
  filters: TaskFilters;
  /** Группа объединяет разные колонки, поэтому полный список показывает колонку задачи. */
  shouldShowColumn?: boolean;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства группы задач, требующих внимания. */
export type AttentionGroupProps = RootAttrs & AttentionGroupParams;
