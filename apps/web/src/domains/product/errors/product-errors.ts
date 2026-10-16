import { z } from "zod";
import { ApiError } from "infra/tasks-api";

const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string().optional() }) });
/** Коды Core: запись продукта или связанная сущность отсутствует. */
const NOT_FOUND_CODES = new Set(["PRODUCT_RECORD_NOT_FOUND", "ENTITY_NOT_FOUND"]);

/**
 * Записи продукта (фичи, сценария, приложения, реализации) с таким адресом нет в проекте:
 * её удалили или адрес неверен. Повтор чтения не поможет — нужен возврат к списку.
 */
export class ProductNotFoundError extends Error {}

/** Переводит отказ сервера «запись не найдена» в предметную ошибку; прочее не меняет. */
export const toProductReadFailure = (failure: unknown): unknown => {
  if (!(failure instanceof ApiError)) return failure;
  const parsed = FAILURE_SCHEMA.safeParse(failure.error);
  if (parsed.success && NOT_FOUND_CODES.has(parsed.data.error.code ?? ""))
    return new ProductNotFoundError("Запись продукта не найдена", { cause: failure });
  return failure;
};
