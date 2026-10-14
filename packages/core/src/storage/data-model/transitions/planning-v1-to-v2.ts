/**
 * Исторический переход планирования: план v1 + отдельные этапы `plan-stage` v1 + релиз v1
 * со снимками выпуска → план v2 с `stages[]`, записи совместимости прежних адресов этапов
 * (`plan-stage` v2 `{ planId }`) и релиз v2 без `snapshotId`. Снимки выпуска `release-snapshot`
 * и `release-snapshot-entry` v1 сохраняются без изменений как технические исторические записи.
 *
 * Переход получает только чтение согласованного снимка и возвращает набор изменений;
 * публикацию, удаление исходников и проверку полной согласованности выполняет исполнитель.
 * Нет обращений к часам, сети, ФС и случайным ID. Неоднозначность и повреждение — блокер
 * с ID, а не подстановка.
 *
 * Контракт отношений (для исполнителя): `view.relations(owner)` возвращает набор владельца
 * в собранной встроенной форме `{schemaVersion:1, owner, storage:"inline", entries}`
 * (сегменты уже объединены); `changes.relations(owner, value)` принимает ту же форму,
 * а inline/сегменты при записи выбирает исполнитель по правилам `saveOwned`.
 */
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import type {
  StorageBlocker,
  StorageMaintenanceErrorCode,
} from "@relay/contracts/storage-maintenance";
import { storageError, STORAGE_NEXT } from "../errors.js";
import {
  planStageDataV1,
  releaseDataV1,
  releaseSnapshotEntryV1,
  releaseSnapshotV1,
  workPlanDataV1,
} from "../history/planning-v1.js";
import type { PlanStageDataV1, ReleaseSnapshotV1 } from "../history/planning-v1.js";
import { planStageDataV2, releaseDataV2, workPlanDataV2 } from "../history/planning-v2.js";
import type { WorkPlanDataV2 } from "../history/planning-v2.js";
import { relationSetInlineV1 } from "../history/primitives-43d683b.js";
import type { RelationEntryV1, RelationSetInlineV1 } from "../history/primitives-43d683b.js";
import type { ChangeSet, SnapshotTransition, SnapshotView } from "../types.js";

export const PLANNING_V1_TO_V2 = "planning-v1-to-v2";
const MEMBERSHIP = "planning-membership";
const MAX_STAGES = 200;
const MAX_BLOCKERS = 50;

/**
 * Правило порядка этапов прежнего reader: `a.rank - b.rank || a.id.localeCompare(b.id)`
 * (43d683b: application/planning/model.ts, planning/service.ts). `localeCompare` без локали
 * зависит от локали процесса (в da-DK `aa` идёт после `z`, а `Intl.Collator("und")` в Node
 * откатывается к локали среды), поэтому фиксируется коллация `en` с параметрами по умолчанию
 * `localeCompare` — она совпадает с прежним поведением в средах с английской или корневой коллацией. Дополнительный
 * сравнитель по кодовым точкам срабатывает только при равенстве коллации.
 */
const collator = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "variant",
  ignorePunctuation: false,
  numeric: false,
  caseFirst: "false",
});
export function compareStages(
  left: { readonly rank: number; readonly id: string },
  right: { readonly rank: number; readonly id: string },
): number {
  return (
    left.rank - right.rank ||
    collator.compare(left.id, right.id) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const address = (ref: EntityRef) => `${ref.kind}:${ref.id}`;
const isLive = (
  record: Readonly<StoredRecord>,
): record is Readonly<Extract<StoredRecord, { data: unknown }>> => !("deleted" in record);
const path = (collection: string, id: string) => `entities/${collection}/${id}.json`;
const brief = (value: string | number | undefined) =>
  typeof value === "string" && value.length > 64 ? undefined : value;

type Blocker = Omit<StorageBlocker, "next" | "step">;

class Blockers {
  readonly items: Blocker[] = [];
  add(
    code: StorageMaintenanceErrorCode,
    message: string,
    detail: Omit<Blocker, "code" | "message">,
  ) {
    const entry: Blocker = { code, message };
    if (detail.owner) entry.owner = detail.owner;
    if (detail.path) entry.path = detail.path;
    if (detail.id) entry.id = detail.id.length > 256 ? detail.id.slice(0, 256) : detail.id;
    const current = brief(detail.current);
    const expected = brief(detail.expected);
    if (current !== undefined) entry.current = current;
    if (expected !== undefined) entry.expected = expected;
    this.items.push(entry);
  }
  /** Все найденные причины сразу: пользователь видит полный список ID, а не первую ошибку. */
  throwIfAny(): void {
    const first = this.items[0];
    if (!first) return;
    const next = STORAGE_NEXT.status;
    throw storageError(
      first.code,
      `Перенос планирования v1 невозможен: найдено причин — ${this.items.length}`,
      {
        step: PLANNING_V1_TO_V2,
        ...(first.owner ? { owner: first.owner } : {}),
        ...(first.id ? { id: first.id } : {}),
        ...(first.path ? { path: first.path } : {}),
        ...(first.current !== undefined ? { current: first.current } : {}),
        ...(first.expected !== undefined ? { expected: first.expected } : {}),
        blockers: this.items
          .slice(0, MAX_BLOCKERS)
          .map((item) => ({ ...item, step: PLANNING_V1_TO_V2, next })),
        next,
      },
    );
  }
}

type LiveRecord<T> = Readonly<Extract<StoredRecord, { data: unknown }>> & { readonly parsed: T };

/** Разбор входной версии замороженной схемой; исполнитель уже проверил её, это защита шага. */
function parsed<T>(
  view: SnapshotView,
  kind: string,
  collection: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  blockers: Blockers,
) {
  const live: LiveRecord<T>[] = [];
  const tombstones: Readonly<StoredRecord>[] = [];
  const other: Readonly<StoredRecord>[] = [];
  for (const record of [...view.records(kind)].sort(byId)) {
    if (record.dataVersion !== 1) {
      other.push(record);
      continue;
    }
    if (!isLive(record)) {
      tombstones.push(record);
      continue;
    }
    const result = schema.safeParse(record.data);
    if (!result.success) {
      blockers.add("STORAGE_DATA_CORRUPT", "Запись не соответствует исторической схеме v1", {
        owner: kind,
        id: record.id,
        path: path(collection, record.id),
        current: 1,
      });
      continue;
    }
    live.push({ ...record, parsed: result.data } as LiveRecord<T>);
  }
  return { live, tombstones, other };
}

/** Набор отношений в собранной встроенной форме; иная форма — блокер, а не пропуск. */
function readSet(
  view: SnapshotView,
  owner: EntityRef,
  collection: string,
  blockers: Blockers,
): RelationSetInlineV1 | null | undefined {
  const raw = view.relations(owner);
  if (raw === null) return null;
  const result = relationSetInlineV1.safeParse(raw);
  if (
    !result.success ||
    result.data.owner.kind !== owner.kind ||
    result.data.owner.id !== owner.id
  ) {
    blockers.add("STORAGE_DATA_CORRUPT", "Набор отношений не распознан в собранной форме v1", {
      owner: owner.kind,
      id: owner.id,
      path: `relations/${collection}/${owner.id}.json`,
    });
    return undefined;
  }
  return structuredClone(result.data);
}

const signature = (edge: RelationEntryV1["edge"]) =>
  JSON.stringify([edge.type, address(edge.from), address(edge.to)]);

function apply(view: SnapshotView, changes: ChangeSet): void {
  const blockers = new Blockers();
  const projectId = view.project().id;
  const plans = parsed(view, "work-plan", "work-plans", workPlanDataV1, blockers);
  const stages = parsed(view, "plan-stage", "plan-stages", planStageDataV1, blockers);
  const releases = parsed(view, "release", "releases", releaseDataV1, blockers);
  const snapshots = parsed(
    view,
    "release-snapshot",
    "release-snapshots",
    releaseSnapshotV1,
    blockers,
  );
  const entries = parsed(
    view,
    "release-snapshot-entry",
    "release-snapshot-entries",
    releaseSnapshotEntryV1,
    blockers,
  );

  const liveTasks = new Set(
    view
      .records("task")
      .filter(isLive)
      .map((record) => record.id),
  );
  const plansById = new Map(plans.live.map((plan) => [plan.id, plan]));
  const plansAnyVersion = new Map(view.records("work-plan").map((plan) => [plan.id, plan]));

  // 1. Этапы по planId: существование и принадлежность плана проекту.
  const stagesByPlan = new Map<string, LiveRecord<PlanStageDataV1>[]>();
  for (const stage of stages.live) {
    const data = stage.parsed;
    const plan = plansById.get(data.planId);
    const stagePath = path("plan-stages", stage.id);
    if (!plan) {
      const other = plansAnyVersion.get(data.planId);
      if (other && isLive(other))
        blockers.add(
          "STORAGE_MIGRATION_CONFLICT",
          "Этап v1 ссылается на план другой версии; владение составом неоднозначно",
          {
            owner: "plan-stage",
            id: stage.id,
            path: stagePath,
            current: other.dataVersion,
            expected: 1,
          },
        );
      else
        blockers.add(
          "STORAGE_REFERENCE_BROKEN",
          other ? "Этап ссылается на удалённый план" : "Этап ссылается на отсутствующий план",
          { owner: "plan-stage", id: stage.id, path: stagePath, expected: data.planId },
        );
      continue;
    }
    if (
      data.projectId !== plan.parsed.projectId ||
      (projectId !== null && data.projectId !== projectId)
    )
      blockers.add("STORAGE_REFERENCE_BROKEN", "Этап принадлежит другому проекту, чем план", {
        owner: "plan-stage",
        id: stage.id,
        path: stagePath,
        current: data.projectId,
        expected: plan.parsed.projectId,
      });
    const group = stagesByPlan.get(plan.id) ?? [];
    group.push(stage);
    stagesByPlan.set(plan.id, group);
  }
  for (const plan of plans.live)
    if (projectId !== null && plan.parsed.projectId !== projectId)
      blockers.add("STORAGE_REFERENCE_BROKEN", "План принадлежит другому проекту", {
        owner: "work-plan",
        id: plan.id,
        path: path("work-plans", plan.id),
        current: plan.parsed.projectId,
        expected: projectId,
      });

  // 2. Порядок и состав: инварианты прежнего reader (DUPLICATE_VALUE, TASK_IN_PLAN, задачи).
  const current = new Map<string, string>();
  for (const plan of [...view.records("work-plan")].filter(isLive).sort(byId)) {
    if (plan.dataVersion !== 2) continue;
    const data = plan.data as unknown as WorkPlanDataV2;
    if (data.status === "draft" || data.status === "active")
      for (const stage of data.stages ?? [])
        for (const id of stage.taskIds) current.set(id, plan.id);
  }
  for (const plan of plans.live) {
    const group = (stagesByPlan.get(plan.id) ?? []).sort((left, right) =>
      compareStages(
        { rank: left.parsed.rank, id: left.id },
        { rank: right.parsed.rank, id: right.id },
      ),
    );
    stagesByPlan.set(plan.id, group);
    if (group.length > MAX_STAGES)
      blockers.add("STORAGE_LIMIT_EXCEEDED", "В плане больше 200 этапов", {
        owner: "work-plan",
        id: plan.id,
        path: path("work-plans", plan.id),
        current: group.length,
        expected: MAX_STAGES,
      });
    const seen = new Set<string>();
    const open = plan.parsed.status === "draft" || plan.parsed.status === "active";
    for (const stage of group)
      for (const taskId of stage.parsed.taskIds) {
        if (!liveTasks.has(taskId))
          blockers.add("STORAGE_REFERENCE_BROKEN", "Этап ссылается на отсутствующую задачу", {
            owner: "plan-stage",
            id: stage.id,
            path: path("plan-stages", stage.id),
            expected: taskId,
          });
        if (seen.has(taskId))
          blockers.add(
            "STORAGE_MIGRATION_CONFLICT",
            "Задача повторяется в этапах одного плана; прежний reader отвергал такую базу",
            {
              owner: "plan-stage",
              id: stage.id,
              path: path("plan-stages", stage.id),
              current: taskId,
              expected: plan.id,
            },
          );
        seen.add(taskId);
        if (open) {
          const other = current.get(taskId);
          if (other !== undefined && other !== plan.id)
            blockers.add(
              "STORAGE_MIGRATION_CONFLICT",
              "Задача включена в два текущих плана; прежний reader отвергал такую базу",
              {
                owner: "work-plan",
                id: plan.id,
                path: path("work-plans", plan.id),
                current: taskId,
                expected: other,
              },
            );
          else current.set(taskId, plan.id);
        }
      }
  }

  // 3–5. Отношения этапов: отзыв управляемой группы этапа и перенос включений в план.
  const knownEdgeIds = new Set<string>();
  const stageSets = new Map<string, RelationSetInlineV1 | null>();
  const planSets = new Map<string, RelationSetInlineV1 | null>();
  for (const plan of plans.live) {
    const set = readSet(view, { kind: "work-plan", id: plan.id }, "work-plans", blockers);
    if (set === undefined) continue;
    planSets.set(plan.id, set);
    for (const entry of set?.entries ?? []) knownEdgeIds.add(entry.edge.id);
  }
  for (const stage of stages.live) {
    const set = readSet(view, { kind: "plan-stage", id: stage.id }, "plan-stages", blockers);
    if (set === undefined) continue;
    stageSets.set(stage.id, set);
    for (const entry of set?.entries ?? []) knownEdgeIds.add(entry.edge.id);
  }

  const relationWrites: { owner: EntityRef; value: RelationSetInlineV1 }[] = [];
  const createdIds = new Set<string>();
  for (const plan of plans.live) {
    const planRef = { kind: "work-plan", id: plan.id };
    const planSet = planSets.get(plan.id);
    if (planSet === undefined) continue;
    const planEntries = planSet ? [...planSet.entries] : [];
    const existing = new Set(
      planEntries
        .filter((entry) => entry.slot === MEMBERSHIP && entry.edge.active)
        .map((entry) => signature(entry.edge)),
    );
    let planChanged = false;
    for (const stage of stagesByPlan.get(plan.id) ?? []) {
      const stageRef = { kind: "plan-stage", id: stage.id };
      const stageSet = stageSets.get(stage.id);
      if (stageSet === undefined) continue;
      const taskIds = new Set(stage.parsed.taskIds);
      const sources = new Map<string, RelationEntryV1["edge"]>();
      let stageChanged = false;
      // Управляемая группа этапа выводится из употребления целиком: этап больше не владелец
      // включений. Отзыв сохраняет ID, ревизию и авторские updatedAt/updatedBy (O4).
      for (const entry of [...(stageSet?.entries ?? [])].sort((l, r) => byId(l.edge, r.edge))) {
        if (entry.slot !== MEMBERSHIP || !entry.edge.active) continue;
        const edge = entry.edge;
        if (
          edge.type === "part-of" &&
          address(edge.to) === address(stageRef) &&
          edge.from.kind === "task" &&
          taskIds.has(edge.from.id) &&
          !sources.has(edge.from.id)
        )
          sources.set(edge.from.id, structuredClone(edge));
        edge.active = false;
        stageChanged = true;
      }
      if (stageChanged && stageSet) relationWrites.push({ owner: stageRef, value: stageSet });
      for (const taskId of stage.parsed.taskIds) {
        const desired = { type: "part-of", from: { kind: "task", id: taskId }, to: planRef };
        const key = JSON.stringify([desired.type, address(desired.from), address(desired.to)]);
        if (existing.has(key)) continue;
        const source = sources.get(taskId);
        const seed = source
          ? `${source.id}:part-of:task:${taskId}:work-plan:${plan.id}`
          : `missing:plan-stage:${stage.id}:task:${taskId}:work-plan:${plan.id}`;
        const id = changes.newId(seed);
        if (knownEdgeIds.has(id) || createdIds.has(id)) {
          blockers.add("STORAGE_ADDRESS_COLLISION", "Детерминированный ID связи уже занят", {
            owner: "work-plan",
            id,
            path: `relations/work-plans/${plan.id}.json`,
          });
          continue;
        }
        createdIds.add(id);
        existing.add(key);
        planEntries.push({
          slot: MEMBERSHIP,
          edge: {
            id,
            type: "part-of",
            from: { kind: "task", id: taskId },
            to: planRef,
            description: source ? [...source.description] : [""],
            revision: 1,
            source: "graph",
            createdBy: source?.createdBy ?? stage.updatedBy,
            createdAt: source?.createdAt ?? stage.updatedAt,
            active: true,
            updatedAt: source?.updatedAt ?? stage.updatedAt,
            updatedBy: source?.updatedBy ?? stage.updatedBy,
          },
        });
        planChanged = true;
      }
    }
    if (planChanged)
      relationWrites.push({
        owner: planRef,
        value: { schemaVersion: 1, owner: planRef, storage: "inline", entries: planEntries },
      });
  }

  // 6. Релизы и снимки выпуска (R2): снимок может быть единственной копией текста на момент
  // выпуска, поэтому снимки и их записи не удаляются и не меняются — остаются техническими
  // историческими записями с прежними ID. Принадлежность выражает releaseId снимка;
  // переход только доказывает однозначность связи релиз ↔ снимок ↔ записи.
  const releasesById = new Map(releases.live.map((release) => [release.id, release]));
  const entriesById = new Map(entries.live.map((entry) => [entry.id, entry]));
  const claimed = new Set<string>();
  for (const tombstone of [...snapshots.tombstones, ...entries.tombstones])
    blockers.add(
      "STORAGE_MIGRATION_CONFLICT",
      "Надгробие технической записи снимка не распознано",
      {
        owner: tombstone.kind,
        id: tombstone.id,
      },
    );
  for (const record of [...snapshots.other, ...entries.other])
    blockers.add("STORAGE_VERSION_UNSUPPORTED", "Неизвестная версия технической записи снимка", {
      owner: record.kind,
      id: record.id,
      current: record.dataVersion,
      expected: 1,
    });
  const snapshotIds = new Set(snapshots.live.map((snapshot) => snapshot.id));
  const releaseTombstones = new Set(
    view
      .records("release")
      .filter((record) => !isLive(record))
      .map((record) => record.id),
  );
  for (const release of releases.live) {
    const snapshotId = release.parsed.snapshotId;
    if (snapshotId !== null && !snapshotIds.has(snapshotId))
      blockers.add("STORAGE_REFERENCE_BROKEN", "Релиз ссылается на отсутствующий снимок выпуска", {
        owner: "release",
        id: release.id,
        path: path("releases", release.id),
        expected: snapshotId,
      });
  }
  for (const snapshot of snapshots.live) {
    const data: ReleaseSnapshotV1 = snapshot.parsed;
    const snapshotPath = path("release-snapshots", snapshot.id);
    const release = releasesById.get(data.releaseId);
    // Надгробие релиза — допустимый владелец: удаление не каскадирует на снимок, а его текст
    // может быть единственной копией. Связь снимок → записи проверяется так же.
    const releaseTombstone = releaseTombstones.has(data.releaseId);
    if (!releaseTombstone && (!release || release.parsed.snapshotId !== snapshot.id))
      blockers.add(
        "STORAGE_REFERENCE_BROKEN",
        "Снимок не принадлежит релизу v1, который на него ссылается",
        {
          owner: "release-snapshot",
          id: snapshot.id,
          path: snapshotPath,
          expected: data.releaseId,
        },
      );
    if (view.relations({ kind: "release-snapshot", id: snapshot.id }) !== null)
      blockers.add("STORAGE_MIGRATION_CONFLICT", "У технического снимка есть набор отношений", {
        owner: "release-snapshot",
        id: snapshot.id,
      });
    // Повторы `entryIds`/`planEntryIds` и принадлежность записей плана общему составу —
    // инварианты кодека `release-snapshot` (unified-adapter.ts): запись с ними не проходит
    // проверку схемы до любого шага, в любом профиле.
    const listed = new Set(data.entryIds);
    for (const id of [...listed].sort()) {
      const entry = entriesById.get(id);
      const entryPath = path("release-snapshot-entries", id);
      if (!entry) {
        blockers.add("STORAGE_RECORD_MISSING", "Запись снимка выпуска отсутствует", {
          owner: "release-snapshot-entry",
          id,
          path: entryPath,
        });
        continue;
      }
      if (claimed.has(id) || entry.parsed.snapshotId !== snapshot.id) {
        blockers.add("STORAGE_REFERENCE_BROKEN", "Запись снимка принадлежит другому снимку", {
          owner: "release-snapshot-entry",
          id,
          path: entryPath,
          expected: snapshot.id,
        });
        continue;
      }
      claimed.add(id);
      if (view.relations({ kind: "release-snapshot-entry", id }) !== null)
        blockers.add("STORAGE_MIGRATION_CONFLICT", "У записи снимка есть набор отношений", {
          owner: "release-snapshot-entry",
          id,
        });
      // Признак плана записи и `planEntryIds` снимка — взаимные ссылки кодеков
      // `release-snapshot`/`release-snapshot-entry` (unified-adapter.ts): проверяются в любом
      // профиле общей проверкой согласованности.
    }
  }
  for (const entry of entries.live)
    if (!claimed.has(entry.id) && !blockers.items.some((item) => item.id === entry.id))
      blockers.add("STORAGE_REFERENCE_BROKEN", "Запись снимка не входит ни в один снимок", {
        owner: "release-snapshot-entry",
        id: entry.id,
        path: path("release-snapshot-entries", entry.id),
      });

  blockers.throwIfAny();

  // Изменения формируются только после полной проверки.
  for (const plan of plans.live) {
    const data = plan.parsed;
    const next: WorkPlanDataV2 = {
      title: data.title,
      summary: data.summary,
      goal: data.goal,
      rationale: data.rationale,
      boundaries: data.boundaries,
      expectedResult: data.expectedResult,
      scope: data.scope,
      participants: data.participants,
      projectId: data.projectId,
      stages: (stagesByPlan.get(plan.id) ?? []).map((stage) => ({
        title: stage.parsed.title,
        summary: stage.parsed.summary,
        outcome: stage.parsed.outcome,
        completionConditions: stage.parsed.completionConditions,
        id: stage.id,
        taskIds: stage.parsed.taskIds,
      })),
      status: data.status,
      result: data.result,
      startedAt: data.startedAt,
      closedAt: data.closedAt,
    };
    changes.put(withData(plan, structuredClone(next) as unknown as Record<string, JsonValue>));
  }
  for (const stage of stages.live) changes.put(withData(stage, { planId: stage.parsed.planId }));
  for (const release of releases.live) {
    const { snapshotId: _snapshotId, ...rest } = structuredClone(release.parsed);
    changes.put(withData(release, rest as unknown as Record<string, JsonValue>));
  }
  for (const tombstone of [...plans.tombstones, ...stages.tombstones, ...releases.tombstones])
    changes.put({ ...structuredClone(tombstone), dataVersion: 2 } as StoredRecord);
  for (const write of relationWrites)
    changes.relations(write.owner, structuredClone(write.value) as unknown as JsonValue);
}

/** Оболочка (ID, ключ, алиасы, ревизия, авторство, даты, комментарии) не меняется. */
function withData<T>(record: LiveRecord<T>, data: Record<string, JsonValue>): StoredRecord {
  const { parsed: _parsed, ...envelope } = record;
  return { ...structuredClone(envelope), dataVersion: 2, data } as StoredRecord;
}

export const planningV1ToV2: SnapshotTransition = {
  id: PLANNING_V1_TO_V2,
  version: 1,
  type: "snapshot",
  description:
    "Этапы плана v1 переносятся в work-plan.stages, прежние адреса этапов становятся записями совместимости, снимки выпуска v1 сохраняются техническими записями, связь задаёт их releaseId",
  requires: {
    "work-plan": 1,
    "plan-stage": 1,
    release: 1,
  },
  produces: {
    "work-plan": 2,
    "plan-stage": 2,
    release: 2,
  },
  inputs: {
    "work-plan": workPlanDataV1,
    "plan-stage": planStageDataV1,
    release: releaseDataV1,
  },
  outputs: {
    "work-plan": workPlanDataV2,
    "plan-stage": planStageDataV2,
    release: releaseDataV2,
  },
  apply,
};
