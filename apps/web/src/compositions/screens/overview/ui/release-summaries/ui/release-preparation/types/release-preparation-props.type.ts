import type { ComponentPropsWithoutRef } from "react";
import type { OverviewOperator } from "domains/product-overview";

/** Параметры подготовки выпуска. */
export type ReleasePreparationParams = {
  /** Готовые запланированные релизы и готовые завершённые планы вне релизов. */
  preparation: OverviewOperator["releasePreparation"];
  /** Версия показанного обзора. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства подготовки выпуска. */
export type ReleasePreparationProps = RootAttrs & ReleasePreparationParams;
