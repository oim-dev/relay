import { useEffect } from "react";
import { subscribeWorkspace } from "infra/workspace-events";
import { subscribeMaterialsChanged } from "../operations/materials-changes";

/** Окно объединения соседних уведомлений SSE. */
const REFRESH_DELAY = 150;

/**
 * Перечитывает подтверждённые данные материалов после изменений из этой вкладки и из потока проекта.
 * Первый сигнал подписки отражает уже известное состояние: первичное чтение выполняет SWR.
 */
export const useMaterialsSubscription = (
  projectId: string,
  refresh: () => Promise<unknown>,
): void => {
  useEffect(() => {
    let isFirst = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => void refresh().catch(() => undefined);
    const unsubscribeStream = subscribeWorkspace(projectId, (signal) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (signal.state !== "connected") return;
      clearTimeout(timer);
      timer = setTimeout(run, REFRESH_DELAY);
    });
    const unsubscribeLocal = subscribeMaterialsChanged(projectId, run);
    return () => {
      clearTimeout(timer);
      unsubscribeStream();
      unsubscribeLocal();
    };
  }, [projectId, refresh]);
};
