import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { storedCommentSchema, storedPlanningEventSchema, storedKeySpaceSchema } from "@relay/contracts/storage";
import type { StoredRecord, StoredReceipt, JsonValue } from "@relay/contracts/storage";
import { entityRefSchema, entityAddress } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { readUnifiedMigrationSources } from "./unified-sources.js";
import type { UnifiedMigrationOperation } from "./unified-sources.js";
import { StorageSession } from "../entity-store/store.js";
import type { EntityStore } from "../entity-store/store.js";
import { StorageTransaction } from "../entity-store/transaction.js";
import { EMPTY_STATE, digest, jsonValue, RECORD_BYTES } from "../entity-store/format.js";
import { directories, jsonFiles, readJson } from "../files.js";
import { invariant } from "../../shared/errors.js";
import { prepareOrphanPlanningApproval, assertNoOrphanPlanningReferences } from "./orphan-planning-approval.js";
import type { StorageMigrationOptions } from "./orphan-planning-approval.js";

/** Прямой перенос v1/v2: источники читаются, но никогда не переиздаются промежуточным журналом. */
export async function migrateUnifiedStorage(store: EntityStore, owned: () => void, options: StorageMigrationOptions = {}) {
  const source = await readUnifiedMigrationSources(store.root, owned);
  const old = new StorageSession(store, await store.state(), false);
  for (const [path, hash] of await old.indexEntries("file-hashes")) {
    if (!/^(entities|relations|keyspaces)\//.test(path)) continue;
    const raw = await old.readFile(path);
    invariant(raw !== null, "STORAGE_INDEX_CORRUPT", "Потерян ожидаемый постоянный файл", 5, { path });
    invariant(digest(raw) === hash, "STORAGE_INDEX_STALE", "Постоянный файл изменён вне Core", 4, { path });
  }
  const next = new StorageSession(store, structuredClone(EMPTY_STATE), true);
  const records = new Map<string, StoredRecord>();
  const manifest = z.object({ format: z.literal("relay-entities"), productId: z.string().optional() }).parse(await readJson(join(store.root, "storage.json")));
  const collections = await directories(join(store.root, "entities"));
  invariant(collections.every((collection) => store.registry.definitions().some((entry) => entry.collection === collection)),
    "UNKNOWN_ENTITY_KIND", "Неизвестная коллекция; перенос остановлен", 4);
  for (const definition of store.registry.definitions()) {
    for (const filename of await jsonFiles(join(store.root, "entities", definition.collection))) {
      const path = `entities/${definition.collection}/${filename}`;
      const raw = jsonValue(await readJson(join(store.root, path), RECORD_BYTES));
      invariant(await old.indexGet("file-hashes", path) === digest(raw), "STORAGE_INDEX_STALE", "Исходная сущность изменена вне Core", 4, { path });
      const wrapper = z.object({ schemaVersion: z.literal(1) }).passthrough().parse(raw);
      const record = store.registry.validate({ ...wrapper, schemaVersion: 2, receipts: [] });
      invariant(store.registry.path(record) === path, "INVALID_DATA", "Неверный ID-путь сущности", 5, { path });
      records.set(entityAddress(record), record);
    }
  }
  const projects = [...records.values()].filter((record) => record.kind === "project");
  const fallback = () => {
    invariant(projects.length === 1, "STORAGE_MIGRATION_CONFLICT", "Неоднозначная прежняя квитанция требует единственного проекта-владельца", 4);
    return projects[0]!;
  };
  const target = (ref: EntityRef) => {
    const record = records.get(entityAddress(ref));
    invariant(record, "STORAGE_MIGRATION_CONFLICT", "Прежние данные ссылаются на потерянного владельца", 4, { ref });
    return record;
  };
  const ownerOf = (operation: UnifiedMigrationOperation): StoredRecord => {
    const result = z.object({ ref: entityRefSchema.optional(), id: z.string().optional() }).safeParse(operation.result);
    if (result.success && result.data.ref && records.has(entityAddress(result.data.ref))) return target(result.data.ref);
    if (result.success && result.data.id) {
      const candidates = [...records.values()].filter((record) => record.id === result.data.id);
      if (candidates.length === 1) return candidates[0]!;
    }
    if (operation.refs.length === 1 && records.has(entityAddress(operation.refs[0]!))) return target(operation.refs[0]!);
    return fallback();
  };
  const identity = (receipt: StoredReceipt) => JSON.stringify([receipt.namespace, receipt.actor, receipt.requestId]);
  const addReceipt = (owner: StoredRecord, receipt: StoredReceipt) => {
    const old = owner.receipts.find((entry) => identity(entry) === identity(receipt));
    invariant(!old || digest(jsonValue(old)) === digest(jsonValue(receipt)), "IDEMPOTENCY_CONFLICT", "Конфликт прежних квитанций", 4);
    if (!old) owner.receipts.push(receipt);
  };
  const compatible = (owner: StoredRecord, namespace: string, key: string, value: JsonValue) => addReceipt(owner, {
    namespace: `legacy:${namespace}`, actor: "relay", requestId: digest(key), requestHash: digest(value), result: { key, value },
  });
  const approval = await prepareOrphanPlanningApproval(options.orphanPlanning, source, records, old);
  for (const operation of source.operations) {
    const owner = approval?.operationIds.has(operation.id) ? approval.project : ownerOf(operation);
    addReceipt(owner, { namespace: operation.namespace, actor: operation.actor, requestId: operation.requestId,
      requestHash: operation.requestHash, result: operation.result });
    for (const event of operation.indexed) {
      if (event.index === "record-audit") {
        if (approval?.discard(operation, event)) continue;
        const [kind, id] = event.key.split(":");
        const record = target(entityRefSchema.parse({ kind, id }));
        const value = z.discriminatedUnion("type", [
          z.object({ type: z.literal("receipt"), key: z.string(), value: z.json() }),
          z.object({ type: z.literal("event"), value: z.json() }),
        ]).parse(event.value);
        if (value.type === "receipt") compatible(record, `record:${entityAddress(record)}`, value.key, value.value);
        else if (kind === "work-plan" || kind === "release") {
          const planning = storedPlanningEventSchema.parse(value.value);
          record.planningEvents ??= [];
          if (!record.planningEvents.some((entry) => digest(jsonValue(entry)) === digest(jsonValue(planning)))) record.planningEvents.push(planning);
        }
      } else if (event.index === "task-activity-event") {
        const value = z.object({ taskId: z.string(), sequence: z.number().int().positive(), action: z.string() }).parse(event.value);
        const record = target({ kind: "task", id: value.taskId });
        record.commentSequence = Math.max(record.commentSequence ?? 0, value.sequence);
        if (value.action === "comment-publish") {
          const comment = storedCommentSchema.parse(event.value);
          record.comments ??= [];
          const prior = record.comments.find((entry) => entry.id === comment.id);
          invariant(!prior || digest(jsonValue(prior)) === digest(jsonValue(comment)), "STORAGE_MIGRATION_CONFLICT", "Разные комментарии имеют один ID", 4);
          if (!prior) record.comments.push(comment);
        }
      } else if (["graph-receipt", "deletion-receipt", "task-comment-receipt"].includes(event.index)) {
        const value = z.object({ result: z.object({ ref: entityRefSchema.optional(), id: z.string().optional() }) }).safeParse(event.value);
        const ref = value.success ? value.data.result.ref ?? (event.index === "task-comment-receipt" && value.data.result.id ? { kind: "task", id: value.data.result.id } : undefined) : undefined;
        compatible(ref && records.has(entityAddress(ref)) ? target(ref) : owner, event.index, event.key, event.value);
      } else if (event.index === "reserved-key") {
        const record = fallback();
        record.reservedKeys = [...new Set([...(record.reservedKeys ?? []), event.key])];
      } else invariant(["graph-event", "graph-baseline"].includes(event.index), "STORAGE_MIGRATION_CONFLICT", "Неизвестное значение прежнего журнала; перенос остановлен", 4, { index: event.index });
    }
  }
  for (const [key] of await old.indexEntries("reserved-key")) {
    const record = fallback();
    record.reservedKeys = [...new Set([...(record.reservedKeys ?? []), key])];
  }
  for (const record of records.values()) {
    record.comments?.sort((a, b) => a.sequence - b.sequence);
    record.planningEvents?.sort((a, b) => a.revision - b.revision || a.at.localeCompare(b.at));
    store.registry.validate(record);
    await next.writeFile(store.registry.path(record), jsonValue(record));
    await next.indexRecord(record);
  }
  for (const filename of await jsonFiles(join(store.root, "keyspaces"))) {
    const path = `keyspaces/${filename}`;
    const raw = jsonValue(await readJson(join(store.root, path), RECORD_BYTES));
    storedKeySpaceSchema.parse(raw);
    invariant(await old.indexGet("file-hashes", path) === digest(raw), "STORAGE_INDEX_STALE", "Пространство ключей изменено вне Core", 4, { path });
    next.indexSet("file-hashes", path, digest(raw));
  }
  await next.rebuildRelations();
  if (approval) await assertNoOrphanPlanningReferences(next, approval.owners);
  const orphanPlanning = approval?.report();
  for (const file of source.sourceFiles) {
    invariant(digest((await next.readFile(file.path))!) === file.hash, "STORAGE_WRITE_CONFLICT", "Источник изменён после извлечения", 5, { path: file.path });
    await next.writeFile(file.path, null);
  }
  await next.writeFile("storage.json", jsonValue({ ...manifest, schemaVersion: 3 }));
  const expected = new Map(source.files.map((file) => [file.path, file.hash]));
  for (const [path, raw] of old.originals) if (raw !== null) expected.set(path, digest(raw));
  for (const [path, hash] of expected) {
    owned();
    const raw = jsonValue(await readJson(join(store.root, path), RECORD_BYTES));
    invariant(digest(raw) === hash, "STORAGE_WRITE_CONFLICT", "Источник изменён во время подготовки переноса", 5, { path });
  }
  const changes = (await next.prepare(randomUUID())).map((change) => expected.has(change.path)
    ? { ...change, before: expected.get(change.path)! } : change);
  if (approval) for (const path of approval.absentPaths) changes.push({ path, before: null, after: null });
  await new StorageTransaction(store.root, store.probe).publish(changes, owned);
  next.index.published();
  store.formatVersion = 3;
  return { migrated: true, format: "relay-entities", schemaVersion: 3, entities: records.size, operations: source.operations.length,
    ...(orphanPlanning ? { orphanPlanning } : {}) };
}
