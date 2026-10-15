import { z } from "zod";
import { ApiError, getStorageFailureMessage } from "infra/tasks-api";

/** Ожидаемый отказ чтения истории работы. */
export class WorkHistoryError extends Error {
  /** Машинный исход для политики повторного чтения. */
  readonly code: string;

  /**
   * Сохраняет исход и безопасное сообщение для человека.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkHistoryError";
    this.code = code;
  }
}

const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
/** Нативные сообщения Fetch о сетевом отказе; произвольный TypeError остаётся дефектом кода. */
const FETCH_NETWORK_MESSAGES = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

/**
 * Переводит транспортный отказ в исход чтения; дефекты кода не маскируются под пустую историю.
 */
export const toWorkHistoryError = (error: unknown): Error => {
  if (!(error instanceof ApiError)) {
    if (error instanceof DOMException && error.name === "TimeoutError")
      return new WorkHistoryError("TIMEOUT", "Сервер не ответил вовремя. Повторите чтение.");
    if (error instanceof DOMException && error.name === "AbortError")
      return new WorkHistoryError(
        "ABORTED",
        "Чтение прервано или превышено время ожидания ответа. Повторите чтение.",
      );
    if (error instanceof TypeError && FETCH_NETWORK_MESSAGES.has(error.message))
      return new WorkHistoryError(
        "UNAVAILABLE",
        "Сервер недоступен. Проверьте соединение и повторите чтение.",
      );
    if (error instanceof Error) return error;
    return new Error("Неожиданная ошибка чтения истории работы.", { cause: error });
  }
  const failure = FAILURE_SCHEMA.safeParse(error.error);
  const code = failure.success ? failure.data.error.code : "UNAVAILABLE";
  if (code === "VERSION_CONFLICT")
    return new WorkHistoryError(
      code,
      "История изменилась между страницами. Показанные материалы сохранены. Перечитайте список с начала.",
    );
  const storageMessage = getStorageFailureMessage(error);
  if (storageMessage !== null) return new WorkHistoryError("STORAGE_ERROR", storageMessage);
  if (code === "NOT_FOUND" || code === "ENTITY_NOT_FOUND")
    return new WorkHistoryError(
      code,
      "Ветка или точка не найдена в этом проекте. Проверьте адрес или выберите запись в каталоге.",
    );
  if (code === "PROJECT_NOT_FOUND")
    return new WorkHistoryError(
      code,
      "Выбранный проект недоступен. Данные другого проекта не подставлены.",
    );
  return new WorkHistoryError(
    code,
    failure.success
      ? failure.data.error.message
      : "Не удалось прочитать историю работы. Повторите чтение.",
  );
};
