import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { entityAddress, entityRefSchema, graphEdgeSchema } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { GraphEdge } from "@relay/contracts/entities/graph";
import { actorSchema } from "@relay/contracts/primitives";
import { directories, jsonFiles } from "../files.js";
import { invariant } from "../../shared/errors.js";
import { digest, keyHash, jsonValue } from "./format.js";
const json = (value: unknown) => jsonValue(JSON.parse(JSON.stringify(value)));
import type { StorageSession } from "./store.js";

const storedEdgeSchema = graphEdgeSchema.extend({
  historyCount: z.number().int().nonnegative().optional(),
  description: z.array(z.string().refine((line) => !line.includes("\n"))),
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
  updatedBy: actorSchema,
});
const entrySchema = z.strictObject({ slot: z.string().min(1).max(128), edge: storedEdgeSchema });
type Entry = z.infer<typeof entrySchema>;
const inlineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: entityRefSchema,
  storage: z.literal("inline"),
  entries: z.array(entrySchema),
});
const splitSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: entityRefSchema,
  storage: z.literal("segments"),
  segments: z.record(z.string().regex(/^[0-9a-f]{1,64}$/), z.string()),
});
const ownerSchema = z.discriminatedUnion("storage", [inlineSchema, splitSchema]);
const shardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: entityRefSchema,
  entries: z.array(entrySchema),
});
export const desiredRelationSchema = graphEdgeSchema
  .pick({ type: true, from: true, to: true, description: true })
  .extend({ id: graphEdgeSchema.shape.id.optional() });
export type DesiredRelation = z.infer<typeof desiredRelationSchema>;
const MAX_INLINE = 256;
const MAX_BYTES = 1024 * 1024;
const address = (session: StorageSession, owner: EntityRef) =>
  `relations/${session.store.registry.definition(owner.kind).collection}/${entityRefSchema.parse(owner).id}`;
const signature = (edge: Pick<DesiredRelation, "type" | "from" | "to">) =>
  JSON.stringify([edge.type, entityAddress(edge.from), entityAddress(edge.to)]);

export async function readOwned(session: StorageSession, owner: EntityRef, verifyIndex = true) {
  const base = address(session, owner);
  const raw = await session.readFile(`${base}.json`);
  if (raw === null) {
    invariant(
      !verifyIndex || (await session.indexGet("file-hashes", `${base}.json`)) === undefined,
      "STORAGE_INDEX_CORRUPT",
      "Потерян постоянный файл отношений",
      5,
      { path: `${base}.json` },
    );
    return { entries: [] as Entry[], files: [] as string[] };
  }
  if (verifyIndex)
    invariant(
      (await session.indexGet("file-hashes", `${base}.json`)) === digest(raw),
      "STORAGE_INDEX_STALE",
      "Файл отношений изменён вне Core. Выполните storage reindex",
      4,
    );
  const record = ownerSchema.parse(raw);
  invariant(
    entityAddress(record.owner) === entityAddress(owner),
    "INVALID_DATA",
    "Неверный владелец набора связей",
    5,
  );
  const entries: Entry[] = [];
  const files: string[] = [];
  if (record.storage === "inline") entries.push(...record.entries);
  else
    for (const [prefix, hash] of Object.entries(record.segments)) {
      const path = `${base}/${prefix}.json`;
      const rawShard = await session.readFile(path);
      if (verifyIndex)
        invariant(
          rawShard !== null && (await session.indexGet("file-hashes", path)) === digest(rawShard),
          "STORAGE_INDEX_STALE",
          "Сегмент отношений изменён вне Core. Выполните storage reindex",
          4,
        );
      const shard = shardSchema.parse(rawShard);
      invariant(
        digest(json(shard)) === hash &&
          entityAddress(shard.owner) === entityAddress(owner) &&
          shard.entries.every((entry) => keyHash(entry.edge.id).startsWith(prefix)),
        "INVALID_DATA",
        "Сегмент набора связей повреждён",
        5,
      );
      entries.push(...shard.entries);
      files.push(path);
    }
  invariant(
    new Set(entries.map((entry) => entry.edge.id)).size === entries.length,
    "INVALID_DATA",
    "Повтор ID в наборе связей",
    5,
  );
  return { entries, files };
}

/** Адресное чтение открывает только манифест и нужный сегмент, проверяя производный отпечаток. */
export async function readOwnedEntry(
  session: StorageSession,
  owner: EntityRef,
  id: string,
): Promise<Entry> {
  const base = address(session, owner);
  const read = async (path: string) => {
    const value = await session.readFile(path);
    invariant(value, "STORAGE_INDEX_CORRUPT", "Потерян постоянный файл отношения", 5, { path });
    invariant(
      (await session.indexGet("file-hashes", path)) === digest(value),
      "STORAGE_INDEX_STALE",
      "Файл отношений изменён вне Core. Выполните storage reindex",
      4,
      { path },
    );
    return value;
  };
  const record = ownerSchema.parse(await read(`${base}.json`));
  invariant(
    entityAddress(record.owner) === entityAddress(owner),
    "INVALID_DATA",
    "Неверный владелец отношений",
    5,
  );
  let entries: Entry[];
  if (record.storage === "inline") entries = record.entries;
  else {
    const prefixes = Object.keys(record.segments).filter((prefix) =>
      keyHash(id).startsWith(prefix),
    );
    invariant(
      prefixes.length === 1,
      "STORAGE_INDEX_CORRUPT",
      "Потерян или неоднозначен сегмент отношения",
      5,
    );
    const prefix = prefixes[0]!;
    const raw = await read(`${base}/${prefix}.json`);
    invariant(
      digest(raw) === record.segments[prefix],
      "INVALID_DATA",
      "Повреждён сегмент отношений",
      5,
    );
    const shard = shardSchema.parse(raw);
    invariant(
      entityAddress(shard.owner) === entityAddress(owner) &&
        shard.entries.every((entry) => keyHash(entry.edge.id).startsWith(prefix)),
      "INVALID_DATA",
      "Сегмент принадлежит другому владельцу или диапазону",
      5,
    );
    entries = shard.entries;
  }
  const selected = entries.filter((entry) => entry.edge.id === id);
  invariant(
    selected.length === 1,
    "STORAGE_INDEX_CORRUPT",
    "Индекс указывает на потерянное или повторное отношение",
    5,
  );
  return selected[0]!;
}

async function saveOwned(
  session: StorageSession,
  owner: EntityRef,
  entries: Entry[],
  previousFiles: string[],
) {
  const base = address(session, owner);
  entries.sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const inline = { schemaVersion: 1 as const, owner, storage: "inline" as const, entries };
  const files = new Map<string, z.infer<typeof shardSchema>>();
  if (
    entries.length <= MAX_INLINE &&
    Buffer.byteLength(JSON.stringify(inline, null, 2)) < MAX_BYTES
  ) {
    await session.writeFile(`${base}.json`, json(inline));
  } else {
    const partition = (items: Entry[], prefix: string) => {
      const shard = { schemaVersion: 1 as const, owner, entries: items };
      if (
        prefix &&
        items.length <= MAX_INLINE &&
        Buffer.byteLength(JSON.stringify(shard, null, 2)) < MAX_BYTES
      ) {
        files.set(`${base}/${prefix}.json`, shard);
        return;
      }
      invariant(
        prefix.length < 64,
        "STORAGE_LIMIT_EXCEEDED",
        "Связь не помещается в сегмент владельца",
        4,
      );
      const groups = new Map<string, Entry[]>();
      for (const item of items) {
        const key = keyHash(item.edge.id).slice(0, prefix.length + 1);
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
      for (const [key, group] of groups) partition(group, key);
    };
    partition(entries, "");
    const segments: Record<string, string> = {};
    for (const [path, shard] of files) {
      await session.writeFile(path, json(shard));
      segments[path.slice(base.length + 1, -5)] = digest(json(shard));
    }
    await session.writeFile(`${base}.json`, {
      schemaVersion: 1,
      owner,
      storage: "segments",
      segments,
    });
  }
  for (const path of previousFiles) if (!files.has(path)) await session.writeFile(path, null);
}

/**
 * Непустые корни индексов, которые `indexEntry` создаёт для ребра: `edges` — всегда,
 * `adjacency` — только для активного (неактивное снимается с соседства). Явная диагностика
 * обслуживания выводит из этого обязательность корней; пустой корректный индекс не потерян.
 */
export function edgeIndexRoots(active: boolean): readonly string[] {
  return active ? ["edges", "adjacency"] : ["edges"];
}

async function indexEntry(session: StorageSession, owner: EntityRef, entry: Entry) {
  const { edge, slot } = entry;
  const existing = await session.indexGet("edges", edge.id);
  if (existing !== undefined) {
    const prior = z.object({ owner: entityRefSchema, slot: z.string() }).parse(existing);
    invariant(
      entityAddress(prior.owner) === entityAddress(owner) && prior.slot === slot,
      "RELATION_ID_CONFLICT",
      "ID связи занят другим владельцем или назначением",
      4,
    );
  }
  if (edge.active)
    for (const ref of [edge.from, edge.to])
      invariant(
        await session.indexGet("cards", entityAddress(ref)),
        "INVALID_REFERENCE",
        "Активная связь ссылается на отсутствующую сущность",
        4,
      );
  session.indexSet("edges", edge.id, {
    owner,
    slot,
    active: edge.active,
    id: edge.id,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    revision: edge.revision,
    hash: digest(json(edge)),
  });
  for (const ref of new Set([entityAddress(edge.from), entityAddress(edge.to)]))
    await session.addPosting("adjacency", ref, edge.id, !edge.active);
}

/** Явный шаг бекенда после записи продуктовых линков; чтение никогда не вызывает этот метод. */
export async function replaceOwnedRelations(
  session: StorageSession,
  owner: EntityRef,
  slot: string,
  desired: readonly DesiredRelation[],
  actor: string,
): Promise<string[]> {
  entrySchema.shape.slot.parse(slot);
  actorSchema.parse(actor);
  await session.get(owner);
  const previous = await readOwned(session, owner);
  const entries = structuredClone(previous.entries);
  const beforeById = new Map(previous.entries.map((entry) => [entry.edge.id, entry]));
  const byId = new Map(entries.map((entry) => [entry.edge.id, entry]));
  const candidates = new Map<string, Entry[]>();
  const positions = new Map<string, number>();
  for (const entry of entries)
    if (entry.slot === slot && entry.edge.active) {
      const key = signature(entry.edge);
      const group = candidates.get(key) ?? [];
      group.push(entry);
      candidates.set(key, group);
    }
  const used = new Set<string>();
  const result: string[] = [];
  const at = new Date().toISOString();
  for (const raw of desired) {
    const input = desiredRelationSchema.parse(raw);
    let entry = input.id ? byId.get(input.id) : undefined;
    if (!input.id) {
      const key = signature(input);
      const group = candidates.get(key) ?? [];
      let position = positions.get(key) ?? 0;
      while (position < group.length && used.has(group[position]!.edge.id)) position++;
      entry = group[position];
      positions.set(key, position + 1);
    }
    invariant(
      !input.id || (entry?.slot === slot && entry.edge.active),
      "RELATION_NOT_OWNED",
      "Указанная связь не принадлежит активной группе владельца",
      4,
    );
    if (entry) {
      invariant(
        !used.has(entry.edge.id),
        "INVALID_ARGUMENT",
        "Повтор ID связи в желаемом наборе",
        4,
      );
      invariant(
        signature(entry.edge) === signature(input),
        "IMMUTABLE_RELATION_ENDPOINTS",
        "Для изменения типа или концов отзовите связь и создайте новую",
        4,
      );
      if (entry.edge.description.join("\n") !== input.description) {
        entry.edge.description = input.description.split("\n");
        entry.edge.historyCount = (entry.edge.historyCount ?? entry.edge.revision) + 1;
        entry.edge.revision++;
        entry.edge.updatedAt = at;
        entry.edge.updatedBy = actor;
      }
    } else {
      let id = randomUUID();
      while ((await session.indexGet("edges", id)) !== undefined || byId.has(id)) id = randomUUID();
      entry = {
        slot,
        edge: {
          ...input,
          id,
          description: input.description.split("\n"),
          revision: 1,
          source: "graph",
          createdAt: at,
          createdBy: actor,
          active: true,
          updatedAt: at,
          updatedBy: actor,
        },
      };
      entries.push(entry);
      byId.set(id, entry);
    }
    used.add(entry.edge.id);
    result.push(entry.edge.id);
  }
  for (const entry of entries)
    if (entry.slot === slot && entry.edge.active && !used.has(entry.edge.id)) {
      entry.edge.active = false;
      entry.edge.historyCount = (entry.edge.historyCount ?? entry.edge.revision) + 1;
      entry.edge.revision++;
      entry.edge.updatedAt = at;
      entry.edge.updatedBy = actor;
    }
  let changed = false;
  for (const entry of entries) {
    const before = beforeById.get(entry.edge.id);
    if (before && digest(json(before)) === digest(json(entry))) continue;
    changed = true;
    await indexEntry(session, owner, entry);
    for (const ref of [owner, entry.edge.from, entry.edge.to])
      session.touched.add(entityAddress(ref));
  }
  if (changed) await saveOwned(session, owner, entries, previous.files);
  return result;
}

export function publicRelation(entry: Entry): GraphEdge {
  const { id, type, from, to, description, revision, source, createdAt, createdBy } = entry.edge;
  return {
    id,
    type,
    from,
    to,
    description: description.join("\n"),
    revision,
    source,
    createdAt,
    createdBy,
  };
}

/** Запись диагностических и переносимых отношений с сохранением их собственных ID и владельца. */
export async function writeOwnedRelations(
  session: StorageSession,
  owner: EntityRef,
  updates: Entry[],
): Promise<void> {
  const previous = await readOwned(session, owner);
  const entries = new Map(previous.entries.map((entry) => [entry.edge.id, entry]));
  for (const raw of updates) {
    const entry = entrySchema.parse(raw);
    const before = entries.get(entry.edge.id);
    invariant(
      !before || (before.slot === entry.slot && signature(before.edge) === signature(entry.edge)),
      "RELATION_ID_CONFLICT",
      "ID связи нельзя передать другому назначению или концам",
      4,
    );
    entries.set(entry.edge.id, entry);
    await indexEntry(session, owner, entry);
  }
  await saveOwned(session, owner, [...entries.values()], previous.files);
}

/** Перестроение читает сохранённые наборы; продуктовые поля не являются источником рёбер. */
export async function rebuildOwnedRelations(session: StorageSession) {
  const directory = join(session.store.root, "relations");
  session.store.metrics.directoryReads++;
  for (const collection of await directories(directory)) {
    if (collection === ".indexes") continue;
    const definition = session.store.registry
      .definitions()
      .find((entry) => entry.collection === collection);
    if (!definition) {
      invariant(
        !(await hasRecords(join(directory, collection))),
        "UNKNOWN_ENTITY_KIND",
        "Владелец набора связей не зарегистрирован",
        4,
      );
      continue;
    }
    session.store.metrics.directoryReads++;
    for (const filename of await jsonFiles(join(directory, collection))) {
      const owner = { kind: definition.kind, id: filename.slice(0, -5) };
      const record = await readOwned(session, owner, false);
      for (const path of [`${address(session, owner)}.json`, ...record.files])
        session.indexSet("file-hashes", path, digest((await session.readFile(path))!));
      for (const entry of record.entries) await indexEntry(session, owner, entry);
    }
  }
}

async function hasRecords(directory: string): Promise<boolean> {
  if ((await jsonFiles(directory)).length) return true;
  for (const child of await directories(directory))
    if (await hasRecords(join(directory, child))) return true;
  return false;
}
