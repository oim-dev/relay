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
  const fields = record.fields;
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
      updatedAt: record.updatedAt,
      linkCount: fields.links.length + (fields.relations?.length ?? 0),
    },
  };
}
