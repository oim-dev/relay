import type { ComponentPropsWithoutRef } from "react";

/** Навигация по всем точкам только выбранной ветки. */
export type BranchPointsParams = {
  projectId: string;
  sessionId: string;
  /** Производный ID открытой точки, включая события жизненного цикла. */
  selectedPointId: string;
  /** Открывает материал в том же модальном окне. */
  onSelectPoint: (ref: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "aria-labelledby">;
/** Свойства визуальной области. */
export type BranchPointsProps = RootAttrs & BranchPointsParams;
