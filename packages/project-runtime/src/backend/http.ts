import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { actorSchema } from "@relay/contracts/primitives";
import {
  productValidationSchema,
  productLintQuerySchema,
  productLintPageSchema,
  productOverviewMapQuerySchema,
  productOverviewMapPageSchema,
} from "@relay/contracts/product-query";
import {
  productParticipationQuerySchema,
  productParticipationPageSchema,
  productParticipationReplaceSchema,
  productParticipationSavedSchema,
  productImplementationDetailSchema,
} from "@relay/contracts/product-participation";
import {
  documentLinksQuerySchema,
  documentLinksPageSchema,
  documentSectionsQuerySchema,
  documentSectionsPageSchema,
  documentRelationChangeSchema,
  documentSectionChangeSchema,
} from "@relay/contracts/document-library";
import {
  plansQuerySchema,
  plansCompactQuerySchema,
  plansCompactPageSchema,
  planningPageQuerySchema,
  plansPageSchema,
  planSummarySchema,
  stagesPageSchema,
  planningTasksPageSchema,
  planMembershipsSchema,
  createPlanSchema,
  updatePlanSchema,
  transitionPlanSchema,
  changeStageSchema,
  changePlanTasksSchema,
  transferPlanTaskSchema,
  planningSavedSchema,
  planningCandidatesQuerySchema,
  planningCandidatesPageSchema,
} from "@relay/contracts/planning";
import {
  releasesQuerySchema,
  releasesCompactQuerySchema,
  releasesCompactPageSchema,
  releaseCompositionCompactQuerySchema,
  releaseCompositionCompactSchema,
  releasePreviewCompactSchema,
  saveReleaseByRefsSchema,
  updateReleaseByRefsSchema,
  releasesPageSchema,
  releaseSummarySchema,
  saveReleaseSchema,
  updateReleaseSchema,
  releaseActionSchema,
  releasePreviewSchema,
  releaseCompositionSchema,
} from "@relay/contracts/releases";
import {
  progressQuerySchema,
  taskDependenciesQuerySchema,
  taskDependenciesPageSchema,
  progressPageQuerySchema,
  taskProgressSchema,
  implementationProgressSchema,
  scenarioProgressSchema,
  featureProgressSchema,
  applicationProgressSchema,
  productProgressSchema,
  workPlanProgressSchema,
  releaseProgressSchema,
} from "@relay/contracts/progress";
import {
  entityPageQuerySchema,
  entitiesQuerySchema,
  entityGetQuerySchema,
  entityKeysQuerySchema,
  entityKeySpacesQuerySchema,
  entityTypesSchema,
  entityTypeDetailSchema,
  entitiesPageSchema,
  entityDetailSchema,
  entitySummarySchema,
  entityKeysPageSchema,
  entityKeySpacesSchema,
  entitySavedSchema,
  entityCreateSchema,
  entityUpdateSchema,
  entityRenameSchema,
  entityMoveTaskSchema,
  entityLinkTaskSchema,
  entityDeletionQuerySchema,
  entityDeletionPreviewSchema,
  deleteEntitySchema,
  entityDeletedSchema,
} from "@relay/contracts/entities";
import {
  graphPageSchema,
  graphQuerySchema,
  graphMutationSchema,
  graphSavedSchema,
  fullContextSchema,
  fullContextQuerySchema,
} from "@relay/core/domain/entity-graph";
import {
  productEntitySchema,
  productEntitiesSchema,
  productEntitiesQuerySchema,
  productEntityQuerySchema,
} from "@relay/core/domain/product-implementation";
import { boardsPageSchema, boardViewSchema, boardsQuerySchema } from "@relay/core/domain/board";
import {
  boardTaskViewSchema,
  boardTaskSavedSchema,
  boardTasksPageSchema,
  boardTaskLinksPageSchema,
  boardTasksQuerySchema,
  criteriaPageSchema,
  criteriaQuerySchema,
  criterionViewSchema,
  createBoardTaskSchema,
  taskCommentsQuerySchema,
  taskCommentsPageSchema,
  taskCommentSchema,
  taskCommentSavedSchema,
  publishTaskCommentSchema,
} from "@relay/core/domain/board-task";
import { HttpClient, ApiError } from "@relay/rest-sdk/http-client";
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { operationsTree } from "@relay/rest-sdk/operations-tree";
import { configSchema } from "@relay/core/domain/config";
import {
  projectSettingsSchema,
  saveProjectSettingsSchema,
} from "@relay/core/domain/project-settings";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { isStorageCompatibility } from "../storage-errors.js";
import type { Backend, WorkspaceInfo } from "./types.js";
import {
  productStateSchema,
  productSavedSchema,
  productOverviewSchema,
  productOverviewMetricSchema,
  productOverviewMetricPageSchema,
  productOverviewMetricPageQuerySchema,
  productListSchema,
  productListQuerySchema,
  productContextSchema,
} from "@relay/core/domain/product";
import type { ProductOverviewMetric } from "@relay/core/domain/product";

/** Возможность сервера: snapshot.operator и детализация метрик оператора обзора. */
export const OVERVIEW_METRICS_CAPABILITY = "relay-overview-metrics-v1";
/** Страницы библиотеки и адресные записи без клиентского полного чтения документа/проекта. */
export const DOCUMENT_LIBRARY_CAPABILITY = "relay-document-library-v1";
/** Адресные продуктовые чтения и атомарная замена участия без full-state fallback. */
export const PRODUCT_QUERIES_CAPABILITY = "relay-product-queries-v1";
/** Явные компактные проекции планирования и специализированная страница зависимостей. */
export const WORK_READ_MODELS_CAPABILITY = "relay-work-read-models-v1";
/** Разрешение публичных адресов планов внутри единственной записи релиза. */
export const RELEASE_REFS_CAPABILITY = "relay-release-refs-v1";
/** Полнотекстовый поиск и типовые FI/SI-фильтры общего каталога. */
export const ENTITY_SEARCH_CAPABILITY = "relay-entity-search-v2";

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    exitCode: z.number().int().min(1).max(255).optional(),
    details: z.unknown().optional(),
  }),
});

function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError("INVALID_SERVER_RESPONSE", "Ответ сервера не соответствует контракту", 5);
  return result.data;
}

/**
 * Обзор продукта расширен согласованным срезом (snapshotVersion, generatedAt, snapshot).
 * Ответ сервера прежней версии без этих полей — рассинхронизация версий, а не повреждение.
 */
function decodeOverview(value: unknown, url: string) {
  const record = typeof value === "object" && value !== null ? value : undefined;
  const legacy =
    record !== undefined &&
    "items" in record &&
    !("snapshot" in record) &&
    !("snapshotVersion" in record);
  if (legacy)
    throw new AppError(
      "SERVER_INCOMPATIBLE",
      "Сервер Relay вернул обзор продукта прежнего формата без согласованного среза (snapshot, snapshotVersion). Обновите и перезапустите Relay Server той же версии, что и клиент.",
      5,
      { url },
    );
  // Срез без метрик оператора — сервер предыдущей версии, а не повреждённый ответ.
  const snapshot = record && "snapshot" in record ? record.snapshot : undefined;
  if (typeof snapshot === "object" && snapshot !== null && !("operator" in snapshot))
    throw new AppError(
      "SERVER_INCOMPATIBLE",
      "Сервер Relay вернул обзор продукта без метрик оператора (snapshot.operator). Обновите и перезапустите Relay Server той же версии, что и клиент.",
      5,
      { url },
    );
  return decode(productOverviewSchema, value);
}

function projectClient(url: string, project?: string) {
  return createApiClient(
    new HttpClient({
      baseUrl: url,
      timeout: 15000,
      redirect: "error",
      onRequest: (request) =>
        project === undefined
          ? request
          : {
              ...request,
              path: request.path.replace(
                /^\/api\/v1\//,
                `/api/v1/projects/${encodeURIComponent(project)}/`,
              ),
            },
    }),
    operationsTree,
  );
}

/** Единственный REST-адаптер CLI и MCP; после подключения проект закреплён по ID сервера. */
export async function createHttpBackend(url: string, project?: string): Promise<Backend> {
  async function call<T>(
    operation: () => Promise<{ ok: true; data: T }>,
    mode: "read" | "write" = "read",
    requestId?: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await operation();
        if (!response || response.ok !== true || !("data" in response))
          throw new AppError(
            "INVALID_SERVER_RESPONSE",
            mode === "write"
              ? "Сервер вернул неверный API-конверт. Запись могла завершиться. Перечитайте состояние; requestId не предотвращает дублирование."
              : "Сервер вернул неверный API-конверт",
            5,
            {
              url,
              ...(requestId ? { requestId } : {}),
            },
          );
        return response.data;
      } catch (error) {
        const transportFailure =
          !(error instanceof AppError) && (!(error instanceof ApiError) || error.status >= 500);
        // requestId служит корреляции, а не дедупликации: повторяем только чтения.
        if (transportFailure && attempt < 2 && mode === "read") {
          await delay(100 * (attempt + 1));
          continue;
        }
        if (error instanceof AppError) throw error;
        if (error instanceof ApiError) {
          const parsed = failureSchema.safeParse(error.error);
          if (parsed.success) {
            const { code, message, details, exitCode } = parsed.data.error;
            throw new AppError(
              code,
              mode === "write" && error.status >= 500
                ? `${message}. Результат записи не подтверждён. Перечитайте состояние; повтор может выполнить новое действие, requestId не предотвращает дублирование.`
                : message,
              exitCode ??
                (error.status === 404 ? 3 : error.status === 409 ? 4 : error.status < 500 ? 2 : 5),
              // Отказ совместимости определён (запись не выполнена): details в той же
              // форме, что у чтения, чтобы клиент показал next сервера.
              requestId === undefined ||
                (error.status === 409 && isStorageCompatibility(code, exitCode))
                ? details
                : { serverDetails: details, requestId, url },
            );
          }
          throw new AppError(
            "HTTP_ERROR",
            `HTTP ${error.status} от сервера задач${mode === "write" ? ". Результат записи не подтверждён. Перечитайте состояние перед новой отправкой; requestId не предотвращает дублирование." : ""}`,
            5,
            {
              url,
              ...(requestId ? { requestId } : {}),
            },
          );
        }
        throw new AppError(
          "SERVER_UNAVAILABLE",
          mode === "write"
            ? "Не удалось подтвердить запись на сервере. Запись могла завершиться. Перечитайте состояние перед новой отправкой; requestId служит корреляции и не предотвращает дублирование."
            : "Сервер задач недоступен. Проверьте URL и запуск сервера; локальный режим выбирается явно через --local.",
          5,
          { url, ...(requestId ? { requestId } : {}) },
        );
      }
    }
  }

  const context = await call(() => projectClient(url, project).context.getContext());
  if (!context.capabilities?.includes("relay-projects-v1"))
    throw new AppError(
      "SERVER_INCOMPATIBLE",
      "Требуется Relay Server с поддержкой relay-projects-v1. Обновите и перезапустите сервер.",
      5,
      { url },
    );
  const projectId = decode(z.string().min(1), context.projectId);
  const api = projectClient(url, projectId);
  const workspace: WorkspaceInfo = {
    projectId,
    config: parse(configSchema, context.config, "конфигурация сервера"),
    configPath: context.configPath,
    root: context.storagePath,
  };
  const writePlanning = async (
    operation: () => Promise<{ ok: true; data: unknown }>,
    requestId: string,
  ) => decode(planningSavedSchema, await call(operation, "write", requestId));
  const requireDocumentLibrary = () => {
    if (!context.capabilities?.includes(DOCUMENT_LIBRARY_CAPABILITY))
      throw new AppError(
        "SERVER_INCOMPATIBLE",
        `Операции библиотеки требуют Relay Server с ${DOCUMENT_LIBRARY_CAPABILITY}. Обновите и перезапустите сервер той же версии, что и клиент.`,
        5,
        { url },
      );
  };
  const requireCapability = (capability: string) => {
    if (!context.capabilities?.includes(capability))
      throw new AppError(
        "SERVER_INCOMPATIBLE",
        `Операция требует Relay Server с ${capability}. Обновите и перезапустите сервер той же версии, что и клиент.`,
        5,
        { url },
      );
  };
  return {
    kind: "http",
    projectSettings: {
      get: async () =>
        decode(projectSettingsSchema, await call(() => api.context.getProjectSettings())),
      save: async (input) => {
        const command = parse(saveProjectSettingsSchema, input, "настройки проекта");
        return decode(
          projectSettingsSchema,
          await call(() => api.context.saveProjectSettings(command), "write"),
        );
      },
    },
    plans: {
      listCompact: async (input) => {
        requireCapability(WORK_READ_MODELS_CAPABILITY);
        return decode(
          plansCompactPageSchema,
          await call(() =>
            api.plans.getPlansCompact(defined(plansCompactQuerySchema.parse(input))),
          ),
        );
      },
      candidates: async (query = {}) =>
        decode(
          planningCandidatesPageSchema,
          await call(() =>
            api.plans.getPlanningCandidates(defined(planningCandidatesQuerySchema.parse(query))),
          ),
        ),
      list: async (query = {}) =>
        decode(
          plansPageSchema,
          await call(() => api.plans.getPlans(defined(plansQuerySchema.parse(query)))),
        ),
      get: async (reference) =>
        decode(planSummarySchema, await call(() => api.plans.getPlan({ reference }))),
      stages: async (reference, query = {}) =>
        decode(
          stagesPageSchema,
          await call(() =>
            api.plans.getPlanStages({
              reference,
              ...defined(planningPageQuerySchema.parse(query)),
            }),
          ),
        ),
      tasks: async (reference, stage, query = {}) =>
        decode(
          planningTasksPageSchema,
          await call(() =>
            api.plans.getPlanStageTasks({
              reference,
              stage,
              ...defined(planningPageQuerySchema.parse(query)),
            }),
          ),
        ),
      memberships: async (reference, query = {}) =>
        decode(
          planMembershipsSchema,
          await call(() =>
            api.plans.getTaskPlanMemberships({
              reference,
              ...defined(planningPageQuerySchema.parse(query)),
            }),
          ),
        ),
      create: (input, actor) =>
        writePlanning(
          () =>
            api.plans.createPlan(
              defined(createPlanSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      update: (reference, input, actor) =>
        writePlanning(
          () =>
            api.plans.updatePlan(
              { reference },
              defined(updatePlanSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      transition: (reference, input, actor) =>
        writePlanning(
          () =>
            api.plans.transitionPlan(
              { reference },
              defined(transitionPlanSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      changeStage: async (reference, input, actor) => {
        const { fields, ...command } = changeStageSchema.parse({
          ...input,
          actor: input.actor ?? actor,
        });
        return decode(
          planningSavedSchema.required({ stageId: true }),
          await writePlanning(
            () =>
              api.plans.changePlanStage(
                { reference },
                defined({
                  ...command,
                  ...(fields === undefined ? {} : { fields: defined(fields) }),
                }),
              ),
            input.requestId,
          ),
        );
      },
      changeTasks: (reference, input, actor) =>
        writePlanning(
          () =>
            api.plans.changePlanTasks(
              { reference },
              defined(changePlanTasksSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      transfer: async (reference, input, actor) =>
        decode(
          planningSavedSchema.required({ targetRevision: true }),
          await writePlanning(
            () =>
              api.plans.transferPlanTask(
                { reference },
                defined(transferPlanTaskSchema.parse({ ...input, actor: input.actor ?? actor })),
              ),
            input.requestId,
          ),
        ),
    },
    releases: {
      listCompact: async (input) => {
        requireCapability(WORK_READ_MODELS_CAPABILITY);
        return decode(
          releasesCompactPageSchema,
          await call(() =>
            api.releases.getReleasesCompact(defined(releasesCompactQuerySchema.parse(input))),
          ),
        );
      },
      compositionCompact: async (reference, input) => {
        requireCapability(WORK_READ_MODELS_CAPABILITY);
        return decode(
          releaseCompositionCompactSchema,
          await call(() =>
            api.releases.getReleasePlansCompact({
              reference,
              ...defined(releaseCompositionCompactQuerySchema.parse(input)),
            }),
          ),
        );
      },
      previewCompact: async (input) => {
        requireCapability(WORK_READ_MODELS_CAPABILITY);
        const { projection, ...body } = releasePreviewCompactSchema.parse(input);
        return decode(
          releaseCompositionCompactSchema,
          await call(() => api.releases.previewReleaseCompact({ projection }, defined(body))),
        );
      },
      createByRefs: async (input, defaultActor) => {
        requireCapability(RELEASE_REFS_CAPABILITY);
        const command = saveReleaseByRefsSchema.parse({
          ...input,
          actor: input.actor ?? defaultActor,
        });
        return writePlanning(
          () => api.releases.createReleaseByRefs(defined(command)),
          command.requestId,
        );
      },
      updateByRefs: async (reference, input, defaultActor) => {
        requireCapability(RELEASE_REFS_CAPABILITY);
        const command = updateReleaseByRefsSchema.parse({
          ...input,
          actor: input.actor ?? defaultActor,
        });
        return writePlanning(
          () => api.releases.updateReleaseByRefs({ reference }, defined(command)),
          command.requestId,
        );
      },
      list: async (query = {}) =>
        decode(
          releasesPageSchema,
          await call(() => api.releases.getReleases(defined(releasesQuerySchema.parse(query)))),
        ),
      get: async (reference) =>
        decode(releaseSummarySchema, await call(() => api.releases.getRelease({ reference }))),
      composition: async (reference, query = {}) =>
        decode(
          releaseCompositionSchema,
          await call(() =>
            api.releases.getReleasePlans({
              reference,
              ...defined(planningPageQuerySchema.parse(query)),
            }),
          ),
        ),
      preview: async (input) =>
        decode(
          releaseCompositionSchema,
          await call(() => api.releases.previewRelease(defined(releasePreviewSchema.parse(input)))),
        ),
      create: (input, actor) =>
        writePlanning(
          () =>
            api.releases.createRelease(
              defined(saveReleaseSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      update: (reference, input, actor) =>
        writePlanning(
          () =>
            api.releases.updateRelease(
              { reference },
              defined(updateReleaseSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
      transition: (reference, input, actor) =>
        writePlanning(
          () =>
            api.releases.transitionRelease(
              { reference },
              defined(releaseActionSchema.parse({ ...input, actor: input.actor ?? actor })),
            ),
          input.requestId,
        ),
    },
    progress: {
      taskDependencies: async (input) => {
        requireCapability(WORK_READ_MODELS_CAPABILITY);
        return decode(
          taskDependenciesPageSchema,
          await call(() =>
            api.progress.getTaskDependencies(defined(taskDependenciesQuerySchema.parse(input))),
          ),
        );
      },
      workPlan: async (input) =>
        decode(
          workPlanProgressSchema,
          await call(() =>
            api.progress.getWorkPlanProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      release: async (input) =>
        decode(
          releaseProgressSchema,
          await call(() =>
            api.progress.getReleaseProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      task: async (input) =>
        decode(
          taskProgressSchema,
          await call(() => api.progress.getTaskProgress(defined(progressQuerySchema.parse(input)))),
        ),
      implementation: async (input) =>
        decode(
          implementationProgressSchema,
          await call(() =>
            api.progress.getImplementationProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      scenario: async (input) =>
        decode(
          scenarioProgressSchema,
          await call(() =>
            api.progress.getScenarioProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      feature: async (input) =>
        decode(
          featureProgressSchema,
          await call(() =>
            api.progress.getFeatureProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      application: async (input) =>
        decode(
          applicationProgressSchema,
          await call(() =>
            api.progress.getApplicationProgress(defined(progressQuerySchema.parse(input))),
          ),
        ),
      product: async (input = {}) =>
        decode(
          productProgressSchema,
          await call(() =>
            api.progress.getProductProgress(defined(progressPageQuerySchema.parse(input))),
          ),
        ),
    },
    entities: {
      types: async (input = {}) =>
        decode(
          entityTypesSchema,
          await call(() =>
            api.entities.listEntityTypes(defined(entityPageQuerySchema.parse(input))),
          ),
        ),
      describe: async (input) =>
        decode(entityTypeDetailSchema, await call(() => api.entities.describeEntityType(input))),
      list: async (input = {}) => {
        const query = entitiesQuerySchema.parse(input);
        if (
          query.implementationTarget !== undefined ||
          (query.q !== undefined && query.kind !== "document") ||
          (query.sort === "updated" && query.kind !== "document") ||
          (query.kind === undefined && (query.active !== undefined || query.section !== undefined))
        )
          requireCapability(ENTITY_SEARCH_CAPABILITY);
        return decode(
          entitiesPageSchema,
          await call(() => api.entities.listEntities(defined(query))),
        );
      },
      get: async (input) =>
        decode(
          entityDetailSchema,
          await call(() => api.entities.getEntity(defined(entityGetQuerySchema.parse(input)))),
        ),
      resolve: async (input) =>
        decode(
          entitySummarySchema,
          await call(() => api.entities.resolveEntity(defined(entityGetQuerySchema.parse(input)))),
        ),
      keys: async (input) =>
        decode(
          entityKeysPageSchema,
          await call(() => api.entities.getEntityKeys(defined(entityKeysQuerySchema.parse(input)))),
        ),
      keySpaces: async (input) =>
        decode(
          entityKeySpacesSchema,
          await call(() =>
            api.entities.getEntityKeySpaces(defined(entityKeySpacesQuerySchema.parse(input))),
          ),
        ),
      create: async (input, actor) => {
        const command = entityCreateSchema.parse(input);
        return decode(
          entitySavedSchema,
          await call(
            () =>
              api.entities.createEntity({
                ...defined(command),
                data: defined(command.data),
                actor: input.actor ?? actor,
              }),
            "write",
            input.requestId,
          ),
        );
      },
      update: async (input, actor) => {
        const command = entityUpdateSchema.parse(input);
        return decode(
          entitySavedSchema,
          await call(
            () =>
              api.entities.updateEntity({
                ...defined(command),
                changes: defined(command.changes),
                actor: input.actor ?? actor,
              }),
            "write",
            input.requestId,
          ),
        );
      },
      rename: async (input, actor) =>
        decode(
          entitySavedSchema,
          await call(
            () =>
              api.entities.renameEntityKey(
                defined({ ...entityRenameSchema.parse(input), actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      moveTask: async (input, actor) =>
        decode(
          entitySavedSchema,
          await call(
            () =>
              api.entities.moveEntityTask(
                defined({ ...entityMoveTaskSchema.parse(input), actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      linkTask: async (input, actor) =>
        decode(
          entitySavedSchema,
          await call(
            () =>
              api.entities.linkEntityTask(
                defined({ ...entityLinkTaskSchema.parse(input), actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
    },
    documents: {
      links: async (input) => {
        requireDocumentLibrary();
        const query = parse(documentLinksQuerySchema, input, "прикрепления документа");
        return decode(
          documentLinksPageSchema,
          await call(() => api.documents.getDocumentLinks(defined(query))),
        );
      },
      sections: async (input = {}) => {
        requireDocumentLibrary();
        const query = parse(documentSectionsQuerySchema, input, "разделы библиотеки");
        return decode(
          documentSectionsPageSchema,
          await call(() => api.documents.getDocumentSections(defined(query))),
        );
      },
      changeRelation: async (input, defaultActor) => {
        requireDocumentLibrary();
        const command = parse(documentRelationChangeSchema, input, "изменение прикрепления");
        const actor = parse(actorSchema, command.actor ?? defaultActor, "автор изменения");
        return decode(
          entitySavedSchema,
          await call(
            () => api.documents.changeDocumentRelation(defined({ ...command, actor })),
            "write",
            command.requestId,
          ),
        );
      },
      changeSection: async (input, defaultActor) => {
        requireDocumentLibrary();
        const command = parse(documentSectionChangeSchema, input, "изменение раздела");
        const actor = parse(actorSchema, command.actor ?? defaultActor, "автор изменения");
        return decode(
          entitySavedSchema,
          await call(
            () => api.documents.changeDocumentSection(defined({ ...command, actor })),
            "write",
            command.requestId,
          ),
        );
      },
    },
    deletion: {
      preview: async (input) => {
        const query = parse(entityDeletionQuerySchema, input, "предпросмотр удаления");
        return decode(
          entityDeletionPreviewSchema,
          await call(() => api.entities.previewEntityDeletion(query)),
        );
      },
      delete: async (input, defaultActor) => {
        const command = parse(deleteEntitySchema, input, "удаление сущности");
        const actor = parse(actorSchema, command.actor ?? defaultActor, "автор удаления");
        return decode(
          entityDeletedSchema,
          await call(
            () => api.entities.deleteEntity(defined({ ...command, actor })),
            "write",
            command.requestId,
          ),
        );
      },
    },
    graph: {
      context: async (input) => {
        if (!context.capabilities?.includes("relay-full-context-v1"))
          throw new AppError(
            "SERVER_INCOMPATIBLE",
            "Для полного контекста обновите Relay Server",
            5,
          );
        return decode(
          fullContextSchema,
          await call(() => api.graph.getFullContext(fullContextQuerySchema.parse(input))),
        );
      },
      read: async (input = {}) =>
        decode(
          graphPageSchema,
          await call(() => api.graph.getGraph(defined(graphQuerySchema.parse(input)))),
        ),
      mutate: async (input, actor) =>
        decode(
          graphSavedSchema,
          await call(
            () =>
              api.graph.mutateGraph({
                ...graphMutationSchema.parse(input),
                actor: input.actor ?? actor,
              }),
            "write",
            input.requestId,
          ),
        ),
    },
    boards: {
      list: async (input = {}) =>
        decode(
          boardsPageSchema,
          await call(() => api.boards.getBoards(defined(boardsQuerySchema.parse(input)))),
        ),
      get: async (slug) =>
        decode(boardViewSchema, await call(() => api.boards.getBoardBySlug({ slug }))),
    },
    boardTasks: {
      listComments: async (reference, input = {}) =>
        decode(
          taskCommentsPageSchema,
          await call(() =>
            api.kanban.getTaskComments({
              reference,
              ...defined(taskCommentsQuerySchema.parse(input)),
            }),
          ),
        ),
      getComment: async (reference, entryId) =>
        decode(
          taskCommentSchema,
          await call(() =>
            api.kanban.getTaskComment({
              reference,
              entryId,
            }),
          ),
        ),
      publishComment: async (reference, input) =>
        decode(
          taskCommentSavedSchema,
          await call(
            () =>
              api.kanban.publishTaskComment({ reference }, publishTaskCommentSchema.parse(input)),
            "write",
            input.requestId,
          ),
        ),
      listCriteria: async (reference, input = {}) =>
        decode(
          criteriaPageSchema,
          await call(() =>
            api.kanban.getTaskCriteria({ reference, ...defined(criteriaQuerySchema.parse(input)) }),
          ),
        ),
      getCriterion: async (reference, criterionId) =>
        decode(
          criterionViewSchema,
          await call(() => api.kanban.getTaskCriterion({ reference, criterionId })),
        ),
      changeCriterion: async (reference, input, actor) =>
        decode(
          boardTaskSavedSchema,
          await call(
            () =>
              api.kanban.changeTaskCriterion(
                { reference },
                defined({ ...input, actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      list: async (input = {}) =>
        decode(
          boardTasksPageSchema,
          await call(() => api.kanban.getBoardTasks(defined(boardTasksQuerySchema.parse(input)))),
        ),
      get: async (reference) =>
        decode(boardTaskViewSchema, await call(() => api.kanban.getBoardTask({ reference }))),
      links: async (reference, input = {}) =>
        decode(
          boardTaskLinksPageSchema,
          await call(() =>
            api.kanban.getBoardTaskLinks({
              reference,
              ...defined(boardTasksQuerySchema.parse(input)),
            }),
          ),
        ),
      create: async (input, actor) =>
        decode(
          boardTaskSavedSchema,
          await call(
            () =>
              api.kanban.createBoardTask(
                defined(createBoardTaskSchema.parse({ ...input, actor: input.actor ?? actor })),
              ),
            "write",
            input.requestId,
          ),
        ),
      update: async (reference, input, actor) =>
        decode(
          boardTaskSavedSchema,
          await call(
            () =>
              api.kanban.updateBoardTask(
                { reference },
                defined({ ...input, actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      move: async (reference, input, actor) =>
        decode(
          boardTaskSavedSchema,
          await call(
            () =>
              api.kanban.moveBoardTask(
                { reference },
                defined({ ...input, actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      link: async (reference, input, actor) =>
        decode(
          boardTaskSavedSchema,
          await call(
            () =>
              api.kanban.linkBoardTask(
                { reference },
                defined({ ...input, actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
    },
    product: {
      validate: async () => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        return decode(productValidationSchema, await call(() => api.product.validateProduct()));
      },
      lint: async (input = {}) => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        return decode(
          productLintPageSchema,
          await call(() => api.product.lintProduct(defined(productLintQuerySchema.parse(input)))),
        );
      },
      overviewMap: async (input = {}) => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        return decode(
          productOverviewMapPageSchema,
          await call(() =>
            api.product.getProductOverviewMap(defined(productOverviewMapQuerySchema.parse(input))),
          ),
        );
      },
      participation: async (input) => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        return decode(
          productParticipationPageSchema,
          await call(() =>
            api.product.getProductParticipation(
              defined(productParticipationQuerySchema.parse(input)),
            ),
          ),
        );
      },
      implementation: async (ref) => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        return decode(
          productImplementationDetailSchema,
          await call(() =>
            api.product.getProductImplementation(productEntityQuerySchema.parse({ ref })),
          ),
        );
      },
      replaceParticipation: async (input, defaultActor) => {
        requireCapability(PRODUCT_QUERIES_CAPABILITY);
        const command = productParticipationReplaceSchema.parse({
          ...input,
          actor: input.actor ?? defaultActor,
        });
        return decode(
          productParticipationSavedSchema,
          await call(
            () =>
              api.product.replaceProductParticipation(
                defined({ ...command, selections: command.selections.map(defined) }),
              ),
            "write",
            command.requestId,
          ),
        );
      },
      entity: async (ref) =>
        decode(productEntitySchema, await call(() => api.product.getProductEntity({ ref }))),
      entities: async (input = {}) =>
        decode(
          productEntitiesSchema,
          await call(() =>
            api.product.getProductEntities(defined(productEntitiesQuerySchema.parse(input))),
          ),
        ),
      updateImplementation: async (input, actor) =>
        decode(
          productSavedSchema,
          await call(
            () =>
              api.product.updateProductImplementation(
                defined({ ...input, actor: input.actor ?? actor }),
              ),
            "write",
            input.requestId,
          ),
        ),
      state: async () =>
        decode(productStateSchema, await call(() => api.product.getProductState())),
      overview: async () => decodeOverview(await call(() => api.product.getProductOverview()), url),
      overviewMetric: async (input) => {
        // Проверка до запроса: прежний сервер ответил бы неинформативным 404 маршрута.
        if (!context.capabilities?.includes(OVERVIEW_METRICS_CAPABILITY))
          throw new AppError(
            "SERVER_INCOMPATIBLE",
            `Детализация метрик обзора требует Relay Server с ${OVERVIEW_METRICS_CAPABILITY}. Обновите и перезапустите сервер той же версии, что и клиент.`,
            5,
            { url },
          );
        const { metric, ...query } = input;
        // Метрика попадает в сегмент пути: только значение enum, иначе `..`/`/`
        // увели бы запрос из закреплённого проекта. Ошибка та же, что у local Core.
        const parsedMetric = productOverviewMetricSchema.safeParse(metric);
        if (!parsedMetric.success)
          throw new AppError(
            "UNKNOWN_METRIC",
            `Неизвестная метрика обзора: ${String(metric)}. Допустимы: ${productOverviewMetricSchema.options.join(", ")}`,
            2,
          );
        return decode(
          productOverviewMetricPageSchema,
          await call(() =>
            api.product.getProductOverviewMetric({
              // Generated SDK не кодирует сегменты пути; enum-значение кодируем явно.
              metric: encodeURIComponent(parsedMetric.data) as ProductOverviewMetric,
              ...defined(productOverviewMetricPageQuerySchema.parse(query)),
            }),
          ),
        );
      },
      list: async (input = {}) =>
        decode(
          productListSchema,
          await call(() =>
            api.product.getProductRecords(defined(productListQuerySchema.parse(input))),
          ),
        ),
      context: async (input = {}) =>
        decode(
          productContextSchema,
          await call(() => api.product.getProductContext(defined(input))),
        ),
      mutate: async (input, actor) =>
        decode(
          productSavedSchema,
          await call(
            () =>
              api.product.mutateProduct({
                ...defined(input),
                fields:
                  input.fields.kind === "scope"
                    ? { ...input.fields, contracts: input.fields.contracts.map(defined) }
                    : defined(input.fields),
                actor: input.actor ?? actor,
              }),
            "write",
            input.requestId,
          ),
        ),
    },
    workspace,
    validate: () => call(() => api.project.validateProject()),
  };
}
