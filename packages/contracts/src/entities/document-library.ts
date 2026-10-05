import { z } from "zod";
import { singleLine, text } from "../primitives.js";

/** Смысл документа независим от раздела и состояния публикации. */
export const documentKindSchema = z
  .enum([
    "specification",
    "description",
    "rules",
    "instruction",
    "proposal",
    "decision",
    "research",
  ])
  .describe("Тип: ТЗ, описание, правила, инструкция, проект решения, решение или исследование");
export const documentStatusSchema = z
  .enum(["draft", "active", "archived"])
  .describe(
    "Состояние публикации: черновик, действующий или архив; не подтверждает истинность текста",
  );
/** Формат материала независим от предметного типа; отсутствие поля означает markdown. */
export const documentFormatSchema = z
  .enum(["markdown", "link"])
  .describe(
    "Формат материала: markdown — содержание в непустом Markdown; link — внешняя ссылка url с необязательным Markdown-пояснением. Отсутствие поля в прежних записях означает markdown",
  );
export const documentUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .describe(
    "Абсолютный адрес http или https внешнего материала; обязателен для формата link и запрещён для markdown",
  );
export const documentTagSchema = singleLine(256, true)
  .pipe(z.string().max(50))
  .describe(
    "Тег материала: одна строка до 50 символов; Core обрезает края, отбрасывает пустые и повторы без учёта регистра",
  );
export const documentTagsSchema = z
  .array(documentTagSchema)
  .max(20)
  .describe(
    "Теги материала, до 20; сохраняется первое написание повторяющегося без учёта регистра тега, реестра тегов нет",
  );
export const documentSectionSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .describe("Постоянный ID раздела библиотеки"),
  name: singleLine(80).describe("Название раздела библиотеки"),
});
export const documentSectionsSchema = z
  .array(documentSectionSchema)
  .max(100)
  .refine(
    (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
    "ID разделов не должны повторяться",
  )
  .describe("Разделы библиотеки в порядке отображения; пустой список допустим");
export const defaultDocumentSections = [
  { id: "product", name: "Продукт" },
  { id: "architecture", name: "Архитектура" },
  { id: "development", name: "Разработка" },
  { id: "infrastructure", name: "Инфраструктура" },
  { id: "processes", name: "Процессы" },
];
export const documentRelationSchema = z.strictObject({
  target: z
    .strictObject({
      kind: z
        .enum([
          "project",
          "product",
          "feature",
          "scenario",
          "application",
          "implementation",
          "board",
          "task",
          "document",
          "work-plan",
          "release",
        ])
        .describe("Вид связанной сущности проекта"),
      id: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
        .describe("Постоянный ID связанной сущности"),
    })
    .describe("Связанная сущность проекта: вид и постоянный ID"),
  type: z
    .enum(["references", "documents"])
    .describe("references — контекст для сущности; documents — документ описывает сущность"),
  description: text(16 * 1024).describe(
    "Когда и зачем читать документ: необязательное пояснение Markdown",
  ),
});
export const documentRelationsSchema = z
  .array(documentRelationSchema)
  .max(100)
  .refine(
    (links) =>
      new Set(links.map((link) => `${link.target.kind}:${link.target.id}:${link.type}`)).size ===
      links.length,
    "Повтор отношения документа",
  )
  .describe("Адресные связи документа; текст и связи сохраняются атомарно");
export const documentMetadataShape = {
  sectionId: documentSectionSchema.shape.id
    .nullable()
    .optional()
    .describe("Раздел; null — без раздела"),
  documentStatus: documentStatusSchema.optional(),
  pinned: z.boolean().optional().describe("Закреплён для всех участников проекта"),
  documentFormat: documentFormatSchema.optional(),
  url: documentUrlSchema.optional(),
  tags: documentTagsSchema.optional(),
  relations: documentRelationsSchema.optional(),
};
