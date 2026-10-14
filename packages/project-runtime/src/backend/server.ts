import { HttpClient, ApiError } from "@relay/rest-sdk/http-client";
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { getProjects } from "@relay/rest-sdk/operations/get-projects";
import { getServerContext } from "@relay/rest-sdk/operations/get-server-context";
import { registerProject } from "@relay/rest-sdk/operations/register-project";
import { unregisterProject } from "@relay/rest-sdk/operations/unregister-project";
import { getServerCapabilities } from "@relay/rest-sdk/operations/get-server-capabilities";
import { getProjectCatalogPage } from "@relay/rest-sdk/operations/get-project-catalog-page";
import { registerProjectCompact } from "@relay/rest-sdk/operations/register-project-compact";
import { unregisterProjectCompact } from "@relay/rest-sdk/operations/unregister-project-compact";
import {
  PROJECT_CATALOG_CAPABILITY,
  serverContextResponseSchema,
  serverCapabilitiesSchema,
  projectCatalogPageSchema,
  projectRegistrationReceiptSchema,
  projectUnregistrationReceiptSchema,
} from "@relay/contracts/server-context";
import { AppError } from "@relay/core/shared/errors";
import { z } from "zod";
import { serverUrlSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";

const failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    exitCode: z.number().optional(),
    details: z.unknown().optional(),
  }),
});

const capabilitiesResponse = serverContextResponseSchema.extend({ data: serverCapabilitiesSchema });
const pageResponse = serverContextResponseSchema.extend({ data: projectCatalogPageSchema });
const registrationResponse = serverContextResponseSchema.extend({
  data: projectRegistrationReceiptSchema,
});
const unregistrationResponse = serverContextResponseSchema.extend({
  data: projectUnregistrationReceiptSchema,
});

/** Клиент реестра; проектные операции получают отдельный неизменяемый HTTP-контекст. */
export function createServerApi(url: string) {
  const origin = new URL(parse(serverUrlSchema, url, "адрес Relay Server")).origin;
  const uncertain = ". Запись могла завершиться. Перечитайте реестр перед новой отправкой";
  const incompatible = () =>
    new AppError(
      "SERVER_INCOMPATIBLE",
      `Серверные страницы и компактные квитанции требуют Relay Server с ${PROJECT_CATALOG_CAPABILITY}. Обновите и перезапустите Server. Полный каталог или local автоматически не используются.`,
      5,
      { url: origin, capability: PROJECT_CATALOG_CAPABILITY },
    );
  const api = createApiClient(
    new HttpClient({
      baseUrl: origin,
      timeout: 15000,
      redirect: "error",
      onResponse(response, context) {
        const path = context.request.path;
        const method = context.request.method ?? "GET";
        const schema =
          method === "GET" && path === "/api/v1/server/capabilities"
            ? capabilitiesResponse
            : method === "GET" && path === "/api/v1/projects/page"
              ? pageResponse
              : /^\/api\/v1\/projects\/[^/]+\/registration$/.test(path)
                ? method === "DELETE"
                  ? unregistrationResponse
                  : registrationResponse
                : serverContextResponseSchema;
        const parsed = schema.safeParse(response.data);
        if (!parsed.success) {
          const write = !["GET", "HEAD"].includes(context.request.method ?? "GET");
          throw new AppError(
            "INVALID_SERVER_RESPONSE",
            "Relay Server вернул неверный конверт или каталог проектов" + (write ? uncertain : ""),
            5,
            { url: origin, issues: parsed.error.issues },
          );
        }
        return response;
      },
      onError(error, context) {
        if (error instanceof AppError) throw error;
        const write = !["GET", "HEAD"].includes(context.request.method ?? "GET");
        if (error instanceof SyntaxError)
          throw new AppError(
            "INVALID_SERVER_RESPONSE",
            "Relay Server вернул ответ, не являющийся JSON" + (write ? uncertain : ""),
            5,
            { url: origin },
          );
        if (error instanceof ApiError) {
          if (context.request.path === "/api/v1/server/capabilities" && error.status === 404)
            throw incompatible();
          const parsed = failure.safeParse(error.error);
          if (parsed.success)
            throw new AppError(
              parsed.data.error.code,
              parsed.data.error.message + (write && error.status >= 500 ? uncertain : ""),
              parsed.data.error.exitCode ??
                (error.status === 404 ? 3 : error.status === 409 ? 4 : error.status < 500 ? 2 : 5),
              parsed.data.error.details,
            );
        }
        throw new AppError(
          "SERVER_UNAVAILABLE",
          "Relay Server недоступен. Проверьте адрес и запуск сервера" + (write ? uncertain : ""),
          5,
        );
      },
    }),
    {
      server: { getServerContext, getServerCapabilities },
      projects: {
        getProjects,
        registerProject,
        unregisterProject,
        getProjectCatalogPage,
        registerProjectCompact,
        unregisterProjectCompact,
      },
    },
  );
  // Только capability кешируется в пределах клиента; состояние каталога всегда читается заново.
  let capability: Promise<void> | undefined;
  const requireCatalog = () =>
    (capability ??= api.server
      .getServerCapabilities()
      .then(({ data }) => {
        if (!data.capabilities.includes(PROJECT_CATALOG_CAPABILITY)) throw incompatible();
      })
      .catch((error: unknown) => {
        // Следующий явный вызов может обнаружить обновлённый Server; текущий не повторяем.
        capability = undefined;
        throw error;
      }));
  return {
    ...api,
    projects: {
      ...api.projects,
      async getProjectCatalogPage(...args: Parameters<typeof api.projects.getProjectCatalogPage>) {
        await requireCatalog();
        const response = await api.projects.getProjectCatalogPage(...args);
        const { catalog, total, nextOffset, version } = response.data;
        const offset = args[0]?.offset ?? 0;
        const limit = args[0]?.limit ?? 20;
        const count = catalog.projects.length;
        if (
          count > limit ||
          count > Math.max(0, total - offset) ||
          (nextOffset !== null &&
            (nextOffset !== offset + count || nextOffset >= total || count === 0)) ||
          (nextOffset === null && offset + count < total) ||
          (args[0]?.version !== undefined && args[0].version !== version)
        )
          throw new AppError(
            "INVALID_SERVER_RESPONSE",
            "Relay Server вернул несогласованную страницу каталога",
            5,
            { url: origin },
          );
        return response;
      },
      async registerProjectCompact(
        ...args: Parameters<typeof api.projects.registerProjectCompact>
      ) {
        await requireCatalog();
        return api.projects.registerProjectCompact(...args);
      },
      async unregisterProjectCompact(
        ...args: Parameters<typeof api.projects.unregisterProjectCompact>
      ) {
        await requireCatalog();
        return api.projects.unregisterProjectCompact(...args);
      },
    },
  };
}
