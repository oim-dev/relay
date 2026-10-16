import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ProductTasksParams = {
  /** Постоянный ID продуктовой цели. Отсутствие скрывает блок прототипа. */
  targetId?: string;
  /** Открытый список и прогресс для продуктовой цели или реализации приложения. */
  scope?: "application" | "product";
  /** Переход к планированию задач приложения. */
  boardHref?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства визуальной области. */
export type ProductTasksProps = RootAttrs & ProductTasksParams;
