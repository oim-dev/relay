import type { ComponentPropsWithoutRef } from "react";
import type { OverviewPreview, OverviewRelease } from "domains/product-overview";

/** Параметры группы релизов. */
export type ReleaseGroupParams = {
  /** Название группы. */
  title: string;
  /** Пояснение пустой группы. */
  emptyText: string;
  /** Подборка релизов группы. */
  preview: OverviewPreview<OverviewRelease>;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства группы релизов. */
export type ReleaseGroupProps = RootAttrs & ReleaseGroupParams;
