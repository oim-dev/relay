import { z } from "zod";
import {
  entitiesQuerySchema,
  entitiesPageSchema,
  entitySummarySchema,
  entityDefinitions,
  entityDetailSchema,
} from "@relay/contracts/entities";
import type { EntitiesQuery, EntitiesPage, EntitySummary } from "@relay/contracts/entities";
import { getProjectApi, ApiError, getStorageFailureMessage } from "infra/tasks-api";
import type { EntityContent } from "../types/entity-content.type";

const FAILURE_SCHEMA = z.object({ error: z.object({ message: z.string() }) });

/** Ожидаемая недоступность или отказ чтения сохраняет работающую форму. */
export class EntityAccessError extends Error {}

/** Отделяет ожидаемые ошибки доступа от нарушения контракта приложения. */
const throwEntityFailure = (failure: unknown): never => {
  if (failure instanceof ApiError) {
    const response = FAILURE_SCHEMA.safeParse(failure.error);
    if (response.success && failure.status < 500) {
      throw new EntityAccessError(
        getStorageFailureMessage(failure) ?? response.data.error.message,
        { cause: failure },
      );
    }
    if (failure.status === 502 || failure.status === 503) {
      throw new EntityAccessError(
        "Сервер недоступен. Обновите варианты после восстановления соединения.",
        { cause: failure },
      );
    }
  }
  if (failure instanceof TypeError) {
    throw new EntityAccessError(
      "Не удалось загрузить сущности. Проверьте соединение и повторите запрос.",
      { cause: failure },
    );
  }
  throw failure;
};

/** Читает страницу карточек через общий движок, включая поиск по прежним ключам. */
export const getEntities = async (
  projectId: string,
  query: EntitiesQuery,
): Promise<EntitiesPage> => {
  try {
    const response = await getProjectApi(projectId).entities.listEntities(
      entitiesQuerySchema.parse(query),
    );
    return entitiesPageSchema.parse(response.data);
  } catch (failure) {
    return throwEntityFailure(failure);
  }
};

/** Разрешение выбранного ключа или ID выполняет Core; полный документ для селектора не нужен. */
export const getEntitySummary = async (projectId: string, ref: string): Promise<EntitySummary> => {
  try {
    const response = await getProjectApi(projectId).entities.resolveEntity({ ref });
    return entitySummarySchema.parse(response.data);
  } catch (failure) {
    return throwEntityFailure(failure);
  }
};

/**
 * Адресно читает полный текст узла; карточки графа не подменяют Markdown сущности.
 */
export const getEntityContent = async (projectId: string, ref: string): Promise<EntityContent> => {
  try {
    const response = await getProjectApi(projectId).entities.getEntity({ ref });
    const entry = entityDetailSchema.parse(response.data);
    const fields = entry.data;
    const markdown =
      fields.kind === "document"
        ? fields.body
        : fields.kind === "work-plan"
          ? [fields.goal, fields.rationale, fields.boundaries, fields.expectedResult, fields.result]
              .filter(Boolean)
              .join("\n\n")
          : "description" in fields
            ? fields.description
            : "";
    return {
      title: entry.title,
      markdown,
      boardSlug: fields.kind === "board" ? fields.slug : undefined,
    };
  } catch (failure) {
    return throwEntityFailure(failure);
  }
};

/**
 * Виды адресов, оставшиеся после миграции только в сохранённых связях: карточки
 * у них нет, новые прикрепления к ним Core отклоняет.
 */
const RELOCATED_KIND_LABELS: Readonly<Record<string, string>> = {
  "plan-stage": "Этап плана (прежний)",
};

/**
 * Возвращает русское название зарегистрированного вида и сохраняет имя расширенного вида.
 */
export const entityKindLabel = (kind: string): string =>
  entityDefinitions.find((definition) => definition.kind === kind)?.title ??
  RELOCATED_KIND_LABELS[kind] ??
  kind;

/** Адрес прежнего вида: связь читается и сохраняется, но открыть или выбрать заново нельзя. */
export const isRelocatedEntityKind = (kind: string): boolean => kind in RELOCATED_KIND_LABELS;
