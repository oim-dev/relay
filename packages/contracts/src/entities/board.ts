import { z } from "zod";
import {
  actorSchema,
  timestampSchema,
  entityKeySchema,
} from "../primitives.js";

export const boardPrefixSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{1,15}$/,
    "Префикс: 2–16 заглавных латинских букв и цифр, начинается с буквы",
  )
  .describe("Неизменяемый уникальный префикс ключей задач, например WEB или PRODUCT");

/** Совместимое предложение префикса для ранее созданной доски. */
export function defaultBoardPrefix(slug: string): string {
  if (slug === "product") return "PRODUCT";
  if (slug === "infrastructure") return "INFRA";
  const value = slug.replaceAll("-", "").toUpperCase();
  return (/^[A-Z]/.test(value) ? value : `APP${value}`).slice(0, 16).padEnd(2, "X");
}

/** Slug одновременно является сегментом URL и именем каталога доски. */
export const boardSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Используйте строчные латинские буквы, цифры и дефисы")
  .describe("Адрес доски: 1–64 символа, строчные латинские буквы, цифры и дефисы");
/** Системные адреса нельзя занимать приложением. */
export const applicationSlugSchema = boardSlugSchema
  .refine(
    (slug) => !["product", "infrastructure", "new"].includes(slug),
    "Этот адрес зарезервирован системой",
  )
  .describe(
    "Неизменяемый уникальный адрес приложения и доски: 1–64 символа, строчные латинские буквы, цифры и дефисы; product, infrastructure и new зарезервированы",
  );
/** Постоянная запись доски; название приложения читается по его ID. */
export const boardSchema = z.strictObject({
  version: z
    .union([z.literal(1), z.literal(2)])
    .describe("Версия дискового формата доски; v2 сохраняет адреса и историю"),
  id: z
    .string()
    .regex(/^(?:[A-Za-z0-9]{8}|board_(?:product|infrastructure|[a-f0-9]{32}))$/)
    .describe("Постоянный ID доски"),
  slug: boardSlugSchema,
  prefix: boardPrefixSchema.optional(),
  key: entityKeySchema.optional(),
  aliases: z.array(entityKeySchema).optional(),
  kind: z
    .enum(["product", "application", "infrastructure"])
    .describe("Область ответственности доски"),
  applicationId: z
    .string()
    .regex(/^(?:[A-Za-z0-9]{8}|application_[a-f0-9]{32})$/)
    .nullable()
    .describe("ID приложения; null у системных досок"),
  revision: z.number().int().positive().describe("Ревизия записи доски"),
  createdAt: timestampSchema.describe("Дата создания доски"),
  createdBy: actorSchema.describe("Автор создания доски"),
});
export const boardViewSchema = boardSchema
  .omit({ aliases: true })
  .extend({
    prefix: boardPrefixSchema,
    name: z.string().describe("Название доски; для приложения — его актуальное название"),
  });
export const boardsQuerySchema = z.strictObject({
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение в каталоге досок"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Размер страницы, не более 100 досок"),
  version: z
    .string()
    .optional()
    .describe("Версия каталога первой страницы; защищает продолжение от изменений"),
});
export const boardsPageSchema = z.strictObject({
  items: z
    .array(boardViewSchema)
    .describe("Доски: продукт, приложения по времени создания, инфраструктура"),
  total: z.number().int().nonnegative().describe("Полное число досок проекта"),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Смещение продолжения; null в конце"),
  version: z.string().describe("Версия согласованного каталога"),
});
export type Board = z.infer<typeof boardSchema>;
export type BoardView = z.infer<typeof boardViewSchema>;
export type BoardsQuery = z.input<typeof boardsQuerySchema>;
