import { z } from "zod";
import { actorSchema, requestIdSchema } from "@relay/contracts/primitives";
import { entityAddress, entityRefSchema } from "@relay/contracts/entities/graph";
import { storedPlanningEventSchema } from "@relay/contracts/storage";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import { digest, hashSchema, jsonValue } from "../entity-store/format.js";
import type { StorageSession } from "../entity-store/store.js";
import type { UnifiedMigrationSources, UnifiedMigrationIndexedEvent, UnifiedMigrationOperation } from "./unified-sources.js";
import { invariant } from "../../shared/errors.js";
import { exists } from "../files.js";
import { join } from "node:path";

const ownerSchema = entityRefSchema.extend({ kind: z.enum(["work-plan", "plan-stage", "release"]) });
const eventApprovalSchema = z.strictObject({
  operationId: z.string().min(1),
  owner: ownerSchema,
  key: z.string().min(1),
  eventHash: hashSchema.describe("Отпечаток всего исходного indexed event, включая группы"),
});
const receiptApprovalSchema = z.strictObject({
  operationId: z.string().min(1),
  namespace: z.enum(["planning", "release"]),
  actor: actorSchema,
  requestId: requestIdSchema,
  requestHash: z.string().min(1),
  resultHash: hashSchema.describe("Отпечаток первоначального JSON-результата без изменения полей"),
});

/** Внутренний maintenance API: отсутствие опции никогда не означает согласия на потерю истории. */
export const storageMigrationOptionsSchema = z.strictObject({
  orphanPlanning: z.strictObject({
    projectId: entityRefSchema.shape.id,
    events: z.array(eventApprovalSchema).min(1),
    receipts: z.array(receiptApprovalSchema).min(1),
  }).optional(),
});
export type StorageMigrationOptions = z.infer<typeof storageMigrationOptionsSchema>;
export type OrphanPlanningApproval = NonNullable<StorageMigrationOptions["orphanPlanning"]>;
export type OrphanPlanningReport = { projectId: string; discardedEvents: number; preservedReceipts: number };

const eventIdentity = (operationId: string, key: string) => JSON.stringify([operationId, key]);
const receiptIdentity = (value: { namespace: string; actor: string; requestId: string }) =>
  JSON.stringify([value.namespace, value.actor, value.requestId]);

function approvedOwners(approval: OrphanPlanningApproval) {
  return new Set(approval.events.map((event) => entityAddress(event.owner)));
}

/** Не разрешаем согласованное исключение audit при сохранившихся текущих адресах или связях. */
export async function assertNoOrphanPlanningReferences(session: StorageSession, owners: ReadonlySet<string>) {
  const referencesOwner = (value: JsonValue): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(referencesOwner);
    if (typeof value.kind === "string" && typeof value.id === "string" && owners.has(`${value.kind}:${value.id}`)) return true;
    return Object.values(value).some(referencesOwner);
  };
  for (const name of ["records", "cards", "addresses", "selectors", "edges", "adjacency"]) {
    for (const [key, value] of await session.indexEntries(name))
      invariant(!owners.has(key) && !referencesOwner(value), "STORAGE_MIGRATION_CONFLICT",
        "У согласованного отсутствующего владельца сохранился текущий адрес или связь", 4, { index: name, key });
  }
}

function validateUnique(approval: OrphanPlanningApproval) {
  invariant(new Set(approval.events.map((event) => eventIdentity(event.operationId, event.key))).size === approval.events.length,
    "STORAGE_MIGRATION_CONFLICT", "В разрешении повторяется событие", 4);
  invariant(new Set(approval.receipts.map((receipt) => receipt.operationId)).size === approval.receipts.length &&
    new Set(approval.receipts.map(receiptIdentity)).size === approval.receipts.length,
    "STORAGE_MIGRATION_CONFLICT", "В разрешении повторяется квитанция", 4);
  const operations = new Set(approval.events.map((event) => event.operationId));
  invariant(operations.size === approval.receipts.length && approval.receipts.every((receipt) => operations.has(receipt.operationId)) &&
    approval.events.every((event) => event.key.startsWith(`${entityAddress(event.owner)}:event:`)),
    "STORAGE_MIGRATION_CONFLICT", "Разрешение должно точно связывать события, владельцев и квитанции", 4);
}

export async function prepareOrphanPlanningApproval(
  approval: OrphanPlanningApproval | undefined,
  source: UnifiedMigrationSources,
  records: ReadonlyMap<string, StoredRecord>,
  old: StorageSession,
) {
  if (!approval) return undefined;
  validateUnique(approval);
  const projects = [...records.values()].filter((record) => record.kind === "project");
  invariant(projects.length === 1 && projects[0]!.id === approval.projectId && !("deleted" in projects[0]!),
    "STORAGE_MIGRATION_CONFLICT", "Разрешение относится к другому или отсутствующему проекту", 4);
  const project = projects[0]!;
  const owners = approvedOwners(approval);
  for (const owner of owners) invariant(!records.has(owner), "STORAGE_MIGRATION_CONFLICT",
    "События существующей сущности или tombstone нельзя исключить этим разрешением", 4, { owner });
  await assertNoOrphanPlanningReferences(old, owners);
  const absentPaths = new Set<string>();
  const collections = { "work-plan": "work-plans", "plan-stage": "plan-stages", release: "releases" };
  for (const { owner } of approval.events) {
    const collection = old.store.registry.definitions().find((definition) => definition.kind === owner.kind)?.collection ?? collections[owner.kind];
    for (const prefix of ["entities", "relations"]) {
      const path = `${prefix}/${collection}/${owner.id}.json`;
      invariant(!(await exists(join(old.store.root, path))), "STORAGE_MIGRATION_CONFLICT",
        "Файл согласованного отсутствующего владельца всё ещё существует", 4, { path });
      absentPaths.add(path);
    }
  }
  const operations = new Map(source.operations.map((operation) => [operation.id, operation]));
  invariant(operations.size === source.operations.length, "STORAGE_MIGRATION_CONFLICT", "Повтор ID исходной операции", 4);
  const selected = new Set<string>();
  const operationIds = new Set<string>();
  for (const expected of approval.events) {
    const operation = operations.get(expected.operationId);
    invariant(operation, "STORAGE_MIGRATION_CONFLICT", "Согласованная операция отсутствует в источнике", 4, { operationId: expected.operationId });
    const matches = operation.indexed.filter((event) => event.index === "record-audit" && event.key === expected.key);
    invariant(matches.length === 1 && expected.key.startsWith(`${entityAddress(expected.owner)}:event:`),
      "STORAGE_MIGRATION_CONFLICT", "Согласованное событие отсутствует, повторено или принадлежит другому владельцу", 4, { key: expected.key });
    const event = matches[0]!;
    invariant(digest(jsonValue(event)) === expected.eventHash && operation.refs.some((ref) => entityAddress(ref) === entityAddress(expected.owner)),
      "STORAGE_MIGRATION_CONFLICT", "Согласованное событие или его принадлежность изменились", 4, { key: expected.key });
    const payload = z.strictObject({ type: z.literal("event"), value: storedPlanningEventSchema }).safeParse(event.value);
    invariant(payload.success, "STORAGE_MIGRATION_CONFLICT", "Разрешено исключать только предметные planning events, не квитанции и неизвестные данные", 4, { key: expected.key });
    selected.add(eventIdentity(operation.id, event.key));
    operationIds.add(operation.id);
  }
  invariant(operationIds.size === approval.receipts.length && approval.receipts.every((receipt) => operationIds.has(receipt.operationId)),
    "STORAGE_MIGRATION_CONFLICT", "Набор квитанций не соответствует точному набору согласованных событий", 4);
  for (const expected of approval.receipts) {
    const operation = operations.get(expected.operationId)!;
    invariant(receiptIdentity(operation) === receiptIdentity(expected) && operation.requestHash === expected.requestHash && digest(operation.result) === expected.resultHash,
      "STORAGE_MIGRATION_CONFLICT", "Исходная identity, hash или result квитанции изменились", 4, { operationId: expected.operationId });
    const result = z.object({ id: z.string().optional(), ref: entityRefSchema.optional() }).safeParse(operation.result);
    invariant(result.success && approval.events.some((event) => event.operationId === operation.id &&
      (operation.namespace === "release" ? event.owner.kind === "release" : event.owner.kind !== "release") &&
      (result.data.ref ? entityAddress(result.data.ref) === entityAddress(event.owner) : result.data.id === event.owner.id)),
      "STORAGE_MIGRATION_CONFLICT", "Квитанция относится не к согласованному отсутствующему владельцу", 4, { operationId: expected.operationId });
  }
  const seen = new Set<string>();
  return {
    project,
    owners,
    operationIds,
    absentPaths,
    discard(operation: UnifiedMigrationOperation, event: UnifiedMigrationIndexedEvent) {
      const identity = eventIdentity(operation.id, event.key);
      if (!selected.has(identity)) return false;
      invariant(!seen.has(identity), "STORAGE_MIGRATION_CONFLICT", "Согласованное событие повторяется в источнике", 4);
      seen.add(identity);
      return true;
    },
    report(): OrphanPlanningReport {
      invariant(seen.size === selected.size, "STORAGE_MIGRATION_CONFLICT", "Согласованный набор событий обработан не полностью", 4);
      return { projectId: project.id, discardedEvents: seen.size, preservedReceipts: operationIds.size };
    },
  };
}

/** После recovery уже опубликованного v3 проверяем квитанции; новые события не удаляются. */
export async function verifyAppliedOrphanPlanningApproval(session: StorageSession, approval: OrphanPlanningApproval): Promise<OrphanPlanningReport> {
  validateUnique(approval);
  await assertNoOrphanPlanningReferences(session, approvedOwners(approval));
  const project = await session.get({ kind: "project", id: approval.projectId });
  for (const expected of approval.receipts) {
    const matches = (project.receipts ?? []).filter((receipt) => receiptIdentity(receipt) === receiptIdentity(expected));
    invariant(matches.length === 1 && matches[0]!.requestHash === expected.requestHash && digest(matches[0]!.result) === expected.resultHash,
      "STORAGE_MIGRATION_CONFLICT", "В текущем проекте не подтверждена исходная квитанция согласованного переноса", 4);
  }
  return { projectId: project.id, discardedEvents: 0, preservedReceipts: approval.receipts.length };
}
