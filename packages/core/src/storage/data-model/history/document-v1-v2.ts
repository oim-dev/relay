/**
 * Замороженные дисковые схемы документа библиотеки: dataVersion 1 (вход перехода
 * `document-v1-to-v2`) и dataVersion 2 (его выход и текущая форма кодека `document`).
 *
 * Происхождение v1: origin/dev 4a96ff1 (PR #16, профиль модели данных 2),
 * `git show 4a96ff1:packages/contracts/src/entities/product.ts` (вариант `document`
 * `productFieldsSchema`, `productReferenceSchema`, `productIdSchema`),
 * `git show 4a96ff1:packages/contracts/src/entities/document-library.ts`
 * (`documentMetadataShape`, `documentRelationsSchema`), `git show 4a96ff1:packages/core/src/
 * storage/entity-store/codecs.ts` (строгий объект без `kind`, Markdown-пути `body` и
 * `relations.*.description`). v1 на 4a96ff1 — надмножество v1 релиза 0.9.2 (4321233):
 * отличается только значением `plan-stage` в виде цели связи (запись совместимости этапа).
 * Примитивы на 4a96ff1 совпадают с 43d683b по проверкам, поэтому используется та же копия.
 * Фикстуры с документами v1: `test/fixtures/data-migrations/legacy-5c7265b`,
 * `physical4-v0.7.0-52c4609` и др. (документ v1 получают все поддерживаемые входы).
 *
 * v2 вводит формат материала (`documentFormat`: markdown | link), внешний адрес `url`
 * и теги `tags`; `body` для ссылки может быть пустым. `documentFormat` и `tags` в v2
 * обязательны: переход явно записывает `markdown` и `[]`, чтение их не подставляет.
 * Сочетание формата, адреса и непустого Markdown проверяет Core, а не дисковая схема.
 *
 * Нет `.default()`, `.transform()`, `.catch()`, trim-pipe и удаления неизвестных ключей.
 */
import { z } from "zod";
import { markdownLines, planningId, singleLine, text } from "./primitives-43d683b.js";

const KIB = 1024;
const productId = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9]{8}|passport|(?:feature|scenario|application|scope|document|contract)_[a-f0-9]{32})$/,
  );
const productReference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product") }),
  z.strictObject({ kind: z.literal("feature"), id: productId }),
  z.strictObject({ kind: z.literal("scenario"), id: productId }),
  z.strictObject({ kind: z.literal("application"), id: productId }),
  z.strictObject({
    kind: z.literal("implementation"),
    applicationId: productId,
    id: productId,
  }),
]);
const documentRelation = z.strictObject({
  target: z.strictObject({
    kind: z.enum([
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
    ]),
    id: planningId,
  }),
  type: z.enum(["references", "documents"]),
  description: markdownLines(16 * KIB),
});
const documentRelations = z
  .array(documentRelation)
  .max(100)
  .refine(
    (links) =>
      new Set(links.map((link) => `${link.target.kind}:${link.target.id}:${link.type}`)).size ===
      links.length,
    "Повтор отношения документа",
  );
const common = {
  name: singleLine(1024),
  summary: text(4 * KIB),
  documentKind: z.enum([
    "specification",
    "description",
    "rules",
    "instruction",
    "proposal",
    "decision",
    "research",
  ]),
  sectionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .nullable()
    .optional(),
  documentStatus: z.enum(["draft", "active", "archived"]).optional(),
  pinned: z.boolean().optional(),
  relations: documentRelations.optional(),
  links: z.array(productReference).max(1000),
};

/** Тег v2 хранится нормализованным: однострочный, без краевых пробелов, до 50 символов. */
const documentTagV2 = singleLine(256)
  .refine((value) => value === value.trim(), "Тег хранится без краевых пробелов")
  .refine((value) => value.length <= 50, "Тег длиннее 50 символов");
const documentUrl = z.url({ protocol: /^https?$/ }).max(2048);

/** Документ dataVersion 1: Markdown `body` непустой после склейки строк и trim. */
export const documentDataV1 = z.strictObject({
  ...common,
  body: markdownLines(256 * KIB).refine(
    (lines) => lines.join("\n").trim().length > 0,
    "Markdown не должен быть пустым",
  ),
});

/**
 * Вариант v1 промежуточной сборки библиотеки знаний (04cff36 и предшественники ветки
 * `feat/web-admin-layout`, не выпускалась): она писала документы с `dataVersion` 1 в базы
 * формата 4 профиля 1 и при каждом сохранении документа записывала `documentFormat` и
 * нормализованные `tags`, `url` — только у ссылки
 * (`git show 04cff36:packages/core/src/application/product/service.ts`, `ProductService`
 * сохранение документа; `git show 04cff36:packages/contracts/src/entities/document-library.ts`).
 * Документы, которые сборка не сохраняла, остались в выпущенной форме `documentDataV1`.
 *
 * Строгий объект: только поля выпущенной v1 плюс точно эти три поля. Обязательность
 * формата и тегов и сочетание формата, адреса и непустого Markdown повторяют инвариант
 * той сборки, поэтому вариант не ослабляет проверку выпущенной v1: документ без формата
 * обязан пройти `documentDataV1` (непустой Markdown, без адреса и тегов).
 * Legacy-раскладку сборка не писала (запись в неё запрещена до `storage migrate`), поэтому
 * замороженный legacy-reader не расширяется.
 */
export const documentDataV1Library = z
  .strictObject({
    ...common,
    body: markdownLines(256 * KIB),
    documentFormat: z.enum(["markdown", "link"]),
    url: documentUrl.optional(),
    tags: z.array(documentTagV2).max(20),
  })
  .refine(
    (data) =>
      data.documentFormat === "link"
        ? data.url !== undefined
        : data.url === undefined && data.body.join("\n").trim().length > 0,
    "Формат link требует адрес, markdown — непустой текст без адреса",
  );

/** Вход перехода document-v1-to-v2: выпущенная v1 или вариант промежуточной сборки. */
export const documentDataV1Input = z.union([documentDataV1, documentDataV1Library]);

/** Документ dataVersion 2: формат и теги обязательны, адрес — только у ссылки (проверяет Core). */
export const documentDataV2 = z.strictObject({
  ...common,
  body: markdownLines(256 * KIB),
  documentFormat: z.enum(["markdown", "link"]),
  url: documentUrl.optional(),
  tags: z.array(documentTagV2).max(20),
});

export type DocumentDataV1 = z.output<typeof documentDataV1>;
export type DocumentDataV2 = z.output<typeof documentDataV2>;
