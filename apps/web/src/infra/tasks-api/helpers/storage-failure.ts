import { z } from "zod";
import { ApiError } from "@relay/rest-sdk/http-client";

/** Отказ сервера с кодом и необязательным следующим действием Core. */
const FAILURE_SCHEMA = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.object({ next: z.string().optional() }).loose().optional(),
  }),
});
/** Строка каталога проектов вида `КОД: сообщение`. */
const AVAILABILITY_PATTERN = /^([A-Z][A-Z0-9_]*): (.+)$/s;
/** Следующий шаг, когда сервер не передал собственный. */
const DEFAULT_NEXT =
  "в каталоге проекта выполните relay-cli --local storage status, затем storage migrate по его указаниям";

/**
 * Семейство совместимости хранилища по HTTP-контракту: база требует явного
 * обслуживания (migrate, recovery, reindex) владельцем, а не повтора запроса.
 */
const isStorageCode = (code: string): boolean =>
  code.startsWith("STORAGE_") || code === "UNKNOWN_ENTITY_KIND";

/**
 * Собирает объяснение для человека: причина и код сервера, отсутствие действия
 * со стороны Web и локальная команда обслуживания.
 */
const formatStorageFailure = (code: string, message: string, next?: string): string => {
  const reason = message.replace(/[.\s]+$/, "");
  const action = (next ?? DEFAULT_NEXT).replace(/[.\s]+$/, "");
  return `${reason} (${code}). Web не изменяет хранилище. Следующий шаг: ${action}.`;
};

/** Находит отказ REST в ошибке или в цепочке её причин. */
const findApiError = (error: unknown): ApiError | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof ApiError) return current;
    current = current.cause;
  }
  return undefined;
};

/**
 * Объясняет отказ из-за несовместимого или требующего обслуживания хранилища.
 * Запрос с таким ответом не выполнен; его нельзя повторять автоматически.
 *
 * @returns Текст для человека либо `null`, если это другой отказ.
 */
export const getStorageFailureMessage = (error: unknown): string | null => {
  const apiError = findApiError(error);
  if (apiError === undefined || apiError.status !== 409) return null;
  const failure = FAILURE_SCHEMA.safeParse(apiError.error);
  if (!failure.success || !isStorageCode(failure.data.error.code)) return null;
  const { code, message, details } = failure.data.error;
  return formatStorageFailure(code, message, details?.next);
};

/** Отказ хранилища, автоматический повтор которого бесполезен. */
export const isStorageFailure = (error: unknown): boolean =>
  getStorageFailureMessage(error) !== null;

/**
 * Объясняет причину недоступности проекта из каталога сервера (`КОД: сообщение`);
 * другие причины возвращаются без изменений.
 */
export const getProjectAvailabilityMessage = (error: string): string => {
  const [, code, message] = AVAILABILITY_PATTERN.exec(error) ?? [];
  if (code === undefined || message === undefined || !isStorageCode(code)) return error;
  return formatStorageFailure(code, message);
};
