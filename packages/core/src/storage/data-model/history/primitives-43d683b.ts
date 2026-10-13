/**
 * Замороженные примитивы проверки дисковых данных на коммите 43d683b (`1afe138^`).
 *
 * Происхождение: 43d683be11cda57f8861468c20ae14b18cc9e419 («планы и релизы (часть 1)»),
 * `git show 43d683b:packages/contracts/src/primitives.ts` (`text`, `singleLine`, `actorSchema`,
 * `timestampSchema`), `git show 43d683b:packages/contracts/src/planning.ts` (`planningIdSchema`),
 * `git show 43d683b:packages/core/src/storage/entity-store/codecs.ts` (Markdown на диске —
 * массив строк без `\n`, `decode` склеивает их через `\n`).
 * Фикстура: `packages/core/test/fixtures/data-migrations/` (база до 1afe138).
 *
 * Схемы копируются, а не импортируются: текущие примитивы Contracts могут меняться.
 * Исторический reader выполнял `trim()` внутри `singleLine`; здесь это проверка без
 * преобразования, чтобы схема принимала то же, что прежний reader, и не меняла значение.
 * Нет `.default()`, `.transform()`, `.catch()` и удаления неизвестных ключей.
 */
import { z } from "zod";

const surrogate = /[\uD800-\uDFFF]/u;
const control = /[\p{Cc}\u2028\u2029]/u;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** `text(maxBytes)`: без непарных суррогатов и не длиннее maxBytes байт UTF-8. */
export function text(maxBytes: number) {
  return z
    .string()
    .refine((value) => !surrogate.test(value), "Текст содержит непарный суррогат Unicode")
    .refine((value) => bytes(value) <= maxBytes, `Не более ${maxBytes} байт UTF-8`);
}

/** `singleLine`: однострочный текст, непустой после trim; значение не изменяется. */
export function singleLine(maxBytes: number, allowEmpty = false) {
  return text(maxBytes)
    .refine((value) => !control.test(value), "Поле должно быть однострочным")
    .refine(
      (value) => allowEmpty || value.trim().length > 0,
      "Поле не может быть пустым после удаления пробелов",
    );
}

/** `actorSchema = singleLine(512).pipe(z.string().max(128))`; max применялся после trim. */
export const actor = singleLine(512).refine(
  (value) => value.trim().length <= 128,
  "Автор длиннее 128 символов",
);
export const timestamp = z.iso.datetime();
export const planningId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/**
 * Дисковая форма Markdown-поля `text(maxBytes)` кодека 43d683b: массив строк без `\n`,
 * склейка которого через `\n` удовлетворяет `text(maxBytes)`.
 */
export function markdownLines(maxBytes: number) {
  return z
    .array(z.string().refine((line) => !line.includes("\n"), "Строка Markdown содержит \\n"))
    .refine((lines) => !surrogate.test(lines.join("\n")), "Текст содержит непарный суррогат")
    .refine((lines) => bytes(lines.join("\n")) <= maxBytes, `Не более ${maxBytes} байт UTF-8`);
}

/** Ссылка на сущность графа (`entityRefSchema` graph.ts на 43d683b). */
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const entityRef = z.strictObject({ kind: token, id: token });

/**
 * Запись набора отношений, `storedEdgeSchema` + `entrySchema` из
 * `git show 43d683b:packages/core/src/storage/entity-store/relations.ts`
 * (формат набора отношений v1 не менялся до HEAD 4321233).
 */
export const relationEntryV1 = z.strictObject({
  slot: z.string().min(1).max(128),
  edge: z.strictObject({
    id: token,
    type: token,
    from: entityRef,
    to: entityRef,
    description: z.array(z.string().refine((line) => !line.includes("\n"))),
    revision: z.number().int().positive(),
    source: z.literal("graph"),
    createdBy: actor,
    createdAt: timestamp,
    historyCount: z.number().int().nonnegative().optional(),
    active: z.boolean(),
    updatedAt: z.iso.datetime(),
    updatedBy: actor,
  }),
});
/** Встроенная форма набора отношений владельца (`inlineSchema` relations.ts). */
export const relationSetInlineV1 = z.strictObject({
  schemaVersion: z.literal(1),
  owner: entityRef,
  storage: z.literal("inline"),
  entries: z.array(relationEntryV1),
});
export type RelationEntryV1 = z.output<typeof relationEntryV1>;
export type RelationSetInlineV1 = z.output<typeof relationSetInlineV1>;
