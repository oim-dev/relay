import { z } from "zod";
import { entityKeySchema } from "../primitives.js";
import { documentSectionsSchema } from "./document-library.js";

/** Имя проекта — однострочный текст, независимый от паспорта продукта. */
export const projectDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u, "Имя должно быть однострочным текстом")
  .describe("Отображаемое имя проекта, от 1 до 120 символов без переносов строк");

/** Человекочитаемый сегмент адреса проекта. */
export const projectSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Используйте строчные латинские буквы, цифры и одиночные дефисы",
  )
  .describe("Slug адреса: 2–64 строчные латинские буквы/цифры с одиночными дефисами между частями");

/** Публичные настройки проекта; ревизия 0 обозначает прежнюю конфигурацию без настроек. */
export const projectSettingsSchema = z.strictObject({
  name: projectDisplayNameSchema,
  slug: projectSlugSchema,
  documentSections: documentSectionsSchema.optional(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Ревизия настроек проекта для защиты от одновременного редактирования"),
});

/** Версия нового вложенного документа; внешний формат конфигурации совместим с версией 1. */
export const storedProjectSettingsSchema = projectSettingsSchema.extend({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  entityKey: entityKeySchema.optional(),
  aliases: z.array(entityKeySchema).optional(),
});

/** Полная замена редактируемых настроек с проверкой ревизии. */
export const saveProjectSettingsSchema = projectSettingsSchema
  .omit({ revision: true, documentSections: true })
  .extend({
    ifRevision: projectSettingsSchema.shape.revision.describe(
      "Исходная ревизия; конфликт возвращает REVISION_CONFLICT",
    ),
  });

/** Настройки, видимые пользователю. */
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
/** Полная новая пара имени/slug и исходная ревизия. */
export type SaveProjectSettings = z.infer<typeof saveProjectSettingsSchema>;
/** Дисковые метаданные совместимого документа настроек. */
export type StoredProjectSettings = z.infer<typeof storedProjectSettingsSchema>;
