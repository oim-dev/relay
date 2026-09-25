import { z } from "zod";
import { entityAddress } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue } from "@relay/contracts/storage";
import { createEntityStorageRegistry } from "./entity-store/codecs.js";
import type { EntityRecord } from "./entity-store/registry.js";
import { EntityStorageRegistry } from "./entity-store/registry.js";
import type { StorageSession } from "./entity-store/store.js";
import { digest, jsonValue } from "./entity-store/format.js";
import type { Workspace } from "./workspace.js";
import { invariant } from "../shared/errors.js";
import { productRecordSchema } from "../domain/product.js";
import type { ProductRecord } from "../domain/product.js";
import { productImplementationSchema } from "../domain/product-implementation.js";
import type { ProductImplementation } from "../domain/product-implementation.js";
import { boardTaskRecordSchema } from "../domain/board-task.js";
import type { BoardTaskRecord } from "../domain/board-task.js";
import { boardSchema, defaultBoardPrefix } from "../domain/board.js";
import type { Board } from "../domain/board.js";
import { storedProjectSettingsSchema } from "../domain/project-settings.js";
import type { Config } from "../domain/config.js";
import { productIdSchema } from "../domain/product.js";

/** Состав сохраняет собственные ID, ревизию и историю, но не получает искусственный публичный ключ. */
export function workspaceStorageRegistry() {
  const definitions = createEntityStorageRegistry()
    .definitions()
    .map((definition) =>
      definition.kind === "project"
        ? {
            ...definition,
            indexes: (record: EntityRecord) => [
              {
                index: "configuration",
                key: "project",
                value: json({
                  ...record.data,
                  version: 3,
                  revision: record.revision,
                  entityKey: record.key,
                  aliases: record.aliases,
                }),
              },
            ],
          }
        : definition,
    );
  return new EntityStorageRegistry([
    ...definitions,
    {
      kind: "scope",
      collection: "scopes",
      dataVersion: 1,
      addressable: false,
      schema: z.strictObject({
        applicationId: productIdSchema,
        implementations: z.array(productIdSchema),
      }),
      encode: (data) => jsonValue(data) as Record<string, JsonValue>,
      decode: (data) => data,
      card: () => ({ title: "Состав приложения", status: "", selectors: [] }),
    },
  ]);
}

export const json = (value: unknown): JsonValue => jsonValue(JSON.parse(JSON.stringify(value)));
const auditSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), value: z.json() }),
  z.object({ type: z.literal("receipt"), key: z.string(), value: z.json() }),
]);
type Audit = { events: unknown[]; requests: Record<string, unknown> };
const audits = new WeakMap<StorageSession, Map<string, Audit>>();

export function session(workspace: Workspace): StorageSession {
  invariant(
    workspace.storageSession,
    "STORAGE_SESSION_REQUIRED",
    "Операция требует общей сессии хранилища",
    5,
  );
  return workspace.storageSession;
}

/** Совместимое предметное представление истории; текущий файл сущности не содержит растущих массивов. */
export async function readAudit(workspace: Workspace, ref: EntityRef): Promise<Audit> {
  const tx = session(workspace),
    address = entityAddress(ref);
  let cache = audits.get(tx);
  if (!cache) audits.set(tx, (cache = new Map()));
  const cached = cache.get(address);
  if (cached) return structuredClone(cached);
  const result: Audit = { events: [], requests: {} };
  for (const key of await tx.postings("record-audit-keys", address)) {
    const value = auditSchema.parse(await tx.value("record-audit", key));
    if (value.type === "event") result.events.push(value.value);
    else result.requests[value.key] = value.value;
  }
  result.events.sort((left, right) => {
    const a = left as { revision: number; at: string },
      b = right as { revision: number; at: string };
    return a.revision - b.revision || a.at.localeCompare(b.at);
  });
  cache.set(address, result);
  return structuredClone(result);
}

export async function saveAudit(
  workspace: Workspace,
  ref: EntityRef,
  events: readonly unknown[],
  requests: Record<string, unknown>,
) {
  const tx = session(workspace),
    address = entityAddress(ref);
  const groups = [{ index: "record-audit-keys", key: address }];
  for (const event of events) {
    const value = json(event);
    await tx.appendValue(
      "record-audit",
      `${address}:event:${digest(value)}`,
      { type: "event", value },
      groups,
    );
  }
  for (const [key, receipt] of Object.entries(requests))
    await tx.appendValue(
      "record-audit",
      `${address}:receipt:${key}`,
      { type: "receipt", key, value: json(receipt) },
      groups,
    );
  audits.get(tx)?.delete(address);
}

function metadata(
  record: {
    id: string;
    revision: number;
    key?: string | null | undefined;
    createdAt: string;
    createdBy: string;
    updatedAt?: string | undefined;
    updatedBy?: string | undefined;
    reservedKeys?: string[] | undefined;
    aliases?: string[] | undefined;
  },
  kind: string,
  data: Record<string, unknown>,
): EntityRecord {
  return {
    schemaVersion: 1,
    dataVersion: 1,
    kind,
    id: record.id,
    revision: record.revision,
    key: record.key ?? null,
    aliases: record.reservedKeys ?? record.aliases ?? [],
    data: json(data) as Record<string, unknown>,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt ?? record.createdAt,
    updatedBy: record.updatedBy ?? record.createdBy,
  };
}

async function publish(workspace: Workspace, record: EntityRecord, importing = false) {
  const tx = session(workspace);
  if (importing) return tx.importRecord(record);
  const raw = await tx.readFile(tx.store.registry.path(record));
  if (raw) {
    const old = tx.store.registry.decode(raw);
    if (digest(json(old)) === digest(json(record))) return;
    // Назначение первого ключа и миграция оболочки не создают пользовательскую ревизию.
    if (old.revision === record.revision) {
      invariant(
        digest(json(old.data)) === digest(json(record.data)),
        "REVISION_CONFLICT",
        "Изменение данных требует новой ревизии",
        4,
      );
      await tx.writeFile(tx.store.registry.path(record), tx.store.registry.encode(record));
      await tx.indexRecord(tx.store.registry.encode(record));
      return;
    }
    await tx.put(record, old.revision);
  } else await tx.put(record, null);
}

export async function productRecords(
  workspace: Workspace,
  productId: string,
): Promise<ProductRecord[]> {
  const tx = session(workspace);
  const implementations = await implementationRecords(workspace, productId);
  const boardRecords = await boards(workspace);
  const records: ProductRecord[] = [];
  for (const kind of ["product", "feature", "scenario", "application", "document", "scope"]) {
    for (const record of await tx.records(kind)) {
      if (kind === "product" && record.revision === 0) continue;
      const { data, ...meta } = record;
      const audit = await readAudit(workspace, record);
      const fields =
        kind === "scope"
          ? {
              kind: "scope",
              applicationId: data.applicationId,
              contracts: [
                ...new Set([
                  ...(data.implementations as string[]),
                  ...implementations
                    .filter((entry) => entry.fields.applicationId === data.applicationId)
                    .map((entry) => entry.id),
                ]),
              ].map((id) => {
                const entry = implementations.find(
                  (entry) => entry.id === id && entry.fields.applicationId === data.applicationId,
                );
                invariant(
                  entry,
                  "INVALID_REFERENCE",
                  "Состав ссылается на отсутствующую реализацию",
                  4,
                );
                const { kind: _kind, applicationId: _app, ...content } = entry.fields;
                return { ...content, id: entry.id, key: entry.key, revision: entry.revision };
              }),
            }
          : {
              ...data,
              ...(kind === "application"
                ? {
                    prefix: boardRecords.find((board) => board.applicationId === record.id)?.prefix,
                  }
                : {}),
              kind: kind === "product" ? "passport" : kind,
            };
      records.push(
        productRecordSchema.parse({
          version: 1,
          productId,
          id: meta.id,
          ...(meta.key ? { key: meta.key } : {}),
          revision: meta.revision,
          fields,
          createdAt: meta.createdAt,
          createdBy: meta.createdBy,
          updatedAt: meta.updatedAt,
          updatedBy: meta.updatedBy,
          reservedKeys: meta.aliases,
          ...audit,
        }),
      );
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export async function implementationRecords(
  workspace: Workspace,
  productId: string,
): Promise<ProductImplementation[]> {
  const records = [];
  for (const record of await session(workspace).records("implementation")) {
    const audit = await readAudit(workspace, record);
    records.push(
      productImplementationSchema.parse({
        version: 1,
        productId,
        id: record.id,
        key: record.key,
        revision: record.revision,
        fields: { ...record.data, kind: "implementation" },
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        reservedKeys: record.aliases,
        ...audit,
      }),
    );
  }
  return records;
}

export async function saveImplementation(
  workspace: Workspace,
  record: ProductImplementation,
  importing = false,
) {
  const { kind: _kind, ...data } = record.fields;
  await publish(workspace, metadata(record, "implementation", data), importing);
  await saveAudit(
    workspace,
    { kind: "implementation", id: record.id },
    record.events,
    record.requests,
  );
}

export async function saveProduct(workspace: Workspace, record: ProductRecord, importing = false) {
  const tx = session(workspace);
  const kind = record.fields.kind === "passport" ? "product" : record.fields.kind;
  let data: Record<string, unknown>;
  if (record.fields.kind === "scope") {
    const applicationId = record.fields.applicationId;
    const old = new Map(
      (await implementationRecords(workspace, record.productId)).map((entry) => [entry.id, entry]),
    );
    for (const contract of record.fields.contracts) {
      const previous = old.get(contract.id);
      if (!contract.key) {
        const application = await tx.get({ kind: "application", id: applicationId });
        const board = (await boards(workspace)).find(
          (entry) => entry.applicationId === applicationId,
        );
        const prefix = `${board?.prefix ?? defaultBoardPrefix(String(application.data.slug))}-${contract.scenarioId === null ? "FI" : "SI"}`;
        const space = `${applicationId}-${contract.scenarioId === null ? "fi" : "si"}`;
        await tx.saveKeySpace({
          schemaVersion: 1,
          id: space,
          entityKind: "implementation",
          owner: { kind: application.kind, id: application.id },
          prefix,
          format: "{prefix}-{number}",
        });
        contract.key = await tx.nextKey(space);
      }
      const { id, key, revision: _revision, ...fields } = contract;
      const nextFields = { ...fields, kind: "implementation" as const, applicationId };
      const changed =
        previous !== undefined && digest(json(previous.fields)) !== digest(json(nextFields));
      const revision = previous ? previous.revision + (changed ? 1 : 0) : (contract.revision ?? 1);
      await saveImplementation(
        workspace,
        {
          version: 1,
          productId: record.productId,
          id,
          key,
          revision,
          fields: nextFields,
          createdAt: previous?.createdAt ?? record.createdAt,
          createdBy: previous?.createdBy ?? record.createdBy,
          updatedAt: changed || !previous ? record.updatedAt : previous.updatedAt,
          updatedBy: changed || !previous ? record.updatedBy : previous.updatedBy,
          events: [
            ...(previous?.events ?? []),
            ...(changed ? [{ revision, actor: record.updatedBy, at: record.updatedAt }] : []),
          ],
          requests: previous?.requests ?? {},
          reservedKeys: previous?.reservedKeys ?? [],
        },
        importing,
      );
    }
    data = { applicationId, implementations: record.fields.contracts.map((entry) => entry.id) };
  } else {
    const { kind: _kind, ...fields } = record.fields;
    data = fields;
    if (record.fields.kind === "application") delete data.prefix;
  }
  await publish(workspace, metadata(record, kind, data), importing);
  await saveAudit(workspace, { kind, id: record.id }, record.events, record.requests);
}

export async function boards(workspace: Workspace): Promise<Board[]> {
  const output: Board[] = [];
  for (const record of await session(workspace).records("board")) {
    const { scope, ...data } = record.data;
    const space = await session(workspace).readFile(`keyspaces/${record.id}.json`);
    const prefix = space ? z.object({ prefix: z.string() }).parse(space).prefix : data.prefix;
    output.push(
      boardSchema.parse({
        version: 2,
        ...data,
        kind: scope,
        prefix,
        id: record.id,
        key: record.key,
        aliases: record.aliases,
        revision: record.revision,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        ...(await readAudit(workspace, record)),
      }),
    );
  }
  return output;
}

export async function saveBoard(workspace: Workspace, record: Board, importing = false) {
  const prefix = record.prefix ?? defaultBoardPrefix(record.slug);
  await publish(
    workspace,
    metadata(
      {
        ...record,
        key: record.key ?? `BOARD-${prefix}`,
        updatedAt: record.events?.at(-1)?.at ?? record.createdAt,
        updatedBy: record.events?.at(-1)?.actor ?? record.createdBy,
      },
      "board",
      { slug: record.slug, scope: record.kind, applicationId: record.applicationId },
    ),
    importing,
  );
  await session(workspace).saveKeySpace({
    schemaVersion: 1,
    id: record.id,
    entityKind: "task",
    owner: { kind: "board", id: record.id },
    prefix,
    format: "{prefix}-{number}",
  });
  if (record.applicationId)
    for (const suffix of ["fi", "si"])
      await session(workspace).saveKeySpace({
        schemaVersion: 1,
        id: `${record.applicationId}-${suffix}`,
        entityKind: "implementation",
        owner: { kind: "application", id: record.applicationId },
        prefix: `${prefix}-${suffix.toUpperCase()}`,
        format: "{prefix}-{number}",
      });
  await saveAudit(
    workspace,
    { kind: "board", id: record.id },
    record.events ?? [],
    record.requests ?? {},
  );
}

function taskRequests(requests: Record<string, unknown>, encode: boolean): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(requests).map(([key, value]) => {
      const receipt = structuredClone(value) as {
        result: { task?: { description: string | string[] } };
      };
      if (receipt.result.task)
        receipt.result.task.description = encode
          ? String(receipt.result.task.description).split("\n")
          : (receipt.result.task.description as string[]).join("\n");
      return [key, receipt];
    }),
  );
}

export async function tasks(workspace: Workspace): Promise<BoardTaskRecord[]> {
  const output: BoardTaskRecord[] = [];
  for (const record of await session(workspace).records("task")) {
    const audit = await readAudit(workspace, record);
    output.push(
      boardTaskRecordSchema.parse({
        ...record.data,
        version: 5,
        id: record.id,
        key: record.key,
        keys: [...record.aliases, record.key],
        revision: record.revision,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        ...audit,
        requests: taskRequests(audit.requests, false),
      }),
    );
  }
  return output;
}

export async function saveTask(workspace: Workspace, task: BoardTaskRecord, importing = false) {
  const {
    version: _version,
    id,
    key,
    keys,
    revision,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
    events,
    requests,
    ...data
  } = task;
  await publish(
    workspace,
    metadata(
      {
        id,
        key,
        revision,
        createdAt,
        createdBy,
        updatedAt,
        updatedBy,
        aliases: keys.filter((alias) => alias !== key),
      },
      "task",
      data,
    ),
    importing,
  );
  await saveAudit(workspace, { kind: "task", id }, events ?? [], taskRequests(requests, true));
}

export async function settings(workspace: Workspace) {
  const record = await session(workspace).get({
    kind: "project",
    id: workspace.config.projectId ?? "project",
  });
  return storedProjectSettingsSchema.parse({
    ...record.data,
    version: 3,
    revision: record.revision,
    entityKey: record.key,
    aliases: record.aliases,
    ...(await readAudit(workspace, record)),
  });
}

export async function saveSettings(
  workspace: Workspace,
  value: NonNullable<Config["projectSettings"]>,
  importing = false,
) {
  const id = workspace.config.projectId ?? "project",
    tx = session(workspace);
  const previous = await tx.readFile(tx.store.registry.path({ kind: "project", id }));
  const old = previous ? tx.store.registry.decode(previous) : undefined;
  const event = value.events?.at(-1),
    at = event?.at ?? new Date().toISOString();
  await publish(
    workspace,
    {
      schemaVersion: 1,
      dataVersion: 1,
      kind: "project",
      id,
      key: value.entityKey ?? "PROJECT",
      aliases: value.aliases ?? [],
      revision: value.revision,
      createdAt: old?.createdAt ?? at,
      createdBy: old?.createdBy ?? "relay",
      updatedAt: at,
      updatedBy: event?.actor ?? "relay",
      data: {
        name: value.name,
        slug: value.slug,
        ...(value.documentSections ? { documentSections: value.documentSections } : {}),
      },
    },
    importing,
  );
  await saveAudit(workspace, { kind: "project", id }, value.events ?? [], value.requests ?? {});
  workspace.config.projectSettings = value;
}

/** Оболочка квитанции сохраняет Markdown результата задачи в дисковом представлении. */
export function encodeCommandResult(namespace: string, value: unknown): JsonValue {
  if (namespace !== "board-task") return json(value);
  const wrapper = taskRequests({ result: { result: value } }, true);
  return json((wrapper.result as { result: unknown }).result);
}
export function decodeCommandResult<T>(namespace: string, value: JsonValue): T {
  if (namespace !== "board-task") return structuredClone(value) as T;
  return (taskRequests({ result: { result: value } }, false).result as { result: T }).result;
}
