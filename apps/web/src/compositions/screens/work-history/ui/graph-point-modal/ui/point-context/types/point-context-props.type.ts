import type { ComponentPropsWithoutRef } from "react";
import type { WorkGraphPointDetail } from "domains/work-history";

/** Параметры визуальной области. */
export type PointContextParams = {
  /** Контекст и связи выбранного материала. */
  detail: WorkGraphPointDetail;
  /** Открывает связанный материал в том же окне. */
  onSelectPoint: (ref: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type PointContextProps = RootAttrs & PointContextParams;
