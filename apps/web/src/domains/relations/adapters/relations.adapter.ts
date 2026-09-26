import { z } from "zod";
import { getProjectApi, ApiError } from "infra/tasks-api";
import { RELATIONS_PAGE_SCHEMA, ENTITY_CONTEXT_SCHEMA } from "../types/relations.type";
import type {
  EntityRef,
  RelationOperation,
  RelationsPage,
  RelationsQuery,
  EntityContext,
} from "../types/relations.type";

const GRAPH_FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string() }) });

/**
 * Даёт единый адрес для выбора, объяснения пути и перехода между узлами.
 */
export const relationAddress = (ref: EntityRef): string => `${ref.kind}:${ref.id}`;

/**
 * Переводит ожидаемые ошибки транспорта в сообщения интерфейса связей.
 */
export const relationError = (error: unknown): Error => {
  if (error instanceof ApiError) {
    const failure = GRAPH_FAILURE_SCHEMA.safeParse(error.error);
    const code = failure.success ? failure.data.error.code : undefined;
    if (code === "GRAPH_CHANGED")
      return new Error(
        "Граф изменился. Обновите просмотр, чтобы прочитать все раскрытые области в одной версии. Выбор и фильтры сохранены.",
      );
    if (code === "RELATION_MANAGED")
      return new Error(
        "Эта связь сохраняется предметным действием. Измените прикрепление документа, цель, родителя или зависимость в редакторе сущности.",
      );
    if (code === "CONTEXT_TOO_LARGE" || code === "RESPONSE_TOO_LARGE")
      return new Error(
        "Полный контекст превышает бюджет ответа. Частичный граф не показан; используйте диагностический раздел «Связи проекта» для адресного исследования.",
      );
    if (code === "GRAPH_MIGRATION_REQUIRED")
      return new Error(
        "Для записи нужен перенос хранилища. В каталоге проекта выполните relay-cli --local graph migrate, затем обновите граф. Ввод сохранён.",
      );
    if (code === "GRAPH_INDEX_STALE")
      return new Error(
        "Файлы связей изменены вне Relay. Проверьте изменения и выполните relay-cli --local graph reindex в каталоге проекта.",
      );
    if (code === "GRAPH_RECOVERY_CONFLICT")
      return new Error(
        "Восстановление остановлено из-за внешнего изменения файла. Сверьте файлы с журналом прерванной операции; повторное сохранение не исправит конфликт.",
      );
  }
  if (error instanceof ApiError && error.status === 409)
    return new Error(
      "Граф изменился. Обновите версию и повторите сохранение; введённые данные сохранены.",
    );
  if (error instanceof ApiError && error.status === 404)
    return new Error("Сущность или связь больше не найдена. Обновите граф.");
  if (
    error instanceof ApiError ||
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  )
    return new Error(
      "Ответ сервера не получен. Если вы изменяли связи, перечитайте граф перед новой отправкой: действие могло выполниться.",
    );
  return error instanceof Error ? error : new Error("Не удалось обработать граф связей");
};

/**
 * Загружает одну страницу без скрытого обхода всего проекта.
 */
export const getRelations = async (
  projectId: string,
  query: RelationsQuery,
): Promise<RelationsPage> => {
  try {
    const response = await getProjectApi(projectId).graph.getGraph(query);
    return RELATIONS_PAGE_SCHEMA.parse(response.data);
  } catch (error) {
    throw relationError(error);
  }
};

/**
 * Читает всю сохранённую компоненту одним запросом; неполный ответ не принимается.
 */
export const getEntityContext = async (projectId: string, root: string): Promise<EntityContext> => {
  try {
    const response = await getProjectApi(projectId).graph.getFullContext({ root });
    return ENTITY_CONTEXT_SCHEMA.parse(response.data);
  } catch (error) {
    throw relationError(error);
  }
};

/**
 * Сохраняет пакет с исходной версией; requestId служит только корреляции.
 */
export const saveRelations = async (
  projectId: string,
  operations: RelationOperation[],
  version: string,
  requestId: string,
): Promise<string> => {
  try {
    const response = await getProjectApi(projectId).graph.mutateGraph({
      operations,
      ifVersion: version,
      requestId,
    });
    return z.object({ version: z.string() }).parse(response.data).version;
  } catch (error) {
    throw relationError(error);
  }
};
