import type { ComponentPropsWithoutRef } from "react";
import type { TaskFilters } from "domains/board-tasks";
import type { OverviewTask } from "domains/product-overview";

/** Параметры полного списка группы внимания. */
export type AttentionFullListParams = {
  /** Фильтр списка задач проекта с тем же смыслом, что и подборка обзора. */
  filters: TaskFilters;
  /** Задачи подборки: их карточки и причины сохраняются в полном списке. */
  previewTasks: OverviewTask[];
  /** Показывать колонку задачи: нужно, когда группа объединяет разные колонки. */
  shouldShowColumn: boolean;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства полного списка группы внимания. */
export type AttentionFullListProps = RootAttrs & AttentionFullListParams;
