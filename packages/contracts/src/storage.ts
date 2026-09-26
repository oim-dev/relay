import { z } from "zod";
import { actorSchema, entityKeySchema, timestampSchema, requestIdSchema } from "./primitives.js";
import { taskCommentSchema } from "./entities/task-comments.js";
import { entityRefSchema, graphNodeSchema } from "./entities/graph.js";
import { entitySummarySchema } from "./entities.js";
import { planningEventSchema } from "./planning.js";

/** Переносимые схемы нового дискового формата; не DTO предметных операций. */
export const storageManifestSchema = z.strictObject({
  format: z.literal("relay-entities").describe("Маркер единого ID-хранилища"),
  schemaVersion: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe("Версия физического формата: 3 — квитанции и предметные события внутри сущностей; 1 и 2 требуют явного переноса"),
  productId: z
    .string()
    .optional()
    .describe("Постоянный ID прежнего продуктового агрегата для совместимости DTO"),
});
export const storageTokenSchema = entityRefSchema.shape.id;
export const storageCollectionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .describe("Коллекция записей зарегистрированного владельца");
export const storageKindDefinitionSchema = z.strictObject({
  kind: entityRefSchema.shape.kind,
  collection: storageCollectionSchema,
  dataVersion: z.number().int().positive().describe("Версия предметных данных на диске"),
});
export const storedReceiptSchema = z.strictObject({
  namespace: z.string().describe("Пространство операции; часть идентичности повтора"),
  actor: actorSchema.describe("Автор исходного запроса; часть идентичности повтора"),
  requestId: requestIdSchema,
  requestHash: z.string().describe("Исходный хеш содержимого запроса без пересчёта при переносе"),
  result: z.json().describe("Первоначальный результат для точного повтора, включая удаление"),
});
export const storedCommentSchema = taskCommentSchema.extend({
  description: z.array(z.string()).describe("Полный Markdown, разделённый по LF без нормализации"),
});
export const storedPlanningEventSchema = planningEventSchema.extend({
  description: z.array(z.string()).optional().describe("Предметное пояснение в Markdown, разделённое по LF"),
});
const identity = {
  schemaVersion: z.literal(2).describe("Версия оболочки записи с собственными квитанциями"),
  dataVersion: z.number().int().positive().describe("Версия данных зарегистрированного вида"),
  kind: entityRefSchema.shape.kind,
  id: storageTokenSchema,
  revision: z.number().int().nonnegative().describe("Предметная ревизия сущности"),
  key: entityKeySchema
    .nullable()
    .describe("Публичный ключ; null только для технического владельца"),
  aliases: z.array(entityKeySchema).describe("Зарезервированные прежние ключи"),
  receipts: z.array(storedReceiptSchema).default([]).describe("Квитанции команд основного владельца; сохраняются после удаления"),
  reservedKeys: z.array(entityKeySchema).optional().describe("Резервы прежнего формата без сохранившегося владельца; только явный перенос в проект"),
  comments: z.array(storedCommentSchema).optional().describe("Только опубликованные комментарии задачи"),
  commentSequence: z.number().int().nonnegative().optional().describe("Максимальный номер прежней ленты или нового комментария, включая пропуски"),
  planningEvents: z.array(storedPlanningEventSchema).optional().describe("Предметные события плана или релиза, без общего аудита"),
};
export const storedEntitySchema = z.strictObject({
  ...identity,
  data: z
    .record(z.string(), z.json())
    .describe("Данные вида; Markdown закодирован массивами строк"),
  createdAt: timestampSchema,
  createdBy: actorSchema,
  updatedAt: timestampSchema,
  updatedBy: actorSchema,
});
export const storedTombstoneSchema = z.strictObject({
  ...identity,
  deleted: z
    .strictObject({ at: timestampSchema, actor: actorSchema })
    .describe("Факт удаления; адреса сохраняются за прежним владельцем"),
});
export const storedRecordSchema = z.union([storedEntitySchema, storedTombstoneSchema]);
export const storedKeySpaceSchema = z.strictObject({
  schemaVersion: z.literal(1).describe("Версия пространства ключей"),
  id: storageTokenSchema,
  entityKind: entityRefSchema.shape.kind,
  owner: entityRefSchema.describe("Постоянный адрес владельца нумерации"),
  prefix: entityKeySchema.describe("Префикс выдачи; не определяет вид существующей записи"),
  format: z.literal("{prefix}-{number}").describe("Формат последовательного читаемого ключа"),
});
export const storageCardSchema = graphNodeSchema.extend({
  summary: entitySummarySchema.shape.summary.default(""),
  active: entitySummarySchema.shape.active.default(true),
  context: entitySummarySchema.shape.context,
  document: entitySummarySchema.shape.document,
  aliases: z.array(z.string()).describe("Алиасы для разрешения адресов"),
  selectors: z.array(z.string()).describe("Предметные адреса при явно заданном виде"),
});
export { fullContextSchema } from "./entities/graph.js";
export type { FullContext } from "./entities/graph.js";
export type StoredEntity = z.infer<typeof storedEntitySchema>;
export type StoredTombstone = z.infer<typeof storedTombstoneSchema>;
export type StoredRecord = z.infer<typeof storedRecordSchema>;
export type StoredReceipt = z.infer<typeof storedReceiptSchema>;
export type StoredKeySpace = z.infer<typeof storedKeySpaceSchema>;
export type StorageCard = z.infer<typeof storageCardSchema>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
