import { z } from "zod";

/** Серверные страницы с guard и адресные квитанции регистрации без полного каталога. */
export const PROJECT_CATALOG_CAPABILITY = "relay-project-catalog-v1";

/** Общая форма каталога Server: без coercion, defaults и выдуманных пустых проектов. */
export const relayProjectSchema = z.strictObject({
  key: z.string().describe("Ключ регистрации; в local — local"),
  id: z.string().describe("ID проекта; у недоступной базы идентичность не подтверждена"),
  name: z.string().describe("Отображаемое имя проекта или ключ недоступной регистрации"),
  slug: z.string().optional().describe("Человекочитаемый адрес проекта; постоянный id не меняется"),
  configPath: z.string().describe("Путь конфигурации проекта на стороне Server"),
  available: z.boolean().describe("Доступна ли зарегистрированная база"),
  error: z.string().optional().describe("Причина недоступности базы"),
});

export const serverContextSchema = z.strictObject({
  mode: z.enum(["local", "workspace"]).describe("Фактический режим Server"),
  configPath: z.string().describe("Конфигурация Server, не клиентский файл"),
  defaultProject: z.string().nullable().describe("ID local-проекта; в workspace — null"),
  projects: z.array(relayProjectSchema).describe("Регистрации в порядке серверного каталога"),
});

export const serverContextResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: serverContextSchema,
  meta: z
    .strictObject({
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      truncated: z.boolean().optional(),
    })
    .optional(),
});

export const serverCapabilitiesSchema = z.strictObject({
  capabilities: z
    .array(z.string())
    .describe("Поддержанные серверные операции; чтение не открывает каталоги проектов"),
});

export const projectCatalogPageQuerySchema = z.strictObject({
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Смещение страницы; при продолжении передайте исходную version"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Максимальное число регистраций в ответе, от 1 до 100"),
  version: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Отпечаток полного каталога первой страницы; изменение возвращает VERSION_CONFLICT, исторического снимка нет",
    ),
});

export const projectCatalogPageSchema = z.strictObject({
  catalog: serverContextSchema.describe(
    "Фактический режим и конфигурация Server; projects содержит только выбранную страницу",
  ),
  total: z
    .number()
    .int()
    .nonnegative()
    .describe("Число регистраций полного каталога, включая недоступные базы"),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Смещение следующей страницы; null означает конец"),
  version: z
    .string()
    .min(1)
    .describe(
      "Guard полного каталога: регистрации, доступность, идентичность и отображаемые сведения",
    ),
});

export const projectRegistrationReceiptSchema = z.strictObject({
  action: z.literal("register").describe("Регистрация сохранена; это не создание проектной базы"),
  key: z.string().describe("Сохранённый ключ регистрации"),
  configPath: z.string().describe("Конфигурация реестра на стороне Server"),
  entry: z
    .strictObject({
      path: z
        .string()
        .optional()
        .describe("Сохранённый путь проекта относительно серверного реестра, если задан"),
      config: z
        .string()
        .optional()
        .describe("Сохранённый конфиг относительно path, иначе реестра, если задан"),
    })
    .refine(
      (entry) => entry.path !== undefined || entry.config !== undefined,
      "Регистрация должна содержать path или config",
    )
    .describe(
      "Сохранённое подключение одной базы; не полный каталог и не проверка её текущей доступности",
    ),
});

export const projectUnregistrationReceiptSchema = z.strictObject({
  action: z.literal("unregister").describe("Удаление регистрации; файлы базы сохранены"),
  key: z.string().describe("Ключ удаляемой регистрации"),
  configPath: z.string().describe("Конфигурация реестра на стороне Server"),
  removed: z
    .boolean()
    .describe("true — регистрация удалена этой операцией; false — уже отсутствовала"),
});

export type ProjectCatalogPageQuery = z.input<typeof projectCatalogPageQuerySchema>;
export type ProjectCatalogPage = z.output<typeof projectCatalogPageSchema>;
export type ProjectRegistrationReceipt = z.output<typeof projectRegistrationReceiptSchema>;
export type ProjectUnregistrationReceipt = z.output<typeof projectUnregistrationReceiptSchema>;
