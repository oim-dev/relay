import { z } from "zod";

/**
 * Первая дисковая форма истории работы (профиль 3, dataVersion 1). У новых владельцев
 * нет прежней схемы или преобразования данных; профиль 2 переносится с пустой историей.
 * Эта форма фиксируется вместе с первой реализацией work-history-codecs.ts и тестом
 * work-history-storage.test.ts; будущие версии не должны менять её или импортировать
 * сюда изменяемые схемы Contracts. Markdown — строки split("\n"), не публичный DTO.
 */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const sequence = z.number().int().positive();
const at = z.iso.datetime();
const markdown = z.array(
  z
    .string()
    .refine((line) => !line.includes("\n"), "Перевод строки внутри дисковой строки Markdown"),
);
const title = z.string().min(1);
const actor = z.string().min(1).max(128);

export const workSessionV1 = z.strictObject({
  id,
  key: z.string().regex(/^S-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  title,
  description: markdown,
  parentSessionId: id.nullable(),
  originCheckpointId: id.nullable(),
  createdByRunId: id.nullable(),
  parentSequence: sequence.nullable(),
  status: z.enum(["pending", "open", "paused", "completed", "cancelled"]),
  currentRunId: id.nullable(),
  sequence,
  result: markdown,
  createdAt: at,
  updatedAt: at,
  closedAt: at.nullable(),
  revision: z.number().int().positive(),
});
export const agentRunV1 = z.strictObject({
  id,
  key: z.string().regex(/^RUN-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sessionId: id,
  actor,
  operator: z
    .strictObject({
      name: z.string().nullable(),
      email: z.string().nullable(),
      source: z.enum(["explicit", "environment", "git", "inherited"]),
    })
    .nullable(),
  git: z.strictObject({ branch: z.string().nullable(), commit: z.string().nullable() }).nullable(),
  client: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  startedAt: at,
  endedAt: at.nullable(),
  startedSequence: sequence,
  endedSequence: sequence.nullable(),
  endReason: z.enum(["completed", "paused", "transferred", "cancelled"]).nullable(),
  predecessorRunId: id.nullable(),
  reason: markdown,
  endSummary: markdown.nullable(),
});
const checkpointShape = {
  id,
  key: z.string().regex(/^CP-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sessionId: id,
  runId: id,
  sequence,
  title,
  summary: z.string(),
  body: markdown,
  done: markdown,
  remaining: markdown,
  nextStep: markdown,
  checks: markdown,
  references: z
    .array(
      z.strictObject({
        ref: z.strictObject({
          kind: z.enum([
            "project",
            "product",
            "feature",
            "scenario",
            "application",
            "implementation",
            "board",
            "task",
            "document",
            "work-plan",
            "release",
          ]),
          id: z.string().min(1).max(128),
        }),
        key: z.string().nullable(),
        title: z.string(),
      }),
    )
    .max(100),
  createdAt: at,
  createdBy: actor,
};
export const workCheckpointV1 = z.discriminatedUnion("kind", [
  z.strictObject({
    ...checkpointShape,
    kind: z.literal("intent"),
    intentId: z.null(),
    acceptedSessionIds: z.array(id).max(0),
  }),
  z.strictObject({
    ...checkpointShape,
    kind: z.enum(["progress", "result", "cancel"]),
    intentId: id,
    acceptedSessionIds: z.array(id).max(100),
  }),
]);
