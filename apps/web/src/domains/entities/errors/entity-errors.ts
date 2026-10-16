import { z } from "zod";
import { entityRelocatedDetailsSchema } from "@relay/contracts/storage-maintenance";
import { ApiError, getStorageFailureMessage } from "infra/tasks-api";
import type { EntityRelocation } from "../types/entity-relocation.type";

/** Отказ сервера: текст, стабильный код и необязательные машинные сведения Core. */
const FAILURE_SCHEMA = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

/** Ожидаемая недоступность или отказ чтения сохраняет работающую форму. */
export class EntityAccessError extends Error {
  /** Стабильный код Core; null, если сервер не ответил или код не передан. */
  readonly code: string | null;

  constructor(message: string, code: string | null, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Прежний адрес перенесён владельцу (ENTITY_RELOCATED): карточки по нему нет, а сведения
 * о переносе называют текущую цель и прежний ключ.
 */
export class EntityRelocatedError extends EntityAccessError {
  /** Куда перенесена запись. */
  readonly relocation: EntityRelocation;

  constructor(message: string, relocation: EntityRelocation, options?: ErrorOptions) {
    super(message, "ENTITY_RELOCATED", options);
    this.relocation = relocation;
  }
}

/**
 * Читает details ENTITY_RELOCATED по контракту; несогласованная форма не выдаётся за перенос.
 *
 * @returns Перенос либо `null`, если details не соответствуют контракту.
 */
const parseRelocation = (details: unknown): EntityRelocation | null => {
  const parsed = entityRelocatedDetailsSchema.safeParse(details);
  if (!parsed.success) return null;
  // Адрес вида `kind:id`: ID может содержать двоеточие, вид — нет.
  const separator = parsed.data.to.indexOf(":");
  const kind = parsed.data.to.slice(0, separator);
  const id = parsed.data.to.slice(separator + 1);
  if (separator <= 0 || id === "") return null;
  return {
    from: parsed.data.from,
    owner: { kind, id },
    stageId: parsed.data.stageId,
    key: parsed.data.key,
  };
};

/**
 * Отделяет ожидаемые ошибки доступа от нарушения контракта приложения.
 *
 * @returns Предметная ошибка для ожидаемого отказа либо исходная ошибка-дефект.
 */
export const toEntityFailure = (failure: unknown): unknown => {
  if (failure instanceof ApiError) {
    const response = FAILURE_SCHEMA.safeParse(failure.error);
    if (response.success && failure.status < 500) {
      const { message, code, details } = response.data.error;
      const relocation = code === "ENTITY_RELOCATED" ? parseRelocation(details) : null;
      if (relocation !== null)
        return new EntityRelocatedError(message, relocation, { cause: failure });
      return new EntityAccessError(getStorageFailureMessage(failure) ?? message, code ?? null, {
        cause: failure,
      });
    }
    if (failure.status === 502 || failure.status === 503) {
      return new EntityAccessError(
        "Сервер недоступен. Обновите варианты после восстановления соединения.",
        null,
        { cause: failure },
      );
    }
  }
  if (failure instanceof TypeError) {
    return new EntityAccessError(
      "Не удалось загрузить сущности. Проверьте соединение и повторите запрос.",
      null,
      { cause: failure },
    );
  }
  return failure;
};

/** Бросает предметную ошибку ожидаемого отказа или исходный дефект. */
export const throwEntityFailure = (failure: unknown): never => {
  throw toEntityFailure(failure);
};
