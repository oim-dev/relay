import type { ComponentPropsWithoutRef } from "react";
import type { BranchPoint } from "domains/work-history";

/** Адресная запись списка точек ветки. */
export type BranchPointItemParams = {
  point: BranchPoint;
  isCurrent: boolean;
  onSelectPoint: (ref: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"button">, "children" | "onClick" | "aria-current">;
/** Свойства визуальной области. */
export type BranchPointItemProps = RootAttrs & BranchPointItemParams;
