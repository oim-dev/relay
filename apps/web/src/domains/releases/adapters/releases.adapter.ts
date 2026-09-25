import { z } from "zod";
import {
  releasesPageSchema,
  releaseSummarySchema,
  releaseCompositionSchema,
  saveReleaseSchema,
  updateReleaseSchema,
} from "@relay/contracts/releases";
import { planningSavedSchema } from "@relay/contracts/planning";
import {
  getProjectApi,
  ApiError,
  readApiPages,
  pendingApiRequest,
  PendingRequestError,
} from "infra/tasks-api";
import type { PlanningPage } from "domains/planning";
import { releaseView, releaseCompositionView } from "../helpers/release-view";
import type { Release, ReleaseComposition, ReleaseFilters } from "../types/release.type";

const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
/** Предусмотренный отказ работы с выпуском. */
export class ReleaseError extends Error {
  /**
   * Сохраняет причину отказа для предметного интерфейса.
   */
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Проверяет ответ и отличает ошибку чтения от неподтверждённой записи релиза.
 */
const request = async <Result>(
  schema: z.ZodType<Result>,
  operation: () => Promise<{ data: unknown }>,
  isWrite = false,
): Promise<Result> => {
  try {
    return schema.parse((await operation()).data);
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = FAILURE_SCHEMA.safeParse(error.error);
      if (failure.success)
        throw new ReleaseError(failure.data.error.message, failure.data.error.code);
    }
    if (
      error instanceof TypeError ||
      error instanceof PendingRequestError ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw new ReleaseError(
        error instanceof PendingRequestError
          ? error.message
          : isWrite
            ? "Сервер не подтвердил действие. Ввод сохранён; повторите после восстановления соединения."
            : "Не удалось загрузить данные релизов. Проверьте соединение и повторите загрузку.",
        "UNAVAILABLE",
      );
    throw error;
  }
};

/**
 * Читает ограниченный каталог самостоятельных релизов.
 */
export const getReleases = async (
  project: string,
  filters: ReleaseFilters,
  count = 12,
): Promise<PlanningPage<Release> & { statusCounts: Record<string, number> }> => {
  const page = await readApiPages(count, (offset, limit, version) =>
    request(releasesPageSchema, () =>
      getProjectApi(project).releases.getReleases({
        ...filters,
        offset,
        limit,
        ...(version === undefined ? {} : { version }),
      }),
    ),
  );
  return { ...page, items: page.items.map(releaseView) };
};

/**
 * Читает реквизиты выпуска независимо от каталога.
 */
export const getRelease = async (project: string, reference: string): Promise<Release> =>
  releaseView(
    await request(releaseSummarySchema, () =>
      getProjectApi(project).releases.getRelease({ reference }),
    ),
  );

/**
 * Читает актуальные планы выбранного состава.
 */
export const getReleasePlans = async (
  project: string,
  reference: string,
  count = 12,
): Promise<ReleaseComposition> =>
  releaseCompositionView(
    await readApiPages(count, (offset, limit, version) =>
      request(releaseCompositionSchema, () =>
        getProjectApi(project).releases.getReleasePlans({
          reference,
          offset,
          limit,
          ...(version === undefined ? {} : { version }),
        }),
      ),
    ),
  );

/**
 * Проверяет выбранные в форме планы на сервере без записи релиза.
 */
export const getReleasePreview = async (
  project: string,
  planIds: string[],
): Promise<ReleaseComposition> =>
  releaseCompositionView(
    await request(releaseCompositionSchema, () =>
      getProjectApi(project).releases.previewRelease({ plans: planIds, limit: 12 }),
    ),
  );

/** Квитанция сохранённого релиза. */
export type ReleaseSaved = z.infer<typeof planningSavedSchema>;

/**
 * Сохраняет реквизиты, состав и выбранный переход одной серверной операцией.
 */
export const saveRelease = async (project: string, release: Release): Promise<ReleaseSaved> => {
  const payload = {
    title: release.title,
    version: release.version,
    summary: release.summary,
    description: release.description,
    planIds: release.planIds,
    status: release.status,
    plannedFor: release.plannedFor,
    actor: "Оператор",
    ...(release.revision === 0 ? {} : { ifRevision: release.revision }),
  };
  return request(
    planningSavedSchema,
    () =>
      pendingApiRequest(
        project,
        `release-save:v2:${release.id}:${release.revision}`,
        payload,
        (requestId) => {
          const command = saveReleaseSchema.parse({ ...payload, requestId });
          return release.revision === 0
            ? getProjectApi(project).releases.createRelease(command)
            : getProjectApi(project).releases.updateRelease(
                { reference: release.id },
                updateReleaseSchema.parse(command),
              );
        },
      ),
    true,
  );
};
