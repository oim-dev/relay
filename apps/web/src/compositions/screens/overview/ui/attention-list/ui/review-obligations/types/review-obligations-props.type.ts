import type { ComponentPropsWithoutRef } from "react";
import type { OverviewOperator } from "domains/product-overview";

/** Параметры разделения задач на проверке по готовности обязательств. */
export type ReviewObligationsParams = {
  /** Задачи на проверке, разделённые на две непересекающиеся группы. */
  review: OverviewOperator["review"];
  /** Версия показанного обзора. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства разделения задач на проверке. */
export type ReviewObligationsProps = RootAttrs & ReviewObligationsParams;
