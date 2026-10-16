import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры экрана на общей подложке. */
export type PageStageParams = {
  /** Содержимое экрана: заголовок и самостоятельные панели. */
  children?: ReactNode;
  /**
   * Раскладка: default — по высоте содержимого, но в колонке каркаса не короче
   * остатка окна (страница растёт вниз вместе с ней); workspace — рабочее поле
   * (доска, граф) от 768px занимает оставшуюся высоту окна под шапкой каркаса,
   * экран становится flex-колонкой, а прокрутка принадлежит содержимому.
   */
  layout?: "default" | "workspace";
};
/** Атрибуты корневого элемента экрана. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства экрана на общей подложке. */
export type PageStageProps = RootAttrs & PageStageParams;
