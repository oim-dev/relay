import { defaultBoardPrefix } from "../../domain/board.js";
import type { Board } from "../../domain/board.js";
import type { EntityEntry } from "./catalog.js";

/** Канонический EntityDetail доски не подменяется специализированным BoardView. */
export function boardEntityEntry(board: Board, name: string): EntityEntry {
  const prefix = board.prefix ?? defaultBoardPrefix(board.slug);
  return {
    ref: { kind: "board", id: board.id },
    key: board.key ?? `BOARD-${prefix}`,
    title: name,
    summary: `Доска задач: ${name}`,
    revision: board.revision,
    data: {
      kind: "board",
      slug: board.slug,
      prefix,
      scope: board.kind,
      applicationId: board.applicationId,
    },
    aliases: board.aliases ?? [],
    selectors: [board.slug, prefix],
    filters: { application: board.applicationId },
    status: null,
    active: true,
  };
}
