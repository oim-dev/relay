import type { z } from "zod";
import { toWorkHistoryError, WorkHistoryError } from "../errors/work-history.error";

/** Проверяет ответ истории на границе домена и переводит транспортные отказы. */
export const readWorkData = async <T>(
  schema: z.ZodType<T>,
  read: () => Promise<{ data: unknown }>,
): Promise<T> => {
  let body: unknown;
  try {
    body = (await read()).data;
  } catch (error) {
    throw toWorkHistoryError(error);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new WorkHistoryError(
      "INVALID_RESPONSE",
      "Сервер вернул несовместимые данные истории работы. Обновите Server и Web вместе.",
    );
  return parsed.data;
};
