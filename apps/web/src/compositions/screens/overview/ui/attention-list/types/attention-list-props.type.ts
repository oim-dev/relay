import type { ComponentPropsWithoutRef } from "react";
import type { ProductOverview } from "domains/product-overview";

/** Параметры блока «Требует внимания». */
export type AttentionListParams = {
  /** Подборки задач, требующих внимания. */
  attention: ProductOverview["attention"];
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства блока «Требует внимания». */
export type AttentionListProps = RootAttrs & AttentionListParams;
