import { useBoards } from "domains/boards";
import { documentEntityHref } from "../adapters/documents.adapter";
import type { DocumentEntity } from "../types/document.type";

/**
 * Даёт построитель постоянных адресов сущностей проекта, включая экран доски.
 * Slug доски берётся из каталога досок — того же кеша, что у навигации проекта,
 * поэтому отдельного запроса обычно нет; пока каталог не прочитан, доска ведёт в контекст связей.
 */
export const useEntityHref = (
  projectId: string,
  base: string,
): ((entity: DocumentEntity) => string) => {
  const boards = useBoards(projectId);
  const boardSlugs = new Map(
    (boards.data ?? []).flatMap((page) => page.items).map((board) => [board.id, board.slug]),
  );
  return (entity) => documentEntityHref(base, entity, boardSlugs);
};
