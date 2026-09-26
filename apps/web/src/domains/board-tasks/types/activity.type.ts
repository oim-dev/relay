import type { z } from "zod";
import type {
  ACTIVITY_SUMMARY_SCHEMA,
  ACTIVITY_EVENT_SCHEMA,
  ACTIVITY_PAGE_SCHEMA,
  COMMENT_SAVED_SCHEMA,
} from "../config/activity.schema";

/** Запись ленты без полного содержания. */
export type ActivitySummary = z.infer<typeof ACTIVITY_SUMMARY_SCHEMA>;
/** Полное сообщение обсуждения. */
export type ActivityEvent = z.infer<typeof ACTIVITY_EVENT_SCHEMA>;
/** Страница обсуждения. */
export type ActivityPage = z.infer<typeof ACTIVITY_PAGE_SCHEMA>;
/** Первоначальная квитанция публикации. */
export type CommentSaved = z.infer<typeof COMMENT_SAVED_SCHEMA>;
/** Содержание сообщения от оператора. */
export type PublishCommentInput = {
  /** Однострочный заголовок. */
  title: string;
  /** Полное сообщение в Markdown. */
  description: string;
  /** Корреляция HTTP-запроса, не ключ дедупликации. */
  requestId: string;
};
