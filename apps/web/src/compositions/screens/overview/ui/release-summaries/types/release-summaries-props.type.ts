import type { ComponentPropsWithoutRef } from "react";
import type { OverviewReleases } from "domains/product-overview";

/** Параметры сводки релизов. */
export type ReleaseSummariesParams = {
  /** Релизы проекта. */
  releases: OverviewReleases;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сводки релизов. */
export type ReleaseSummariesProps = RootAttrs & ReleaseSummariesParams;
