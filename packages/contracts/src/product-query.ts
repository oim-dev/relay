import { z } from "zod";
import { productRefSchema, productStatusSchema } from "./entities/product.js";

export const productPageQueryShape = {
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение страницы"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe("Размер страницы, от 1 до 100"),
  version: z
    .string()
    .min(1)
    .optional()
    .describe("Прочитанная версия страницы; конфликт требует начать чтение заново"),
};
export const productPageShape = {
  total: z.number().int().nonnegative().describe("Полное число элементов до пагинации"),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Следующее смещение; null — конец списка"),
};
export const productPublicReferenceSchema = z
  .strictObject({
    kind: z
      .enum(["product", "feature", "scenario", "application", "implementation", "document"])
      .describe("Публичный вид сущности"),
    id: z.string().min(1).describe("Постоянный ID сущности"),
  })
  .describe("Постоянный публичный адрес; технический scope сюда не входит");
export const productPublicCardSchema = z
  .strictObject({
    ref: productPublicReferenceSchema,
    key: z.string().min(1).describe("Текущий читаемый ключ"),
    title: z.string().describe("Название сущности"),
  })
  .describe("Компактная ссылка без полного содержания");

export const productValidationSchema = z
  .strictObject({
    valid: z
      .literal(true)
      .describe(
        "Структурные инварианты и ссылки продукта проверены; при нарушении операция возвращает ошибку",
      ),
    records: z
      .number()
      .int()
      .nonnegative()
      .describe("Число проверенных продуктовых агрегатов, включая составы приложений"),
    version: z.string().describe("Версия проверенного продуктового состава"),
  })
  .describe("Проверка продукта без передачи полных текстов");

export const productLintQuerySchema = z
  .strictObject({
    ref: productRefSchema
      .optional()
      .describe(
        "ID, ключ, алиас или типизированный адрес одной записи, включая FI/SI; отсутствие — весь продукт",
      ),
    ...productPageQueryShape,
  })
  .describe("Серверная проверка содержания, не проверка выполнения требований");
export const productLintWarningSchema = z
  .strictObject({
    ...productPublicCardSchema.shape,
    canonicalRef: productRefSchema.describe("Адрес для следующего чтения, обычно текущий ключ"),
    implementationTarget: z
      .enum(["feature", "scenario"])
      .nullable()
      .describe("Разновидность FI/SI; null у остальных сущностей"),
    recordId: z
      .string()
      .describe("ID исходного продуктового агрегата; у реализации — технический scope"),
    field: z.string().describe("Путь поля исходного агрегата, включая contracts.ID.description"),
    code: z
      .enum(["UNSTRUCTURED_MARKDOWN", "MISSING_ACCEPTANCE"])
      .describe("Код рекомендации по содержанию"),
    message: z.string().describe("Объяснение рекомендации"),
  })
  .describe("Адресуемое замечание: публичная сущность отдельно от технического пути поля");
export const productLintPageSchema = z
  .strictObject({
    warnings: z.array(productLintWarningSchema).describe("Замечания выбранной страницы"),
    records: z
      .number()
      .int()
      .nonnegative()
      .describe("Число проверенных агрегатов; адресный FI/SI считается одной проверенной записью"),
    version: z.string().describe("Версия продуктовых источников lint, без задач"),
    ...productPageShape,
  })
  .describe("Полные счётчики и страница рекомендаций без текстов продукта");

export const productOverviewMapQuerySchema = z
  .strictObject(productPageQueryShape)
  .describe("Страница карты; version — исходный snapshotVersion общего обзора");
export const productOverviewMapItemSchema = z
  .strictObject({
    id: z.string().describe("ID продуктового агрегата, включая технический scope"),
    kind: z
      .enum(["passport", "feature", "scenario", "application", "scope", "document"])
      .describe("Вид агрегата прежней карты"),
    revision: z.number().int().positive().describe("Ревизия агрегата"),
    name: z.string().describe("Название; у scope — состав конкретного приложения"),
    subject: productPublicCardSchema.describe(
      "Публичная цель чтения; у scope — приложение и его состав",
    ),
    status: productStatusSchema
      .nullable()
      .describe("Вычисленная готовность фичи или сценария; null у остальных"),
  })
  .describe("Компактная запись карты без полного описания");
export const productOverviewMapPageSchema = z
  .strictObject({
    productId: z.string().describe("ID продукта"),
    version: z.string().describe("Версия продуктового состава для совместимых операций записи"),
    snapshotVersion: z
      .string()
      .describe(
        "Исходный отпечаток всех источников обзора, включая задачи, планы и релизы; guard продолжения",
      ),
    items: z
      .array(productOverviewMapItemSchema)
      .describe("Только записи выбранной страницы карты, без повторения общего обзора"),
    ...productPageShape,
  })
  .describe("Самостоятельная страница карты на срезе обзора; не исторический снимок");

export type ProductValidation = z.output<typeof productValidationSchema>;
export type ProductLintQuery = z.input<typeof productLintQuerySchema>;
export type ProductLintPage = z.output<typeof productLintPageSchema>;
export type ProductLintWarning = z.output<typeof productLintWarningSchema>;
export type ProductOverviewMapQuery = z.input<typeof productOverviewMapQuerySchema>;
export type ProductOverviewMapPage = z.output<typeof productOverviewMapPageSchema>;
