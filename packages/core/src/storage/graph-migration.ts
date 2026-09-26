import { dirname, join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, exists, readJson, syncDirectory } from "./files.js";
import { invariant } from "../shared/errors.js";
import { parse } from "../domain/validation.js";
import { GraphTransaction, graphParallel, publishGraphJson } from "./graph-transaction.js";
import { rebuildGraphIndex } from "./graph-index.js";
import {
  legacyGraphSchema,
  graphDigest,
  encodeGraphCurrent,
  encodeGraphEvent,
  currentPath,
  eventPath,
  receiptPath,
  historyIndexPath,
  GRAPH_RECORD_BYTES,
} from "./graph-format.js";
import type { GraphCurrent, LegacyGraph } from "./graph-format.js";
import type { Workspace } from "./workspace.js";
import type { GraphEdge, GraphEvent } from "../domain/entity-graph.js";

const migrationSchema = z.strictObject({ schemaVersion: z.literal(1), sourceHash: z.string() });

/** Читаемый v1 остаётся неизменяемым источником до окончательного переключения на v2. */
export async function readLegacyGraph(path: string): Promise<LegacyGraph> {
  const legacy = parse(legacyGraphSchema, await readJson(path, 16 * 1024 * 1024), path, true);
  invariant(
    new Set(legacy.edges.map((edge) => edge.id)).size === legacy.edges.length &&
      legacy.edges.every((edge) => edge.source === "graph") &&
      legacy.events.every((event) => event.edge.source === "graph"),
    "INVALID_DATA",
    "Некорректные ID или источники связей v1",
    5,
  );
  return legacy;
}
export function legacyRecords(legacy: LegacyGraph): Map<string, GraphCurrent> {
  const records = new Map<string, GraphCurrent>();
  for (const event of legacy.events) {
    const edge = { ...event.edge, description: event.edge.description.join("\n") };
    const count = records.get(edge.id)?.historyCount ?? 0;
    records.set(edge.id, { active: event.action !== "remove", historyCount: count + 1, edge });
  }
  const liveIds = new Set(legacy.edges.map((edge) => edge.id));
  for (const record of records.values()) record.active = liveIds.has(record.edge.id);
  for (const stored of legacy.edges) {
    const edge: GraphEdge = { ...stored, description: stored.description.join("\n") };
    records.set(edge.id, {
      active: true,
      historyCount: records.get(edge.id)?.historyCount ?? 0,
      edge,
    });
  }
  return records;
}

/** Возобновляемый перенос без нового пользовательского события или изменения ревизий. */
export async function recoverGraphMigration(
  workspace: Workspace,
  assertOwned: () => void,
): Promise<void> {
  const root = new GraphTransaction(workspace).root;
  const pending = join(root, "transactions", "migration.json");
  if (!(await exists(pending))) return;
  const migration = parse(migrationSchema, await readJson(pending), pending, true);
  const original = join(dirname(workspace.configPath), "relations.json");
  const backup = join(root, "v1-backup.json");
  const source = (await exists(original)) ? original : backup;
  const legacy = await readLegacyGraph(source);
  invariant(
    graphDigest(legacy) === migration.sourceHash,
    "GRAPH_RECOVERY_CONFLICT",
    "Исходный граф v1 изменён во время миграции; автоматическая перезапись остановлена",
    5,
  );
  const changes: { path: string; after: unknown }[] = [];
  for (const record of legacyRecords(legacy).values())
    changes.push({ path: currentPath(record.edge.id), after: encodeGraphCurrent(record) });
  const pointers = new Map<string, number[]>();
  legacy.events.forEach((stored, index) => {
    const sequence = index + 1;
    const event: GraphEvent = {
      ...stored,
      edge: { ...stored.edge, description: stored.edge.description.join("\n") },
    };
    changes.push({ path: eventPath(sequence), after: encodeGraphEvent(event, sequence) });
    const path = historyIndexPath(event.edge.id, sequence);
    const entries = pointers.get(path) ?? [];
    entries.push(sequence);
    pointers.set(path, entries);
  });
  for (const [path, sequences] of pointers)
    changes.push({ path, after: { schemaVersion: 1, sequences } });
  for (const [key, receipt] of Object.entries(legacy.requests)) {
    invariant(/^[a-f0-9]{64}$/.test(key), "INVALID_DATA", "Некорректный ключ квитанции v1", 5);
    changes.push({ path: receiptPath(key), after: receipt });
  }
  const publish = async (change: { path: string; after: unknown }) => {
    const path = join(root, change.path);
    if (change.path.startsWith(".indexes/")) {
      await publishGraphJson(path, change.after, workspace, assertOwned);
      return;
    }
    if (await exists(path)) {
      const actual = await readJson(path, GRAPH_RECORD_BYTES);
      invariant(
        graphDigest(actual) === graphDigest(change.after),
        "GRAPH_RECOVERY_CONFLICT",
        "Целевой файл миграции изменён; восстановление остановлено",
        5,
        { path: change.path },
      );
      return;
    }
    await atomicJson(path, change.after, workspace.runtime, true, assertOwned);
  };
  await graphParallel(changes, publish);
  invariant(
    graphDigest(await readLegacyGraph(source)) === migration.sourceHash,
    "GRAPH_RECOVERY_CONFLICT",
    "Источник v1 изменился во время переноса; переключение остановлено",
    5,
  );
  const meta = {
    schemaVersion: 2 as const,
    revision: legacy.revision,
    eventCount: legacy.events.length,
    indexFingerprint: graphDigest(null),
  };
  const index = await rebuildGraphIndex(workspace, root, meta, assertOwned);
  await publish({ path: "meta.json", after: { ...meta, indexFingerprint: index.fingerprint } });
  if (await exists(original)) {
    invariant(
      graphDigest(await readLegacyGraph(original)) === migration.sourceHash,
      "GRAPH_RECOVERY_CONFLICT",
      "Источник v1 изменился перед завершением миграции",
      5,
    );
    invariant(
      !(await exists(backup)),
      "GRAPH_RECOVERY_CONFLICT",
      "Резервная копия v1 уже существует",
      5,
    );
    assertOwned();
    await rename(original, backup);
    await syncDirectory(dirname(original));
    await syncDirectory(root);
  }
  assertOwned();
  await unlink(pending);
  await syncDirectory(dirname(pending));
}
