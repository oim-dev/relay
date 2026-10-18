import { z } from "zod";

export const SYNCHRONIZATION_CAPABILITY = "relay-background-sync-v1";
export const synchronizationRequestSchema = z
  .strictObject({})
  .describe("Запрос фоновой попытки без ожидания origin");
const time = z.string().datetime().nullable();
export const synchronizationStatusSchema = z.strictObject({
  mode: z.enum(["file", "git"]).describe("Файловая база либо база в Git"),
  status: z
    .enum(["local", "synced", "pending", "syncing", "offline", "conflict", "unknown"])
    .describe("Состояние фоновой доставки; offline и conflict не запрещают локальную работу"),
  origin: z.string().nullable().describe("Адрес origin без credentials; null, если не настроен"),
  queuedCommits: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Локальные коммиты без подтверждения в последнем проверенном origin; null, если удалённое состояние неизвестно",
    ),
  uncommittedChanges: z
    .boolean()
    .describe("В локальной базе есть изменения, ещё не собранные в Git-коммит"),
  localHead: z
    .string()
    .nullable()
    .describe("Текущий локальный коммит базы; null для файлового режима"),
  remoteHead: z
    .string()
    .nullable()
    .describe("Последний проверенный коммит origin, не утверждение о его текущем состоянии"),
  lastSuccessAt: time.describe("Время последнего подтверждённого согласования с origin"),
  lastAttemptAt: time.describe("Время начала последней сетевой попытки"),
  nextAttemptAt: time.describe("План следующей фоновой попытки; не ограничение запросов к базе"),
  conflictId: z.string().nullable().describe("ID сохранённого конфликта синхронизации"),
  error: z
    .strictObject({
      code: z.string().describe("Машинный код ошибки доставки"),
      message: z.string().describe("Пояснение ошибки доставки"),
    })
    .nullable()
    .describe("Последняя ошибка; данные доступны локально"),
});
export type SynchronizationStatus = z.infer<typeof synchronizationStatusSchema>;
