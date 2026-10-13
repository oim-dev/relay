import { z } from "zod";
import { productOverviewSchema } from "@relay/contracts/entities/product";
import { ApiError, getProjectApi, getStorageFailureMessage } from "infra/tasks-api";
import {
  createInvalidResponseError,
  createProjectUnavailableError,
  createStorageFailureError,
  createStorageMaintenanceError,
  createTemporarilyUnavailableError,
} from "../errors/product-overview.error";
import { mapProductOverviewDto } from "../mappers/product-overview.mapper";
import type { ProductOverview } from "../types/product-overview.type";

/** Форма отказа сервера: код и сообщение для человека. */
const FAILURE_SCHEMA = z.object({ error: z.object({ message: z.string() }) });

/** Классифицирует отказ HTTP-запроса в исход чтения обзора. */
const toOverviewError = (error: unknown) => {
  if (!(error instanceof ApiError)) return createTemporarilyUnavailableError();
  if (error.status === 404) return createProjectUnavailableError();
  const storageMessage = getStorageFailureMessage(error);
  if (storageMessage !== null) return createStorageMaintenanceError(storageMessage, error);
  const failure = FAILURE_SCHEMA.safeParse(error.error);
  if (error.status >= 500 && failure.success)
    return createStorageFailureError(failure.data.error.message);
  return createTemporarilyUnavailableError();
};

/**
 * Читает согласованный срез проекта одним запросом и проверяет его схемой Contracts.
 */
export const getProductOverview = async (projectId: string): Promise<ProductOverview> => {
  let body: unknown;
  try {
    const response = await getProjectApi(projectId).product.getProductOverview();
    body = response.data;
  } catch (error) {
    throw toOverviewError(error);
  }
  const parsed = productOverviewSchema.safeParse(body);
  if (!parsed.success) throw createInvalidResponseError();
  return mapProductOverviewDto(parsed.data);
};
