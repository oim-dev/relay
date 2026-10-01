import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import useSWRInfinite from "swr/infinite";
import type { SWRInfiniteResponse } from "swr/infinite";
import { subscribeWorkspace } from "infra/workspace-events";
import { getBoard, getBoards } from "../adapters/boards.adapter";
import type { Board, BoardsPage } from "../types/boards.type";

/** Окно объединения соседних уведомлений SSE. */
const REFRESH_DELAY = 100;

/**
 * Перечитывает данные после внешних изменений и восстановления связи.
 * Первый сигнал подписки отражает уже известное состояние: первичную загрузку выполняет SWR.
 * Соседние уведомления объединяются в одно перечитывание.
 */
const useWorkspaceRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  useEffect(() => {
    let isFirst = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspace(projectId, (signal) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (signal.state !== "connected") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh().catch(() => undefined), REFRESH_DELAY);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId, refresh]);
};

/**
 * Изолирует страницы каталога по проекту и перечитывает после внешних изменений.
 * Число загруженных страниц общее для всех потребителей проекта и при обновлении не сбрасывается:
 * все страницы перечитываются заново от первой, продолжение берёт версию только что прочитанной
 * предыдущей страницы, поэтому страницы разных версий не склеиваются.
 */
export const useBoards = (projectId: string): SWRInfiniteResponse<BoardsPage, Error> => {
  const query = useSWRInfinite<BoardsPage, Error>(
    (index: number, previous: BoardsPage | null) => {
      if (previous?.nextOffset === null) return null;
      return ["boards", projectId, index === 0 ? 0 : previous?.nextOffset, previous?.version];
    },
    ([, project, offset, version]: [string, string, number, string | undefined]) =>
      getBoards(project, offset, version),
    { revalidateAll: true, persistSize: false },
  );
  useWorkspaceRefresh(projectId, query.mutate);
  return query;
};

/** Поддерживает актуальность открытой доски, в том числе её названия. */
export const useBoard = (projectId: string, slug: string): SWRResponse<Board, Error> => {
  const query = useSWR<Board, Error>(slug ? ["board-info", projectId, slug] : null, () =>
    getBoard(projectId, slug),
  );
  useWorkspaceRefresh(projectId, query.mutate);
  return query;
};
