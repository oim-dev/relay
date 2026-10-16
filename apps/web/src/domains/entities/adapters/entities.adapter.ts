import {
  entitiesQuerySchema,
  entitiesPageSchema,
  entitySummarySchema,
  entityDefinitions,
  entityDetailSchema,
} from "@relay/contracts/entities";
import type { EntitiesQuery, EntitiesPage, EntitySummary } from "@relay/contracts/entities";
import { ApiError, getProjectApi } from "infra/tasks-api";
import {
  EntityAccessError,
  EntityRelocatedError,
  throwEntityFailure,
  toEntityFailure,
} from "../errors/entity-errors";
import type { EntityContent } from "../types/entity-content.type";
import type { EntityRelocation } from "../types/entity-relocation.type";

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
 * Узнаёт, куда перенесён прежний адрес: Core отвечает на его разрешение ENTITY_RELOCATED
 * со сведениями о владельце. Дополнительное чтение не ломает показ связи.
 *
 * @returns Перенос либо `null`, если адрес не перенесён или сведения прочитать не удалось.
 */
export const getEntityRelocation = async (
  projectId: string,
  ref: string,
): Promise<EntityRelocation | null> => {
  try {
    await getProjectApi(projectId).entities.resolveEntity({ ref });
    return null;
  } catch (failure) {
    const normalized = toEntityFailure(failure);
    if (normalized instanceof EntityRelocatedError) return normalized.relocation;
    // Сбой сервера или сети: связь показывается без сведений о переносе.
    if (normalized instanceof EntityAccessError || normalized instanceof ApiError) return null;
    throw normalized;
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
