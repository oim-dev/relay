import { useCallback, useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { WORK_HISTORY_GRAPH_CAPABILITY } from "@relay/contracts/work-history-graph";
import { getBranchPointsPage } from "../../adapters/branch-points.adapter";
import { getWorkGraphSupport } from "../../adapters/work-graph.adapter";
import { WorkHistoryError } from "../../errors/work-history.error";
import { mergeBranchPointPages } from "../../helpers/merge-branch-point-pages";
import type { BranchPointPage, BranchPointsState } from "../../types/branch-points.type";
import { useWorkRefresh } from "../use-work-refresh.hook";
import { getBranchPointsKey } from "./get-branch-points-key";

/** Читает историю одной ветки и по SSE перечитывает загруженный объём с первой страницы. */
export const useGetBranchPoints = (projectId: string, sessionId: string): BranchPointsState => {
  const support = useSWR<boolean, Error>(
    ["work-history-graph-support", WORK_HISTORY_GRAPH_CAPABILITY, projectId],
    () => getWorkGraphSupport(projectId),
  );
  const pages = useSWRInfinite<BranchPointPage, Error>(
    (_index: number, previous: BranchPointPage | null) => {
      if (support.data !== true || previous?.nextOffset === null) return null;
      return getBranchPointsKey(projectId, sessionId, previous?.nextOffset ?? 0, previous?.version);
    },
    ([, , project, session, offset, version]: ReturnType<typeof getBranchPointsKey>) =>
      getBranchPointsPage(project, session, offset, version),
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
  const merged = useMemo(() => mergeBranchPointPages(pages.data), [pages.data]);
  const unsupportedError =
    support.data === false
      ? new WorkHistoryError(
          "UNSUPPORTED",
          "Server не поддерживает чтение точек ветки. Обновите Server и Web вместе.",
        )
      : undefined;
  return {
    ...merged,
    isLoading: support.isLoading || (support.data === true && pages.isLoading),
    isRefreshing: support.isValidating || pages.isValidating,
    error: support.error ?? pages.error ?? unsupportedError,
    refresh: () => {
      void refresh().catch(() => undefined);
    },
    loadMore: () => {
      if (!merged.hasMore || pages.isValidating || pages.error !== undefined) return;
      void pages.setSize(pages.size + 1).catch(() => undefined);
    },
  };
};
