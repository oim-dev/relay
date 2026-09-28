import type {
  TaskCommentsPage,
  TaskCommentsQuery,
  TaskComment,
  TaskCommentSaved,
} from "@relay/core/domain/board-task";
import { cardText, listText, receiptText } from "./common.js";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import type { TaskInvocation } from "./board-tasks.js";
import { renderMarkdown } from "./markdown.js";

export function taskActivityText(
  page: TaskCommentsPage,
  reference: string,
  query: TaskCommentsQuery,
  options: TextOptions,
  _invoke?: TaskInvocation,
): string {
  return listText(
    {
      title: `Комментарии · ${reference}`,
      filters: [
        ["Автор", query.actor ?? "все"],
        ["После номера", query.after === undefined ? undefined : String(query.after)],
        ["Действие", query.action ? "Публикация комментария" : undefined],
      ],
      items: page.items.map((e) => ({
        key: String(e.id),
        title: e.title,
        details: [`${e.actor} · ${e.at}`],
      })),
      emptyMessage: "В этой части ленты записей нет.",
    },
    options,
  );
}
export function taskActivityEventText(
  event: TaskComment,
  options: TextOptions,
  reference?: string,
  invoke?: TaskInvocation,
): string {
  const roles: Record<string, string> = {
    operator: "Оператор",
    orchestrator: "Оркестратор",
    worker: "Исполнитель",
  };
  return cardText(
    {
      title: `${event.id} · ${event.title}`,
      fields: [
        ["Задача", reference],
        ["Автор", event.actor],
        ["Роль", event.actorRole ? (roles[event.actorRole] ?? event.actorRole) : "не задана"],
        ["Опубликован", event.at],
      ],
      sections: [{ title: "Комментарий", body: renderMarkdown(event.description ?? "", options) }],
      commands:
        reference && invoke
          ? [
              {
                label: "Обсуждение задачи",
                command: invoke(["task", "comment", "list", reference]),
              },
            ]
          : [],
    },
    options,
  );
}
export function taskCommentSavedText(
  saved: TaskCommentSaved,
  invoke: TaskInvocation,
  reference = saved.id,
  title?: string,
  options: TextOptions = defaultTextOptions,
): string {
  return receiptText(
    {
      title: `${reference} · Комментарий опубликован`,
      fields: [
        ["Комментарий", saved.commentId],
        ["Заголовок", title],
        ["Ревизия ленты", saved.revision],
      ],
      commands: [
        {
          label: "Читать комментарий",
          command: invoke(["task", "comment", "get", reference, String(saved.commentId)]),
        },
      ],
    },
    options,
  );
}
