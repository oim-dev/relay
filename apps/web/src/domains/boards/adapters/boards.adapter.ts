import { getProjectApi, ApiError, getStorageFailureMessage } from "infra/tasks-api";
import { BOARD_SCHEMA, BOARDS_PAGE_SCHEMA } from "../config/boards.schema";
import type { Board, BoardsPage } from "../types/boards.type";

/** Читает одну страницу досок через общий SDK. */
export const getBoards = async (
  projectId: string,
  offset: number,
  version?: string,
): Promise<BoardsPage> => {
  const response = await getProjectApi(projectId).boards.getBoards({ offset, limit: 50, version });
  return BOARDS_PAGE_SCHEMA.parse(response.data);
};

/** Читает доску по адресу, независимо от загруженной страницы каталога. */
export const getBoard = async (projectId: string, slug: string): Promise<Board> => {
  const address = BOARD_SCHEMA.shape.slug.safeParse(slug);
  if (!address.success) throw new Error("Некорректный адрес доски");
  const response = await getProjectApi(projectId)
    .boards.getBoardBySlug({ slug: address.data })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404)
        throw new Error("Доска не найдена. Выберите существующую доску в навигации.", {
          cause: error,
        });
      const storageMessage = getStorageFailureMessage(error);
      if (storageMessage !== null) throw new Error(storageMessage, { cause: error });
      if (error instanceof ApiError || error instanceof TypeError)
        throw new Error("Не удалось прочитать доску. Проверьте соединение и повторите загрузку.", {
          cause: error,
        });
      throw error;
    });
  return BOARD_SCHEMA.parse(response.data);
};
