/**
 * Независимый oracle перехода planning-v1-to-v2 (design-core §3.3, §3.5, §3.6).
 *
 * Не вызывает и не импортирует преобразователь: каждое ожидаемое значение задано явным
 * отображением исходного поля на целевое. Порядок этапов передаётся вызывающим из
 * независимого источника (ответ старого reader в oracle фикстуры или литерал теста).
 */
import type { JsonValue } from "@relay/contracts/storage";

type Json = Record<string, JsonValue>;
export type SourceRecord = {
  schemaVersion: number;
  dataVersion: number;
  kind: string;
  id: string;
  revision: number;
  key: string | null;
  aliases: string[];
  data?: Json;
  deleted?: { at: string; actor: string };
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  [extra: string]: JsonValue | undefined;
};

/** Поля плана v1, переносимые без изменений (таблица §3.3, строка «plan v1 все поля»). */
export const PLAN_V1_FIELDS = [
  "title",
  "summary",
  "goal",
  "rationale",
  "boundaries",
  "expectedResult",
  "scope",
  "participants",
  "projectId",
  "status",
  "result",
  "startedAt",
  "closedAt",
] as const;
/** Поля этапа, переходящие во вложенный этап плана. */
export const STAGE_CONTENT_FIELDS = [
  "title",
  "summary",
  "outcome",
  "completionConditions",
] as const;
/** Поля этапа, которые не хранятся после перехода: выводятся из плана и порядка массива. */
export const STAGE_DROPPED_FIELDS = ["projectId", "rank"] as const;
/** Поля релиза v1, переносимые без изменений; snapshotId удаляется. */
export const RELEASE_V1_FIELDS = [
  "title",
  "version",
  "summary",
  "description",
  "planIds",
  "plannedFor",
  "projectId",
  "status",
  "releasedAt",
  "releasedBy",
] as const;
/** Поля оболочки, которые техническое преобразование не меняет. */
export const ENVELOPE_FIELDS = [
  "schemaVersion",
  "kind",
  "id",
  "revision",
  "key",
  "aliases",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "reservedKeys",
  "comments",
  "commentSequence",
  "deleted",
] as const;

function envelope(source: SourceRecord, dataVersion: number): SourceRecord {
  const result: SourceRecord = {
    schemaVersion: source.schemaVersion,
    dataVersion,
    kind: source.kind,
    id: source.id,
    revision: source.revision,
    key: source.key,
    aliases: structuredClone(source.aliases),
  };
  for (const field of ENVELOPE_FIELDS)
    if (source[field] !== undefined && !(field in result))
      (result as Record<string, unknown>)[field] = structuredClone(source[field]);
  return result;
}

/** План v2: те же поля v1 и этапы в заданном порядке; оболочка и ревизия плана не меняются. */
export function expectedPlan(plan: SourceRecord, orderedStages: readonly SourceRecord[]) {
  const result = envelope(plan, 2);
  const data: Json = {};
  for (const field of PLAN_V1_FIELDS) data[field] = structuredClone(plan.data![field]!);
  data.stages = orderedStages.map((stage) => {
    const nested: Json = { id: stage.id };
    for (const field of STAGE_CONTENT_FIELDS) nested[field] = structuredClone(stage.data![field]!);
    nested.taskIds = structuredClone(stage.data!.taskIds!);
    return nested;
  });
  result.data = data;
  return result;
}

/** Запись совместимости прежнего адреса: та же оболочка, данные — только planId. */
export function expectedStageCompatibility(stage: SourceRecord) {
  const result = envelope(stage, 2);
  result.data = { planId: stage.data!.planId! };
  return result;
}

export function expectedRelease(release: SourceRecord) {
  const result = envelope(release, 2);
  const data: Json = {};
  for (const field of RELEASE_V1_FIELDS) data[field] = structuredClone(release.data![field]!);
  result.data = data;
  return result;
}

/** Надгробие меняет только dataVersion. */
export function expectedTombstone(record: SourceRecord) {
  return envelope(record, 2);
}

type Edge = {
  id: string;
  type: string;
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  description: string[];
  revision: number;
  source: "graph";
  createdAt: string;
  createdBy: string;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
  historyCount?: number | undefined;
};
type Entry = { slot: string; edge: Edge };

/**
 * Набор этапа после перехода: управляемая группа planning-membership отозвана
 * (только active:false, ID/ревизия/описание/авторство без изменений), прочие слоты как были.
 */
export function expectedStageRelations(entries: readonly Entry[]): Entry[] {
  return entries.map((entry) => {
    const copy = structuredClone(entry);
    if (copy.slot === "planning-membership") copy.edge.active = false;
    return copy;
  });
}

/**
 * Ожидаемое новое включение задачи в план: тип и концы новые, смысл и авторство — от
 * прежнего ребра task → plan-stage; без прежнего ребра — от оболочки этапа.
 */
export function expectedPlanMembership(
  taskId: string,
  planId: string,
  previous: Edge | undefined,
  stage: SourceRecord,
): Omit<Edge, "id"> {
  return {
    type: "part-of",
    from: { kind: "task", id: taskId },
    to: { kind: "work-plan", id: planId },
    description: previous ? [...previous.description] : [""],
    revision: 1,
    source: "graph",
    createdAt: previous?.createdAt ?? stage.updatedAt!,
    createdBy: previous?.createdBy ?? stage.updatedBy!,
    active: true,
    updatedAt: previous?.updatedAt ?? stage.updatedAt!,
    updatedBy: previous?.updatedBy ?? stage.updatedBy!,
  };
}

/** Markdown на диске → строка, как её читает пользователь. */
export const markdown = (lines: JsonValue | undefined) => (lines as string[]).join("\n");
