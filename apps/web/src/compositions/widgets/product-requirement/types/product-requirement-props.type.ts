import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры визуальной области. */
export type ProductRequirementParams = {
  /** Постоянный ID требования. */
  targetId: string;
  /** Вид проектного требования. */
  kind: "feature" | "scenario";
  /** Полное описание в Markdown. */
  description: string;
  /** Название родительского контекста. */
  parentName: string;
  /** Адрес фичи или каталога требований. */
  parentHref: string;
  /** Компактный список сценариев фичи. */
  children?: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ProductRequirementProps = RootAttrs & ProductRequirementParams;
