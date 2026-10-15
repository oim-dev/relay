import { useCallback, useMemo } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import useSWRInfinite from "swr/infinite";
import { WORK_HISTORY_GRAPH_CAPABILITY } from "@relay/contracts/work-history-graph";
import type { WorkHistoryGraphPage } from "@relay/contracts/work-history-graph";
import {
  getWorkGraphPage,
  getWorkGraphPoint,
  getWorkGraphSupport,
} from "../adapters/work-graph.adapter";
import { WorkHistoryError } from "../errors/work-history.error";
import { mergeGraphPages } from "../helpers/merge-graph-pages";
import { useWorkRefresh } from "./use-work-refresh.hook";
import type { WorkGraphState, WorkGraphPointDetail } from "../types/work-graph.type";

/**
 * Владеет компактным графом проекта: один общий SSE-транспорт, последовательное продолжение
 * и перечитывание того же объёма без смешения версий. Никаких запросов карточек для аватаров.
 */
export const useWorkGraph = (projectId: string): WorkGraphState => {
  const support = useSWR<boolean, Error>(
    ["work-history-graph-support", WORK_HISTORY_GRAPH_CAPABILITY, projectId],
    () => getWorkGraphSupport(projectId),
  );
  const pages = useSWRInfinite<WorkHistoryGraphPage, Error>(
    (index: number, previous: WorkHistoryGraphPage | null) => {
      if (support.data !== true || previous?.nextOffset === null) return null;
      return [
        WORK_HISTORY_GRAPH_CAPABILITY,
        projectId,
        index === 0 ? 0 : previous?.nextOffset,
        previous?.version,
      ];
    },
    ([, project, offset, version]: [string, string, number, string | undefined]) =>
      getWorkGraphPage(project, offset, version),
    {
      revalidateAll: true,
      persistSize: false,
      shouldRetryOnError: (error) =>
        error instanceof WorkHistoryError && error.code === "UNAVAILABLE",
    },
  );
  const refreshSupport = support.mutate;
  const refreshPages = pages.mutate;
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshSupport(), refreshPages()]);
  }, [refreshSupport, refreshPages]);
  useWorkRefresh(projectId, refresh);
  const merged = useMemo(() => mergeGraphPages(pages.data), [pages.data]);
  return {
    ...merged,
    isSupported: support.data,
    isLoading: support.isLoading || (support.data === true && pages.isLoading),
    isRefreshing: support.isValidating || pages.isValidating,
    error: support.error ?? pages.error,
    refresh: () => {
      void refresh().catch(() => undefined);
    },
    loadMore: () => {
      void pages.setSize(pages.size + 1).catch(() => undefined);
    },
  };
};

/**
 * Полный материал читается только при открытой точке; ключ включает постоянный ID проекта.
 */
export const useWorkGraphPoint = (
  projectId: string,
  ref: string,
): SWRResponse<WorkGraphPointDetail, Error> => {
  const query = useSWR<WorkGraphPointDetail, Error>(
    ["work-history-graph-point", WORK_HISTORY_GRAPH_CAPABILITY, projectId, ref],
    () => getWorkGraphPoint(projectId, ref),
  );
  useWorkRefresh(projectId, query.mutate);
  return query;
};
