import { z } from "zod";
import { productOverviewMetricPageSchema } from "@relay/contracts/entities/product";
import { ApiError, getProjectApi, getStorageFailureMessage } from "infra/tasks-api";
import {
  createBlockerNotFoundError,
  createMetricInvalidResponseError,
  createMetricProjectUnavailableError,
  createMetricStorageFailureError,
  createMetricTemporarilyUnavailableError,
  createMetricUnsupportedError,
  createSnapshotChangedError,
} from "../errors/overview-metric.error";
import { mapOverviewMetricPageDto } from "../mappers/product-overview.mapper";
import type { OverviewMetricPage, OverviewMetricRequest } from "../types/product-overview.type";

/** Возможность сервера, объявляющая полные списки метрик оператора. */
const METRICS_CAPABILITY = "relay-overview-metrics-v1";
/** Размер страницы полного списка. */
const PAGE_SIZE = 20;

/** Форма отказа сервера: код, сообщение для человека и необязательные детали. */
const FAILURE_SCHEMA = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
/**
 * Детали `NOT_FOUND`, которыми Core отличает отсутствующую задачу-блокер
 * `blocker-affected` от других отказов с тем же кодом (маршрут, проект).
 */
const MISSING_BLOCKER_DETAILS_SCHEMA = z.object({ parameter: z.literal("blocker") });
/** Объявленные возможности сервера; прежний сервер их не перечисляет. */
const CONTEXT_SCHEMA = z.object({ capabilities: z.array(z.string()).optional() });

/**
 * Классифицирует отказ HTTP-запроса в исход чтения списка метрики.
 *
 * @param request Запрошенная метрика; `null` — проверка возможностей сервера.
 */
const toMetricError = (error: unknown, request: OverviewMetricRequest | null) => {
  if (!(error instanceof ApiError)) return createMetricTemporarilyUnavailableError();
  const failure = FAILURE_SCHEMA.safeParse(error.error);
  const code = failure.success ? failure.data.error.code : null;
  // Продолжение прежнего среза больше недействительно: список перечитывается целиком.
  if (code === "VERSION_CONFLICT" || code === "INVALID_CURSOR") return createSnapshotChangedError();
  if (code === "PROJECT_NOT_FOUND") return createMetricProjectUnavailableError();
  const storageMessage = getStorageFailureMessage(error);
  if (storageMessage !== null) return createMetricStorageFailureError(storageMessage, error);
  // Несуществующий блокер Core сообщает как NOT_FOUND с details.parameter = "blocker".
  const isMissingBlocker =
    request?.metric === "blocker-affected" &&
    code === "NOT_FOUND" &&
    MISSING_BLOCKER_DETAILS_SCHEMA.safeParse(failure.data?.error.details).success;
  if (isMissingBlocker) return createBlockerNotFoundError();
  if (code === "UNKNOWN_METRIC" || error.status === 404) return createMetricUnsupportedError();
  // Сбой хранилища сервер сообщает только как 500 с телом отказа. 502–504 отвечает
  // посредник (прокси, шлюз), когда сервер недоступен: это отсутствие связи.
  if (error.status === 500 && failure.success)
    return createMetricStorageFailureError(failure.data.error.message);
  return createMetricTemporarilyUnavailableError();
};

/**
 * Проверяет по контексту проекта, что сервер умеет раскрывать полные списки метрик оператора.
 */
export const getOverviewMetricsSupport = async (projectId: string): Promise<boolean> => {
  let body: unknown;
  try {
    body = (await getProjectApi(projectId).context.getContext()).data;
  } catch (error) {
    throw toMetricError(error, null);
  }
  const parsed = CONTEXT_SCHEMA.safeParse(body);
  if (!parsed.success) throw createMetricInvalidResponseError();
  return parsed.data.capabilities?.includes(METRICS_CAPABILITY) ?? false;
};

/**
 * Читает страницу полного списка метрики, привязанную к версии показанного среза:
 * первая страница проверяет версию, продолжение — курсор того же неизменного среза.
 */
export const getOverviewMetricPage = async (
  projectId: string,
  request: OverviewMetricRequest,
  snapshotVersion: string,
  cursor: string | null,
): Promise<OverviewMetricPage> => {
  let body: unknown;
  try {
    const response = await getProjectApi(projectId).product.getProductOverviewMetric({
      metric: request.metric,
      blocker: request.metric === "blocker-affected" ? request.blocker : undefined,
      limit: PAGE_SIZE,
      cursor: cursor ?? undefined,
      version: snapshotVersion,
    });
    body = response.data;
  } catch (error) {
    throw toMetricError(error, request);
  }
  const parsed = productOverviewMetricPageSchema.safeParse(body);
  if (!parsed.success || parsed.data.metric !== request.metric)
    throw createMetricInvalidResponseError();
  // Страница другого среза не смешивается с показанными страницами.
  if (parsed.data.snapshotVersion !== snapshotVersion) throw createSnapshotChangedError();
  return mapOverviewMetricPageDto(parsed.data);
};
