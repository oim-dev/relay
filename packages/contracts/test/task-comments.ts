import { z } from "zod";
import {
  taskCommentsQuerySchema,
  taskCommentsPageSchema,
  taskCommentSchema,
  taskCommentSummarySchema,
  publishTaskCommentSchema,
} from "../src/entities/task-comments.js";
import type {
  TaskCommentsQuery,
  TaskCommentsPage,
  TaskComment,
  TaskCommentSummary,
  PublishTaskComment,
} from "../src/entities/board-task.js";

/** Ввод запроса допускает coercion, результат уже содержит числовой limit. */
const input: TaskCommentsQuery = { limit: "2", after: "7", action: "comment-publish" };
const output: z.output<typeof taskCommentsQuerySchema> = taskCommentsQuerySchema.parse(input);
const limit: number = output.limit;
void limit;

export function checkCommentTypes(value: unknown) {
  const summary: TaskCommentSummary = taskCommentSummarySchema.parse(value);
  const comment: TaskComment = taskCommentSchema.parse(value);
  const page: TaskCommentsPage = taskCommentsPageSchema.parse(value);
  const publish: PublishTaskComment = publishTaskCommentSchema.parse(value);
  const action: "comment-publish" = summary.action;
  const emptyChanges: [] = comment.changes;
  const emptyFields: [] = summary.fields;
  const description: string = comment.description;
  void [page, publish, action, emptyChanges, emptyFields, description];
}

// @ts-expect-error Общий аудит не является фильтром комментариев.
const historyQuery: TaskCommentsQuery = { action: "update" };
void historyQuery;
