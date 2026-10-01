import type { ComponentPropsWithoutRef } from "react";
import type { OverviewMetricEntry, OverviewMetricRequest } from "domains/product-overview";

/** Подборка показателя из среза обзора. */
export type MetricPreview = {
  /** Полное число записей показателя. */
  total: number;
  /** Есть записи сверх подборки. */
  hasMore: boolean;
  /** Записи подборки, не более пяти. */
  entries: OverviewMetricEntry[];
};

/** Параметры показателя оператора с раскрытием полного списка. */
export type MetricDisclosureParams = {
  /** Название показателя: смысл числа, а не оценка. */
  title: string;
  /** Уровень заголовка в структуре блока. */
  headingLevel?: 3 | 4;
  /** Краткое разбиение рядом с числом, например по колонкам. */
  summary?: string | null;
  /** Пояснение: что входит в число и чем оно не является. */
  hint?: string | null;
  /** Раскрываемый полный список. */
  request: OverviewMetricRequest;
  /** Подборка из среза обзора. */
  preview: MetricPreview;
  /** Подборка видна и в свёрнутом состоянии; иначе показано только число. */
  isPreviewShown?: boolean;
  /** Пояснение нулевого показателя. */
  emptyText: string;
  /** Записи из разных колонок: у задачи показывается колонка. */
  shouldShowColumn?: boolean;
  /** Плитка на карточке или строка внутри уже выделенной области. */
  variant?: "tile" | "plain";
  /** Ненулевое число требует внимания и выделяется. */
  tone?: "neutral" | "attention";
  /** Версия показанного обзора. */
  snapshotVersion: string;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства показателя оператора с раскрытием полного списка. */
export type MetricDisclosureProps = RootAttrs & MetricDisclosureParams;
