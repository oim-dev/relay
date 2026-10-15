import { useEffect } from "react";
import { subscribeWorkspace } from "infra/workspace-events";

/**
 * Объединяет изменения и reconnect общего потока проекта, без polling и второго транспорта.
 * Изменение во время чтения оставляет ещё одно перечитывание; cleanup не трогает чужих подписчиков.
 */
export const useWorkRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  useEffect(() => {
    let isFirst = true;
    let isDisposed = false;
    let isReading = false;
    let isPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Последовательно перечитывает состояние, не теряя сигнал во время запроса.
     */
    const flush = async (): Promise<void> => {
      timer = undefined;
      if (isDisposed || isReading) return;
      isReading = true;
      isPending = false;
      try {
        await refresh();
      } catch {
        // Отказ хранится в SWR и выводится рядом с прежними данными.
      } finally {
        isReading = false;
        if (isPending && !isDisposed) timer = setTimeout(() => void flush(), 150);
      }
    };
    const unsubscribe = subscribeWorkspace(projectId, (signal) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (signal.state !== "connected") return;
      isPending = true;
      if (timer === undefined && !isReading) timer = setTimeout(() => void flush(), 150);
    });
    return () => {
      isDisposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId, refresh]);
};
