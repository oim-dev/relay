import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { isStorageFailure } from "infra/tasks-api";
import type { SWRInfiniteResponse } from "swr/infinite";
import {
  getOverviewMetricPage,
  getOverviewMetricsSupport,
} from "../adapters/get-overview-metric.adapter";
import {
  OVERVIEW_METRIC_ERROR_CODE,
  createMetricUnsupportedError,
  isOverviewMetricError,
} from "../errors/overview-metric.error";
import type { GetOverviewMetricError } from "../errors/overview-metric.error";
import { getProductOverviewKey } from "../helpers/get-product-overview-key";
import type { OverviewMetricPage, OverviewMetricRequest } from "../types/product-overview.type";

/** Ключ страницы: проект, раскрываемая метрика, версия показанного среза и продолжение. */
type MetricPageKey = readonly [
  "product-overview-metric",
  string,
  OverviewMetricRequest,
  string,
  string | null,
];

/** Ошибки, которые не исправит повтор того же запроса. */
const FINAL_ERRORS = [
  OVERVIEW_METRIC_ERROR_CODE.UNSUPPORTED,
  OVERVIEW_METRIC_ERROR_CODE.SNAPSHOT_CHANGED,
  OVERVIEW_METRIC_ERROR_CODE.BLOCKER_NOT_FOUND,
  OVERVIEW_METRIC_ERROR_CODE.INVALID_RESPONSE,
];

const fetchPage = ([, projectId, request, version, cursor]: MetricPageKey) =>
  getOverviewMetricPage(projectId, request, version, cursor);

/**
 * Полный список метрики оператора, раскрываемый постранично по действию.
 *
 * Страницы привязаны к `snapshotVersion` показанного обзора: ключ содержит версию,
 * поэтому новое состояние читается заново тем же числом страниц, а продолжение
 * каждой страницы берётся из только что прочитанной предыдущей — страницы разных
 * срезов не склеиваются. Пока новые страницы читаются, видны прежние (последние
 * корректные) записи. Собственной подписки на поток нет: обзор перечитывается по SSE,
 * и его новая версия обновляет список. Если срез сменился раньше, чем обзор узнал
 * об этом (`VERSION_CONFLICT`), перечитывается сам обзор. Без возможности
 * `relay-overview-metrics-v1` на сервере запрос не выполняется — ошибка несовместимости.
 * Исчезнувший блокер затронутых задач тоже перечитывает обзор: его запись уходит из списка.
 *
 * @param request Метрика либо `null`, пока список не раскрыт.
 */
export const useOverviewMetric = (
  projectId: string,
  request: OverviewMetricRequest | null,
  snapshotVersion: string,
): SWRInfiniteResponse<OverviewMetricPage, GetOverviewMetricError> => {
  const { mutate } = useSWRConfig();
  const support = useSWR<boolean, GetOverviewMetricError>(
    request === null ? null : ["product-overview-metrics-support", projectId],
    () => getOverviewMetricsSupport(projectId),
    { revalidateOnFocus: false, revalidateIfStale: false },
  );
  const isSupported = support.data === true;
  const query = useSWRInfinite<OverviewMetricPage, GetOverviewMetricError>(
    (index: number, previous: OverviewMetricPage | null): MetricPageKey | null => {
      if (request === null || !isSupported || previous?.nextCursor === null) return null;
      const cursor = index === 0 ? null : (previous?.nextCursor ?? null);
      return ["product-overview-metric", projectId, request, snapshotVersion, cursor];
    },
    fetchPage,
    {
      // Число загруженных страниц сохраняется при смене версии: перечитывается тот же объём.
      persistSize: true,
      keepPreviousData: true,
      // Страница версии неизменна: повторно читать её незачем.
      revalidateFirstPage: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: (error) =>
        !isStorageFailure(error) &&
        !FINAL_ERRORS.some((code) => isOverviewMetricError(error, code)),
    },
  );
  const { error } = query;
  useEffect(() => {
    // Показанный срез устарел или блокер исчез: новое состояние и список блокеров
    // без него приходят через перечитывание обзора. Каждый новый отказ, в том числе
    // после ручного повтора, снова перечитывает обзор.
    if (
      isOverviewMetricError(error, OVERVIEW_METRIC_ERROR_CODE.SNAPSHOT_CHANGED) ||
      isOverviewMetricError(error, OVERVIEW_METRIC_ERROR_CODE.BLOCKER_NOT_FOUND)
    )
      void mutate(getProductOverviewKey(projectId));
  }, [error, mutate, projectId]);
  if (support.data === false) return { ...query, error: createMetricUnsupportedError() };
  if (support.error !== undefined && !isSupported) return { ...query, error: support.error };
  return query;
};
