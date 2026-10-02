import type { MaterialView } from "domains/documents";

/** Названия системных представлений каталога. */
export const VIEW_LABELS: Record<MaterialView, string> = {
  all: "Все материалы",
  pinned: "Закреплённые",
  recent: "Недавно обновлённые",
  draft: "Черновики",
  none: "Без раздела",
  unattached: "Без прикреплений",
  archived: "Архив",
};
/** Верхняя граница восстанавливаемых по адресу порций, по 40 материалов. */
export const MAX_PAGES = 25;
/** Параметры адреса, задающие область каталога; строка поиска и порядок в неё не входят. */
export const SCOPE_PARAMS = ["view", "section", "kind", "target", "tags", "format", "status"];
/** Предел одного массового действия по контракту. */
export const BULK_LIMIT = 100;
