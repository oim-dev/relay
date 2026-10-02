import type { z } from "zod";
import type { entitiesQuerySchema } from "@relay/contracts/entities";
import { documentKindSchema, documentStatusSchema } from "@relay/contracts/entities";
import type { DocumentFacets } from "@relay/contracts/entities/document-catalog";
import { documentTagKey } from "../../domain/document-library.js";
import { invariant } from "../../shared/errors.js";
import { entityAddress, entitySummary, resolveEntity } from "./catalog.js";
import type { EntityCatalog, EntityEntry } from "./catalog.js";

type Query = z.output<typeof entitiesQuerySchema>;
export type DocumentAxis =
  | "q"
  | "target"
  | "section"
  | "tags"
  | "documentFormat"
  | "documentKind"
  | "status"
  | "archived"
  | "pinned"
  | "unattached";
type Predicate = (entry: EntityEntry) => boolean;

/** Полнотекстовое совпадение каталога: адреса, название, краткое описание и текст документа. */
export function matchesText(entry: EntityEntry, needle: string | undefined) {
  return (
    !needle ||
    `${entry.key} ${entry.aliases.join(" ")} ${entityAddress(entry.ref)} ${entry.title} ${entry.summary} ${entry.context ?? ""} ${entry.data.kind === "document" ? `${entry.data.body} ${entry.data.url ?? ""} ${(entry.data.tags ?? []).join(" ")}` : ""}`
      .toLocaleLowerCase()
      .includes(needle)
  );
}

/**
 * Совпадение фильтра по адресу: у документа сравниваются вид и ID цели,
 * у прочих видов — ID внутри их собственной области целей.
 */
export function matchesTarget(entry: EntityEntry, name: string, ref: { kind: string; id: string }) {
  const addresses = name === "target" ? entry.filters.targetAddress : undefined;
  if (Array.isArray(addresses)) return addresses.includes(entityAddress(ref));
  const value = entry.filters[name];
  return Array.isArray(value) ? value.includes(ref.id) : value === ref.id;
}

/** Нормализованные ключи выбранных тегов: пустые значения игнорируются. */
export const selectedTags = (tags: readonly string[] | undefined) => [
  ...new Set((tags ?? []).map(documentTagKey).filter(Boolean)),
];

/**
 * Фильтры документов по осям: фасет считает выборку без фильтра собственной оси.
 * Цель уже разрешена в постоянный ID вызывающим кодом.
 */
export function documentAxes(
  query: Pick<Query, Exclude<DocumentAxis, "target">>,
  target: { kind: string; id: string } | undefined,
): Record<DocumentAxis, Predicate> {
  const needle = query.q?.trim().toLocaleLowerCase() || undefined;
  const tags = selectedTags(query.tags);
  return {
    q: (entry) => matchesText(entry, needle),
    target: (entry) => target === undefined || matchesTarget(entry, "target", target),
    section: (entry) =>
      query.section === undefined || (entry.document?.sectionId ?? "none") === query.section,
    tags: (entry) => {
      if (!tags.length) return true;
      const own = new Set((entry.document?.tags ?? []).map(documentTagKey));
      return tags.every((tag) => own.has(tag));
    },
    documentFormat: (entry) =>
      query.documentFormat === undefined || entry.document?.format === query.documentFormat,
    documentKind: (entry) =>
      query.documentKind === undefined || entry.document?.kind === query.documentKind,
    status: (entry) => query.status === undefined || entry.status === query.status,
    archived: (entry) =>
      query.archived === undefined ||
      (entry.document?.status === "archived") === (query.archived === "true"),
    pinned: (entry) =>
      query.pinned === undefined || entry.document?.pinned === (query.pinned === "true"),
    unattached: (entry) =>
      query.unattached === undefined ||
      (entry.document !== undefined &&
        (entry.document.linkCount === 0) === (query.unattached === "true")),
  };
}

const passes = (
  axes: Record<DocumentAxis, Predicate>,
  entry: EntityEntry,
  skip: readonly DocumentAxis[] = [],
) =>
  (Object.entries(axes) as [DocumentAxis, Predicate][]).every(
    ([axis, predicate]) => skip.includes(axis) || predicate(entry),
  );

/** Счётчики по всем документам проекта; область каждой оси объявлена в контракте. */
export function documentFacets(
  catalog: EntityCatalog,
  query: Pick<Query, Exclude<DocumentAxis, "target"> | "target">,
): DocumentFacets {
  const target = query.target === undefined ? undefined : resolveEntity(catalog, query.target).ref;
  const axes = documentAxes(query, target);
  const documents = catalog.entries.filter((entry) => entry.document !== undefined);
  const scope = (...skip: DocumentAxis[]) => documents.filter((entry) => passes(axes, entry, skip));
  const project = catalog.entries.find((entry) => entry.ref.kind === "project")!;
  const sectionIds =
    project.data.kind === "project"
      ? (project.data.documentSections ?? []).map((section) => section.id)
      : [];
  const sectionCounts = new Map<string | null, number>([
    ...sectionIds.map((id) => [id, 0] as const),
    [null, 0],
  ]);
  for (const entry of scope("section")) {
    const id = entry.document!.sectionId;
    sectionCounts.set(id, (sectionCounts.get(id) ?? 0) + 1);
  }
  const tagCounts = new Map<string, { count: number; spellings: Map<string, number> }>();
  const selected = scope();
  for (const entry of selected)
    for (const tag of entry.document!.tags) {
      const key = documentTagKey(tag);
      const current = tagCounts.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      current.count++;
      current.spellings.set(tag, (current.spellings.get(tag) ?? 0) + 1);
      tagCounts.set(key, current);
    }
  // Написание детерминировано: самое частое, при равенстве — первое по алфавиту.
  const spelling = (spellings: Map<string, number>) =>
    [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))[0]![0];
  const tally = <T extends string>(
    values: readonly T[],
    items: EntityEntry[],
    read: (entry: EntityEntry) => T,
  ) =>
    values.map((value) => ({
      value,
      count: items.filter((entry) => read(entry) === value).length,
    }));
  const views = scope("section", "status", "archived", "pinned", "unattached");
  const live = views.filter((entry) => entry.document!.status !== "archived");
  return {
    total: selected.length,
    version: catalog.version,
    sections: [...sectionCounts].map(([sectionId, count]) => ({ sectionId, count })),
    tags: [...tagCounts.values()]
      .map(({ count, spellings }) => ({ tag: spelling(spellings), count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "ru")),
    formats: tally(
      ["markdown", "link"] as const,
      scope("documentFormat"),
      (entry) => entry.document!.format,
    ).map(({ value, count }) => ({ format: value, count })),
    kinds: tally(
      documentKindSchema.options,
      scope("documentKind"),
      (entry) => entry.document!.kind,
    ).map(({ value, count }) => ({ kind: value, count })),
    statuses: tally(
      documentStatusSchema.options,
      scope("status", "archived"),
      (entry) => entry.document!.status,
    ).map(({ value, count }) => ({ status: value, count })),
    views: {
      all: live.length,
      pinned: live.filter((entry) => entry.document!.pinned).length,
      draft: views.filter((entry) => entry.document!.status === "draft").length,
      unsectioned: live.filter((entry) => entry.document!.sectionId === null).length,
      unattached: live.filter((entry) => entry.document!.linkCount === 0).length,
      archived: views.length - live.length,
    },
  };
}

type DocumentData = Extract<EntityEntry["data"], { kind: "document" }>;
type Relation = NonNullable<DocumentData["relations"]>[number];
type Link = DocumentData["links"][number];
const linkTarget = (link: Link) => ({
  kind: link.kind,
  id: link.kind === "product" ? "passport" : link.id,
});

/** Связи документа с выбранной сущностью: адресные relations и совместимые links. */
export function documentRelationsTo(data: DocumentData, target: { kind: string; id: string }) {
  const address = entityAddress(target);
  return [
    ...(data.relations ?? [])
      .filter((relation) => entityAddress(relation.target) === address)
      .map((relation) => ({
        type: relation.type,
        description: relation.description,
        source: "relations" as const,
      })),
    ...data.links
      .filter((link) => entityAddress(linkTarget(link)) === address)
      .map(() => ({ type: "documents" as const, description: "", source: "links" as const })),
  ];
}

/** Материалы сущности: только прямые связи, без распространения на детей. */
export function entityDocuments(
  catalog: EntityCatalog,
  ref: string,
  archived: "true" | "false" | undefined,
) {
  const target = resolveEntity(catalog, ref);
  const items = catalog.entries
    .filter((entry) => entry.data.kind === "document" && entry.document)
    .map((entry) => ({
      entry,
      relations: documentRelationsTo(entry.data as DocumentData, target.ref),
      archived: entry.document!.status === "archived",
    }))
    .filter(
      (item) =>
        item.relations.length > 0 &&
        (archived === undefined || item.archived === (archived === "true")),
    )
    .sort(
      (a, b) =>
        Number(b.entry.document!.pinned) - Number(a.entry.document!.pinned) ||
        a.entry.title.localeCompare(b.entry.title, "ru", { numeric: true }) ||
        entityAddress(a.entry.ref).localeCompare(entityAddress(b.entry.ref)),
    )
    .map(({ entry, relations, archived: isArchived }) => ({
      document: entitySummary(entry),
      archived: isArchived,
      relations,
    }));
  return { target: entitySummary(target), items };
}

/**
 * Изменяет одну связь документа и возвращает полный новый набор.
 * Прочие relations и совместимые links сохраняются; links меняется только для выбранной цели.
 */
export function changeDocumentRelation(
  data: DocumentData,
  target: { kind: string; id: string },
  command: {
    action: "attach" | "update" | "detach";
    type: Relation["type"];
    description?: string | undefined;
    nextType?: Relation["type"] | undefined;
  },
): { relations: Relation[]; links: Link[] } {
  const relations = [...(data.relations ?? [])];
  const links = [...data.links];
  const address = entityAddress(target);
  const relationIndex = (type: Relation["type"]) =>
    relations.findIndex(
      (relation) => entityAddress(relation.target) === address && relation.type === type,
    );
  const legacyIndex = () => links.findIndex((link) => entityAddress(linkTarget(link)) === address);
  const exists = (type: Relation["type"]) =>
    relationIndex(type) >= 0 || (type === "documents" && legacyIndex() >= 0);
  const relationTarget = target as Relation["target"];
  if (command.action === "attach") {
    invariant(!exists(command.type), "ALREADY_EXISTS", "Такая связь документа уже есть", 4);
    relations.push({
      target: relationTarget,
      type: command.type,
      description: command.description ?? "",
    });
    return { relations, links };
  }
  invariant(exists(command.type), "RELATION_NOT_FOUND", "Связь документа не найдена", 3);
  const index = relationIndex(command.type);
  if (command.action === "detach") {
    if (index >= 0) relations.splice(index, 1);
    else links.splice(legacyIndex(), 1);
    return { relations, links };
  }
  const previous =
    index >= 0
      ? relations[index]!
      : { target: relationTarget, type: "documents" as const, description: "" };
  const type = command.nextType ?? previous.type;
  invariant(
    type === previous.type || !exists(type),
    "ALREADY_EXISTS",
    "Связь выбранного типа уже есть",
    4,
  );
  const next = {
    target: previous.target,
    type,
    description: command.description ?? previous.description,
  };
  if (index >= 0) relations[index] = next;
  else {
    // Совместимая область превращается в адресную связь только явным изменением этой связи.
    links.splice(legacyIndex(), 1);
    relations.push(next);
  }
  return { relations, links };
}
