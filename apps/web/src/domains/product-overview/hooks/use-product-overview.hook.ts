import { useEffect, useState } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import type { WorkspaceSignal } from "infra/workspace-events";
import { getProductOverview } from "../adapters/get-product-overview.adapter";
import type { GetProductOverviewError } from "../errors/product-overview.error";
import { getProductOverviewKey } from "../helpers/get-product-overview-key";
import type {
  ProductOverview,
  ProductOverviewFreshness,
  ProductOverviewSync,
} from "../types/product-overview.type";

/** Тишина после последнего уведомления перед повторным чтением: пачка изменений сворачивается. */
const COALESCE_DELAY = 300;
/** Предел ожидания при непрерывном потоке уведомлений, чтобы обзор не застывал. */
const MAX_COALESCE_WAIT = 1_000;

/** Состояние сверки обзора с потоком изменений проекта. */
type SyncState = {
  /** Последний сигнал общего потока проекта. */
  signal: WorkspaceSignal["state"];
  /** Сообщение сервера об ошибке хранилища. */
  message?: string;
  /** Номер последнего уведомления, требующего повторного чтения. */
  requested: number;
  /** Номер уведомления, после которого завершено последнее повторное чтение. */
  settled: number;
};

const FRESHNESS_BY_SIGNAL: Record<WorkspaceSignal["state"], ProductOverviewFreshness> = {
  connected: "live",
  connecting: "connecting",
  reconnecting: "connecting",
  disconnected: "offline",
  "storage-error": "storage-error",
};

/**
 * Перечитывает обзор после изменений и восстановления потока: уведомления пачки
 * объединяются до паузы (но не дольше предела ожидания), одновременно выполняется не более
 * одного чтения, а изменение во время чтения вызывает ещё одно чтение после его завершения.
 */
const useProductOverviewSync = (projectId: string, refresh: () => Promise<unknown>): SyncState => {
  const [state, setState] = useState<SyncState>({
    signal: "connecting",
    requested: 0,
    settled: 0,
  });
  useEffect(() => {
    let isFirst = true;
    let isDisposed = false;
    let isReading = false;
    let isDirty = false;
    let requested = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingSince: number | undefined;

    const read = async (): Promise<void> => {
      timer = undefined;
      pendingSince = undefined;
      if (isReading) {
        isDirty = true;
        return;
      }
      isReading = true;
      isDirty = false;
      const target = requested;
      try {
        await refresh();
      } catch {
        // Ошибку чтения показывает SWR; сверка лишь фиксирует завершение попытки.
      } finally {
        isReading = false;
        if (!isDisposed) {
          setState((current) => ({ ...current, settled: Math.max(current.settled, target) }));
          if (isDirty) schedule();
        }
      }
    };

    const schedule = (): void => {
      const now = Date.now();
      pendingSince ??= now;
      const delay = Math.max(0, Math.min(COALESCE_DELAY, pendingSince + MAX_COALESCE_WAIT - now));
      clearTimeout(timer);
      timer = setTimeout(() => void read(), delay);
    };

    const unsubscribe = subscribeWorkspace(projectId, (signal) => {
      // Первый сигнал отражает уже известное состояние; начальное чтение выполняет SWR.
      const shouldRead = !isFirst && signal.state === "connected";
      isFirst = false;
      if (shouldRead) requested = signal.sequence;
      setState((current) => ({
        signal: signal.state,
        message: signal.message,
        requested: shouldRead ? signal.sequence : current.requested,
        settled: current.settled,
      }));
      if (shouldRead) schedule();
    });
    return () => {
      isDisposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId, refresh]);
  return state;
};

/**
 * Сводит состояние потока и последнего чтения в актуальность показанных данных:
 * отказ хранилища и потока важнее неудачного обновления, оно важнее ожидания чтения.
 */
const getFreshness = (sync: SyncState, hasFailedRefresh: boolean): ProductOverviewFreshness => {
  const signalFreshness = FRESHNESS_BY_SIGNAL[sync.signal];
  if (signalFreshness === "storage-error" || signalFreshness === "offline") return signalFreshness;
  if (hasFailedRefresh) return "stale";
  if (signalFreshness === "live" && sync.requested > sync.settled) return "refreshing";
  return signalFreshness;
};

/**
 * Обзор выбранного проекта: согласованный срез сервера и его актуальность.
 *
 * Ключ кеша включает постоянный ID проекта, поэтому поздний ответ другого проекта
 * не попадает в показанный обзор. Отказ потока и ошибка чтения не превращаются в нули.
 */
export const useProductOverview = (
  projectId: string,
): SWRResponse<ProductOverview, GetProductOverviewError> & ProductOverviewSync => {
  const query = useSWR<ProductOverview, GetProductOverviewError>(
    getProductOverviewKey(projectId),
    () => getProductOverview(projectId),
  );
  const sync = useProductOverviewSync(projectId, query.mutate);
  const { data, error } = query;
  const freshness = getFreshness(sync, data !== undefined && error !== undefined);
  return { ...query, freshness, message: sync.message };
};
