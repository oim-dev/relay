import { z } from "zod";
import { workPlanSchema, planningPageQuerySchema } from "@relay/contracts/planning";
import type { WorkPlan, PlanningPageQuery } from "@relay/contracts/planning";
import { releaseSchema } from "@relay/contracts/releases";
import type { Release } from "@relay/contracts/releases";
import type { Workspace } from "./workspace.js";
import type { EntityRecord } from "./entity-store/registry.js";
import { shortId } from "../shared/ids.js";
import { invariant } from "../shared/errors.js";
import { digest } from "./entity-store/format.js";
import { saveAudit, readAudit, json } from "./unified-adapter.js";
import { actorSchema, timestampSchema } from "@relay/contracts/primitives";

export type PlanningRecord = WorkPlan | Release;
export type PlanningKind = PlanningRecord["kind"];
const schemas = {
  "work-plan": workPlanSchema,
  release: releaseSchema,
};
const prefixes = { "work-plan": "PLN", release: "REL" };

/** Планирование использует только единую сессию: старые базы переводятся явной командой. */
export function planningSession(workspace: Workspace) {
  const session = workspace.storageSession;
  invariant(
    session,
    "STORAGE_MIGRATION_REQUIRED",
    "Для планов и релизов выполните relay-cli --local storage migrate",
    4,
  );
  return session;
}

export function decodePlanning(record: EntityRecord): PlanningRecord {
  const schema = schemas[record.kind as PlanningKind];
  invariant(schema, "ENTITY_KIND_MISMATCH", "Ожидается план или релиз", 4);
  return schema.parse({
    ...record.data,
    kind: record.kind,
    id: record.id,
    key: record.key,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
  });
}

export async function planningRecords<K extends PlanningKind>(workspace: Workspace, kind: K) {
  if (!workspace.storageSession) return [] as Extract<PlanningRecord, { kind: K }>[];
  return (await workspace.storageSession.records(kind)).map(decodePlanning) as Extract<
    PlanningRecord,
    { kind: K }
  >[];
}

export async function planningRecord<K extends PlanningKind>(
  workspace: Workspace,
  ref: string,
  kind: K,
) {
  const session = planningSession(workspace);
  const card = await session.resolve(ref, kind);
  return decodePlanning(await session.get(card.ref)) as Extract<PlanningRecord, { kind: K }>;
}

/** Общая оболочка; поля, переходы и состав проверяются предметным сервисом до вызова. */
export async function savePlanning(
  workspace: Workspace,
  value: PlanningRecord,
  actor: string,
  action: string,
  details?: {
    stageId?: string;
    taskId?: string;
    from?: string;
    to?: string;
    reason?: string;
    add?: string[];
    remove?: string[];
  },
) {
  const session = planningSession(workspace);
  const prior = await session.get({ kind: value.kind, id: value.id });
  invariant(
    prior.revision === value.revision,
    "REVISION_CONFLICT",
    "Запись изменилась; перечитайте её и согласуйте ввод",
    4,
  );
  const next = schemas[value.kind].parse({
    ...value,
    revision: value.revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });
  await session.put(toRecord(next, prior.aliases), value.revision);
  const description = [
    ...(details?.stageId ? [`Внутренний ID этапа: ${details.stageId}`] : []),
    ...(details?.taskId
      ? [`Задача: task:${details.taskId}\n\nИз этапа: ${details.from}\n\nВ этап: ${details.to}`]
      : []),
    ...(details?.add?.length ? [`Добавлены задачи: ${details.add.join(", ")}`] : []),
    ...(details?.remove?.length ? [`Исключены задачи: ${details.remove.join(", ")}`] : []),
    ...(details?.reason ? [`## Причина\n\n${details.reason}`] : []),
  ].join("\n\n");
  await saveAudit(
    workspace,
    { kind: next.kind, id: next.id },
    [
      {
        revision: next.revision,
        actor,
        at: next.updatedAt,
        action,
        ...(description ? { description: description.split("\n") } : {}),
      },
    ],
    {},
  );
  return next;
}

export async function createPlanning<K extends PlanningKind>(
  workspace: Workspace,
  kind: K,
  fields: Record<string, unknown>,
  actor: string,
) {
  const session = planningSession(workspace);
  const projectId = workspace.config.projectId ?? "project";
  const keyspace = `global-${kind}`;
  if ((await session.readFile(`keyspaces/${keyspace}.json`)) === null)
    await session.saveKeySpace({
      schemaVersion: 1,
      id: keyspace,
      entityKind: kind,
      owner: { kind: "project", id: projectId },
      prefix: prefixes[kind],
      format: "{prefix}-{number}",
    });
  let id = shortId();
  while (await session.indexGet("records", `${kind}:${id}`)) id = shortId();
  const at = new Date().toISOString();
  const value = schemas[kind].parse({
    ...fields,
    kind,
    projectId,
    id,
    key: await session.nextKey(keyspace),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
    updatedBy: actor,
  });
  await session.put(toRecord(value), null);
  await saveAudit(workspace, { kind, id }, [{ revision: 1, actor, at, action: "create" }], {});
  return value as Extract<PlanningRecord, { kind: K }>;
}

function toRecord(value: PlanningRecord, aliases: string[] = []): EntityRecord {
  const { id, kind, key, revision, createdAt, updatedAt, createdBy, updatedBy, ...data } = value;
  return {
    schemaVersion: 1,
    dataVersion: 2,
    id,
    kind,
    key,
    revision,
    createdAt,
    updatedAt,
    createdBy,
    updatedBy,
    aliases,
    data,
  };
}

/** Версия включает область запроса; продолжение никогда не смешивает разные снимки. */
export function planningPage<T>(items: T[], query: PlanningPageQuery, source: unknown) {
  const page = planningPageQuerySchema.strip().parse(query);
  const version = digest(json(source));
  invariant(
    page.offset === 0 || page.version !== undefined,
    "INVALID_ARGUMENT",
    "Для продолжения укажите версию первой страницы",
    2,
  );
  invariant(
    page.version === undefined || page.version === version,
    "PLANNING_CHANGED",
    "Состав изменился; начните чтение с первой страницы",
    4,
  );
  return {
    items: items.slice(page.offset, page.offset + page.limit),
    total: items.length,
    nextOffset: page.offset + page.limit < items.length ? page.offset + page.limit : null,
    version,
  };
}

export function assertRevision(value: PlanningRecord, revision: number) {
  invariant(
    value.revision === revision,
    "REVISION_CONFLICT",
    "Запись изменилась; перечитайте её и согласуйте ввод",
    4,
  );
}
export function assertEditable(plan: WorkPlan) {
  invariant(
    plan.status === "draft" || plan.status === "active",
    "PLAN_CLOSED",
    "Закрытый план доступен только для чтения",
    4,
  );
}
export const planningSaved = (value: PlanningRecord, action: string, requestId: string) => ({
  id: value.id,
  key: value.key,
  revision: value.revision,
  action,
  requestId,
});

/** Дисковое пояснение истории декодируется, внутренние детали не протекают в общий DTO. */
export async function planningHistory(workspace: Workspace, kind: PlanningKind, id: string) {
  const schema = z.object({
    revision: z.number(),
    actor: actorSchema,
    at: timestampSchema,
    action: z.string(),
    description: z.array(z.string()).optional(),
  });
  return (await readAudit(workspace, { kind, id })).events.map((raw) => {
    const { description, ...event } = schema.parse(raw);
    return {
      ...event,
      ...(description === undefined ? {} : { description: description.join("\n") }),
    };
  });
}
