import { z } from "zod";
import {
  productRecordSchema,
  productContractSchema,
  productIdSchema,
  productKeySchema,
  productRefSchema,
  productStatusSchema,
} from "./product.js";
import { actorSchema, requestIdSchema } from "../primitives.js";

/** Самостоятельная реализация; история прежнего состава остаётся у исходного агрегата. */
export const productImplementationSchema = productRecordSchema.omit({ fields: true }).extend({
  fields: productContractSchema.omit({ id: true, key: true, revision: true }).extend({
    kind: z.literal("implementation"),
    applicationId: productIdSchema,
  }),
});
export const storedImplementationSchema = productImplementationSchema.extend({
  version: z.literal(3),
  fields: productImplementationSchema.shape.fields.extend({
    description: z.array(z.string().refine((line) => !line.includes("\n"))),
  }),
});
export type ProductImplementation = z.infer<typeof productImplementationSchema>;
export const productEntitySchema = z.union([
  productRecordSchema.extend({ canonicalRef: productRefSchema.optional() }),
  productImplementationSchema.extend({ canonicalRef: productRefSchema.optional() }),
]);
export const productEntityQuerySchema = z.strictObject({ ref: productRefSchema });
export const productEntitySummarySchema = z.strictObject({
  id: productIdSchema,
  key: productKeySchema.optional(),
  kind: z.enum(["passport", "feature", "scenario", "application", "implementation", "document"]),
  title: z.string().describe("Однострочное название цели"),
  summary: z.string().describe("Краткий обычный текст без полного Markdown"),
  revision: z.number().int().positive(),
  applicationId: productIdSchema.nullable(),
  applicationKey: productKeySchema.nullable(),
  applicationName: z.string().nullable(),
  featureId: productIdSchema.nullable(),
  scenarioId: productIdSchema.nullable(),
  targetKey: productKeySchema.nullable(),
  targetName: z.string().nullable(),
  active: z.boolean(),
  status: productStatusSchema.nullable(),
});
export const productEntitiesQuerySchema = z.strictObject({
  q: z
    .string()
    .max(4096)
    .optional()
    .describe("Поиск по ключу или названию; точное совпадение первым"),
  kind: productEntitySummarySchema.shape.kind.optional().describe("Тип цели"),
  application: productRefSchema.optional().describe("ID или ключ приложения"),
  implementationTarget: z
    .enum(["feature", "scenario"])
    .optional()
    .describe("Только реализации фич или сценариев; фильтр применяется до пагинации"),
  refs: z
    .array(productRefSchema)
    .max(100)
    .optional()
    .describe("До 100 ID или ключей для краткого чтения существующих связей"),
  active: z
    .enum(["true", "false"])
    .optional()
    .describe("Фильтр участия; прежние ссылки читаются без фильтра"),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Смещение страницы; продолжение возвращается в nextOffset"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe("Размер страницы от 1 до 100"),
});
export const productEntitiesSchema = z.strictObject({
  items: z.array(productEntitySummarySchema),
  total: z.number(),
  nextOffset: z.number().nullable(),
  version: z.string(),
});
export const updateImplementationSchema = z.strictObject({
  ref: productRefSchema,
  ifRevision: z.number().int().positive().describe("Ревизия выбранной реализации"),
  title: productContractSchema.shape.title.optional().describe("Однострочный заголовок реализации"),
  description: productContractSchema.shape.description
    .optional()
    .describe("Полное описание вклада в Markdown"),
  status: productStatusSchema
    .optional()
    .describe("Состояние реализации; done подтверждает актуальные требования"),
  key: productKeySchema
    .optional()
    .describe("Свободный ключ для разрешения коллизии; ID сохраняется"),
  requestId: requestIdSchema,
  actor: actorSchema.optional().describe("Автор изменения"),
});
export type ProductEntity = z.infer<typeof productEntitySchema>;
export type ProductEntitySummary = z.infer<typeof productEntitySummarySchema>;
export type ProductEntitiesQuery = z.input<typeof productEntitiesQuerySchema>;
export type UpdateImplementation = z.infer<typeof updateImplementationSchema>;

export function encodeImplementation(record: ProductImplementation) {
  return storedImplementationSchema.parse({
    ...record,
    version: 3,
    fields: { ...record.fields, description: record.fields.description.split("\n") },
  });
}
export function decodeImplementation(value: unknown): ProductImplementation {
  const stored = storedImplementationSchema.parse(value);
  return productImplementationSchema.parse({
    ...stored,
    version: 1,
    fields: { ...stored.fields, description: stored.fields.description.join("\n") },
  });
}
