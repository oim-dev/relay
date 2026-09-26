import { z } from "zod";

/** Общая семантика текста одинакова в Node.js и браузере. */
export function text(maxBytes: number) {
  return z
    .string()
    .refine((value) => !/[\uD800-\uDFFF]/u.test(value), "Текст содержит непарный суррогат Unicode")
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `Не более ${maxBytes} байт UTF-8`,
    );
}

/** Заголовки и короткие метаданные сохраняют однострочную семантику. */
export function singleLine(maxBytes: number, allowEmpty = false) {
  return text(maxBytes)
    .refine((value) => !/[\p{Cc}\u2028\u2029]/u.test(value), "Поле должно быть однострочным")
    .pipe(
      z
        .string()
        .trim()
        .min(allowEmpty ? 0 : 1),
    );
}

export const actorSchema = singleLine(512).pipe(z.string().max(128)).describe("Автор операции");
export const timestampSchema = z.iso.datetime().describe("Момент времени в UTC");
export const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .describe("Ключ безопасного повтора операции");
export const entityKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/)
  .describe("Читаемый ключ сущности; назначается ядром, может иметь прежние алиасы");
export const entityReferenceSchema = z
  .string()
  .min(1)
  .max(257)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .describe("Ключ или постоянный ID сущности; для уточнения вида допустим kind:ID");
