import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { SWRResponse } from "swr";
import type { EntitiesQuery, EntitiesPage, EntitySummary } from "@relay/contracts/entities";
import { subscribeWorkspace } from "infra/workspace-events";
import {
  getEntities,
  getEntitySummary,
  getEntityContent,
  EntityAccessError,
} from "../adapters/entities.adapter";
import type { EntityContent } from "../types/entity-content.type";

/**
 * Перечитывает проекции каскада во всех доменах только выбранного проекта.
 */
export const useDeletionRefresh = (projectId: string): (() => Promise<void>) => {
  const { mutate } = useSWRConfig();
  return async () => {
    await mutate((key) => Array.isArray(key) && key[1] === projectId);
  };
};

/** Подписка обновляет серверный кеш, не заменяя локальное состояние редактора. */
const useEntityRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void refresh().catch(() => undefined);
      }),
    [projectId, refresh],
  );
};

/** Постраничный каталог изолирован по проекту, виду и условиям выборки. */
export const useEntities = (
  projectId: string,
  query: EntitiesQuery,
): SWRResponse<EntitiesPage, Error> => {
  const response = useSWR<EntitiesPage, Error>(
    ["entities", projectId, query],
    () => getEntities(projectId, query),
    { shouldRetryOnError: false },
  );
  useEntityRefresh(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof EntityAccessError))
    throw response.error;
  return response;
};

/** Краткая выбранная запись остаётся доступна независимо от текущей страницы поиска. */
export const useEntitySummary = (
  projectId: string,
  ref: string | null,
): SWRResponse<EntitySummary, Error> => {
  const response = useSWR<EntitySummary, Error>(
    ref === null ? null : ["entity-summary", projectId, ref],
    () => getEntitySummary(projectId, ref ?? ""),
    { shouldRetryOnError: false },
  );
  useEntityRefresh(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof EntityAccessError))
    throw response.error;
  return response;
};

/**
 * Загружает полный текст только выбранного узла и обновляет его по событиям проекта.
 */
export const useEntityContent = (
  projectId: string,
  ref: string | null,
): SWRResponse<EntityContent, Error> => {
  const response = useSWR<EntityContent, Error>(
    ref === null ? null : ["entity-content", projectId, ref],
    () => getEntityContent(projectId, ref ?? ""),
    { shouldRetryOnError: false },
  );
  useEntityRefresh(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof EntityAccessError))
    throw response.error;
  return response;
};
