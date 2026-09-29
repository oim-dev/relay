import { createHash } from "node:crypto";
import { boardsQuerySchema, defaultBoardPrefix } from "../../domain/board.js";
import type { Board, BoardView, BoardsQuery } from "../../domain/board.js";
import type { ProductRecord } from "../../domain/product.js";
import { parse } from "../../domain/validation.js";
import { BoardRepository } from "../../storage/boards.js";
import { ProductRepository } from "../../storage/product.js";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { entityReferenceSchema } from "@relay/contracts/primitives";

/**
 * Представление досок каталога с проверкой системных досок и досок приложений.
 * Чистая функция: вызывающий читает записи в одной сессии блокировки.
 */
export function boardViews(boards: Board[], products: ProductRecord[]): BoardView[] {
  const views = boards.map((board): BoardView => {
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
    const application = products.find((record) => record.id === board.applicationId);
    invariant(
      application?.fields.kind === "application" && application.fields.slug === board.slug,
      "INVALID_DATA",
      "Доска не соответствует приложению",
      5,
    );
    return {
      ...data,
      prefix: board.prefix ?? defaultBoardPrefix(board.slug),
      name: application.fields.name,
    };
  });
  invariant(
    views.some((board) => board.kind === "product") &&
      views.some((board) => board.kind === "infrastructure"),
    "INVALID_DATA",
    "Системные доски отсутствуют: требуется новый инициализированный проект",
    5,
  );
  for (const record of products) {
    if (record.fields.kind === "application")
      invariant(
        views.some((board) => board.applicationId === record.id),
        "INVALID_DATA",
        "У приложения отсутствует доска",
        5,
      );
  }
  const order = { product: 0, application: 1, infrastructure: 2 };
  return views.sort(
    (left, right) =>
      order[left.kind] - order[right.kind] ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

/** Каталог досок одного проекта; не смешивает прежние задачи с новыми контейнерами. */
export class BoardsService {
  constructor(readonly workspace: Workspace) {}

  private async snapshot(): Promise<BoardView[]> {
    return this.workspace.locked(async () =>
      boardViews(
        await new BoardRepository(this.workspace).all(),
        await new ProductRepository(this.workspace).all(),
      ),
    );
  }

  async list(input: BoardsQuery = {}) {
    const query = parse(boardsQuerySchema, input, "параметры каталога досок");
    const boards = await this.snapshot();
    const version = createHash("sha256").update(JSON.stringify(boards)).digest("hex");
    invariant(
      query.version === undefined || query.version === version,
      "BOARD_CHANGED",
      "Каталог досок изменился. Начните чтение заново.",
      4,
    );
    const items = boards.slice(query.offset, query.offset + query.limit);
    return {
      items,
      total: boards.length,
      version,
      nextOffset: query.offset + items.length < boards.length ? query.offset + items.length : null,
    };
  }

  async get(ref: string): Promise<BoardView> {
    return this.workspace.locked(async () => {
      const parsed = parse(entityReferenceSchema, ref, "ключ или ID доски");
      const address = parsed.startsWith("board:") ? parsed.slice(6) : parsed;
      const stored = (await new BoardRepository(this.workspace).all()).find(
        (entry) =>
          entry.id === address ||
          entry.slug === address ||
          entry.key === address ||
          entry.aliases?.includes(address) ||
          `BOARD-${entry.prefix ?? defaultBoardPrefix(entry.slug)}` === address ||
          (entry.prefix ?? defaultBoardPrefix(entry.slug)) === address,
      );
      const board = (await this.snapshot()).find((entry) => entry.id === stored?.id);
      invariant(board, "NOT_FOUND", "Доска не найдена", 3);
      return board;
    });
  }
}
