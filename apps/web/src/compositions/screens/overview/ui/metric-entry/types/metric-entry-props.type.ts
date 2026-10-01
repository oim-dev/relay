import type { OverviewMetricEntry } from "domains/product-overview";

/** Свойства записи показателя оператора. */
export type MetricEntryProps = {
  /** Запись полного списка или подборки показателя. */
  entry: OverviewMetricEntry;
  /** Версия показанного обзора: по ней раскрываются вложенные списки. */
  snapshotVersion: string;
  /** Наибольшее число незавершённых задач среди показанных досок. */
  boardScale: number;
  /** Показывать колонку задачи: список объединяет разные колонки. */
  shouldShowColumn: boolean;
  /** Базовый адрес проекта. */
  basePath: string;
};
