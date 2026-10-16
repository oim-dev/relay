import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры примера галереи. */
export type KitExampleParams = {
  /** Название примера. */
  title: string;
  /**
   * Уровень заголовка примера: h2, если в образце есть собственные заголовки h2
   * (например, StatePanel), чтобы порядок заголовков не нарушался.
   */
  titleAs?: "h2" | "h3";
  /** Назначение: какую задачу человека решает вариант. */
  purpose: string;
  /** Строка импорта для потребителя. */
  importLine: string;
  /** Правило выбора варианта. */
  rule: string;
  /** Живой пример на реальных компонентах. */
  children: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children" | "title">;
/** Свойства примера галереи. */
export type KitExampleProps = RootAttrs & KitExampleParams;
