import { createHash } from "node:crypto";
import { boardsQuerySchema, defaultBoardPrefix } from "../../domain/board.js";
import type { BoardView, BoardsQuery } from "../../domain/board.js";
import { parse } from "../../domain/validation.js";
import { BoardRepository } from "../../storage/boards.js";
import { ProductRepository } from "../../storage/product.js";
import type { Workspace } from "../../storage/workspace.js";
import { AppError, invariant } from "../../shared/errors.js";
import { entityReferenceSchema } from "@relay/contracts/primitives";
import { boardViews } from "./view.js";
import { indexedBoardApplications, readBoard, resolveBoardCard } from "./read.js";
export { boardViews } from "./view.js";

/** Каталог досок одного проекта; не смешивает прежние задачи с новыми контейнерами. */
export class BoardsService {
  constructor(readonly workspace: Workspace) {}

  private async snapshot(): Promise<BoardView[]> {
    return this.workspace.locked(async () => {
      const boards = await new BoardRepository(this.workspace).all();
      const session = this.workspace.storageSession;
      return boardViews(
        boards,
        session && !session.changed
          ? await indexedBoardApplications(session)
          : await new ProductRepository(this.workspace).all(),
      );
    });
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
      const session = this.workspace.storageSession;
      if (session && !session.changed) {
        let card;
        try {
          card = await resolveBoardCard(session, parsed);
        } catch (error) {
          if (error instanceof AppError && error.code === "ENTITY_NOT_FOUND")
            throw new AppError("NOT_FOUND", "Доска не найдена", 3);
          throw error;
        }
        return (await readBoard(this.workspace, card)).view;
      }
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
