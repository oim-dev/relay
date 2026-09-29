import type { ComponentPropsWithoutRef } from "react";
import type { OverviewPreview, OverviewTask } from "domains/product-overview";

/** Параметры группы задач, требующих внимания. */
export type AttentionGroupParams = {
  /** Название группы. */
  title: string;
  /** Пояснение пустой группы. */
  emptyText: string;
  /** Подборка задач группы. */
  preview: OverviewPreview<OverviewTask>;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства группы задач, требующих внимания. */
export type AttentionGroupProps = RootAttrs & AttentionGroupParams;
