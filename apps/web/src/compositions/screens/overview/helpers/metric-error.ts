import { OVERVIEW_METRIC_ERROR_CODE } from "domains/product-overview";
import type { GetOverviewMetricError } from "domains/product-overview";

/** Объяснение отказа чтения полного списка метрики и следующий шаг человека. */
export type MetricErrorMessage = {
  /** Текст для человека. */
  text: string;
  /** Повтор чтения может помочь. */
  canRetry: boolean;
  /** Это ожидаемое обновление состояния, а не сбой: сообщается без тревоги. */
  isUpdate: boolean;
};

/**
 * Объясняет отказ чтения полного списка метрики обзора.
 */
export const getMetricErrorMessage = (error: GetOverviewMetricError): MetricErrorMessage => {
  const { details } = error;
  switch (details.code) {
    case OVERVIEW_METRIC_ERROR_CODE.SNAPSHOT_CHANGED:
      return {
        text: "Данные проекта изменились — перечитываем обзор и список по новому состоянию.",
        canRetry: true,
        isUpdate: true,
      };
    case OVERVIEW_METRIC_ERROR_CODE.UNSUPPORTED:
      return {
        text: "Сервер не умеет раскрывать полные списки показателей обзора: версии сервера и интерфейса не совпадают. Обновите Relay Server.",
        canRetry: false,
        isUpdate: false,
      };
    case OVERVIEW_METRIC_ERROR_CODE.BLOCKER_NOT_FOUND:
      return {
        text: "Задача-блокер больше не найдена: её удалили или перенесли — обновляем список блокеров.",
        canRetry: false,
        isUpdate: true,
      };
    case OVERVIEW_METRIC_ERROR_CODE.STORAGE_FAILURE:
      return {
        text: `Сервер не смог прочитать хранилище проекта: ${details.payload.message}`,
        canRetry: true,
        isUpdate: false,
      };
    case OVERVIEW_METRIC_ERROR_CODE.INVALID_RESPONSE:
      return {
        text: "Сервер вернул список в неожиданном формате. Версии сервера и интерфейса могут не совпадать.",
        canRetry: true,
        isUpdate: false,
      };
    case OVERVIEW_METRIC_ERROR_CODE.TEMPORARILY_UNAVAILABLE:
      return {
        text: "Нет связи с сервером Relay — полный список не прочитан. Проверьте, что сервер запущен и сеть доступна, и повторите.",
        canRetry: true,
        isUpdate: false,
      };
  }
};
