import type { PlanStatus, PlanningPage } from "domains/planning";

/** Собственное состояние выпуска. */
export type ReleaseStatus = "planned" | "released" | "cancelled";
/** Полная серверная готовность выбранного состава. */
export type ReleaseSummary = {
  /** Всего планов. */
  total: number;
  /** Готовые планы. */
  ready: number;
  /** Недоступные планы. */
  missing: number;
  /** Полный процент. */
  percent: number;
  /** Допустима фиксация выпуска. */
  canRelease: boolean;
};
/** Самостоятельный релиз Web. */
export type Release = {
  /** ID. */
  id: string;
  /** Ключ. */
  key: string;
  /** Исходная ревизия. */
  revision: number;
  /** Название. */
  title: string;
  /** Обозначение выпуска. */
  version: string;
  /** Краткий текст. */
  summary: string;
  /** Описание Markdown. */
  description: string;
  /** Полный выбранный состав ID. */
  planIds: string[];
  /** Собственное состояние. */
  status: ReleaseStatus;
  /** Плановая дата. */
  plannedFor: string;
  /** Фактическая дата. */
  releasedAt: string | null;
  /** Автор выпуска. */
  releasedBy: string | null;
  /** Дата изменения. */
  updatedAt: string;
  /** Серверная готовность. */
  readiness: ReleaseSummary;
};
/** Актуальный план в составе выпуска. */
export type ReleasePlanItem = {
  /** ID плана. */
  id: string;
  /** Ключ. */
  key: string;
  /** Название. */
  title: string;
  /** Краткий текст. */
  summary: string;
  /** Цель Markdown. */
  goal: string;
  /** Итог Markdown. */
  result: string;
  /** Текущее состояние плана; null, если план недоступен. */
  status: PlanStatus | null;
  /** Выполненные задачи. */
  done: number;
  /** Все задачи. */
  total: number;
  /** Полный процент. */
  percent: number;
  /** Исходный план недоступен. */
  isMissing: boolean;
};
/** Страница выбранных планов с полными итогами. */
export type ReleaseComposition = PlanningPage<ReleasePlanItem> & {
  /** Полная готовность выбранного состава. */
  readiness: ReleaseSummary;
};
/** Проверка несохранённого состава формы вне кеша серверных GET-запросов. */
export type ReleasePreviewState = {
  /** Проверенный состав текущего выбора. */
  data: ReleaseComposition | undefined;
  /** Предусмотренный отказ проверки. */
  error: Error | undefined;
  /** Проверка текущего выбора ещё выполняется. */
  isLoading: boolean;
  /** Повторно проверить текущий выбор. */
  refresh: () => Promise<void>;
};
/** Поиск релизов. */
export type ReleaseFilters = {
  /** Текст поиска. */
  q?: string;
  /** Состояние. */
  status?: ReleaseStatus;
};
