import { defaultBoardPrefix } from "../../domain/board.js";
import type { Board, BoardView } from "../../domain/board.js";
import { invariant } from "../../shared/errors.js";

/** Для имени и проверки принадлежности не нужны Markdown и состав реализации. */
export type BoardApplication = {
  id: string;
  fields: { kind: string; slug?: string; name?: string };
};

export function boardView(board: Board, application?: BoardApplication): BoardView {
  const { aliases: _aliases, requests: _requests, events: _events, ...data } = board;
  if (board.kind !== "application") {
    invariant(
      board.slug === board.kind && board.applicationId === null,
      "INVALID_DATA",
      "Некорректная системная доска",
      5,
    );
    return {
      ...data,
      prefix: board.prefix ?? defaultBoardPrefix(board.slug),
      name: board.kind === "product" ? "Продукт" : "Инфраструктура",
    };
  }
  invariant(
    application?.id === board.applicationId &&
      application.fields.kind === "application" &&
      application.fields.slug === board.slug &&
      typeof application.fields.name === "string",
    "INVALID_DATA",
    "Доска не соответствует приложению",
    5,
  );
  return {
    ...data,
    prefix: board.prefix ?? defaultBoardPrefix(board.slug),
    name: application.fields.name,
  };
}

/** Полная проверка состава и прежний системный порядок снимка. */
export function boardViews(boards: Board[], products: BoardApplication[]): BoardView[] {
  const applications = new Map(products.map((record) => [record.id, record]));
  const views = boards.map((board) =>
    boardView(board, applications.get(board.applicationId ?? "")),
  );
  invariant(
    views.some((board) => board.kind === "product"),
    "INVALID_DATA",
    "Продуктовая доска отсутствует: требуется инициализированный проект",
    5,
  );
  const owners = new Set(views.map((board) => board.applicationId));
  for (const record of products) {
    if (record.fields.kind === "application")
      invariant(owners.has(record.id), "INVALID_DATA", "У приложения отсутствует доска", 5);
  }
  const order = { product: 0, application: 1, infrastructure: 2 };
  return views.sort(
    (left, right) =>
      order[left.kind] - order[right.kind] ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}
