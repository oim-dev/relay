import type {
  TaskCommentsPage,
  TaskCommentsQuery,
  TaskComment,
  TaskCommentSaved,
} from "@relay/core/domain/board-task";
import type { TextOptions } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { safeText } from "./text.js";
import { wrap } from "./layout.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Читаемая лента с точной командой продолжения и сохранением фильтров. */
export function taskActivityText(
  page: TaskCommentsPage,
  reference: string,
  query: TaskCommentsQuery,
  options: TextOptions,
): string {
  const flags = [
    query.actor ? `--by ${quote(query.actor)}` : "",
    query.action ? `--action ${quote(query.action)}` : "",
    query.after !== undefined ? `--after ${query.after}` : "",
    `--limit ${query.limit ?? 20}`,
  ]
    .filter(Boolean)
    .join(" ");
  const rows = page.items.map((event) =>
    wrap(
      `${event.id} · ${safeText(event.title)}\n${safeText(event.actor)} · ${event.at}\nЧитать: relay-cli task comment get ${quote(reference)} ${event.id}`,
      options.width,
    ),
  );
  return [
    `Обсуждения · ${safeText(reference)}`,
    rows.join("\n\n") || "В этой части ленты записей нет.",
    `Граница снимка: ${page.snapshot}.`,
    page.nextCursor
      ? `Продолжение: relay-cli task comment list ${quote(reference)} ${flags} --cursor ${quote(page.nextCursor)}`
      : "Конец списка.",
  ].join("\n\n");
}

/** Полное сообщение: Markdown рендерится, обычный текст экранируется. */
export function taskActivityEventText(event: TaskComment, options: TextOptions): string {
  return [
    wrap(`${event.id} · ${safeText(event.title)}`, options.width),
    wrap(
      `${safeText(event.actor)} · ${event.actorRole ?? "роль не задана"} · ${event.at}\nОперация: ${safeText(event.operationId)}`,
      options.width,
    ),
    event.description !== undefined ? renderMarkdown(event.description, options) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Ответ текущей публикации; ревизия относится к ленте. */
export function taskCommentSavedText(saved: TaskCommentSaved): string {
  return `Сообщение опубликовано.\nЗадача: ${saved.id}\nСообщение: ${saved.commentId}\nРевизия ленты: ${saved.revision}\nИдентификатор запроса: ${saved.requestId}`;
}
