import type { ComponentPropsWithoutRef } from "react";

/** Параметры композиционного примера каркаса. */
export type KitShellParams = {
  /**
   * Раскладка: desktop следует настоящему порогу каркаса (сайдбар от 1024px окна),
   * mobile всегда показывает узкую раскладку с кнопкой меню и Drawer.
   */
  variant: "desktop" | "mobile";
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства композиционного примера каркаса. */
export type KitShellProps = RootAttrs & KitShellParams;
