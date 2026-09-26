import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { storedCommentSchema, storedKeySpaceSchema } from "@relay/contracts/storage";
import type { StoredRecord } from "@relay/contracts/storage";
import { entityAddress } from "@relay/contracts/entities/graph";
import { readUnifiedMigrationSources } from "./unified-sources.js";
import { StorageSession } from "../entity-store/store.js";
import type { EntityStore } from "../entity-store/store.js";
import { StorageTransaction } from "../entity-store/transaction.js";
import { EMPTY_STATE, digest, jsonValue } from "../entity-store/format.js";
import { directories, jsonFiles, readJson } from "../files.js";
import { invariant } from "../../shared/errors.js";
import type { StorageMigrationOptions } from "./options.js";

/** Явный переход: сохраняются состояние и комментарии, но не результаты прежних команд. */
export async function migrateUnifiedStorage(
  store: EntityStore,
  owned: () => void,
  _options: StorageMigrationOptions = {},
) {
  const manifest = z
    .object({
      format: z.literal("relay-entities"),
      schemaVersion: z.number(),
      productId: z.string().optional(),
    })
    .parse(await readJson(join(store.root, "storage.json")));
  const source =
    manifest.schemaVersion < 3 ? await readUnifiedMigrationSources(store.root, owned) : undefined;
  const old = new StorageSession(store, await store.state(), false);
  for (const [path, hash] of await old.indexEntries("file-hashes")) {
    if (!/^(entities|relations|keyspaces)\//.test(path)) continue;
    const raw = await old.readFile(path);
    invariant(raw !== null, "STORAGE_INDEX_CORRUPT", "Потерян ожидаемый постоянный файл", 5, {
      path,
    });
    invariant(digest(raw) === hash, "STORAGE_INDEX_STALE", "Постоянный файл изменён вне Core", 4, {
      path,
    });
  }
  const next = new StorageSession(store, structuredClone(EMPTY_STATE), true);
  const records = new Map<string, StoredRecord>();
  const collections = await directories(join(store.root, "entities"));
  invariant(
    collections.every((collection) =>
      store.registry.definitions().some((entry) => entry.collection === collection),
    ),
    "UNKNOWN_ENTITY_KIND",
    "Неизвестная коллекция; перенос остановлен",
    4,
  );
  for (const definition of store.registry.definitions()) {
    for (const filename of await jsonFiles(join(store.root, "entities", definition.collection))) {
      const path = `entities/${definition.collection}/${filename}`;
      const raw = jsonValue(await readJson(join(store.root, path), Number.POSITIVE_INFINITY));
      invariant(
        (await old.indexGet("file-hashes", path)) === digest(raw),
        "STORAGE_INDEX_STALE",
        "Исходная сущность изменена вне Core",
        4,
        { path },
      );
      const wrapper = z
        .object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) })
        .passthrough()
        .parse(raw);
      const {
        receipts: _receipts,
        planningEvents: _planning,
        requests: _requests,
        events: _events,
        ...current
      } = wrapper;
      // В старой смешанной ленте пользовательское сообщение не является автоматическим аудитом.
      if (current.kind === "task") {
        const data = current.data as Record<string, unknown> | undefined;
        const comments = z.array(storedCommentSchema).parse(current.comments ?? []);
        for (const events of [_events, data?.events])
          if (Array.isArray(events)) {
            for (const event of events) {
              if (!event || typeof event !== "object" || event.action !== "comment-publish")
                continue;
              const comment = storedCommentSchema.parse({
                ...event,
                description:
                  typeof event.description === "string"
                    ? event.description.split("\n")
                    : event.description,
              });
              const prior = comments.find((entry) => entry.id === comment.id);
              invariant(
                !prior || digest(jsonValue(prior)) === digest(jsonValue(comment)),
                "STORAGE_MIGRATION_CONFLICT",
                "Разные комментарии имеют один ID",
                4,
              );
              if (!prior) comments.push(comment);
            }
          }
        if (comments.length) {
          current.comments = comments.sort((a, b) => a.sequence - b.sequence);
          current.commentSequence = Math.max(
            Number(current.commentSequence ?? 0),
            ...comments.map((comment) => comment.sequence),
          );
        }
      }
      if (current.data && typeof current.data === "object" && !Array.isArray(current.data)) {
        const {
          receipts: _r,
          requests: _q,
          events: _e,
          planningEvents: _p,
          ...data
        } = current.data as Record<string, unknown>;
        current.data = data;
      }
      const record = store.registry.validate({ ...current, schemaVersion: 3 });
      invariant(
        store.registry.path(record) === path,
        "INVALID_DATA",
        "Неверный ID-путь сущности",
        5,
        { path },
      );
      records.set(entityAddress(record), record);
    }
  }
  const project = () => {
    const projects = [...records.values()].filter((record) => record.kind === "project");
    invariant(
      projects.length === 1,
      "STORAGE_MIGRATION_CONFLICT",
      "Резерв адресов требует единственного проекта",
      4,
    );
    return projects[0]!;
  };
  for (const operation of source?.operations ?? []) {
    for (const event of operation.indexed) {
      if (event.index === "task-activity-event") {
        const value = z
          .object({ action: z.string(), taskId: z.string(), sequence: z.number().int().positive() })
          .parse(event.value);
        const owner = records.get(`task:${value.taskId}`);
        if (owner) owner.commentSequence = Math.max(owner.commentSequence ?? 0, value.sequence);
        if (value.action !== "comment-publish") continue;
        const comment = storedCommentSchema.parse(event.value);
        const record = records.get(`task:${comment.taskId}`);
        invariant(
          record,
          "STORAGE_MIGRATION_CONFLICT",
          "Потерян владелец пользовательского комментария",
          4,
        );
        record.comments ??= [];
        const prior = record.comments.find((entry) => entry.id === comment.id);
        invariant(
          !prior || digest(jsonValue(prior)) === digest(jsonValue(comment)),
          "STORAGE_MIGRATION_CONFLICT",
          "Разные комментарии имеют один ID",
          4,
        );
        if (!prior) record.comments.push(comment);
        record.commentSequence = Math.max(record.commentSequence ?? 0, comment.sequence);
      } else if (event.index === "reserved-key") {
        const record = project();
        record.reservedKeys = [...new Set([...(record.reservedKeys ?? []), event.key])];
      }
    }
  }
  for (const [key] of await old.indexEntries("reserved-key")) {
    const record = project();
    record.reservedKeys = [...new Set([...(record.reservedKeys ?? []), key])];
  }
  for (const record of records.values()) {
    record.comments?.sort((a, b) => a.sequence - b.sequence);
    store.registry.validate(record);
    await next.writeFile(store.registry.path(record), jsonValue(record));
    await next.indexRecord(record);
  }
  for (const filename of await jsonFiles(join(store.root, "keyspaces"))) {
    const path = `keyspaces/${filename}`;
    const raw = jsonValue(await readJson(join(store.root, path)));
    storedKeySpaceSchema.parse(raw);
    next.indexSet("file-hashes", path, digest(raw));
  }
  await next.rebuildRelations();
  for (const file of source?.sourceFiles ?? []) await next.writeFile(file.path, null);
  // Старые производные страницы также содержат квитанции. Их удаление входит в тот же WAL.
  for (const shard of await directories(join(store.root, ".indexes/segments"))) {
    for (const file of await jsonFiles(join(store.root, ".indexes/segments", shard)))
      await next.writeFile(`.indexes/segments/${shard}/${file}`, null);
  }
  await next.writeFile("storage.json", jsonValue({ ...manifest, schemaVersion: 4 }));
  const expected = new Map((source?.files ?? []).map((file) => [file.path, file.hash]));
  for (const [path, raw] of old.originals) if (raw !== null) expected.set(path, digest(raw));
  for (const [path, hash] of expected) {
    owned();
    const raw = jsonValue(await readJson(join(store.root, path), Number.POSITIVE_INFINITY));
    invariant(
      digest(raw) === hash,
      "STORAGE_WRITE_CONFLICT",
      "Источник изменён во время подготовки переноса",
      5,
      { path },
    );
  }
  const changes = (await next.prepare(randomUUID())).map((change) =>
    expected.has(change.path) ? { ...change, before: expected.get(change.path)! } : change,
  );
  // Страница с тем же содержимым может использоваться новым индексом: последняя запись побеждает.
  const unique = [...new Map(changes.map((change) => [change.path, change])).values()];
  await new StorageTransaction(store.root, store.probe).publish(unique, owned);
  next.index.published();
  store.formatVersion = 4;
  return {
    migrated: true,
    format: "relay-entities",
    schemaVersion: 4,
    entities: records.size,
    operations: 0,
  };
}
