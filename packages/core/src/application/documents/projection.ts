import type { EntityData, EntityMetadata } from "@relay/contracts/entities";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { EntityEntry } from "../entities/catalog.js";

export type DocumentData = Extract<EntityData, { kind: "document" }>;
export type DocumentEntry = EntityEntry & { data: DocumentData };

/** Метаданные чтения не входят в карточки, каталоговый хеш или формат хранения. */
export function documentMetadata(record: EntityMetadata): EntityMetadata {
  const { createdAt, createdBy, updatedAt, updatedBy } = record;
  return { createdAt, createdBy, updatedAt, updatedBy };
}

/** Общая проекция выбранной записи и строки строгого полного каталога. */
export function documentEntityEntry(
  record: {
    id: string;
    key?: string | undefined;
    revision: number;
    reservedKeys?: string[] | undefined;
    updatedAt: string;
    fields: DocumentData;
  },
  sections: readonly { id: string }[] = defaultDocumentSections,
): DocumentEntry {
  // Прежняя запись до перехода document-v1-to-v2 (legacy/dirty-чтение) не содержит формат
  // и теги; публичные данные документа v2 всегда включают оба поля с прежними значениями.
  const fields: DocumentData = {
    ...record.fields,
    documentFormat: record.fields.documentFormat ?? "markdown",
    tags: record.fields.tags ?? [],
  };
  return {
    ref: { kind: "document", id: record.id },
    key: record.key ?? record.id,
    title: fields.name,
    summary: fields.summary,
    revision: record.revision,
    data: fields,
    aliases: record.reservedKeys ?? [],
    selectors: [],
    filters: {
      target: [
        ...fields.links.map((link) => (link.kind === "product" ? "passport" : link.id)),
        ...(fields.relations ?? []).map((link) => link.target.id),
      ],
      // Цель документа может быть любого вида, а ID уникальны только внутри вида.
      targetAddress: [
        ...fields.links.map((link) =>
          link.kind === "product" ? "product:passport" : `${link.kind}:${link.id}`,
        ),
        ...(fields.relations ?? []).map((link) => `${link.target.kind}:${link.target.id}`),
      ],
    },
    status: fields.documentStatus ?? "active",
    active: true,
    document: {
      kind: fields.documentKind,
      status: fields.documentStatus ?? "active",
      sectionId: sections.some((section) => section.id === fields.sectionId)
        ? (fields.sectionId ?? null)
        : null,
      pinned: fields.pinned ?? false,
      format: fields.documentFormat ?? "markdown",
      ...(fields.url === undefined ? {} : { url: fields.url }),
      tags: fields.tags ?? [],
      updatedAt: record.updatedAt,
      linkCount: fields.links.length + (fields.relations?.length ?? 0),
    },
  };
}
