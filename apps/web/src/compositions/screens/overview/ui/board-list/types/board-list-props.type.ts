import type { ComponentPropsWithoutRef } from "react";
import type { OverviewBoard, OverviewPreview } from "domains/product-overview";

/** Параметры перечня досок. */
export type BoardListParams = {
  /** Подборка досок обзора в порядке каталога с полным числом. */
  catalog: OverviewPreview<OverviewBoard>;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства перечня досок. */
export type BoardListProps = RootAttrs & BoardListParams;
