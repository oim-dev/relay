import type { ComponentPropsWithoutRef } from "react";

/** Параметры навигации примера каркаса. */
export type KitShellNavParams = {
  /** Идентификатор текущего раздела. */
  currentId: string;
  /** Выбор раздела: пример меняет текущий пункт без перехода по адресу. */
  onSelect: (id: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"nav">, "children" | "onSelect">;
/** Свойства навигации примера каркаса. */
export type KitShellNavProps = RootAttrs & KitShellNavParams;
