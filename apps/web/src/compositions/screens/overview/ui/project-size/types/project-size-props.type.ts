import type { ComponentPropsWithoutRef } from "react";
import type { ProductOverview } from "domains/product-overview";

/** Параметры диаграммы размера проекта. */
export type ProjectSizeParams = {
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
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства диаграммы размера проекта. */
export type ProjectSizeProps = RootAttrs & ProjectSizeParams;
