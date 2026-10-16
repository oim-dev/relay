import { z } from "zod";
import { entityRefSchema } from "@relay/contracts/entities/graph";
import { entityDataSchemas, entityDetailSchema } from "@relay/contracts/entities";
import type { EntityGetQuery } from "@relay/contracts/entities";
import { AppError, invariant } from "../../shared/errors.js";
import type { StorageSession } from "../../storage/entity-store/store.js";
import type { Workspace } from "../../storage/workspace.js";
import { boardRecord } from "../../storage/unified-adapter.js";
import {
  entityKeySpacePrefix,
  readEntityCard,
  readEntityCards,
  resolveEntityCard,
} from "../entities/indexed-catalog.js";
import type { EntityCard } from "../entities/indexed-catalog.js";
import { entityAddress, entitySummary } from "../entities/catalog.js";
import { boardEntityEntry } from "../entities/board.js";
import { resolveAddress } from "../entities/resolver.js";
import { boardView } from "./view.js";
import type { BoardApplication } from "./view.js";

const selectorRefs = z.array(entityRefSchema);
const selectorKey = z.tuple([z.string(), z.string()]);
const liveRecord = z.object({ ref: entityRefSchema, deleted: z.literal(false) });

function readSelectorKey(key: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(key);
  } catch {
    // Повреждение производного индекса — не отсутствие выбранной доски.
  }
  const parsed = selectorKey.safeParse(raw);
  invariant(parsed.success, "STORAGE_INDEX_CORRUPT", "Повреждён ключ селектора", 5);
  return parsed.data;
}

function readSelectorRefs(raw: unknown) {
  const parsed = selectorRefs.safeParse(raw);
  invariant(parsed.success, "STORAGE_INDEX_CORRUPT", "Повреждены владельцы селектора", 5);
  return parsed.data;
}

async function selectedCard(session: StorageSession, ref: { kind: string; id: string }) {
  const address = entityAddress(ref);
  const record = liveRecord.safeParse(await session.indexGet("records", address));
  invariant(
    record.success && entityAddress(record.data.ref) === address,
    "STORAGE_INDEX_CORRUPT",
    `Селектор ссылается на отсутствующую запись ${address}`,
    5,
  );
  return readEntityCard(session, address);
}

/** Slug уже индексируется кодеком. Старый индекс может не содержать префикс доски. */
async function boardSelectorCards(session: StorageSession, value: string): Promise<EntityCard[]> {
  invariant(
    (await session.snapshotRoots()).selectors,
    "STORAGE_INDEX_CORRUPT",
    "Потерян индекс selectors",
    5,
  );
  const refs = readSelectorRefs(
    (await session.indexGet("selectors", JSON.stringify(["board", value]))) ?? [],
  );
  if (refs.length)
    return Promise.all(
      refs.map(async (ref) => {
        const card = await selectedCard(session, ref);
        invariant(
          card.ref.kind === "board" && card.selectors.includes(value),
          "STORAGE_INDEX_CORRUPT",
          "Селектор не соответствует карточке доски",
          5,
        );
        return card;
      }),
    );

  // Совместимость с прежними selectors: обход только владельцев slug, не records всех
  // задач/документов/планов. Полные записи здесь не открываются. Формат индекса не меняем.
  const addresses = new Map<string, { kind: string; id: string }>();
  for (const [key, raw] of await session.indexEntries("selectors")) {
    if (readSelectorKey(key)[0] !== "board") continue;
    for (const ref of readSelectorRefs(raw)) {
      invariant(ref.kind === "board", "STORAGE_INDEX_CORRUPT", "Неверный владелец slug доски", 5);
      addresses.set(entityAddress(ref), ref);
    }
  }
  const cards: EntityCard[] = [];
  for (const ref of addresses.values()) {
    const card = await selectedCard(session, ref);
    if (card.selectors.includes(value)) cards.push(card);
  }
  return cards;
}

export async function resolveBoardCard(session: StorageSession, reference: string) {
  try {
    return await resolveEntityCard(session, reference, "board", (value) =>
      boardSelectorCards(session, value),
    );
  } catch (error) {
    const value = reference.startsWith("board:") ? reference.slice(6) : reference;
    if (
      !(error instanceof AppError) ||
      error.code !== "ENTITY_NOT_FOUND" ||
      !value.startsWith("BOARD-")
    )
      throw error;
    // Только специализированный get исторически принимал BOARD-<prefix> независимо
    // от текущего ключа. Общий резолвер EntityDetail не получает искусственного алиаса.
    const prefix = value.slice(6);
    return resolveAddress(await boardSelectorCards(session, prefix), prefix, "board");
  }
}

/** Полный снимок досок требует всех владельцев, но не их Markdown или продуктового состава. */
export async function indexedBoardApplications(session: StorageSession) {
  const cards = await readEntityCards(session, "application");
  const slugs = new Map<string, string>();
  for (const [key, raw] of await session.indexEntries("selectors")) {
    const [kind, slug] = readSelectorKey(key);
    if (kind !== "application") continue;
    for (const ref of readSelectorRefs(raw)) {
      invariant(ref.kind === kind, "STORAGE_INDEX_CORRUPT", "Неверный владелец slug приложения", 5);
      invariant(
        !slugs.has(ref.id) || slugs.get(ref.id) === slug,
        "STORAGE_INDEX_CORRUPT",
        "У приложения несколько slug",
        5,
      );
      slugs.set(ref.id, slug);
    }
  }
  const applications: BoardApplication[] = cards.map((card) => {
    const slug = slugs.get(card.ref.id);
    invariant(slug, "STORAGE_INDEX_CORRUPT", "Потерян slug приложения", 5);
    return { id: card.ref.id, fields: { kind: "application", name: card.title, slug } };
  });
  return applications;
}

/** Адресный полный BoardView и ссылка на владельца из того же снимка. */
export async function readBoard(workspace: Workspace, card: EntityCard) {
  const session = workspace.storageSession!;
  const board = await boardRecord(workspace, await session.get(card.ref));
  // Постоянный keyspace содержит prefix, которого нет в теле доски.
  await entityKeySpacePrefix(session, card);
  let application: BoardApplication | undefined;
  let owner: EntityCard | undefined;
  if (board.applicationId) {
    const ref = { kind: "application", id: board.applicationId };
    const record = await session.get(ref);
    const data = entityDataSchemas.application.parse({ ...record.data, kind: "application" });
    application = { id: record.id, fields: data };
    owner = await selectedCard(session, ref);
    invariant(
      owner.key === record.key && owner.revision === record.revision && owner.title === data.name,
      "STORAGE_INDEX_STALE",
      "Карточка приложения устарела; выполните reindex",
      4,
    );
  }
  const view = boardView(board, application);
  invariant(
    card.key === board.key &&
      card.revision === board.revision &&
      card.title === view.name &&
      JSON.stringify(card.aliases) === JSON.stringify(board.aliases ?? []) &&
      card.selectors.includes(view.slug) &&
      card.selectors.includes(view.prefix),
    "STORAGE_INDEX_STALE",
    "Карточка доски устарела; выполните reindex",
    4,
  );
  return { board, view, owner };
}

/** Dirty/legacy сохраняют полный логический каталог, не базовые карточки незавершённой записи. */
export async function readBoardDetail(workspace: Workspace, query: EntityGetQuery) {
  const session = workspace.storageSession;
  if (!session || session.changed || (query.kind !== undefined && query.kind !== "board"))
    return undefined;
  if (query.kind === undefined && !query.ref.startsWith("board:")) {
    const candidates = z
      .array(z.object({ ref: entityRefSchema }))
      .parse((await session.indexGet("addresses", query.ref)) ?? []);
    if (!candidates.some(({ ref }) => ref.kind === "board")) return undefined;
  }
  const card = await resolveEntityCard(session, query.ref, query.kind, (value) =>
    boardSelectorCards(session, value),
  );
  if (card.ref.kind !== "board") return undefined;
  const { board, view, owner } = await readBoard(workspace, card);
  const entry = boardEntityEntry(board, view.name);
  return entityDetailSchema.parse({
    ...entitySummary(entry),
    data: entry.data,
    references: owner ? [entitySummary({ ...owner, status: owner.status || null })] : [],
  });
}
