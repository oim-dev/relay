/** Коды неуспешного чтения полного списка метрики обзора. */
export const OVERVIEW_METRIC_ERROR_CODE = {
  UNSUPPORTED: "OVERVIEW_METRIC_UNSUPPORTED",
  SNAPSHOT_CHANGED: "OVERVIEW_METRIC_SNAPSHOT_CHANGED",
  BLOCKER_NOT_FOUND: "OVERVIEW_METRIC_BLOCKER_NOT_FOUND",
  PROJECT_UNAVAILABLE: "OVERVIEW_METRIC_PROJECT_UNAVAILABLE",
  STORAGE_FAILURE: "OVERVIEW_METRIC_STORAGE_FAILURE",
  INVALID_RESPONSE: "OVERVIEW_METRIC_INVALID_RESPONSE",
  TEMPORARILY_UNAVAILABLE: "OVERVIEW_METRIC_TEMPORARILY_UNAVAILABLE",
} as const;

/** Предметные данные неуспешного чтения полного списка метрики. */
export type OverviewMetricErrorDetails =
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.UNSUPPORTED }>
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.SNAPSHOT_CHANGED }>
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.BLOCKER_NOT_FOUND }>
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.PROJECT_UNAVAILABLE }>
  | Readonly<{
      code: typeof OVERVIEW_METRIC_ERROR_CODE.STORAGE_FAILURE;
      payload: Readonly<{ message: string }>;
    }>
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.INVALID_RESPONSE }>
  | Readonly<{ code: typeof OVERVIEW_METRIC_ERROR_CODE.TEMPORARILY_UNAVAILABLE }>;

class OverviewMetricDomainError extends Error {
  readonly name = "OverviewMetricDomainError";

  constructor(readonly details: OverviewMetricErrorDetails) {
    super(`product-overview-metric:${details.code}`);
  }
}

/** Ошибка чтения полного списка метрики обзора. */
export type GetOverviewMetricError = OverviewMetricDomainError;

/** Сервер не поддерживает полные списки метрик оператора: версии не совпадают. */
export const createMetricUnsupportedError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.UNSUPPORTED });

/**
 * Срез проекта изменился после показанного обзора или между страницами:
 * страницы разных состояний не смешиваются, список перечитывается по новому срезу.
 */
export const createSnapshotChangedError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.SNAPSHOT_CHANGED });

/** Задача-блокер больше не найдена: удалена или перенесена из проекта. */
export const createBlockerNotFoundError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.BLOCKER_NOT_FOUND });

/** Проект не найден на сервере: отключён от workspace или удалён. */
export const createMetricProjectUnavailableError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.PROJECT_UNAVAILABLE });

/** Сервер не смог прочитать хранилище проекта. */
export const createMetricStorageFailureError = (message: string): GetOverviewMetricError =>
  new OverviewMetricDomainError({
    code: OVERVIEW_METRIC_ERROR_CODE.STORAGE_FAILURE,
    payload: { message },
  });

/** Ответ сервера не соответствует контракту; его нельзя показывать пустым списком. */
export const createMetricInvalidResponseError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.INVALID_RESPONSE });

/** Сервер временно недоступен или ответ не получен. */
export const createMetricTemporarilyUnavailableError = (): GetOverviewMetricError =>
  new OverviewMetricDomainError({ code: OVERVIEW_METRIC_ERROR_CODE.TEMPORARILY_UNAVAILABLE });

/** Проверяет, что значение — ошибка чтения списка метрики с заданным кодом. */
export const isOverviewMetricError = (
  error: unknown,
  code: OverviewMetricErrorDetails["code"],
): error is GetOverviewMetricError =>
  error instanceof OverviewMetricDomainError && error.details.code === code;
