import { z } from "zod";
import { actorSchema, entityReferenceSchema, requestIdSchema, text } from "../primitives.js";
import {
  entitiesQuerySchema,
  entityPageQuerySchema,
  entityRefSchema,
  entitySummarySchema,
} from "../entities.js";
import {
  documentFormatSchema,
  documentKindSchema,
  documentRelationSchema,
  documentStatusSchema,
  documentTagsSchema,
} from "./document-library.js";

/**
 * Операции каталога библиотеки знаний поверх общего реестра сущностей:
 * счётчики по полным данным, массовые изменения, одна связь и обратное чтение.
 */

const revision = z.number().int().nonnegative();
const writeMetadata = {
  requestId: requestIdSchema,
  actor: actorSchema.optional().describe("Автор; по умолчанию автор текущего интерфейса"),
};

export const documentFacetsQuerySchema = entitiesQuerySchema
  .pick({
    q: true,
    target: true,
    section: true,
    tags: true,
    documentFormat: true,
    documentKind: true,
    status: true,
    pinned: true,
    archived: true,
    unattached: true,
  })
  .describe(
    "Фильтры каталога документов, как у списка; каждая ось считается без собственного фильтра",
  );
export type DocumentFacetsQuery = z.input<typeof documentFacetsQuerySchema>;

const count = z.number().int().nonnegative();
export const documentFacetsSchema = z
  .strictObject({
    total: count.describe("Число документов, проходящих все переданные фильтры"),
    version: z.string().describe("Версия снимка каталога; совпадает с version списка"),
    sections: z
      .array(
        z.strictObject({
          sectionId: z
            .string()
            .nullable()
            .describe("ID раздела проекта; null — без раздела, включая удалённые разделы"),
          count,
        }),
      )
      .describe(
        "Все разделы проекта в порядке отображения и затем null; область — все фильтры, кроме section",
      ),
    tags: z
      .array(
        z.strictObject({
          tag: z.string().describe("Самое частое написание; при равенстве — первое по алфавиту"),
          count,
        }),
      )
      .describe(
        "Теги без учёта регистра по убыванию числа; область — все фильтры, включая выбранные теги: значение равно размеру выборки после добавления тега",
      ),
    formats: z
      .array(z.strictObject({ format: documentFormatSchema, count }))
      .describe("Оба формата; область — все фильтры, кроме documentFormat"),
    kinds: z
      .array(z.strictObject({ kind: documentKindSchema, count }))
      .describe("Все типы документов; область — все фильтры, кроме documentKind"),
    statuses: z
      .array(z.strictObject({ status: documentStatusSchema, count }))
      .describe("Все состояния, включая архив; область — все фильтры, кроме status и archived"),
    views: z
      .strictObject({
        all: count.describe("Неархивные документы"),
        pinned: count.describe("Неархивные закреплённые"),
        draft: count.describe("Черновики"),
        unsectioned: count.describe("Неархивные без раздела"),
        unattached: count.describe("Неархивные без relations и совместимых links"),
        archived: count.describe("Архивные документы"),
      })
      .describe(
        "Системные представления; область — q, target, tags, documentFormat и documentKind без section, status, archived, pinned и unattached",
      ),
  })
  .describe("Счётчики каталога документов по полным данным выбранного проекта, не по странице");
export type DocumentFacets = z.infer<typeof documentFacetsSchema>;

export const documentBulkOperationSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("move").describe("Переместить в раздел"),
      sectionId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,64}$/)
        .nullable()
        .describe("ID существующего раздела; null — без раздела"),
    }),
    z.strictObject({
      type: z.literal("addTags").describe("Добавить теги к существующим"),
      tags: documentTagsSchema.min(1),
    }),
    z.strictObject({
      type: z.literal("removeTags").describe("Снять теги без учёта регистра"),
      tags: documentTagsSchema.min(1),
    }),
    z.strictObject({
      type: z.literal("setStatus").describe("Изменить состояние, например архивировать"),
      documentStatus: documentStatusSchema,
    }),
    z.strictObject({
      type: z.literal("pin").describe("Закрепить или открепить"),
      pinned: z.boolean().describe("true — закрепить, false — снять закрепление"),
    }),
  ])
  .describe("Одно действие для всех выбранных документов; связи и links не изменяются");
export const documentBulkSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          ref: entityReferenceSchema.describe("Ключ или ID документа"),
          ifRevision: revision.describe("Прочитанная ревизия этого документа"),
        }),
      )
      .min(1)
      .max(100)
      .refine(
        (items) => new Set(items.map((item) => item.ref)).size === items.length,
        "Документ указан повторно",
      )
      .describe("От 1 до 100 документов с ожидаемыми ревизиями"),
    operation: documentBulkOperationSchema,
    ...writeMetadata,
  })
  .describe(
    "Массовое изменение: каждый документ записывается отдельно под своей ревизией; отказ одного не откатывает остальные, повторов нет",
  );
export type DocumentBulk = z.input<typeof documentBulkSchema>;
export const documentBulkItemStatusSchema = z
  .enum(["applied", "unchanged", "conflict", "not_found", "invalid", "error"])
  .describe(
    "applied — сохранено; unchanged — ревизия совпала, изменений нет, запись не создана; conflict — ревизия устарела; not_found — документ не найден; invalid — нарушено правило данных; error — прочий отказ",
  );
export const documentBulkResultSchema = z
  .strictObject({
    requestId: requestIdSchema,
    items: z
      .array(
        z.strictObject({
          ref: z.string().describe("Адрес из запроса"),
          status: documentBulkItemStatusSchema,
          target: entityRefSchema.optional().describe("Постоянный адрес найденного документа"),
          key: z.string().optional().describe("Текущий ключ документа"),
          revision: revision
            .optional()
            .describe("Ревизия после applied/unchanged; при conflict — актуальная ревизия"),
          error: z
            .strictObject({
              code: z.string().describe("Стабильный код ошибки Core"),
              message: z.string().describe("Сообщение для человека"),
            })
            .optional()
            .describe("Причина отказа элемента"),
        }),
      )
      .describe("Результат по каждому элементу в порядке запроса"),
    applied: count.describe("Число сохранённых документов"),
    failed: count.describe("Число элементов с отказом"),
  })
  .describe("Частичный результат массовой операции");
export type DocumentBulkResult = z.infer<typeof documentBulkResultSchema>;

export const documentRelationChangeSchema = z
  .strictObject({
    ref: entityReferenceSchema.describe("Ключ или ID документа — владельца связи"),
    ifRevision: revision.describe("Прочитанная ревизия документа"),
    action: z
      .enum(["attach", "update", "detach"])
      .describe("Прикрепить, изменить тип или пояснение, открепить одну связь"),
    target: entityReferenceSchema.describe(
      "Ключ, ID или kind:ID связанной сущности; родитель не распространяется на детей",
    ),
    type: documentRelationSchema.shape.type.describe(
      "Тип новой связи (attach) или текущей изменяемой связи (update, detach)",
    ),
    description: text(16 * 1024)
      .optional()
      .describe(
        "Пояснение Markdown: для attach по умолчанию пусто; для update отсутствие сохраняет текущее",
      ),
    nextType: documentRelationSchema.shape.type
      .optional()
      .describe("Только update: новый тип связи; отсутствие сохраняет текущий"),
    ...writeMetadata,
  })
  .describe(
    "Изменение одной связи документа; остальные relations и совместимые links сохраняются, рёбра графа пишутся в той же транзакции",
  );
export type DocumentRelationChange = z.input<typeof documentRelationChangeSchema>;

export const entityDocumentsQuerySchema = entityPageQuerySchema
  .extend({
    ref: entityReferenceSchema.describe("Ключ, ID или kind:ID сущности"),
    archived: entitiesQuerySchema.shape.archived,
  })
  .describe("Материалы, прикреплённые непосредственно к сущности; дети не учитываются");
export type EntityDocumentsQuery = z.input<typeof entityDocumentsQuerySchema>;
export const entityDocumentsPageSchema = z.strictObject({
  target: entitySummarySchema.describe("Сущность, для которой читаются материалы"),
  items: z
    .array(
      z.strictObject({
        document: entitySummarySchema.describe("Краткая карточка документа с форматом и тегами"),
        archived: z.boolean().describe("Документ находится в архиве"),
        relations: z
          .array(
            z.strictObject({
              type: documentRelationSchema.shape.type,
              description: z.string().describe("Пояснение Markdown; пусто для links"),
              source: z
                .enum(["relations", "links"])
                .describe("relations — адресная связь; links — совместимая продуктовая область"),
            }),
          )
          .min(1)
          .describe("Связи документа с этой сущностью"),
      }),
    )
    .describe("Страница материалов: сначала закреплённые, затем по названию"),
  total: count.describe("Полное число материалов сущности"),
  nextOffset: count.nullable().describe("Смещение продолжения; null в конце"),
  version: z.string().describe("Версия согласованного снимка"),
});
export type EntityDocumentsPage = z.infer<typeof entityDocumentsPageSchema>;
