import { z } from "zod";
import type { entitiesQuerySchema, EntitySummary } from "@relay/contracts/entities";
import type { Workspace } from "../../storage/workspace.js";
import type { StorageSession } from "../../storage/entity-store/store.js";
import { invariant } from "../../shared/errors.js";
import { entityAddress, entityDigest, entitySummary } from "../entities/catalog.js";
import { readEntityCards, resolveEntityCard } from "../entities/indexed-catalog.js";
import { readDocumentRecord } from "./read.js";
import { matchesTarget } from "../entities/document-library.js";
import { matchesSummary } from "../entities/query.js";

/** Guard индексного документного чтения; счётчики библиотеки возвращают ту же версию. */
export async function documentListVersion(session: StorageSession) {
  return `documents-v1:${entityDigest(
    Object.entries(await session.snapshotRoots()).sort(([a], [b]) => a.localeCompare(b)),
  )}`;
}

/** Документная выборка не строит готовность продукта и не открывает чужие полные записи. */
export async function readDocumentList(
  workspace: Workspace,
  query: z.output<typeof entitiesQuerySchema>,
) {
  const session = workspace.storageSession;
  if (!session || session.changed) return undefined;
  const version = await documentListVersion(session);
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
    query.target === undefined ? undefined : (await resolveEntityCard(session, query.target)).ref;
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
    // Формат, теги и прикрепления хранятся в карточке: фильтр не читает полные записи.
    if (
      (selected && !selected.has(entityAddress(card.ref))) ||
      !matchesSummary({ ...card, status: card.status || null }, query)
    )
      continue;
    // Цели принадлежат полям документа, не диагностическому графу. Поиск действительно ищет
    // body, url и теги; цель сравнивается полным адресом, ID уникальны только внутри вида.
    const source =
      needle || target !== undefined ? await readDocumentRecord(workspace, card) : undefined;
    if (target !== undefined && !matchesTarget(source!.entry, "target", target)) continue;
    const body = source?.entry.data.body ?? "";
    // Составная строка прежнего документного reader-а сохраняется: совпадение на стыке полей
    // проходит фильтр, а основание match определяется отдельно по одному полю.
    const data = source?.entry.data;
    if (
      needle &&
      !`${card.key} ${card.aliases.join(" ")} ${entityAddress(card.ref)} ${card.title} ${card.summary} ${card.context ?? ""} ${body} ${data?.url ?? ""} ${(data?.tags ?? []).join(" ")}`
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
