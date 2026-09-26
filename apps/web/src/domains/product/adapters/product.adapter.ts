import { z } from "zod";
import { getProjectApi, ApiError } from "infra/tasks-api";
import { PRODUCT_STATE_SCHEMA } from "../config/product.schema";
import type { ProductCommand, ProductState } from "../types/product.type";

/**
 * Читает и проверяет серверный продукт выбранной области Relay.
 */
export const getProduct = async (projectId: string): Promise<ProductState> => {
  const response = await getProjectApi(projectId).product.getProductState();
  return PRODUCT_STATE_SCHEMA.parse(response.data);
};

/**
 * Сохраняет одну запись через общий REST-клиент.
 */
export const saveProduct = async (
  projectId: string,
  command: ProductCommand,
): Promise<{ id: string; revision: number }> => {
  const response = await getProjectApi(projectId).product.mutateProduct(command);
  return z.object({ id: z.string(), revision: z.number() }).parse(response.data);
};

/**
 * Возвращает понятное сообщение ожидаемого отказа записи.
 */
export const productError = (error: unknown): string => {
  if (error instanceof ApiError) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(error.error);
    if (parsed.success && error.status < 500) return parsed.data.error.message;
  }
  return "Исход сохранения неизвестен. Ввод сохранён. Перечитайте состояние перед новой отправкой: повтор может создать дубликат.";
};
