import { z } from "zod";
import {
  actorSchema,
  singleLine,
  text,
  timestampSchema,
  requestIdSchema,
  entityKeySchema,
  entityReferenceSchema,
} from "../primitives.js";
import { applicationSlugSchema, boardPrefixSchema } from "./board.js";
import { documentKindSchema, documentMetadataShape } from "./document-library.js";

export const productIdSchema = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9]{8}|passport|(?:feature|scenario|application|scope|document|contract)_[a-f0-9]{32})$/,
  );
export const productKeySchema = entityKeySchema;
export const productRefSchema = entityReferenceSchema.describe(
  "Постоянный ID или читаемый ключ сущности в выбранном проекте",
);
const title = singleLine(1024);
const markdown = text(256 * 1024).refine(
  (value) => value.trim().length > 0,
  "Markdown не должен быть пустым",
);
const description = {
  name: title.describe("Однострочное название"),
  summary: text(4096).describe("Краткое многострочное описание обычным текстом"),
  description: markdown.describe("Полное описание в Markdown"),
};
export const productStatusSchema = z.enum(["none", "partial", "done"]);
export const productReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product") }),
  z.strictObject({ kind: z.literal("feature"), id: productIdSchema }),
  z.strictObject({ kind: z.literal("scenario"), id: productIdSchema }),
  z.strictObject({ kind: z.literal("application"), id: productIdSchema }),
  z.strictObject({
    kind: z.literal("implementation"),
    applicationId: productIdSchema,
    id: productIdSchema,
  }),
]);
export const productContractInputSchema = z.strictObject({
  featureId: productIdSchema.describe("Постоянный ID общей фичи"),
  scenarioId: productIdSchema
    .nullable()
    .describe("Постоянный ID сценария; null для общего вклада в фичу"),
  title: title.describe("Однострочное название реализации"),
  description: markdown.describe("Описание вклада приложения в Markdown"),
  status: productStatusSchema.describe("Состояние вклада приложения"),
});
export const productContractSchema = productContractInputSchema.extend({
  id: productIdSchema,
  key: productKeySchema.optional(),
  revision: z.number().int().positive().optional(),
  active: z.boolean(),
  basis: z.string(),
});
export const productFieldsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("passport"), ...description }),
  z.strictObject({ kind: z.literal("feature"), ...description }),
  z.strictObject({
    kind: z.literal("scenario"),
    featureId: productIdSchema.describe("Постоянный ID родительской фичи"),
    name: title.describe("Однострочное название сценария"),
    description: markdown.describe("Описание поведения сценария в Markdown"),
  }),
  z.strictObject({
    kind: z.literal("application"),
    ...description,
    slug: applicationSlugSchema,
    prefix: boardPrefixSchema
      .optional()
      .describe("Префикс задач доски; при создании по умолчанию из slug, затем неизменяем"),
    type: z
      .enum(["frontend", "backend", "internal"])
      .describe("Назначение приложения: клиентское, серверное или внутреннее"),
  }),
  z.strictObject({
    kind: z.literal("scope"),
    applicationId: productIdSchema,
    contracts: z.array(productContractSchema).max(10000),
  }),
  z.strictObject({
    kind: z.literal("document"),
    name: title.describe("Однострочное название документа"),
    summary: text(4096).describe("Краткое обычное описание документа"),
    body: markdown.describe("Полный текст документа в Markdown"),
    documentKind: documentKindSchema,
    ...documentMetadataShape,
    links: z
      .array(productReferenceSchema)
      .max(1000)
      .describe("Явные области применимости документа по постоянным ID"),
  }),
]);
const writableFields = z.discriminatedUnion("kind", [
  productFieldsSchema.options[0],
  productFieldsSchema.options[1],
  productFieldsSchema.options[2].extend({ featureId: productRefSchema }),
  productFieldsSchema.options[3],
  productFieldsSchema.options[5].extend({
    links: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("product") }),
          z.strictObject({ kind: z.literal("feature"), id: productRefSchema }),
          z.strictObject({ kind: z.literal("scenario"), id: productRefSchema }),
          z.strictObject({ kind: z.literal("application"), id: productRefSchema }),
          z.strictObject({
            kind: z.literal("implementation"),
            applicationId: productRefSchema,
            id: productRefSchema,
          }),
        ]),
      )
      .max(1000),
  }),
  z.strictObject({
    kind: z.literal("scope"),
    applicationId: productRefSchema,
    contracts: z
      .array(
        productContractInputSchema.extend({
          featureId: productRefSchema,
          scenarioId: productRefSchema.nullable(),
          key: productKeySchema
            .optional()
            .describe("Прочитанный ключ; не меняется операцией замены состава"),
          revision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Прочитанная ревизия реализации; замена состава проверяет общую версию"),
        }),
      )
      .max(10000),
  }),
  z.strictObject({
    kind: z.literal("contract"),
    applicationId: productRefSchema,
    contractId: productRefSchema,
    status: productStatusSchema,
    title: title.optional(),
    description: markdown.optional(),
  }),
  productContractInputSchema.extend({
    kind: z
      .literal("implementation")
      .describe("Добавить одну реализацию, сохраняя остальные вклады"),
    applicationId: productRefSchema.describe("Ключ или ID приложения"),
    featureId: productRefSchema.describe("Ключ или ID общей фичи"),
    scenarioId: productRefSchema
      .nullable()
      .describe("Ключ или ID сценария; null для общего вклада"),
  }),
]);
export const productMutationSchema = z.strictObject({
  action: z.enum(["create", "update"]),
  id: productRefSchema.optional(),
  key: productKeySchema
    .optional()
    .describe("Новый ключ при явном разрешении конфликта; ID и связи сохраняются"),
  fields: writableFields,
  ifRevision: z.number().int().nonnegative().optional(),
  ifVersion: z.string().optional(),
  requestId: requestIdSchema,
  actor: actorSchema.optional(),
});
export const productSavedSchema = z.strictObject({
  id: productIdSchema,
  key: productKeySchema.optional(),
  revision: z.number().int().positive(),
});
export const productRecordSchema = z.strictObject({
  version: z.literal(1),
  productId: z.string().min(1),
  id: productIdSchema,
  key: productKeySchema.optional(),
  reservedKeys: z.array(productKeySchema).optional(),
  revision: z.number().int().positive(),
  fields: productFieldsSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema,
  updatedBy: actorSchema,
});
export const productReadinessSchema = z.strictObject({
  id: productIdSchema,
  status: productStatusSchema,
  participants: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
});
export const productStateSchema = z.strictObject({
  productId: z.string(),
  version: z.string(),
  records: z.array(productRecordSchema),
  readiness: z.array(productReadinessSchema),
});
export const productContextQuerySchema = z.strictObject({
  id: productRefSchema.optional(),
  applicationId: productRefSchema.optional(),
});
export const productContextSchema = z.strictObject({
  productId: z.string(),
  version: z.string(),
  records: z.array(
    z.strictObject({
      record: productRecordSchema,
      reasons: z.array(z.string()),
    }),
  ),
  readiness: z.array(productReadinessSchema),
});
export const productListQuerySchema = z.strictObject({
  kind: z.enum(["passport", "feature", "scenario", "application", "scope", "document"]).optional(),
  q: z.string().max(4096).optional(),
  id: productRefSchema.optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const productListSchema = z.strictObject({
  version: z.string(),
  total: z.number(),
  items: z.array(productRecordSchema),
  nextOffset: z.number().nullable(),
});
export const productOverviewSchema = z.strictObject({
  productId: z.string(),
  version: z.string(),
  items: z.array(
    z.strictObject({
      id: productIdSchema,
      key: productKeySchema.optional(),
      revision: z.number(),
      kind: z.string(),
      name: z.string(),
      summary: z.string(),
    }),
  ),
  readiness: z.array(productReadinessSchema),
});
export type ProductListQuery = z.input<typeof productListQuerySchema>;
export type ProductList = z.infer<typeof productListSchema>;
export type ProductOverview = z.infer<typeof productOverviewSchema>;
export type ProductRecord = z.infer<typeof productRecordSchema>;
export type ProductFields = z.infer<typeof productFieldsSchema>;
export type ProductMutation = z.infer<typeof productMutationSchema>;
export type ProductState = z.infer<typeof productStateSchema>;
export type ProductContract = z.infer<typeof productContractSchema>;
export type ProductReference = z.infer<typeof productReferenceSchema>;
export type ProductStatus = z.infer<typeof productStatusSchema>;
export type ProductSaved = z.infer<typeof productSavedSchema>;
export type ProductContextQuery = z.infer<typeof productContextQuerySchema>;
export type ProductContext = z.infer<typeof productContextSchema>;
