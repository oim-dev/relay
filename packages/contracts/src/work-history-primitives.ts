import { z } from "zod";

/** Адреса и состояния без зависимости от каталога сущностей и полных материалов. */
export const workHistoryIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe("Постоянный ID записи истории в выбранном проекте");
export const workSessionKeySchema = z
  .string()
  .regex(/^S-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe(
    "Собственный адрес ветки: S- и безопасный случайный token; прежние числовые ключи допустимы",
  );
export const workSessionStatusSchema = z
  .enum(["pending", "open", "paused", "completed", "cancelled"])
  .describe("Ветка ожидает агента, открыта, приостановлена, завершена или отменена");
export const workHistoryEventKindSchema = z
  .enum([
    "session-created",
    "session-forked",
    "session-closed",
    "run-started",
    "run-ended",
    "checkpoint",
  ])
  .describe(
    "Производная точка хронологии из сохранённых веток, участий и checkpoints; отдельного event-store нет",
  );
