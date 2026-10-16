import type { z } from "zod";
import type {
  entitiesQuerySchema,
  EntityMatch,
  EntityMetadata,
  EntitySummary,
} from "@relay/contracts/entities";
import { entityAddress, entitySummary } from "./catalog.js";
import type { EntityEntry } from "./catalog.js";
import { matchesTarget, selectedTags } from "./document-library.js";
import { documentTagKey } from "../../domain/document-library.js";

export type ParsedEntitiesQuery = z.output<typeof entitiesQuerySchema>;

/** Публичные дополнения чтения не становятся новой дисковой карточкой. */
export function queryEntitySummary(entry: EntityEntry, metadata?: EntityMetadata): EntitySummary {
  const updatedAt = metadata?.updatedAt ?? entry.document?.updatedAt;
  return {
    ...entitySummary(entry),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(entry.implementation === undefined ? {} : { implementation: entry.implementation }),
  };
}

/** Явные поля, не JSON.stringify агрегата: критерии, комментарии и этапы не входят в поиск. */
export function entitySearchFields(
  entry: EntityEntry,
): { field: EntityMatch["field"]; value: string }[] {
  const data = entry.data;
  const fields: { field: EntityMatch["field"]; value: string }[] = [
    { field: "key", value: entry.key },
    { field: "title", value: entry.title },
    ...entry.aliases.map((value) => ({ field: "alias" as const, value })),
    { field: "address", value: entityAddress(entry.ref) },
    { field: "id", value: entry.ref.id },
    { field: "summary", value: entry.summary },
    { field: "context", value: entry.context ?? "" },
  ];
  if ("description" in data) fields.push({ field: "description", value: data.description });
  if (data.kind === "document") {
    fields.push({ field: "body", value: data.body });
    if (data.url !== undefined) fields.push({ field: "url", value: data.url });
    if (data.tags?.length) fields.push({ field: "tags", value: data.tags.join(" ") });
  }
  if (data.kind === "work-plan") fields.push({ field: "goal", value: data.goal });
  if (data.kind === "release") fields.push({ field: "version", value: data.version });
  if (entry.implementation) {
    const { application, target } = entry.implementation;
    fields.push(
      { field: "application.key", value: application.key },
      { field: "application.title", value: application.title },
      { field: "target.key", value: target.key },
      { field: "target.title", value: target.title },
    );
  }
  return fields;
}

function findEntityMatch(entry: EntityEntry, needle: string) {
  for (const field of entitySearchFields(entry)) {
    const normalized = field.value.toLocaleLowerCase();
    const index = normalized.indexOf(needle);
    if (index >= 0) return { ...field, index, normalized };
  }
  return undefined;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Индексы lowercase не всегда совпадают с исходными: например, İ превращается в i + ◌̇. */
function sourceMatchIndex(value: string, normalized: string, index: number) {
  if (value.length === normalized.length) return index;
  let source = 0,
    folded = 0;
  for (const character of value) {
    const length = character.toLocaleLowerCase().length;
    if (folded + length > index) return source;
    source += character.length;
    folded += length;
  }
  return source;
}

/** Ограниченный фрагмент, а не копия полного Markdown. Обычные границы сохраняют графемы. */
function matchFragment(value: string, index: number) {
  if (value.length <= 240) return { text: value, truncated: false };
  const segments = graphemes.segment(value);
  let start = segments.containing(Math.max(0, index - 50))?.index ?? 0;
  let end = Math.min(value.length, start + 240);
  if (end < value.length) end = segments.containing(end)?.index ?? end;
  if (end <= index) {
    // Одна графема может состоять из тысяч combining marks. Бюджет ответа всё равно
    // сохраняется; крайний случай режется по Unicode scalar, никогда внутри surrogate pair.
    start = index;
    if (/^[\uDC00-\uDFFF]$/.test(value[start] ?? "")) start--;
    end = Math.min(value.length, start + 240);
    if (/^[\uD800-\uDBFF]$/.test(value[end - 1] ?? "")) end--;
  }
  return { text: value.slice(start, end), truncated: start > 0 || end < value.length };
}

/** Один источник основания для общего, документного и dirty/legacy-представления. */
export function entitySearchMatch(
  entry: EntityEntry,
  q: string | undefined,
): EntityMatch | undefined {
  const needle = q?.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const match = findEntityMatch(entry, needle);
  if (!match) return undefined;
  return {
    field: match.field,
    ...matchFragment(match.value, sourceMatchIndex(match.value, match.normalized, match.index)),
  };
}

/** Все выбранные теги без учёта регистра; пустой выбор не фильтрует и не сужает виды. */
function matchesTags(entry: EntitySummary, tags: readonly string[] | undefined) {
  const selected = selectedTags(tags);
  if (!selected.length) return true;
  if (!entry.document) return false;
  const own = new Set(entry.document.tags.map(documentTagKey));
  return selected.every((tag) => own.has(tag));
}

/** Неприменимость типового фильтра не равна пустому значению поля. */
export function matchesSummary(entry: EntitySummary, query: ParsedEntitiesQuery) {
  return (
    (!query.kind || entry.ref.kind === query.kind) &&
    (query.status === undefined || entry.status === query.status) &&
    (query.active === undefined ||
      (entry.ref.kind === "implementation" && entry.active === (query.active === "true"))) &&
    (query.implementationTarget === undefined || entry.ref.kind === "implementation") &&
    (query.section === undefined ||
      (entry.ref.kind === "document" && (entry.document?.sectionId ?? "none") === query.section)) &&
    (query.documentKind === undefined || entry.document?.kind === query.documentKind) &&
    (query.documentFormat === undefined || entry.document?.format === query.documentFormat) &&
    matchesTags(entry, query.tags) &&
    (query.unattached === undefined ||
      (entry.document !== undefined &&
        (entry.document.linkCount === 0) === (query.unattached === "true"))) &&
    (query.pinned === undefined || entry.document?.pinned === (query.pinned === "true")) &&
    (query.archived === undefined ||
      (entry.document?.status === "archived") === (query.archived === "true"))
  );
}

export function matchesEntry(
  entry: EntityEntry,
  query: ParsedEntitiesQuery,
  resolved: Readonly<Record<string, { kind: string; id: string }>>,
) {
  const needle = query.q?.trim().toLocaleLowerCase();
  return (
    matchesSummary(entry, query) &&
    (query.implementationTarget === undefined ||
      (entry.data.kind === "implementation" &&
        (entry.data.scenarioId === null ? "feature" : "scenario") ===
          query.implementationTarget)) &&
    (!needle || findEntityMatch(entry, needle) !== undefined) &&
    // Цель документа сравнивается полным адресом, прочие фильтры — ID внутри своей области.
    Object.entries(resolved).every(([name, ref]) => matchesTarget(entry, name, ref))
  );
}

export function searchEntitySummary(
  entry: EntityEntry,
  query: ParsedEntitiesQuery,
  metadata?: EntityMetadata,
) {
  const summary = queryEntitySummary(entry, metadata);
  const match = entitySearchMatch(entry, query.q);
  if (match) summary.match = match;
  const needle = query.q?.trim().toLocaleLowerCase();
  if (needle && entry.data.kind === "document" && summary.document) {
    const match = entry.data.body.toLocaleLowerCase().indexOf(needle);
    if (match >= 0)
      summary.document = {
        ...summary.document,
        excerpt: entry.data.body.slice(Math.max(0, match - 50), match + needle.length + 100),
      };
  }
  return summary;
}

export function compareEntitySummaries(
  a: EntitySummary,
  b: EntitySummary,
  sort: ParsedEntitiesQuery["sort"],
) {
  return (
    (sort === "updated"
      ? (b.updatedAt === undefined ? -Infinity : Date.parse(b.updatedAt)) -
        (a.updatedAt === undefined ? -Infinity : Date.parse(a.updatedAt))
      : a[sort].localeCompare(b[sort], "ru", { numeric: true })) ||
    entityAddress(a.ref).localeCompare(entityAddress(b.ref))
  );
}
