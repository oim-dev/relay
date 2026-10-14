import { entityDataSchemas } from "@relay/contracts/entities";
import type {
  EntityData,
  EntityKind,
  EntityMetadata,
  EntitySummary,
} from "@relay/contracts/entities";
import type { Workspace } from "../../storage/workspace.js";
import { digest } from "../../storage/entity-store/format.js";
import { invariant } from "../../shared/errors.js";
import { documentMetadata } from "../documents/projection.js";
import { readDocumentRecord } from "../documents/read.js";
import { entityAddress, entityDigest } from "./catalog.js";
import type { EntityEntry } from "./catalog.js";
import {
  readEntityCard,
  readEntityCards,
  requireEntityIndexes,
  resolveEntityCard,
} from "./indexed-catalog.js";
import type { EntityCard } from "./indexed-catalog.js";
import {
  compareEntitySummaries,
  entitySearchMatch,
  matchesEntry,
  matchesSummary,
  searchEntitySummary,
} from "./query.js";
import type { ParsedEntitiesQuery } from "./query.js";

/** Сохраняет документный фильтр/guard/excerpt. При q тела уже прочитаны reader-ом
 * библиотеки в этой сессии; дополнительных EntityEngine.get или API-вызовов нет. */
export async function withDocumentSearchMatches(
  workspace: Workspace,
  items: EntitySummary[],
  query: ParsedEntitiesQuery,
) {
  if (!query.q?.trim()) return items;
  const result: EntitySummary[] = [];
  for (const summary of items) {
    const card = await readEntityCard(workspace.storageSession!, entityAddress(summary.ref));
    const { entry } = await readDocumentRecord(workspace, card);
    const match = entitySearchMatch(entry, query.q);
    result.push(match ? { ...summary, match } : summary);
  }
  return result;
}

/** Отдельный read-only путь. Writer и dirty/legacy не используют частичный каталог. */
export async function readIndexedEntityList(workspace: Workspace, query: ParsedEntitiesQuery) {
  const session = workspace.storageSession;
  if (!session || session.changed) return undefined;
  await requireEntityIndexes(session);
  const version = `entities-v2:${entityDigest(
    Object.entries(await session.snapshotRoots()).sort(([a], [b]) => a.localeCompare(b)),
  )}`;
  invariant(
    query.version === undefined || query.version === version,
    "ENTITIES_CHANGED",
    "Сущности изменились. Начните чтение с первой страницы",
    4,
  );
  const expected: Record<string, EntityKind | undefined> = {
    board: "board",
    application: "application",
    feature: "feature",
    scenario: "scenario",
    parent: "task",
    target: undefined,
  };
  const resolved: Record<string, string> = {};
  for (const name of Object.keys(expected) as (keyof typeof expected)[]) {
    const value = query[name as keyof ParsedEntitiesQuery];
    if (typeof value === "string")
      resolved[name] = (await resolveEntityCard(session, value, expected[name])).ref.id;
  }
  let cards: EntityCard[];
  if (query.refs !== undefined) {
    const selected = new Map<string, EntityCard>();
    for (const ref of query.refs) {
      const [kind, id, extra] = ref.split(":");
      if (
        extra === undefined &&
        id !== undefined &&
        session.store.registry.definitions().find((entry) => entry.kind === kind)?.relocation &&
        (await session.indexGet("cards", ref)) !== undefined
      )
        continue;
      const card = await resolveEntityCard(session, ref, query.kind);
      selected.set(entityAddress(card.ref), card);
    }
    cards = [...selected.values()];
  } else {
    // Типовые фильтры сужают чтение карточек до применимых видов ещё до чтения тел.
    const kind =
      query.kind ??
      (query.active !== undefined || query.implementationTarget !== undefined
        ? "implementation"
        : query.section !== undefined ||
            query.documentKind !== undefined ||
            query.pinned !== undefined ||
            query.archived === "true"
          ? "document"
          : undefined);
    cards = await readEntityCards(session, kind);
  }
  const cache = new Map(cards.map((card) => [entityAddress(card.ref), card]));
  const records = new Map<string, Awaited<ReturnType<typeof session.get>>>();
  const verifiedRecord = async (card: EntityCard) => {
    const address = entityAddress(card.ref);
    const cached = records.get(address);
    if (cached) return cached;
    const record = await session.get(card.ref);
    const path = session.store.registry.path(record);
    invariant(
      (await session.indexGet("file-hashes", path)) === digest(await session.readFile(path)) &&
        record.key === card.key &&
        record.revision === card.revision &&
        JSON.stringify(record.aliases) === JSON.stringify(card.aliases),
      "STORAGE_INDEX_STALE",
      "Карточка сущности устарела; выполните reindex",
      4,
      { path, ref: card.ref },
    );
    // Повторно нужен только владелец задач; полные тексты кандидатов не удерживаем после проекции.
    if (card.ref.kind === "board") records.set(address, record);
    return record;
  };
  const related = async (kind: EntityKind, id: string) => {
    const address = `${kind}:${id}`;
    let card = cache.get(address);
    if (!card) {
      card = await readEntityCard(session, address);
      cache.set(address, card);
    }
    return card;
  };
  const items: EntitySummary[] = [];
  for (const card of cards) {
    if (!matchesSummary({ ...card, status: card.status || null }, query)) continue;
    let entry: EntityEntry;
    let metadata: EntityMetadata | undefined;
    if (card.ref.kind === "document") {
      ({ entry, metadata } = await readDocumentRecord(workspace, card));
    } else if (
      card.ref.kind === "product" &&
      card.status === "uninitialized" &&
      (await session.indexGet("records", entityAddress(card.ref))) === undefined
    ) {
      entry = {
        ...card,
        status: card.status || null,
        filters: {},
        data: { kind: "product", name: "", summary: "", description: "" },
      };
    } else {
      const record = await verifiedRecord(card);
      const fields = { ...record.data };
      if (card.ref.kind === "task") delete fields.acceptanceCriteria;
      const data: EntityData = entityDataSchemas[card.ref.kind].parse({
        ...fields,
        kind: card.ref.kind,
      });
      metadata = card.status === "uninitialized" ? undefined : documentMetadata(record);
      entry = { ...card, status: card.status || null, data, filters: {} };
      if (data.kind === "scenario") entry.filters.feature = data.featureId;
      if (data.kind === "board") entry.filters.application = data.applicationId;
      if (data.kind === "task") {
        const board = await related("board", data.boardId);
        // При фильтре по приложению достаточно прямого владельца доски. Чужие задачи не читаются.
        const applicationId =
          query.application === undefined
            ? null
            : ((await verifiedRecord(board)).data.applicationId as string | null);
        entry.filters = {
          board: data.boardId,
          application: applicationId,
          parent: data.parentId,
          target: data.productLinks.map((ref) => ref.id),
        };
      }
      if (data.kind === "implementation") {
        const application = await related("application", data.applicationId);
        const target = await related(
          data.scenarioId === null ? "feature" : "scenario",
          data.scenarioId ?? data.featureId,
        );
        const addressCard = ({ ref, key, title }: EntityCard) => ({ ref, key, title });
        entry.implementation = {
          type: data.scenarioId === null ? "FI" : "SI",
          application: addressCard(application),
          target: addressCard(target),
        };
        entry.filters = {
          application: data.applicationId,
          feature: data.featureId,
          scenario: data.scenarioId,
          target: data.scenarioId ?? data.featureId,
        };
      }
    }
    if (matchesEntry(entry, query, resolved))
      items.push(searchEntitySummary(entry, query, metadata));
  }
  items.sort((a, b) => compareEntitySummaries(a, b, query.sort));
  return { items, version };
}
