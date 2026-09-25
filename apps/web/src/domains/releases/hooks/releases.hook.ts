import { useCallback, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { SWRResponse } from "swr";
import { z } from "zod";
import { subscribeWorkspace } from "infra/workspace-events";
import type { PlanningPage } from "domains/planning";
import {
  getReleases,
  getRelease,
  getReleasePlans,
  getReleasePreview,
  ReleaseError,
} from "../adapters/releases.adapter";
import type {
  Release,
  ReleaseFilters,
  ReleaseComposition,
  ReleasePreviewState,
} from "../types/release.type";

/** Результат одной проверки с идентичностью проекта и выбранных планов. */
type PreviewRequestState = {
  /** Проект и полный выбор, к которым относится ответ. */
  key: string;
  /** Проверенный состав. */
  data: ReleaseComposition | undefined;
  /** Отказ операции; неожиданный сбой передаётся границе приложения. */
  error: unknown;
  /** Проверка ещё выполняется. */
  isLoading: boolean;
};

/**
 * Повторно читает серверное представление после записи и восстановления SSE.
 */
const useReleaseSync = (project: string, refresh: () => Promise<unknown>): void => {
  useEffect(() => {
    let isFirst = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspace(project, (signal) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (signal.state !== "connected") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh().catch(() => undefined), 100);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [project, refresh]);
};

/**
 * Каталог релизов выбранного проекта с независимыми фильтрами.
 */
export const useReleases = (
  project: string,
  filters: ReleaseFilters,
  count = 12,
): SWRResponse<PlanningPage<Release> & { statusCounts: Record<string, number> }, Error> => {
  const query = useSWR(["releases", project, "list", filters, count], () =>
    getReleases(project, filters, count),
  );
  useReleaseSync(project, query.mutate);
  return query;
};

/**
 * Адресный релиз; поздний ответ остаётся в кеше своего проекта.
 */
export const useRelease = (
  project: string,
  reference: string | null,
): SWRResponse<Release, Error> => {
  const query = useSWR(
    reference === null ? null : ["releases", project, "release", reference],
    () => getRelease(project, reference ?? ""),
  );
  useReleaseSync(project, query.mutate);
  return query;
};

/**
 * Состав выпуска имеет собственное продолжение и общий серверный итог.
 */
export const useReleasePlans = (
  project: string,
  reference: string,
  count = 12,
): SWRResponse<ReleaseComposition, Error> => {
  const query = useSWR(["releases", project, "plans", reference, count], () =>
    getReleasePlans(project, reference, count),
  );
  useReleaseSync(project, query.mutate);
  return query;
};

/**
 * Проверяет несохранённый состав через предметный POST вне SWR; поздний ответ не меняет новый выбор.
 */
export const useReleasePreview = (project: string, planIds: string[]): ReleasePreviewState => {
  const selection = JSON.stringify(planIds);
  const key = JSON.stringify([project, selection]);
  const latestRequest = useRef(0);
  const [preview, setPreview] = useState<PreviewRequestState | null>(null);

  /**
   * Запоминает только последний ответ для текущего проекта и состава.
   */
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++latestRequest.current;
    setPreview({ key, data: undefined, error: undefined, isLoading: true });
    try {
      const selectedIds = z.array(z.string()).parse(JSON.parse(selection));
      const data = await getReleasePreview(project, selectedIds);
      if (request === latestRequest.current) {
        setPreview({ key, data, error: undefined, isLoading: false });
      }
    } catch (error) {
      if (request === latestRequest.current) {
        setPreview({ key, data: undefined, error, isLoading: false });
      }
    }
  }, [key, project, selection]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);
  useReleaseSync(project, refresh);

  const current = preview?.key === key ? preview : null;
  const error = current?.error;
  if (error !== undefined && !(error instanceof ReleaseError)) throw error;
  return {
    data: current?.data,
    error,
    isLoading: current?.isLoading ?? true,
    refresh,
  };
};

/**
 * Обновляет только релизные представления выбранного проекта после квитанции.
 */
export const useReleasesRefresh = (project: string): (() => Promise<unknown>) => {
  const { mutate } = useSWRConfig();
  return useCallback(
    () => mutate((key) => Array.isArray(key) && key[0] === "releases" && key[1] === project),
    [mutate, project],
  );
};
