import { z } from "zod";
import { ApiError } from "infra/tasks-api";

const FAILURE_SCHEMA = z.object({
  error: z.object({ message: z.string(), code: z.string().optional() }),
});
/** Коды отказа, означающие, что прочитанное состояние устарело. */
const CONFLICT_CODES = new Set(["REVISION_CONFLICT", "ENTITIES_CHANGED", "VERSION_CONFLICT"]);
/** Предметные отказы изменения одной связи. */

/** Предусмотренная ошибка доступа, записи или версии библиотеки. */
export class DocumentAccessError extends Error {}

/**
 * Запись или выдача изменилась после прочтения: нужно перечитать состояние и решить заново,
 * повтор с прежней ревизией не выполняется.
 */
export class DocumentConflictError extends DocumentAccessError {}

/** Отказ изменения связи: такая связь уже есть или изменяемой связи больше нет. */
export class DocumentRelationError extends DocumentAccessError {
  /** Стабильный код Core. */
  readonly code: "ALREADY_EXISTS" | "RELATION_NOT_FOUND";

  constructor(
    code: "ALREADY_EXISTS" | "RELATION_NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/** Сохраняет диагностические дефекты, нормализуя только ожидаемые отказы. */
export const throwDocumentFailure = (failure: unknown): never => {
  if (failure instanceof ApiError) {
    const parsed = FAILURE_SCHEMA.safeParse(failure.error);
    const code = parsed.success ? (parsed.data.error.code ?? "") : "";
    const message = parsed.success ? parsed.data.error.message : "";
    if (CONFLICT_CODES.has(code)) throw new DocumentConflictError(message, { cause: failure });
    if (code === "ALREADY_EXISTS" || code === "RELATION_NOT_FOUND")
      throw new DocumentRelationError(code, message, { cause: failure });
    throw new DocumentAccessError(
      parsed.success && failure.status < 500
        ? message
        : "Ответ сервера не получен. Перед новой записью перечитайте состояние: операция могла выполниться.",
      { cause: failure },
    );
  }
  if (
    failure instanceof TypeError ||
    (failure instanceof DOMException && failure.name === "AbortError")
  )
    throw new DocumentAccessError(
      "Нет ответа сервера. Перед новой записью перечитайте состояние: повтор может создать дубликат.",
      { cause: failure },
    );
  throw failure;
};
