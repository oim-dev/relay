import type { ComponentPropsWithoutRef } from "react";
import type { OverviewBoard } from "domains/product-overview";

/** Параметры перечня досок. */
export type BoardListParams = {
  /** Показанные доски в порядке каталога. */
  boards: OverviewBoard[];
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"ul">, "children">;
/** Свойства перечня досок. */
export type BoardListProps = RootAttrs & BoardListParams;
