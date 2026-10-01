import type { ComponentPropsWithoutRef } from "react";
import type { OverviewOperator, OverviewReleases } from "domains/product-overview";

/** Параметры сводки релизов. */
export type ReleaseSummariesParams = {
  /** Релизы проекта. */
  releases: OverviewReleases;
  /** Подготовка выпуска: готовые релизы и готовые планы вне релизов. */
  preparation: OverviewOperator["releasePreparation"];
  /** Версия показанного обзора: по ней раскрываются полные списки показателей. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сводки релизов. */
export type ReleaseSummariesProps = RootAttrs & ReleaseSummariesParams;
