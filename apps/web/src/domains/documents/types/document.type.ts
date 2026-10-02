import { z } from "zod";
import {
  documentFormatSchema,
  documentKindSchema,
  documentStatusSchema,
  documentRelationsSchema,
  entitySummarySchema,
} from "@relay/contracts/entities";
import type {
  DocumentBulk,
  DocumentBulkResult,
  DocumentFacets,
  DocumentRelationChange,
  EntityDocumentsPage,
} from "@relay/contracts/entities/document-catalog";

/** Поля пользовательского редактора документа. */
export const DOCUMENT_INPUT_SCHEMA = z.object({
  name: z.string(),
  summary: z.string(),
  body: z.string(),
  documentKind: documentKindSchema,
  documentStatus: documentStatusSchema,
  sectionId: z.string().nullable(),
  pinned: z.boolean(),
  relations: documentRelationsSchema,
  /** Формат; отсутствие при записи сохраняет текущий, при создании означает markdown. */
  documentFormat: documentFormatSchema.optional(),
  /** Внешний адрес формата link; для markdown не передаётся. */
  url: z.string().optional(),
  /** Теги; отсутствие при записи сохраняет текущие. Нормализацию выполняет Core. */
  tags: z.array(z.string()).optional(),
});
/** Ввод самостоятельного материала библиотеки. */
export type DocumentInput = z.infer<typeof DOCUMENT_INPUT_SCHEMA>;
/** Одна явная адресная связь. */
export type DocumentRelation = DocumentInput["relations"][number];
/** Краткая карточка существующей сущности. */
export type DocumentEntity = z.infer<typeof entitySummarySchema>;
/** Подтверждённое содержание с ревизией и именами связей. */
export type KnowledgeDocument = DocumentInput & {
  /** Постоянный ID. */
  id: string;
  /** Публичный ключ. */
  key: string;
  /** Ревизия записи. */
  revision: number;
  /** Последнее подтверждённое обновление. */
  updatedAt: string;
  /** Краткие карточки прямых целей. */
  references: DocumentEntity[];
  /**
   * Совместимые продуктовые области (links) только для чтения: не входят в relations
   * и сохраняются при любой записи; product отображается адресом passport.
   */
  legacyLinks: DocumentRelation[];
  /** Эффективный формат: прежние записи без поля читаются как markdown. */
  documentFormat: MaterialFormat;
  /** Нормализованные Core теги. */
  tags: string[];
};
/** Формат материала библиотеки. */
export type MaterialFormat = NonNullable<DocumentEntity["document"]>["format"];
/** Раздел библиотеки с постоянным ID. */
export type DocumentSection = {
  /** Идентификатор раздела. */
  id: string;
  /** Отображаемое название. */
  name: string;
};
/** Настройки общей библиотеки проекта. */
export type LibrarySettings = {
  /** Адрес проекта. */
  ref: string;
  /** Версия для изменения разделов. */
  revision: number;
  /** Упорядоченные разделы. */
  sections: DocumentSection[];
};
/** Системное представление каталога материалов. */
export type MaterialView =
  "all" | "pinned" | "recent" | "draft" | "none" | "unattached" | "archived";
/** Порядок выдачи каталога. */
export type MaterialSort = "updated" | "title";
/** Условия выборки каталога, которые сервер применяет ко всей библиотеке проекта. */
export type MaterialCatalogFilters = {
  /** Строка поиска; пустая строка — без поиска. */
  q: string;
  /** Системное представление; игнорируется при выбранном разделе. */
  view: MaterialView;
  /** ID раздела или null. */
  section: string | null;
  /** Предметный тип или null. */
  kind: DocumentInput["documentKind"] | null;
  /** Адрес сущности, к которой прикреплены материалы, или null. */
  target: string | null;
  /** Порядок выдачи; представление «Недавно обновлённые» всегда сортирует по обновлению. */
  sort: MaterialSort;
  /** Теги: выбираются материалы со всеми тегами без учёта регистра. */
  tags?: string[];
  /** Формат или null — любой. */
  format?: MaterialFormat | null;
  /** Только материалы без прикреплений (вне архива); то же, что представление unattached. */
  unattached?: boolean;
  /** Состояние вне архива или null — любое; представления draft и archived задают его сами. */
  status?: "draft" | "active" | null;
};
/** Одна прочитанная порция каталога. */
export type MaterialCatalogPage = {
  /** Краткие карточки материалов. */
  items: DocumentEntity[];
  /** Полное число материалов выбранной области. */
  total: number;
  /** Смещение продолжения; null в конце. */
  nextOffset: number | null;
  /** Версия согласованного снимка для продолжения. */
  version: string;
  /** Серверные счётчики библиотеки без поисковых фильтров: all, draft, pinned, archived, none, section:ID. */
  counts: Record<string, number>;
};
/** Свойства, которые быстрые действия меняют без открытия редактора. */
export type MaterialPropertyChanges = Partial<
  Pick<DocumentInput, "pinned" | "sectionId" | "documentStatus">
>;
/** Счётчики каталога по полным данным проекта: разделы, теги, форматы, типы, состояния и представления. */
export type MaterialFacets = DocumentFacets;
/** Одно действие массового изменения. */
export type MaterialBulkOperation = DocumentBulk["operation"];
/** Материал, выбранный для массового изменения, с прочитанной ревизией. */
export type MaterialRevision = {
  /** Постоянный ID или ключ. */
  id: string;
  /** Прочитанная ревизия. */
  revision: number;
};
/** Поэлементный результат массового изменения; отказ одного не откатывает остальные. */
export type MaterialBulkResult = DocumentBulkResult;
/** Исход одного элемента массового изменения. */
export type MaterialBulkItem = DocumentBulkResult["items"][number];
/** Изменение одной связи материала с сущностью. */
export type MaterialRelationChange = Pick<
  DocumentRelationChange,
  "action" | "type" | "description" | "nextType"
> & {
  /** Сущность связи: kind и постоянный ID. */
  target: DocumentRelation["target"];
};
/** Вид сущности, к которой прикрепляется материал (11 видов). */
export type MaterialTargetKind = DocumentRelation["target"]["kind"];
/** Страница материалов, прикреплённых к одной сущности. */
export type EntityMaterialsPage = EntityDocumentsPage;
/** Материал сущности со связями к ней и признаком архива. */
export type EntityMaterial = EntityDocumentsPage["items"][number];
