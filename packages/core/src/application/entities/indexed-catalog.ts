import { z } from "zod";
import { entityKinds, entityRefSchema } from "@relay/contracts/entities";
import type { EntityKind } from "@relay/contracts/entities";
import { storageCardSchema, storedKeySpaceSchema } from "@relay/contracts/storage";
import type { StorageSession } from "../../storage/entity-store/store.js";
import { invariant } from "../../shared/errors.js";
import { entityAddress } from "./catalog.js";
import { resolveAddress } from "./resolver.js";
import { digest } from "../../storage/entity-store/format.js";

const recordSchema = z.object({
  ref: z.object({ kind: z.string(), id: z.string() }),
  deleted: z.boolean(),
});
const candidateSchema = recordSchema.extend({ matches: z.array(z.enum(["id", "key", "alias"])) });
const cardSchema = storageCardSchema.extend({ ref: entityRefSchema });
export type EntityCard = z.infer<typeof cardSchema>;
const publicKind = (kind: string): kind is EntityKind =>
  (entityKinds as readonly string[]).includes(kind);
const emptyProduct: EntityCard = {
  ref: { kind: "product", id: "passport" },
  key: "PRODUCT",
  title: "Продукт (паспорт не заполнен)",
  summary: "",
  revision: 0,
  status: "uninitialized",
  active: true,
  aliases: [],
  selectors: [],
};

async function requireIndexes(session: StorageSession) {
  // В проекте всегда есть PROJECT. Потеря корня не означает пустой каталог.
  const roots = await session.snapshotRoots();
  for (const name of ["records", "cards", "addresses", "file-hashes"])
    invariant(roots[name], "STORAGE_INDEX_CORRUPT", `Потерян индекс ${name}`, 5);
}

async function readCard(session: StorageSession, address: string): Promise<EntityCard> {
  const raw = await session.indexGet("cards", address);
  invariant(raw, "STORAGE_INDEX_CORRUPT", `Потеряна карточка ${address}`, 5);
  const parsed = cardSchema.safeParse(raw);
  invariant(
    parsed.success && entityAddress(parsed.data.ref) === address,
    "STORAGE_INDEX_CORRUPT",
    `Повреждена карточка ${address}`,
    5,
  );
  return parsed.data;
}

/** Компактный реестр определяет состав, карточки читаются только для выбранных владельцев. */
export async function readEntityCards(session: StorageSession, kind?: EntityKind) {
  await requireIndexes(session);
  const cards: EntityCard[] = [];
  for (const [address, raw] of await session.indexEntries("records")) {
    const record = recordSchema.parse(raw);
    invariant(
      entityAddress(record.ref) === address,
      "STORAGE_INDEX_CORRUPT",
      "Адрес записи не соответствует индексу",
      5,
    );
    if (!record.deleted && publicKind(record.ref.kind) && (!kind || record.ref.kind === kind))
      cards.push(await readCard(session, address));
  }
  // Прежний логический каталог показывает незаполненный паспорт даже в перенесённой
  // базе без его записи. Реальная запись без карточки по-прежнему является ошибкой.
  if (
    (!kind || kind === "product") &&
    !cards.some((card) => card.ref.kind === "product") &&
    (await session.indexGet("records", "product:passport")) === undefined
  )
    cards.push(structuredClone(emptyProduct));
  return cards.sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref)));
}

/** Те же правила ключ/алиас/ID и selectors, что у каталога, без чтения предметных тел. */
export async function resolveEntityCard(
  session: StorageSession,
  reference: string,
  kind?: EntityKind,
): Promise<EntityCard> {
  await requireIndexes(session);
  const pieces = reference.split(":");
  const value = pieces.at(-1)!;
  const candidates = z
    .array(candidateSchema)
    .parse((await session.indexGet("addresses", value)) ?? []);
  if (pieces.length === 2 && publicKind(pieces[0]!)) {
    const direct = await session.indexGet("records", reference);
    if (direct !== undefined) {
      const record = recordSchema.parse(direct);
      invariant(
        record.deleted ||
          candidates.some(
            (candidate) => entityAddress(candidate.ref) === reference && !candidate.deleted,
          ),
        "STORAGE_INDEX_CORRUPT",
        "Потерян постоянный адрес записи",
        5,
      );
    }
  }
  const cards: EntityCard[] = [];
  for (const candidate of candidates) {
    if (candidate.deleted || !publicKind(candidate.ref.kind)) continue;
    const address = entityAddress(candidate.ref);
    const record = recordSchema.safeParse(await session.indexGet("records", address));
    invariant(
      record.success && !record.data.deleted && entityAddress(record.data.ref) === address,
      "STORAGE_INDEX_CORRUPT",
      `Адрес ссылается на отсутствующую запись ${address}`,
      5,
    );
    const card = await readCard(session, address);
    invariant(
      [card.ref.id, card.key, ...card.aliases].includes(value),
      "STORAGE_INDEX_CORRUPT",
      "Адрес не соответствует карточке",
      5,
    );
    cards.push(card);
  }
  // В каноническом каталоге selectors есть только у PROJECT и досок. Префикс доски
  // уже сохранён в карточке, но не во всех прежних деревьях индекса selectors.
  if ((kind === "project" || kind === "board") && !cards.some((card) => card.ref.kind === kind))
    for (const card of await readEntityCards(session, kind))
      if (card.selectors.includes(value)) cards.push(card);
  if (
    ["PRODUCT", "passport"].includes(value) &&
    (await session.indexGet("records", "product:passport")) === undefined
  )
    cards.push(structuredClone(emptyProduct));
  return resolveAddress(cards, reference, kind);
}

/** Префикс не выводится из изменяемого ключа: он принадлежит постоянному keyspace владельца. */
export async function entityKeySpacePrefix(session: StorageSession, owner: EntityCard) {
  const application = owner.ref.kind === "application";
  const id = application ? `${owner.ref.id}-fi` : owner.ref.id;
  const raw = await session.readFile(`keyspaces/${id}.json`);
  const parsed = storedKeySpaceSchema.safeParse(raw);
  invariant(
    parsed.success &&
      parsed.data.id === id &&
      entityAddress(parsed.data.owner) === entityAddress(owner.ref) &&
      parsed.data.entityKind === (application ? "implementation" : "task"),
    "STORAGE_INDEX_CORRUPT",
    `Потеряно или повреждено пространство ключей ${id}`,
    5,
  );
  invariant(
    (await session.indexGet("file-hashes", `keyspaces/${id}.json`)) === digest(raw),
    "STORAGE_INDEX_STALE",
    "Пространство ключей изменено вне Core; выполните reindex",
    4,
  );
  const prefix = parsed.data.prefix;
  invariant(
    !application || prefix.endsWith("-FI"),
    "STORAGE_INDEX_CORRUPT",
    "Неверный префикс реализации",
    5,
  );
  return application ? prefix.slice(0, -3) : prefix;
}
