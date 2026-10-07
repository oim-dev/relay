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
          "plan-stage",
          "release",
        ])
        .describe(
          "Вид связанной сущности проекта; plan-stage — только чтение сохранённой связи с прежним адресом этапа, новые прикрепления к этапу запрещены",
        ),
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
  relations: documentRelationsSchema.optional(),
};
