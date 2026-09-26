import { HttpClient, ApiError } from "@relay/rest-sdk/http-client";
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { operationsTree } from "@relay/rest-sdk/operations-tree";
import { AppError } from "@relay/core/shared/errors";
import { z } from "zod";
import { serverUrlSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";

const failure = z.object({
  error: z.object({ code: z.string(), message: z.string(), exitCode: z.number().optional() }),
});

/** Клиент реестра; проектные операции получают отдельный неизменяемый HTTP-контекст. */
export function createServerApi(url: string) {
  const origin = new URL(parse(serverUrlSchema, url, "адрес Relay Server")).origin;
  return createApiClient(
    new HttpClient({
      baseUrl: origin,
      timeout: 15000,
      redirect: "error",
      onError(error, context) {
        const write = !["GET", "HEAD"].includes(context.request.method ?? "GET");
        const uncertain = ". Запись могла завершиться. Перечитайте реестр перед новой отправкой";
        if (error instanceof ApiError) {
          const parsed = failure.safeParse(error.error);
          if (parsed.success)
            throw new AppError(
              parsed.data.error.code,
              parsed.data.error.message + (write && error.status >= 500 ? uncertain : ""),
              parsed.data.error.exitCode ?? 5,
            );
        }
        throw new AppError(
          "SERVER_UNAVAILABLE",
          "Relay Server недоступен. Проверьте адрес и запуск сервера" + (write ? uncertain : ""),
          5,
        );
      },
    }),
    operationsTree,
  );
}
