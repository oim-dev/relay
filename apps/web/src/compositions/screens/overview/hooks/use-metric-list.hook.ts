import { useProjectId } from "domains/project";
import { useOverviewMetric } from "domains/product-overview";
import type { OverviewMetricEntry, OverviewMetricRequest } from "domains/product-overview";
import { isDefined } from "shared/value-predicates";
import { getMetricErrorMessage } from "../helpers/metric-error";
import type { MetricErrorMessage } from "../helpers/metric-error";

/** Состояние раскрытого списка метрики для отображения. */
export type MetricListState = {
  /** Показываемые записи: полный список либо подборка, пока он не прочитан. */
  entries: OverviewMetricEntry[];
  /** Чтение выполняется: первая страница, продолжение или новое состояние. */
  isBusy: boolean;
  /** Сообщение о ходе чтения. */
  statusText: string | null;
  /** Сколько записей показано из полного числа. */
  loadedNote: string | null;
  /** Отказ чтения. */
  error: MetricErrorMessage | null;
  /** Есть следующая страница. */
  hasMore: boolean;
  /** Следующая страница читается. */
  isLoadingMore: boolean;
  /** Дочитать следующую страницу. */
  loadMore: () => void;
  /** Перечитать загруженный объём заново. */
  retry: () => void;
};

/**
 * Связывает раскрытие показателя с постраничным полным списком того же среза.
 * Пока полный список не прочитан, показывается подборка обзора; при обновлении
 * среза видны прежние записи, пока новые страницы не прочитаны.
 *
 * @param request Метрика либо `null`, пока список свёрнут.
 * @param snapshotVersion Версия показанного обзора.
 * @param previewEntries Записи подборки обзора.
 */
export const useMetricList = (
  request: OverviewMetricRequest | null,
  snapshotVersion: string,
  previewEntries: OverviewMetricEntry[],
): MetricListState => {
  const projectId = useProjectId();
  const query = useOverviewMetric(projectId, request, snapshotVersion);
  const pages = request === null ? [] : (query.data ?? []);
  const lastPage = pages.at(-1);
  const hasData = isDefined(lastPage);
  const error =
    request !== null && isDefined(query.error) ? getMetricErrorMessage(query.error) : null;
  // Страницы прежнего среза видны, пока читается новое состояние того же объёма.
  const isRefreshing = hasData && lastPage.snapshotVersion !== snapshotVersion && !isDefined(error);
  const isFirstLoading = request !== null && !hasData && !isDefined(error);
  const isLoadingMore = hasData && query.isValidating && pages.length < query.size;
  const entries = hasData ? pages.flatMap((page) => page.entries) : previewEntries;
  const statusText = isFirstLoading
    ? "Загружаем полный список…"
    : isRefreshing
      ? "Обновляем список по новому состоянию проекта…"
      : null;
  const loadedNote = hasData ? `Показано ${entries.length} из ${lastPage.total}` : null;
  return {
    entries,
    isBusy: isFirstLoading || isRefreshing || isLoadingMore,
    statusText,
    loadedNote,
    error,
    hasMore: hasData && lastPage.nextCursor !== null,
    isLoadingMore,
    loadMore: () => void query.setSize(query.size + 1).catch(() => undefined),
    // Перечитывается весь загруженный объём, а не только первая страница.
    retry: () => void query.mutate().catch(() => undefined),
  };
};
