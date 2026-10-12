import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ProductDependenciesParams = {
  /** Адрес сущности для прямых исходящих зависимостей. */
  reference: string;
  /** Заголовок раздела. */
  title: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства визуальной области. */
export type ProductDependenciesProps = RootAttrs & ProductDependenciesParams;
