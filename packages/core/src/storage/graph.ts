import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { graphEdgeSchema } from "../domain/entity-graph.js";
import type { GraphEdge, GraphEvent, GraphSaved } from "../domain/entity-graph.js";
import { invariant } from "../shared/errors.js";
import { parse } from "../domain/validation.js";
import { directories, exists, readJson } from "./files.js";
import type { Workspace } from "./workspace.js";
import {
  GRAPH_RECORD_BYTES,
  currentPath,
  receiptPath,
  graphDigest,
  graphMetaSchema,
  graphReceiptSchema,
  decodeGraphCurrent,
  encodeGraphCurrent,
  summarizeGraphCurrent,
} from "./graph-format.js";
import type { GraphMeta, GraphCurrent, GraphReceipt, LegacyGraph } from "./graph-format.js";
import { GraphIndex, openGraphIndex } from "./graph-index.js";
import { readLegacyGraph, legacyRecords } from "./graph-migration.js";
import { GraphTransaction } from "./graph-transaction.js";
import type { GraphFileChange } from "./graph-transaction.js";
import type { ActivityFile } from "./task-activity.js";
import {
  openUnifiedGraph,
  unifiedGraphRecord,
  commitUnifiedGraph,
} from "./unified-graph.js";

export type GraphSnapshot = { meta: GraphMeta; index: GraphIndex; legacy?: LegacyGraph };

/** Раздельные постоянные записи графа; история и квитанции читаются адресно. */
export class GraphRepository {
  readonly root: string;
  readonly path: string;
  readonly legacyPath: string;
  /** Диагностика файловых чтений для нагрузочных и регрессионных проверок. */
  readonly metrics = { currentReads: 0, eventReads: 0, receiptReads: 0 };
  constructor(readonly workspace: Workspace) {
    this.root = join(dirname(workspace.configPath), "relations");
    this.path = join(this.root, "meta.json");
    this.legacyPath = join(dirname(workspace.configPath), "relations.json");
  }

  async meta(): Promise<GraphMeta> {
    if (!this.workspace.storageSession && (await this.workspace.hasUnifiedStorage()))
      return this.workspace.locked(() => this.meta());
    if (this.workspace.storageSession) return (await openUnifiedGraph(this.workspace)).meta;
    if (await exists(this.path))
      return parse(graphMetaSchema, await readJson(this.path, GRAPH_RECORD_BYTES), this.path, true);
    invariant(
      (await directories(join(this.root, "current"))).length === 0,
      "INVALID_DATA",
      "Метаданные графа потеряны; текущие связи нельзя считать пустой базой",
      5,
    );
    return {
      schemaVersion: 2,
      revision: 0,
      eventCount: 0,
      indexFingerprint: graphDigest({ schemaVersion: 1, revision: 0, shards: {} }),
    };
  }

  /** SSE читает только малые метаданные, не текущие связи, журнал или индекс. */
  async signal(): Promise<
    | GraphMeta
    | { version: string }
    | { schemaVersion: number; size: number; mtime: number; ctime: number }
  > {
    if (!this.workspace.storageSession && (await this.workspace.hasUnifiedStorage()))
      return this.workspace.locked(() => this.signal());
    if (this.workspace.storageSession)
      return { version: this.workspace.storageSession.state.version };
    if (await exists(this.legacyPath)) {
      const info = await stat(this.legacyPath);
      return { schemaVersion: 1, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs };
    }
    return this.meta();
  }

  async open(assertOwned: () => void): Promise<GraphSnapshot> {
    if (this.workspace.storageSession) return openUnifiedGraph(this.workspace);
    if (await exists(this.legacyPath)) {
      invariant(
        !(await exists(this.path)),
        "GRAPH_RECOVERY_CONFLICT",
        "Обнаружены одновременно v1 и v2 графа",
        5,
      );
      const legacy = await readLegacyGraph(this.legacyPath);
      return {
        legacy,
        meta: {
          schemaVersion: 2,
          revision: legacy.revision,
          eventCount: legacy.events.length,
          indexFingerprint: graphDigest(legacy),
        },
        index: new GraphIndex(
          { schemaVersion: 1, revision: legacy.revision, shards: {} },
          [...legacyRecords(legacy).values()].map(summarizeGraphCurrent),
        ),
      };
    }
    const meta = await this.meta();
    return { meta, index: await openGraphIndex(this.workspace, this.root, meta, assertOwned) };
  }

  async receipt(key: string): Promise<GraphReceipt | undefined> {
    invariant(/^[a-f0-9]{64}$/.test(key), "INVALID_DATA", "Некорректный адрес квитанции", 5);
    if (this.workspace.storageSession) {
      const value = await this.workspace.storageSession.compatibilityReceipt("graph-receipt", key);
      return value === undefined ? undefined : graphReceiptSchema.parse(value);
    }
    if (await exists(this.legacyPath))
      return (await readLegacyGraph(this.legacyPath)).requests[key];
    const path = join(this.root, receiptPath(key));
    if (!(await exists(path))) return undefined;
    this.metrics.receiptReads++;
    return parse(graphReceiptSchema, await readJson(path, GRAPH_RECORD_BYTES), path, true);
  }

  async get(id: string, snapshot: GraphSnapshot): Promise<GraphCurrent | undefined> {
    graphEdgeSchema.shape.id.parse(id);
    if (this.workspace.storageSession) {
      this.metrics.currentReads++;
      return unifiedGraphRecord(this.workspace, snapshot, id);
    }
    if (snapshot.legacy) return legacyRecords(snapshot.legacy).get(id);
    const entry = snapshot.index.entries.get(id);
    if (!entry) return undefined;
    this.metrics.currentReads++;
    const record = decodeGraphCurrent(
      await readJson(join(this.root, currentPath(id)), GRAPH_RECORD_BYTES),
    );
    invariant(
      record.edge.id === id && record.edge.source === "graph",
      "INVALID_DATA",
      "Неверный ID или источник связи",
      5,
    );
    invariant(
      graphDigest(encodeGraphCurrent(record)) === entry.hash,
      "GRAPH_INDEX_STALE",
      "Файл связи изменён вне Core. Выполните graph reindex в локальном режиме.",
      4,
    );
    return record;
  }

  async edge(id: string, snapshot: GraphSnapshot): Promise<GraphEdge> {
    const record = await this.get(id, snapshot);
    invariant(
      record?.active,
      "INVALID_DATA",
      "Индекс ссылается на отсутствующую активную связь",
      5,
    );
    return record.edge;
  }

  /** Подготавливает историю, квитанцию и изменённые сегменты индекса в одном журнале. */
  async commit(
    _snapshot: GraphSnapshot,
    records: GraphCurrent[],
    events: GraphEvent[],
    key: string,
    requestHash: string,
    saved: (fingerprint: string, revision: number) => GraphSaved,
    assertOwned: () => void,
    activity: ActivityFile[] = [],
  ): Promise<GraphSaved> {
    if (!this.workspace.storageSession && this.workspace.recoveringDocumentLinks) {
      // Только recovery долговечного прикрепления: сохраняем текущее состояние и квитанцию,
      // не возобновляя генерацию исторических событий и указателей на них.
      const revision = _snapshot.meta.revision + 1;
      const restored: GraphCurrent[] = [];
      const changes: GraphFileChange[] = [];
      for (const record of records) {
        const previous = await this.get(record.edge.id, _snapshot);
        const next = { ...record, historyCount: previous?.historyCount ?? 0 };
        restored.push(next);
        changes.push({ path: currentPath(record.edge.id), after: encodeGraphCurrent(next) });
      }
      const index = _snapshot.index.prepare(restored, revision);
      const result = saved(index.fingerprint, revision);
      changes.push(
        { path: receiptPath(key), after: { hash: requestHash, result } },
        ...index.changes,
        { path: "meta.json", after: { ..._snapshot.meta, revision, indexFingerprint: index.fingerprint } },
      );
      await new GraphTransaction(this.workspace).publish(changes, assertOwned);
      index.publish();
      return result;
    }
    this.workspace.assertWritableStorage();
    return commitUnifiedGraph(
        this.workspace,
        records,
        events,
        key,
        requestHash,
        saved,
        assertOwned,
        activity,
      );
  }

  /** Готовит граф для общей транзакции, не публикуя файлы или кеш индекса. */
  async prepareCommit(
    _snapshot: GraphSnapshot,
    _records: GraphCurrent[],
    _events: GraphEvent[],
    _key: string,
    _requestHash: string,
    _saved: (fingerprint: string, revision: number) => GraphSaved,
  ): Promise<{ changes: GraphFileChange[]; result: GraphSaved; publish: () => void }> {
    invariant(false, "STORAGE_MIGRATION_REQUIRED", "Прежняя запись графа отключена. Выполните storage migrate", 4);
  }

  async migrate(_assertOwned: () => void) {
    this.workspace.assertWritableStorage();
    if (this.workspace.storageSession) {
      const state = await openUnifiedGraph(this.workspace);
      return {
        migrated: false,
        revision: state.meta.revision,
        edges: state.index.active.length,
        events: state.meta.eventCount,
      };
    }
    invariant(false, "STORAGE_MIGRATION_REQUIRED", "Выполните storage migrate", 4);
  }

  async reindex(assertOwned: () => void) {
    this.workspace.assertWritableStorage();
    const session = this.workspace.storageSession;
    if (session) {
      invariant(
        !session.changed,
        "REINDEX_DURING_MUTATION",
        "Нельзя перестраивать индекс внутри изменения сущностей",
        4,
      );
      await session.store.reindex(assertOwned);
      Object.assign(session.state, await session.store.state());
      session.originals.clear();
      const snapshot = await openUnifiedGraph(this.workspace);
      return {
        revision: snapshot.meta.revision,
        edges: snapshot.index.active.length,
        events: snapshot.meta.eventCount,
      };
    }
    invariant(false, "STORAGE_MIGRATION_REQUIRED", "Выполните storage migrate", 4);
  }
}
