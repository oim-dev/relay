/** Коды неуспешного чтения обзора проекта. */
export const PRODUCT_OVERVIEW_ERROR_CODE = {
  PROJECT_UNAVAILABLE: "PRODUCT_OVERVIEW_PROJECT_UNAVAILABLE",
  STORAGE_FAILURE: "PRODUCT_OVERVIEW_STORAGE_FAILURE",
  INVALID_RESPONSE: "PRODUCT_OVERVIEW_INVALID_RESPONSE",
  TEMPORARILY_UNAVAILABLE: "PRODUCT_OVERVIEW_TEMPORARILY_UNAVAILABLE",
} as const;

/** Предметные данные неуспешного чтения обзора. */
export type ProductOverviewErrorDetails =
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.PROJECT_UNAVAILABLE }>
  | Readonly<{
      code: typeof PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_FAILURE;
      payload: Readonly<{ message: string }>;
    }>
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.INVALID_RESPONSE }>
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.TEMPORARILY_UNAVAILABLE }>;

class ProductOverviewDomainError extends Error {
  readonly name = "ProductOverviewDomainError";

  constructor(readonly details: ProductOverviewErrorDetails) {
    super(`product-overview:${details.code}`);
  }
}

/** Ошибка чтения обзора проекта. */
export type GetProductOverviewError = ProductOverviewDomainError;

/** Проект недоступен или не найден сервером. */
export const createProjectUnavailableError = (): GetProductOverviewError =>
  new ProductOverviewDomainError({ code: PRODUCT_OVERVIEW_ERROR_CODE.PROJECT_UNAVAILABLE });

/** Сервер не смог прочитать хранилище проекта. */
export const createStorageFailureError = (message: string): GetProductOverviewError =>
  new ProductOverviewDomainError({
    code: PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_FAILURE,
    payload: { message },
  });

/** Ответ сервера не соответствует контракту обзора; его нельзя показывать нулями. */
export const createInvalidResponseError = (): GetProductOverviewError =>
  new ProductOverviewDomainError({ code: PRODUCT_OVERVIEW_ERROR_CODE.INVALID_RESPONSE });

/** Сервер временно недоступен или ответ не получен. */
export const createTemporarilyUnavailableError = (): GetProductOverviewError =>
  new ProductOverviewDomainError({ code: PRODUCT_OVERVIEW_ERROR_CODE.TEMPORARILY_UNAVAILABLE });
