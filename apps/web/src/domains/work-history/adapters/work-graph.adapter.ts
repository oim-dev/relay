import { z } from "zod";
import {
  WORK_HISTORY_GRAPH_CAPABILITY,
  workHistoryGraphPageSchema,
  workHistoryGraphPointDetailSchema,
} from "@relay/contracts/work-history-graph";
import type {
  WorkHistoryGraphPage,
  WorkHistoryGraphPointDetail,
} from "@relay/contracts/work-history-graph";
import { getProjectApi } from "infra/tasks-api";
import { toWorkHistoryError, WorkHistoryError } from "../errors/work-history.error";

const CONTEXT_SCHEMA = z.object({ capabilities: z.array(z.string()).optional() });
/** Одна порция содержит только компактные точки, не Markdown соседних работ. */
const GRAPH_PAGE_SIZE = 50;

/**
 * Проверяет предметный ответ источника до помещения в SWR.
 */
const readGraphData = async <T>(
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
      "Сервер вернул несовместимый граф истории. Обновите Server и Web вместе.",
    );
  return parsed.data;
};

/**
 * Отличает отсутствие новой возможности от пустого графа.
 */
export const getWorkGraphSupport = async (projectId: string): Promise<boolean> => {
  const context = await readGraphData(CONTEXT_SCHEMA, () =>
    getProjectApi(projectId).context.getContext(),
  );
  return context.capabilities?.includes(WORK_HISTORY_GRAPH_CAPABILITY) ?? false;
};

/**
 * Всегда читает весь проект, независимо от прежних query-параметров Web.
 */
export const getWorkGraphPage = async (
  projectId: string,
  offset: number,
  version?: string,
): Promise<WorkHistoryGraphPage> => {
  const page = await readGraphData(workHistoryGraphPageSchema, () =>
    getProjectApi(projectId).workHistory.getWorkHistoryGraph({
      offset,
      limit: GRAPH_PAGE_SIZE,
      version,
      order: "desc",
    }),
  );
  if (page.scopeRootId !== null)
    throw new WorkHistoryError(
      "INVALID_RESPONSE",
      "Сервер вернул поддерево вместо истории всего проекта.",
    );
  if (version !== undefined && page.version !== version)
    throw new WorkHistoryError(
      "VERSION_CONFLICT",
      "Версия истории изменилась. Перечитайте граф с начала.",
    );
  return page;
};

/**
 * Открывает материалы только выбранной точки; принимает также прежние CP-key/ID ссылки.
 */
export const getWorkGraphPoint = (
  projectId: string,
  ref: string,
): Promise<WorkHistoryGraphPointDetail> =>
  readGraphData(workHistoryGraphPointDetailSchema, () =>
    getProjectApi(projectId).workHistory.getWorkHistoryGraphPoint({ ref: encodeURIComponent(ref) }),
  );
