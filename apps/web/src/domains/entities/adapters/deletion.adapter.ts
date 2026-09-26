import { z } from "zod";
import { entityDeletedSchema, entityDeletionPreviewSchema } from "@relay/contracts/entities";
import type {
  DeleteEntity,
  EntityDeleted,
  EntityDeletionQuery,
  EntityDeletionPreview,
} from "@relay/contracts/entities";
import { ApiError, getProjectApi } from "infra/tasks-api";

const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/**
 * Отказ удаления с признаком необходимости нового подтверждения.
 */
export class EntityDeletionError extends Error {
  constructor(
    message: string,
    readonly shouldRefresh = false,
  ) {
    super(message);
  }
}

/**
 * Сохраняет различие конфликта и неопределённого сетевого результата.
 */
const throwDeletionFailure = (failure: unknown): never => {
  if (failure instanceof ApiError) {
    const response = FAILURE_SCHEMA.safeParse(failure.error);
    if (response.success && failure.status < 500) {
      throw new EntityDeletionError(
        response.data.error.message,
        response.data.error.code === "REVISION_CONFLICT",
      );
    }
    throw new EntityDeletionError(
      "Исход удаления неизвестен. Перечитайте состояние и состав каскада перед новым подтверждением.",
      true,
    );
  }
  if (
    failure instanceof TypeError ||
    (failure instanceof DOMException && failure.name === "AbortError")
  ) {
    throw new EntityDeletionError(
      "Исход удаления неизвестен. Перечитайте состояние и состав каскада перед новым подтверждением.",
      true,
    );
  }
  throw failure;
};

/**
 * Получает полный состав каскада; предпросмотр не подписывается на фоновое обновление.
 */
export const previewEntityDeletion = async (
  projectId: string,
  query: EntityDeletionQuery,
): Promise<EntityDeletionPreview> => {
  try {
    const response = await getProjectApi(projectId).entities.previewEntityDeletion(query);
    return entityDeletionPreviewSchema.parse(response.data);
  } catch (failure) {
    return throwDeletionFailure(failure);
  }
};

/**
 * Подтверждает именно просмотренную версию; requestId служит только корреляции.
 */
export const deleteEntity = async (
  projectId: string,
  command: DeleteEntity,
): Promise<EntityDeleted> => {
  try {
    const response = await getProjectApi(projectId).entities.deleteEntity(command);
    return entityDeletedSchema.parse(response.data);
  } catch (failure) {
    return throwDeletionFailure(failure);
  }
};
