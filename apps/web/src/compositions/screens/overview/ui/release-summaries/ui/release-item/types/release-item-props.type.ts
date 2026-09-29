import type { ComponentPropsWithoutRef } from "react";
import type { OverviewRelease } from "domains/product-overview";

/** Параметры релиза в обзоре. */
export type ReleaseItemParams = {
  /** Релиз проекта. */
  release: OverviewRelease;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства релиза в обзоре. */
export type ReleaseItemProps = RootAttrs & ReleaseItemParams;
