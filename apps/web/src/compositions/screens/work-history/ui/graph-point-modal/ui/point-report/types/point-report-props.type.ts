import type { ComponentPropsWithoutRef, Ref } from "react";
import type { WorkGraphPointDetail } from "domains/work-history";

/** Параметры визуальной области. */
export type PointReportParams = {
  /** Полный материал выбранной точки и сохранённое авторство. */
  detail: WorkGraphPointDetail;
  /** Заголовок для фокуса после адресного переключения. */
  titleRef: Ref<HTMLHeadingElement>;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children" | "aria-labelledby">;
/** Свойства визуальной области. */
export type PointReportProps = RootAttrs & PointReportParams;
