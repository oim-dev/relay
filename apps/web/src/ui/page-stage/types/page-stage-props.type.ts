import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры сцены экрана. */
export type PageStageParams = {
  /** Содержимое сцены. */
  children?: ReactNode;
  /**
   * Раскладка: default — сцена по высоте содержимого, но в колонке каркаса не короче
   * остатка окна (страница растёт вниз вместе с ней); workspace — рабочее поле
   * (доска, граф) от 768px занимает оставшуюся высоту окна под шапкой каркаса,
   * сцена становится flex-колонкой, а прокрутка принадлежит содержимому.
   */
  layout?: "default" | "workspace";
};
/** Атрибуты сцены; внешняя серая область не настраивается. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сцены экрана. */
export type PageStageProps = RootAttrs & PageStageParams;
