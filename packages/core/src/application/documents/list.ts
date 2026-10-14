import { z } from "zod";
import type { entitiesQuerySchema, EntitySummary } from "@relay/contracts/entities";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { entityAddress, entityDigest, entitySummary } from "../entities/catalog.js";
import { readEntityCards, resolveEntityCard } from "../entities/indexed-catalog.js";
import { readDocumentRecord } from "./read.js";

/** Документная выборка не строит готовность продукта и не открывает чужие полные записи. */
export async function readDocumentList(
  workspace: Workspace,
  query: z.output<typeof entitiesQuerySchema>,
) {
  const session = workspace.storageSession;
  if (!session || session.changed) return undefined;
  const version = `documents-v1:${entityDigest(
    Object.entries(await session.snapshotRoots()).sort(([a], [b]) => a.localeCompare(b)),
  )}`;
  invariant(
    query.version === undefined || query.version === version,
    "ENTITIES_CHANGED",
    "Сущности изменились. Начните чтение с первой страницы",
    4,
  );
  const cards = await readEntityCards(session, "document");
  const counts: Record<string, number> = { all: 0, draft: 0, pinned: 0, archived: 0, none: 0 };
  for (const card of cards) {
    const document = card.document;
    invariant(
      document,
      "STORAGE_INDEX_STALE",
      "Нет свойств документа в карточке; выполните reindex",
      4,
    );
    if (document.status === "archived") {
      counts.archived!++;
      continue;
    }
    counts.all!++;
    if (document.status === "draft") counts.draft!++;
    if (document.pinned) counts.pinned!++;
    const section = document.sectionId === null ? "none" : `section:${document.sectionId}`;
    counts[section] = (counts[section] ?? 0) + 1;
  }
  const target =
    query.target === undefined
      ? undefined
      : (await resolveEntityCard(session, query.target)).ref.id;
  const selected = query.refs === undefined ? undefined : new Set<string>();
  for (const ref of query.refs ?? []) {
    const [kind, id, extra] = ref.split(":");
    if (
      extra === undefined &&
      id !== undefined &&
      session.store.registry.definitions().find((entry) => entry.kind === kind)?.relocation &&
      (await session.indexGet("cards", ref)) !== undefined
    )
      continue;
    selected!.add(entityAddress((await resolveEntityCard(session, ref, "document")).ref));
  }
  const needle = query.q?.trim().toLocaleLowerCase();
  const items: EntitySummary[] = [];
  for (const card of cards) {
    const document = card.document!;
    if (
      (selected && !selected.has(entityAddress(card.ref))) ||
      (query.status !== undefined && card.status !== query.status) ||
      (query.section !== undefined && (document.sectionId ?? "none") !== query.section) ||
      (query.documentKind !== undefined && document.kind !== query.documentKind) ||
      (query.pinned !== undefined && document.pinned !== (query.pinned === "true")) ||
      (query.archived !== undefined &&
        (document.status === "archived") !== (query.archived === "true"))
    )
      continue;
    // Цели принадлежат полям документа, не диагностическому графу. Поиск действительно ищет body.
    const source =
      needle || target !== undefined ? await readDocumentRecord(workspace, card) : undefined;
    if (target !== undefined && !source!.entry.filters.target?.includes(target)) continue;
    const body = source?.entry.data.body ?? "";
    if (
      needle &&
      !`${card.key} ${card.aliases.join(" ")} ${entityAddress(card.ref)} ${card.title} ${card.summary} ${card.context ?? ""} ${body}`
        .toLocaleLowerCase()
        .includes(needle)
    )
      continue;
    const summary = entitySummary({ ...card, status: card.status || null });
    if (needle && summary.document) {
      const match = body.toLocaleLowerCase().indexOf(needle);
      if (match >= 0)
        summary.document.excerpt = body.slice(Math.max(0, match - 50), match + needle.length + 100);
    }
    items.push(summary);
  }
  items.sort(
    (a, b) =>
      (query.sort === "updated"
        ? (b.document?.updatedAt ?? "").localeCompare(a.document?.updatedAt ?? "")
        : a[query.sort].localeCompare(b[query.sort], "ru", { numeric: true })) ||
      entityAddress(a.ref).localeCompare(entityAddress(b.ref)),
  );
  return { items, version, libraryCounts: counts };
}
