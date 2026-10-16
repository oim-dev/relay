import { z } from "zod";
import { text, timestampSchema } from "./primitives.js";
import {
  workHistoryEventKindSchema,
  workHistoryIdSchema,
  workSessionKeySchema,
  workSessionStatusSchema,
} from "./work-history-primitives.js";

export const OVERVIEW_SESSIONS_LIMIT = 5;
const sessionAddress = z.strictObject({
  id: workHistoryIdSchema.describe("Постоянный ID сессии"),
  key: workSessionKeySchema,
});
export const overviewSessionSchema = sessionAddress
  .extend({
    title: text(1024).describe("Сохранённое название поручения без сокращения"),
    status: workSessionStatusSchema,
    parent: sessionAddress.nullable().describe("Адрес родительской сессии; null у корня"),
    lastEvent: z
      .strictObject({
        kind: workHistoryEventKindSchema,
        at: timestampSchema.describe("Время последнего сохранённого события самой сессии"),
        sequence: z.number().int().positive().describe("Номер последнего события внутри сессии"),
      })
      .describe("Последнее событие сессии; не признак присутствия агента online"),
  })
  .describe("Краткая сессия для обзора проекта: без поручения, итога, оператора и Git");

export const overviewSessionsSchema = z
  .strictObject({
    total: z
      .number()
      .int()
      .nonnegative()
      .describe("Все сессии проекта, включая завершённые и отменённые"),
    latest: overviewSessionSchema
      .nullable()
      .describe("Сессия последнего события проекта; null, если история пуста"),
    unfinished: z
      .strictObject({
        total: z
          .number()
          .int()
          .nonnegative()
          .describe("Все сессии pending/open/paused независимо от давности"),
        shown: z
          .number()
          .int()
          .nonnegative()
          .max(OVERVIEW_SESSIONS_LIMIT)
          .describe("Число сессий в подборке"),
        hasMore: z.boolean().describe("Есть незавершённые сессии вне подборки"),
        items: z
          .array(overviewSessionSchema)
          .max(OVERVIEW_SESSIONS_LIMIT)
          .describe("До пяти незавершённых сессий: время последнего события, затем ID по убыванию"),
      })
      .describe(
        "Подборка всех незавершённых веток; дети учитываются отдельно и сохраняют родителя",
      ),
  })
  .describe("Последняя сессия и независимая от неё выборка незавершённых сессий проекта");

export type OverviewSession = z.output<typeof overviewSessionSchema>;
export type OverviewSessions = z.output<typeof overviewSessionsSchema>;
