import type { ComponentPropsWithoutRef } from "react";
import type { OverviewKnowledge } from "domains/product-overview";

/** Параметры продуктовых знаний. */
export type ProductKnowledgeParams = {
  /** Продуктовые знания проекта. */
  knowledge: OverviewKnowledge;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"dl">, "children">;
/** Свойства продуктовых знаний. */
export type ProductKnowledgeProps = RootAttrs & ProductKnowledgeParams;
