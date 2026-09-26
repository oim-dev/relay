import { z } from "zod";
import { entityAddress, entityRefSchema } from "../domain/entity-graph.js";
import type { GraphEvent, GraphSaved } from "../domain/entity-graph.js";
import type { Workspace } from "./workspace.js";
import type { GraphCurrent } from "./graph-format.js";
import type { GraphSnapshot } from "./graph.js";
import type { ActivityFile } from "./task-activity.js";
import { TaskActivityRepository } from "./task-activity.js";
import { GraphIndex } from "./graph-index.js";
import { graphDigest, graphShard } from "./graph-format.js";
import type { GraphSummary } from "./graph-format.js";
import { invariant } from "../shared/errors.js";
import { digest } from "./entity-store/format.js";
import { readOwnedEntry, publicRelation, writeOwnedRelations } from "./entity-store/relations.js";
import { session, json } from "./unified-adapter.js";
import { fullContextVersion } from "./entity-store/context.js";

const ownerSchema = z.object({ owner: entityRefSchema, slot: z.string() });
const indexedEdgeSchema = ownerSchema.extend({
  id: z.string(),
  type: z.string(),
  from: entityRefSchema,
  to: entityRefSchema,
  active: z.boolean(),
  revision: z.number(),
  hash: z.string().optional(),
});
const snapshots = new WeakMap<GraphSnapshot, Map<string, z.infer<typeof indexedEdgeSchema>>>();

/** Каталог графа читается из индекса; полные записи открываются только для выбранной страницы. */
export async function openUnifiedGraph(workspace: Workspace): Promise<GraphSnapshot> {
  const tx = session(workspace);
  const records = new Map(
    (await tx.indexEntries("edges")).map(([id, value]) => [id, indexedEdgeSchema.parse(value)]),
  );
  const summaries: GraphSummary[] = [...records.values()].map((entry) => ({
    id: entry.id,
    type: entry.type,
    from: entry.from,
    to: entry.to,
    active: entry.active,
    revision: entry.revision,
    hash: entry.hash ?? graphDigest(entry),
  }));
  const revision = summaries.reduce((sum, entry) => sum + entry.revision, 0);
  const shards = new Map<string, GraphSummary[]>();
  for (const entry of summaries) {
    const key = graphShard(entry.id);
    shards.set(key, [...(shards.get(key) ?? []), entry]);
  }
  const index = new GraphIndex(
    {
      schemaVersion: 1,
      revision,
      shards: Object.fromEntries(
        [...shards]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entries]) => [
            key,
            {
              hash: graphDigest(entries.sort((a, b) => a.id.localeCompare(b.id))),
              count: entries.length,
            },
          ]),
      ),
    },
    summaries,
  );
  const snapshot: GraphSnapshot = {
    index,
    meta: {
      schemaVersion: 2,
      revision,
      eventCount: 0,
      indexFingerprint: index.fingerprint,
    },
  };
  snapshots.set(snapshot, records);
  return snapshot;
}

export async function unifiedGraphRecord(
  workspace: Workspace,
  snapshot: GraphSnapshot,
  id: string,
): Promise<GraphCurrent | undefined> {
  const pointer = snapshots.get(snapshot)?.get(id);
  if (!pointer) return undefined;
  const entry = await readOwnedEntry(session(workspace), pointer.owner, id);
  invariant(
    entry.slot === pointer.slot &&
      entry.edge.active === pointer.active &&
      entry.edge.revision === pointer.revision &&
      entry.edge.type === pointer.type &&
      entityAddress(entry.edge.from) === entityAddress(pointer.from) &&
      entityAddress(entry.edge.to) === entityAddress(pointer.to),
    "STORAGE_INDEX_STALE",
    "Индекс отношения не соответствует сохранённой записи",
    4,
  );
  invariant(
    pointer.hash === undefined || pointer.hash === digest(json(entry.edge)),
    "STORAGE_INDEX_STALE",
    "Содержание отношения не соответствует индексу",
    4,
  );
  return {
    active: entry.edge.active,
    historyCount: entry.edge.historyCount ?? entry.edge.revision,
    edge: publicRelation(entry),
  };
}

export async function commitUnifiedGraph(
  workspace: Workspace,
  records: GraphCurrent[],
  events: GraphEvent[],
  _key: string,
  _hash: string,
  saved: (fingerprint: string, revision: number) => GraphSaved,
  owned: () => void,
  activity: ActivityFile[] = [],
): Promise<GraphSaved> {
  const tx = session(workspace);
  const groups = new Map<
    string,
    { owner: z.infer<typeof entityRefSchema>; updates: Parameters<typeof writeOwnedRelations>[2] }
  >();
  for (const record of records) {
    const indexed = await tx.indexGet("edges", record.edge.id);
    const binding = indexed
      ? ownerSchema.parse(indexed)
      : { owner: record.edge.from, slot: "diagnostic" };
    const address = entityAddress(binding.owner);
    const group = groups.get(address) ?? { owner: binding.owner, updates: [] };
    const event = events.findLast((event) => event.edge.id === record.edge.id);
    group.updates.push({
      slot: binding.slot,
      edge: {
        ...record.edge,
        description: record.edge.description.split("\n"),
        active: record.active,
        historyCount: record.historyCount,
        updatedAt: event?.at ?? record.edge.createdAt,
        updatedBy: event?.actor ?? record.edge.createdBy,
      },
    });
    groups.set(address, group);
  }
  for (const group of groups.values()) await writeOwnedRelations(tx, group.owner, group.updates);
  await new TaskActivityRepository(workspace).publish(activity, owned);
  const snapshot = await openUnifiedGraph(workspace);
  const result = saved(snapshot.index.fingerprint, snapshot.meta.revision);
  result.version = await fullContextVersion(tx);
  return result;
}
