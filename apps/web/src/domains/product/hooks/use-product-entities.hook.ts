import { useEffect, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { subscribeWorkspace } from "infra/workspace-events";
import { getProductEntities, getProductEntity } from "../adapters/product-entities.adapter";
import { ProductNotFoundError } from "../errors/product-errors";
import type { ProductEntitiesQuery, ProductEntities } from "../types/product-entity.type";

/** Каталог целей; null не запускает запрос скрытого выбора. */
export const useProductEntities = (projectId: string, query: ProductEntitiesQuery | null) => {
  const result = useSWR(
    query === null ? null : ["product-entities", projectId, query],
    () => getProductEntities(projectId, query!),
    { keepPreviousData: true },
  );
  const { mutate } = result;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate().catch(() => undefined);
      }),
    [projectId, mutate],
  );
  return result;
};

/** Адресный кеш подробностей; после разрешения URL потребитель использует стабильный ID. */
export const useProductEntity = (projectId: string, ref: string | null) => {
  const resolved = useRef(new Map<string, string>());
  const cache = useSWRConfig();
  const addressKey = `${projectId}:${ref}`;
  const stableRef = resolved.current.get(addressKey) ?? ref;
  const result = useSWR(
    stableRef === null ? null : ["product-entity", projectId, stableRef],
    () => getProductEntity(projectId, stableRef!),
    {
      /* Отсутствующая запись не появится от повтора: показывается сразу. */
      shouldRetryOnError: (error) => !(error instanceof ProductNotFoundError),
      onSuccess: (entity) => {
        if (stableRef === entity.id) return;
        void cache.mutate(["product-entity", projectId, entity.id], entity, false);
        resolved.current.set(addressKey, entity.id);
      },
    },
  );
  const { mutate } = result;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected" && ref !== null) void mutate().catch(() => undefined);
      }),
    [projectId, ref, mutate],
  );
  return result;
};

/** Последовательные ограниченные страницы выбора без искусственного лимита всех результатов. */
export const useProductTargetSearch = (projectId: string, query: ProductEntitiesQuery | null) => {
  const result = useSWRInfinite<ProductEntities>(
    (page, previous: ProductEntities | null) => {
      if (query === null || previous?.nextOffset === null) return null;
      return [
        "product-target-search",
        projectId,
        { ...query, limit: 20, offset: page === 0 ? 0 : (previous?.nextOffset ?? 0) },
      ];
    },
    ([, project, input]: [string, string, ProductEntitiesQuery]) =>
      getProductEntities(project, input),
    { revalidateFirstPage: true },
  );
  return {
    ...result,
    items: result.data?.flatMap((page) => page.items) ?? [],
    hasMore:
      result.data?.at(-1)?.nextOffset !== null && result.data?.at(-1)?.nextOffset !== undefined,
  };
};
