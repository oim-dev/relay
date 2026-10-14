import { z } from "zod";
import { actorSchema, requestIdSchema } from "./primitives.js";
import {
  productContractInputSchema,
  productRefSchema,
  productSavedSchema,
  productStatusSchema,
} from "./entities/product.js";
import { productImplementationSchema } from "./entities/product-implementation.js";
import {
  productPageQueryShape,
  productPageShape,
  productPublicCardSchema,
} from "./product-query.js";

export const productParticipationQuerySchema = z
  .strictObject({
    application: productRefSchema.describe("ID, ключ, алиас или типизированный адрес приложения"),
    ...productPageQueryShape,
  })
  .describe("Страница всего состава, включая снятые FI/SI; version — snapshotVersion страницы");
export const productParticipationItemSchema = z
  .strictObject({
    ...productPublicCardSchema.shape,
    revision: z
      .number()
      .int()
      .positive()
      .describe("Собственная ревизия реализации, не ревизия состава"),
    implementationTarget: z.enum(["feature", "scenario"]).describe("FI — feature, SI — scenario"),
    target: productPublicCardSchema.describe("Общее требование реализации"),
    feature: productPublicCardSchema.describe("Родительская фича требования"),
    active: z.boolean().describe("Участие в активном составе; false не означает удаление"),
    status: productStatusSchema.describe("Вычисленная готовность; у снятой реализации none"),
    savedStatus: productStatusSchema.describe(
      "Сохранённая совместимая ручная отметка; не управляет готовностью",
    ),
  })
  .describe("Компактная реализация без description и basis; полное содержание читается адресно");
export const productParticipationPageSchema = z
  .strictObject({
    application: productPublicCardSchema.describe("Приложение выбранного состава"),
    scopeId: z
      .string()
      .nullable()
      .describe("Технический ID состава; null, если состав ещё не создавался"),
    revision: z
      .number()
      .int()
      .nonnegative()
      .describe("Ревизия состава для ifRevision; 0 до первого сохранения"),
    version: z
      .string()
      .describe("Версия продуктового состава для ifVersion; не меняется только от задач"),
    snapshotVersion: z
      .string()
      .describe("Guard страницы, учитывающий продукт и задачи; передаётся в query.version"),
    items: z
      .array(productParticipationItemSchema)
      .describe("Выбранная страница FI/SI, включая снятые"),
    ...productPageShape,
  })
  .describe("Состав приложения: компактная страница и исходные guards для одной замены");

export const productParticipationSelectionSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("existing").describe("Выбрать существующую реализацию, в том числе снятую"),
      ref: productRefSchema.describe(
        "Адрес реализации этого приложения; тексты, ID, ключ и savedStatus сохраняются",
      ),
    })
    .describe("Существующий вклад без перезаписи содержания"),
  z
    .strictObject({
      kind: z.literal("target").describe("Создать ещё не существующую пару приложение/требование"),
      target: productRefSchema.describe(
        "Адрес фичи для FI либо сценария для SI; родительская фича SI определяется Core",
      ),
      title: productContractInputSchema.shape.title,
      description: productContractInputSchema.shape.description,
      status: productStatusSchema
        .optional()
        .describe("Совместимая ручная отметка нового вклада; по умолчанию none, не готовность"),
    })
    .describe("Новый вклад с собственным текстом; существующую пару выбирают через existing"),
]);
export const productParticipationReplaceSchema = z
  .strictObject({
    application: productRefSchema.describe("Адрес приложения"),
    selections: z
      .array(productParticipationSelectionSchema)
      .max(10000)
      .describe(
        "Полный новый активный состав; пустой массив снимает все участия; SI требует выбранный FI",
      ),
    ifRevision: z
      .number()
      .int()
      .nonnegative()
      .describe("Прочитанная ревизия состава, 0 до создания"),
    ifVersion: z.string().min(1).describe("Прочитанная product version страницы состава"),
    requestId: requestIdSchema,
    actor: actorSchema.optional().describe("Автор; при отсутствии используется автор вызова"),
  })
  .describe(
    "Атомарная замена состава: разрешение refs, CAS, создание FI/SI и отношения в одной записи",
  );
export const productParticipationSavedSchema = z
  .strictObject({
    application: productPublicCardSchema,
    scopeId: z.string().describe("Технический ID сохранённого состава"),
    key: productSavedSchema.shape.key.describe(
      "Совместимое поле исходной квитанции состава, только если возвращено предметной mutation; не ключ приложения и не публичный адрес scope",
    ),
    revision: z.number().int().positive().describe("Новая ревизия состава"),
    version: z.string().describe("Новая версия продуктового состава"),
    selected: z
      .number()
      .int()
      .nonnegative()
      .describe("Полное число активных реализаций после замены"),
  })
  .describe("Результат единственной замены, без полных текстов; не сохранённая квитанция");
export const productImplementationDetailSchema = productImplementationSchema
  .extend({
    fields: productImplementationSchema.shape.fields.extend({
      status: productStatusSchema.describe(
        "Вычисленная готовность реализации; снятая реализация имеет none",
      ),
    }),
    canonicalRef: productRefSchema.describe("Канонический адрес выбранной реализации"),
    savedStatus: productStatusSchema.describe(
      "Сохранённый status, отдельно от вычисленного fields.status",
    ),
    implementationTarget: z
      .enum(["feature", "scenario"])
      .describe("Разновидность реализации FI/SI"),
  })
  .describe(
    "Полный вклад: точный Markdown, собственные метаданные/ревизия, вычисленный и сохранённый статусы раздельно",
  );

export type ProductParticipationQuery = z.input<typeof productParticipationQuerySchema>;
export type ProductParticipationPage = z.output<typeof productParticipationPageSchema>;
export type ProductParticipationReplace = z.input<typeof productParticipationReplaceSchema>;
export type ProductParticipationSaved = z.output<typeof productParticipationSavedSchema>;
export type ProductImplementationDetail = z.output<typeof productImplementationDetailSchema>;
