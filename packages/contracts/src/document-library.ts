import { z } from "zod";
import {
  entitiesPageSchema,
  entityPageQuerySchema,
  entityRefSchema,
  entitySummarySchema,
} from "./entities.js";
import { actorSchema, entityReferenceSchema, requestIdSchema } from "./primitives.js";
import { documentRelationSchema, documentSectionSchema } from "./entities/document-library.js";

const pageShape = entitiesPageSchema.pick({ total: true, nextOffset: true, version: true }).shape;
const revision = z.number().int().nonnegative().describe("Ревизия записи владельца");
const writeShape = {
  ifRevision: revision.describe("Исходная прочитанная ревизия; при конфликте запись отменяется"),
  requestId: requestIdSchema,
  actor: actorSchema
    .optional()
    .describe("Автор изменения; при отсутствии используется автор вызова"),
};

export const documentLinksQuerySchema = entityPageQuerySchema.extend({
  ref: entityReferenceSchema.describe("Ключ, ID или постоянный адрес документа"),
});
export const documentSectionsQuerySchema = entityPageQuerySchema.describe(
  "Страница разделов выбранного проекта в сохранённом порядке",
);
export const documentLinkItemSchema = z.strictObject({
  source: z
    .enum(["relations", "links"])
    .describe("Поле документа: адресные отношения или прежние области"),
  target: documentRelationSchema.shape.target,
  type: documentRelationSchema.shape.type,
  description: documentRelationSchema.shape.description.describe(
    "Полное Markdown-пояснение отношения страницы; пустая строка у прежней области",
  ),
});
export const documentLinksPageSchema = z.strictObject({
  ref: entityRefSchema.describe("Постоянный адрес выбранного документа"),
  key: z.string().describe("Текущий читаемый ключ документа для заголовка"),
  title: z.string().describe("Название документа для заголовка"),
  revision,
  items: z
    .array(documentLinkItemSchema)
    .describe("Отношения страницы: сначала relations, затем links"),
  references: z
    .array(entitySummarySchema.pick({ ref: true, key: true, title: true }))
    .describe(
      "Уникальные доступные цели только этой страницы; без тел, аннотаций и прежних этапов",
    ),
  ...pageShape,
});
export const documentSectionsPageSchema = z.strictObject({
  project: entityRefSchema.describe("Постоянный адрес выбранного проекта"),
  projectKey: z.string().describe("Текущий ключ проекта для заголовка без дополнительного чтения"),
  revision,
  items: z.array(documentSectionSchema).describe("Разделы страницы в сохранённом порядке"),
  ...pageShape,
});

const relationShape = {
  ...writeShape,
  ref: entityReferenceSchema.describe("Ключ, ID или постоянный адрес изменяемого документа"),
  target: entityReferenceSchema.describe("Ключ, ID или постоянный адрес цели прикрепления"),
};
const modernShape = {
  ...relationShape,
  source: z.literal("relations").describe("Изменить адресное отношение, сохранив прежние области"),
  relation: documentRelationSchema.shape.type.default("documents"),
};
export const documentRelationChangeSchema = z.union([
  z.strictObject({
    ...modernShape,
    action: z.literal("link").describe("Добавить отношение или изменить его пояснение"),
    description: documentRelationSchema.shape.description
      .optional()
      .describe(
        "Отсутствие сохраняет пояснение, для нового отношения означает пустое; пустая строка очищает",
      ),
  }),
  z.strictObject({
    ...modernShape,
    action: z.literal("unlink").describe("Снять существующее адресное отношение выбранного типа"),
  }),
  z.strictObject({
    ...relationShape,
    source: z
      .literal("links")
      .describe("Изменить прежнюю продуктовую область без типа и пояснения"),
    action: z.enum(["link", "unlink"]).describe("Сохранить прежнюю область или снять существующую"),
  }),
]);

const sectionShape = { ...writeShape, id: documentSectionSchema.shape.id };
export const documentSectionChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...sectionShape,
    action: z
      .enum(["create", "update"])
      .describe("Добавить раздел в конец или изменить его название"),
    name: documentSectionSchema.shape.name,
  }),
  z.strictObject({
    ...sectionShape,
    action: z
      .literal("move")
      .describe("Переместить существующий раздел, сохранив его ID и название"),
    before: documentSectionSchema.shape.id
      .nullable()
      .describe("ID следующего раздела; null — конец списка"),
  }),
  z.strictObject({
    ...sectionShape,
    action: z.literal("remove").describe("Удалить раздел, сохранив документы и их ревизии"),
  }),
]);

export type DocumentLinksQuery = z.input<typeof documentLinksQuerySchema>;
export type DocumentSectionsQuery = z.input<typeof documentSectionsQuerySchema>;
export type DocumentLinkItem = z.output<typeof documentLinkItemSchema>;
export type DocumentLinksPage = z.output<typeof documentLinksPageSchema>;
export type DocumentSectionsPage = z.output<typeof documentSectionsPageSchema>;
export type DocumentRelationChange = z.input<typeof documentRelationChangeSchema>;
export type DocumentSectionChange = z.input<typeof documentSectionChangeSchema>;
