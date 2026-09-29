import { PRODUCT_OVERVIEW_ERROR_CODE } from "domains/product-overview";
import type { GetProductOverviewError } from "domains/product-overview";

/**
 * Объясняет отказ чтения обзора и следующий шаг человеку.
 */
export const getOverviewErrorMessage = (error: GetProductOverviewError): string => {
  const { details } = error;
  switch (details.code) {
    case PRODUCT_OVERVIEW_ERROR_CODE.PROJECT_UNAVAILABLE:
      return "Проект недоступен на сервере. Проверьте подключение проекта или выберите другой.";
    case PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_FAILURE:
      return `Сервер не смог прочитать хранилище проекта: ${details.payload.message}`;
    case PRODUCT_OVERVIEW_ERROR_CODE.INVALID_RESPONSE:
      return "Сервер вернул обзор в неожиданном формате. Версии сервера и интерфейса могут не совпадать.";
    case PRODUCT_OVERVIEW_ERROR_CODE.TEMPORARILY_UNAVAILABLE:
      return "Сервер не ответил. Проверьте, что он запущен, и повторите чтение.";
  }
};
