import { z } from "zod";
import { entityDataSchemas, entityDetailSchema } from "@relay/contracts/entities";
import type { EntityGetQuery, EntitySummary } from "@relay/contracts/entities";
import type { Workspace } from "../../storage/workspace.js";
import type { StorageSession } from "../../storage/entity-store/store.js";
import { digest } from "../../storage/entity-store/format.js";
import { invariant } from "../../shared/errors.js";
import { entityAddress, entityDigest, entitySummary } from "../entities/catalog.js";
import { readEntityCard, resolveEntityCard } from "../entities/indexed-catalog.js";
import type { EntityCard } from "../entities/indexed-catalog.js";
import { documentEntityEntry, documentMetadata } from "./projection.js";
import type { DocumentData } from "./projection.js";

/** Тело и метаданные принадлежат одной проверенной записи, карточка служит только адресации. */
export async function readDocumentRecord(workspace: Workspace, card: EntityCard) {
  const session = workspace.storageSession!;
  const record = await session.get(card.ref);
  const fields = entityDataSchemas.document.parse({ ...record.data, kind: "document" });
  const entry = documentEntityEntry(
    { ...record, key: record.key ?? undefined, reservedKeys: record.aliases, fields },
    workspace.config.projectSettings?.documentSections,
  );
  const path = session.store.registry.path(record);
  invariant(
    (await session.indexGet("file-hashes", path)) === digest(await session.readFile(path)) &&
      entityDigest(entitySummary(entry)) ===
        entityDigest(entitySummary({ ...card, status: card.status || null })) &&
      JSON.stringify(entry.aliases) === JSON.stringify(card.aliases),
    "STORAGE_INDEX_STALE",
    "Карточка документа устарела; выполните reindex",
    4,
    { path, ref: card.ref },
  );
  return { entry, metadata: documentMetadata(record) };
}

export function documentTargets(data: DocumentData) {
  return [
    ...(data.relations ?? []).map((relation) => relation.target),
    ...data.links.map((link) => ({
      kind: link.kind,
      id: link.kind === "product" ? "passport" : link.id,
    })),
  ];
}

const recordIndexSchema = z.object({
  ref: z.object({ kind: z.string(), id: z.string() }),
  deleted: z.boolean(),
});

/** Нет обхода каталога: только доступные прямые цели; старый этап не получает фиктивный get. */
export async function documentReferences(
  session: StorageSession,
  targets: readonly { kind: string; id: string }[],
): Promise<EntitySummary[]> {
  const references: EntitySummary[] = [];
  const addresses = [
    ...new Set(targets.filter((ref) => ref.kind !== "plan-stage").map(entityAddress)),
  ];
  for (const address of addresses.sort((a, b) => a.localeCompare(b))) {
    const raw = await session.indexGet("records", address);
    // Полный каталог также не возвращает карточки удалённых/отсутствующих целей.
    if (raw === undefined) {
      if (address === "product:passport")
        references.push(
          entitySummary({
            ...(await resolveEntityCard(session, address)),
            status: "uninitialized",
          }),
        );
      continue;
    }
    const record = recordIndexSchema.safeParse(raw);
    invariant(
      record.success && entityAddress(record.data.ref) === address,
      "STORAGE_INDEX_CORRUPT",
      `Повреждён адрес цели ${address}`,
      5,
    );
    if (record.data.deleted) continue;
    const card = await readEntityCard(session, address);
    references.push(entitySummary({ ...card, status: card.status || null }));
  }
  return references;
}

/** Только неизменённая current-сессия; запись и legacy используют строгий логический каталог. */
export async function readDocumentDetail(workspace: Workspace, query: EntityGetQuery) {
  const session = workspace.storageSession;
  if (!session || session.changed || (query.kind !== undefined && query.kind !== "document"))
    return undefined;
  if (query.kind === undefined && !query.ref.startsWith("document:")) {
    const candidates = z
      .array(recordIndexSchema)
      .parse((await session.indexGet("addresses", query.ref)) ?? []);
    if (!candidates.some(({ ref }) => ref.kind === "document")) return undefined;
  }
  const card = await resolveEntityCard(session, query.ref, query.kind);
  if (card.ref.kind !== "document") return undefined;
  const { entry, metadata } = await readDocumentRecord(workspace, card);
  return entityDetailSchema.parse({
    ...entitySummary(entry),
    data: entry.data,
    metadata,
    references: await documentReferences(session, documentTargets(entry.data)),
  });
}
