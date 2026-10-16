import {
  documentFormatSchema,
  documentTagsSchema,
  entityDataSchemas,
} from "@relay/contracts/entities";
import { acceptanceCriterionSchema } from "@relay/contracts/entities/board-task";
import { z } from "zod";
import type { JsonValue } from "@relay/contracts/storage";
import { invariant } from "../../shared/errors.js";
import { EntityStorageRegistry } from "./registry.js";
import { BUILTIN_REFERENCES } from "./references.js";
import type { EntityCodec } from "./registry.js";

/** Путь '*' проходит элементы массива, не меняя остальные предметные поля. */
function markdown(value: JsonValue, path: readonly string[], encode: boolean): JsonValue {
  if (!path.length) {
    if (encode) {
      invariant(typeof value === "string", "INVALID_DATA", "Markdown должен быть строкой", 5);
      return value.split("\n");
    }
    invariant(
      Array.isArray(value) &&
        value.every((line) => typeof line === "string" && !line.includes("\n")),
      "INVALID_DATA",
      "Markdown на диске должен быть массивом строк",
      5,
    );
    return value.join("\n");
  }
  const [part, ...rest] = path;
  if (part === "*") {
    invariant(Array.isArray(value), "INVALID_DATA", "Ожидается массив предметных записей", 5);
    return value.map((entry) => markdown(entry, rest, encode));
  }
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_DATA",
    "Ожидается объект предметных полей",
    5,
  );
  if (!(part! in value)) return value;
  return { ...value, [part!]: markdown(value[part!]!, rest, encode) };
}

/** Общий кодек текста используется только с явно заданными владельцем Markdown-полями. */
export function markdownCodec(paths: readonly (readonly string[])[]) {
  const convert = (value: unknown, encode: boolean) =>
    paths.reduce((result, path) => markdown(result, path, encode), z.json().parse(value)) as Record<
      string,
      JsonValue
    >;
  return {
    encode: (data: Record<string, unknown>) => convert(data, true),
    decode: (data: Record<string, JsonValue>) => convert(data, false),
  };
}

/**
 * Версии данных встроенных видов. Повышение требует профиля, замороженных схем и перехода
 * (`storage/data-model`); документ v2 — формат материала и теги (`document-v1-to-v2`).
 */
const BUILTIN_DATA_VERSIONS: Readonly<Record<string, number>> = {
  "work-plan": 2,
  release: 2,
  document: 2,
};

/** Версия данных встроенного вида для записей, которые предметные адаптеры собирают сами. */
export const builtinDataVersion = (kind: string) => {
  invariant(kind in entityDataSchemas, "UNKNOWN_ENTITY_KIND", `Вид ${kind} не встроенный`, 4);
  return BUILTIN_DATA_VERSIONS[kind] ?? 1;
};

/** Коллекции и текстовые поля встроенных видов; добавление вида не меняет алгоритмы хранения. */
const definitions: EntityCodec[] = Object.entries(entityDataSchemas).map(([kind, shape]) => {
  const schema = z.strictObject(shape.shape as z.ZodRawShape).omit({ kind: true });
  const paths =
    kind === "work-plan"
      ? [
          ["goal"],
          ["rationale"],
          ["boundaries"],
          ["expectedResult"],
          ["result"],
          ["stages", "*", "outcome"],
          ["stages", "*", "completionConditions"],
        ]
      : kind === "document"
        ? [["body"], ["relations", "*", "description"]]
        : kind === "task"
          ? [["description"], ["acceptanceCriteria", "*", "description"]]
          : ["project", "board"].includes(kind)
            ? []
            : [["description"]];
  return {
    kind,
    collection: kind === "work-plan" ? "work-plans" : `${kind}s`,
    dataVersion: builtinDataVersion(kind),
    schema:
      kind === "task"
        ? schema.extend({ acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100) })
        : kind === "document"
          ? // На диске v2 формат и теги обязательны: отсутствие означает непройденную миграцию.
            schema.extend({ documentFormat: documentFormatSchema, tags: documentTagsSchema })
          : schema,
    ...markdownCodec(paths),
    ...(BUILTIN_REFERENCES[kind] ? { references: BUILTIN_REFERENCES[kind] } : {}),
    card(record) {
      const data = record.data;
      return {
        title:
          typeof data.title === "string"
            ? data.title
            : typeof data.name === "string"
              ? data.name
              : kind === "board"
                ? String(data.slug)
                : (record.key ?? record.id),
        status: String(data.column ?? data.documentStatus ?? data.status ?? ""),
        summary: typeof data.summary === "string" ? data.summary : "",
        active: data.active !== false,
        selectors: typeof data.slug === "string" ? [data.slug] : [],
      };
    },
  };
});

export function createEntityStorageRegistry(extra: readonly EntityCodec[] = []) {
  return new EntityStorageRegistry([...definitions, ...extra]);
}
