/**
 * Переход planning-v1-to-v2 (A09, A11, A12 для этапов; ТЗ 6.2 п.1–7).
 *
 * Исполнитель snapshot-шага здесь — минимальный тестовый в памяти: он даёт только чтение
 * согласованного снимка и проверяет каждый выход замороженной схемой перехода и текущими
 * кодеками. Ожидания задаёт независимый oracle (helpers/planning-v1-oracle.ts) и oracle
 * замороженной фикстуры (ответы старого reader 43d683b).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { z } from "zod";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import { storedRecordSchema } from "@relay/contracts/storage";
import {
  planStageSchema as currentPlanStageSchema,
  workPlanDataSchema as currentWorkPlanDataSchema,
} from "@relay/contracts/planning";
import { releaseDataSchema as currentReleaseDataSchema } from "@relay/contracts/releases";
import { AppError } from "../src/shared/errors.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import { deterministicId } from "../src/storage/data-model/registry.js";
import {
  compareStages,
  planningV1ToV2,
  PLANNING_V1_TO_V2,
} from "../src/storage/data-model/transitions/planning-v1-to-v2.js";
import {
  planStageDataV1,
  planSummaryDiskV1,
  releaseDataV1,
  releaseSnapshotEntryV1,
  releaseSnapshotV1,
  workPlanDataV1,
} from "../src/storage/data-model/history/planning-v1.js";
import {
  planStageDataV2,
  planStageInPlanV2,
  releaseDataV2,
  workPlanDataV2,
} from "../src/storage/data-model/history/planning-v2.js";
import { relationSetInlineV1 } from "../src/storage/data-model/history/primitives-43d683b.js";
import type { ChangeSet, SnapshotView } from "../src/storage/data-model/types.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { decodePlanning } from "../src/storage/planning.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { GraphService } from "../src/application/graph/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { ProductRepository } from "../src/storage/product.js";
import { fixture } from "./helpers/workspace.js";
import {
  expectedPlan,
  expectedPlanMembership,
  expectedRelease,
  expectedStageCompatibility,
  expectedStageRelations,
  expectedTombstone,
  markdown,
} from "./helpers/planning-v1-oracle.js";
import type { SourceRecord } from "./helpers/planning-v1-oracle.js";

type RelationSet = z.output<typeof relationSetInlineV1>;
type State = {
  records: Map<string, StoredRecord>;
  relations: Map<string, RelationSet>;
  projectId: string | null;
};
const address = (ref: EntityRef) => `${ref.kind}:${ref.id}`;
const FIXTURES = join(import.meta.dirname, "fixtures/data-migrations");
const MAIN = "physical2-plan-v1-43d683b";
const EQUAL_RANK = "physical2-plan-v1-equal-rank-43d683b";

/** Развёртывание замороженной базы в память с проверкой sha256 каждого файла. */
async function tree(name: string): Promise<Map<string, string>> {
  const bundle = JSON.parse(
    gunzipSync(await readFile(join(FIXTURES, name, "base.json.gz"))).toString("utf8"),
  ) as {
    format: string;
    version: number;
    entries: { path: string; type: string; sha256?: string; encoding?: string; content?: string }[];
  };
  assert.equal(bundle.format, "relay-fixture-tree");
  const files = new Map<string, string>();
  for (const entry of bundle.entries) {
    if (entry.type !== "file") continue;
    const bytes = Buffer.from(entry.content!, entry.encoding as BufferEncoding);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.path);
    files.set(entry.path, bytes.toString("utf8"));
  }
  return files;
}

/**
 * Снимок исторической базы: записи и собранные наборы отношений. Единственная замена —
 * литерал оболочки 1 → 3 (поля оболочки 1 — подмножество 3); это заглушка физического
 * шага формата 2 → 4, который выполняет отдельный переход. Данные записей не трогаются.
 */
async function historicalState(name: string): Promise<{ state: State; source: State }> {
  const files = await tree(name);
  const registry = productionTransitionRegistry();
  const records = new Map<string, StoredRecord>();
  const relations = new Map<string, RelationSet>();
  const allowed = new Set([
    "schemaVersion",
    "dataVersion",
    "kind",
    "id",
    "revision",
    "key",
    "aliases",
    "data",
    "deleted",
    "createdAt",
    "createdBy",
    "updatedAt",
    "updatedBy",
  ]);
  for (const [path, content] of files) {
    const entity = /^\.relay\/entities\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (entity) {
      const raw = JSON.parse(content) as Record<string, JsonValue>;
      assert.equal(raw.schemaVersion, 1, path);
      for (const key of Object.keys(raw)) assert(allowed.has(key), `${path}: ${key}`);
      const record = storedRecordSchema.parse({ ...raw, schemaVersion: 3 });
      assert.equal(registry.kindOfCollection(entity[1]!), record.kind);
      records.set(address(record), registry.validateRecord(record));
      continue;
    }
    const owner = /^\.relay\/relations\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!owner) continue;
    const raw = JSON.parse(content) as {
      schemaVersion: 1;
      owner: EntityRef;
      storage: string;
      entries?: unknown[];
      segments?: Record<string, string>;
    };
    const entries =
      raw.storage === "inline"
        ? raw.entries!
        : Object.keys(raw.segments!).flatMap(
            (prefix) =>
              (
                JSON.parse(
                  files.get(`.relay/relations/${owner[1]}/${owner[2]}/${prefix}.json`)!,
                ) as { entries: unknown[] }
              ).entries,
          );
    relations.set(
      address(raw.owner),
      relationSetInlineV1.parse({
        schemaVersion: 1,
        owner: raw.owner,
        storage: "inline",
        entries,
      }),
    );
  }
  const projects = [...records.values()].filter((record) => record.kind === "project");
  assert.equal(projects.length, 1);
  const state = { records, relations, projectId: projects[0]!.id };
  return { state, source: structuredClone(state) };
}

type Run = {
  state: State;
  removed: { ref: string; category: string }[];
  written: string[];
};

/** Тестовый исполнитель одного snapshot-шага с проверкой выхода и текущих кодеков. */
function run(input: State): Run {
  const state = structuredClone(input);
  const frozen = new Map(
    [...state.records.values()].map((record) => [
      address(record),
      Object.freeze(structuredClone(record)),
    ]),
  );
  const view: SnapshotView = {
    records: (kind) =>
      [...frozen.values()]
        .filter((record) => record.kind === kind)
        .sort((a, b) => (a.id < b.id ? 1 : -1)), // обратный порядок: шаг не должен от него зависеть
    relations: (owner) => {
      const set = state.relations.get(address(owner));
      return set ? (structuredClone(set) as unknown as JsonValue) : null;
    },
    keyspaces: () => [],
    project: () => ({ id: state.projectId }),
  };
  const puts = new Map<string, StoredRecord>();
  const removed: Run["removed"] = [];
  const written: string[] = [];
  const changes: ChangeSet = {
    put: (record) => {
      assert(!puts.has(address(record)), `повторная запись ${address(record)}`);
      puts.set(address(record), structuredClone(record));
    },
    remove: (ref, category) => void removed.push({ ref: address(ref), category }),
    relations: (owner, value) => {
      assert(value !== null);
      written.push(address(owner));
      state.relations.set(address(owner), relationSetInlineV1.parse(value));
    },
    removeSource: () => assert.fail("переход не удаляет файлы сам"),
    newId: (seed) => deterministicId(PLANNING_V1_TO_V2, seed),
  };
  planningV1ToV2.apply(view, changes);
  for (const [key, record] of puts) {
    const version = planningV1ToV2.produces[record.kind];
    assert.equal(record.dataVersion, version, key);
    if (!("deleted" in record))
      assert(planningV1ToV2.outputs[record.kind]!.safeParse(record.data).success, key);
    state.records.set(key, record);
  }
  for (const { ref } of removed) assert(state.records.delete(ref), ref);
  const registry = productionTransitionRegistry();
  for (const record of state.records.values()) {
    assert.notEqual(planningV1ToV2.requires[record.kind], record.dataVersion, address(record));
    registry.validateRecord(record);
    assert.equal(record.dataVersion, registry.target(record.kind), address(record));
  }
  return { state, removed, written };
}

const blockersOf = (error: unknown) => {
  assert(error instanceof AppError);
  return (error.details as { blockers: { code: string; id?: string; owner?: string }[] }).blockers;
};
const records = (state: State, kind: string) =>
  [...state.records.values()].filter((record) => record.kind === kind) as SourceRecord[] &
    StoredRecord[];
const canonical = (state: State) =>
  JSON.stringify({
    records: [...state.records.entries()].sort(),
    relations: [...state.relations.entries()].sort(),
  });

test("Исторические схемы: строгие, без defaults и преобразований, выход сверен с текущими кодеками", () => {
  for (const schema of [
    workPlanDataV1,
    planStageDataV1,
    releaseDataV1,
    releaseSnapshotV1,
    releaseSnapshotEntryV1,
    planSummaryDiskV1,
    workPlanDataV2,
    releaseDataV2,
    planStageDataV2,
    relationSetInlineV1,
  ]) {
    const input = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    const output = JSON.stringify(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));
    assert.equal(input, output, "вход и выход схемы совпадают: нет defaults и coercion");
    assert(!input.includes('"default"'));
  }
  assert.equal(workPlanDataV1.safeParse({}).success, false, "отсутствие поля — повреждение");
  assert.equal(
    planStageDataV1.safeParse({
      title: "Этап",
      summary: "",
      outcome: [""],
      completionConditions: [""],
      projectId: "P",
      planId: "W",
      rank: 0,
      taskIds: [],
      extra: 1,
    }).success,
    false,
    "лишнее поле не удаляется молча",
  );
  // Значение не нормализуется: исторический reader принимал непробельный заголовок.
  const parsed = planStageInPlanV2.parse({
    title: " Этап ",
    summary: "",
    outcome: ["a\r", ""],
    completionConditions: [""],
    id: "S",
    taskIds: [],
  });
  assert.equal(parsed.title, " Этап ");

  // Набор полей выхода совпадает с текущими Contracts (без kind) — тихое изменение заметно.
  const keys = (shape: object, omit: string[] = []) =>
    Object.keys(shape)
      .filter((key) => !omit.includes(key))
      .sort();
  assert.deepEqual(keys(workPlanDataV2.shape), keys(currentWorkPlanDataSchema.shape, ["kind"]));
  assert.deepEqual(keys(planStageInPlanV2.shape), keys(currentPlanStageSchema.shape));
  assert.deepEqual(keys(releaseDataV2.shape), keys(currentReleaseDataSchema.shape, ["kind"]));
  // Образец выхода проходит текущий кодек, а план без этапов ему не соответствует.
  const storage = workspaceStorageRegistry();
  const plan = {
    title: "План",
    summary: "Кратко",
    goal: ["# Цель\r", ""],
    rationale: [""],
    boundaries: [""],
    expectedResult: [""],
    scope: [],
    participants: ["alice"],
    projectId: "P1",
    stages: [
      {
        title: "Этап",
        summary: "",
        outcome: ["Итог"],
        completionConditions: [""],
        id: "S1",
        taskIds: ["T1"],
      },
    ],
    status: "completed",
    result: ["Готово"],
    startedAt: null,
    closedAt: "2026-01-01T00:00:00.000Z",
  };
  assert(workPlanDataV2.safeParse(plan).success);
  storage.currentData("work-plan", plan);
  const { stages: _stages, ...withoutStages } = plan;
  assert.throws(() => storage.currentData("work-plan", withoutStages));
  assert.deepEqual(storage.currentData("plan-stage", { planId: "W1" }), { planId: "W1" });
  assert.throws(() => storage.currentData("plan-stage", { planId: "W1", title: "x" }));
});

test("A09/A11/A12: перенос замороженной базы 43d683b по oracle старого reader", async () => {
  const { state, source } = await historicalState(MAIN);
  const oracle = JSON.parse(await readFile(join(FIXTURES, MAIN, "oracle.json"), "utf8"));
  const first = run(state);
  const second = run(state);
  assert.equal(canonical(first.state), canonical(second.state), "двойной прогон детерминирован");
  const result = first.state;

  const plans = records(source, "work-plan");
  const stages = records(source, "plan-stage");
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const order: Record<string, string[]> = {
    [oracle.entities.P1.id]: (oracle.oldReader.p1Stages.items as { id: string }[]).map(
      (item) => item.id,
    ),
    [oracle.entities.P2.id]: (oracle.oldReader.p2Stages.items as { id: string }[]).map(
      (item) => item.id,
    ),
    [oracle.entities.P3.id]: [] as string[],
  };
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    const ordered = order[plan.id]!.map((id) => byId.get(id)!);
    const actual = result.records.get(`work-plan:${plan.id}`)!;
    assert.deepEqual(actual, expectedPlan(plan, ordered));
    // Чтение текущим кодеком и DTO: Markdown и порядок совпадают со старым reader.
    const decoded = decodePlanning(workspaceStorageRegistry().decode(actual));
    assert(decoded.kind === "work-plan");
    assert.equal(decoded.revision, plan.revision);
    assert.equal(decoded.updatedAt, plan.updatedAt);
    const items =
      plan.id === oracle.entities.P1.id
        ? oracle.oldReader.p1Stages.items
        : plan.id === oracle.entities.P2.id
          ? oracle.oldReader.p2Stages.items
          : [];
    assert.deepEqual(
      decoded.stages.map((stage) => [
        stage.id,
        stage.title,
        stage.summary,
        stage.outcome,
        stage.completionConditions,
        stage.taskIds,
      ]),
      (items as Record<string, unknown>[]).map((item) => [
        item.id,
        item.title,
        item.summary,
        item.outcome,
        item.completionConditions,
        item.taskIds,
      ]),
    );
  }
  const p1 = decodePlanning(
    workspaceStorageRegistry().decode(result.records.get(`work-plan:${oracle.entities.P1.id}`)!),
  );
  assert(p1.kind === "work-plan");
  for (const field of ["goal", "rationale", "boundaries", "expectedResult", "result", "summary"])
    assert.equal(
      (p1 as Record<string, unknown>)[field],
      oracle.entities.P1[field],
      `P1.${field} байт-в-байт`,
    );
  assert.equal(p1.status, "completed", "закрытый план остаётся закрытым");
  assert.deepEqual(p1.participants, oracle.entities.P1.participants);

  // Этапы: записи совместимости с прежними ключами и ревизиями; надгробие остаётся.
  const tombstones = stages.filter((stage) => stage.deleted);
  assert.equal(tombstones.length, 1);
  for (const stage of stages) {
    const actual = result.records.get(`plan-stage:${stage.id}`)!;
    assert.deepEqual(
      actual,
      stage.deleted ? expectedTombstone(stage) : expectedStageCompatibility(stage),
    );
  }
  assert.deepEqual(
    stages.map((stage) => stage.key).sort(),
    ["STG-1", "STG-2", "STG-3", "STG-4", "STG-5", "STG-6"],
    "ключи и надгробие STG-2 зарезервированы",
  );

  // Релизы: поля и реквизиты выпуска сохранены, снимки удалены как распознанные.
  for (const release of records(source, "release"))
    assert.deepEqual(result.records.get(`release:${release.id}`), expectedRelease(release));
  const r1 = decodePlanning(
    workspaceStorageRegistry().decode(result.records.get(`release:${oracle.entities.R1.id}`)!),
  );
  assert(r1.kind === "release");
  assert.equal(r1.status, "released");
  assert.equal(r1.description, oracle.entities.R1.description);
  assert.deepEqual(r1.planIds, oracle.entities.R1.planIds);
  // R2: снимок — возможно единственная копия текста на момент выпуска (тело DOC-4 изменено
  // после выпуска). Снимок и все его записи сохраняются побайтно с прежними ID.
  assert.deepEqual(first.removed, []);
  const snapshotsAfter = records(result, "release-snapshot");
  assert.equal(snapshotsAfter.length, 1);
  assert.equal(records(result, "release-snapshot-entry").length, 19);
  assert.equal(snapshotsAfter[0]!.data!.releaseId, oracle.entities.R1.id);
  for (const kind of ["release-snapshot", "release-snapshot-entry"])
    for (const record of records(source, kind))
      assert.deepEqual(result.records.get(address(record)), record, address(record));
  const doc4 = result.records.get(`document:${oracle.entities.D4.id}`)!;
  const archived = records(result, "release-snapshot-entry").find(
    (record) => (record.data!.item as { id: string }).id === doc4.id,
  )!;
  assert(
    markdown((archived.data!.item as { content: JsonValue }).content).includes(
      oracle.entities.D4.bodyOnlyInReleaseSnapshot,
    ),
    "прежний текст DOC-4 сохранён только снимком и не потерян",
  );

  // Записи других видов не меняются (документы, задачи, комментарии, надгробия).
  for (const [key, record] of source.records)
    if (!["work-plan", "plan-stage", "release"].includes(record.kind))
      assert.deepEqual(result.records.get(key), record, key);

  // Отношения: группа этапа отозвана с прежними ID, включения перенесены в план.
  const sourceIds = new Set(
    [...source.relations.values()].flatMap((set) => set.entries.map((entry) => entry.edge.id)),
  );
  const created: string[] = [];
  for (const plan of plans) {
    const before = source.relations.get(`work-plan:${plan.id}`)?.entries ?? [];
    const after = result.relations.get(`work-plan:${plan.id}`)?.entries ?? [];
    assert.deepEqual(after.slice(0, before.length), before, "прежние рёбра плана без изменений");
    const added = after.slice(before.length);
    const expected = order[plan.id]!.flatMap((stageId) => {
      const stage = byId.get(stageId)!;
      const old = source.relations.get(`plan-stage:${stageId}`)!.entries;
      return (stage.data!.taskIds as string[]).map((taskId) => {
        const previous = old.find(
          (entry) =>
            entry.slot === "planning-membership" &&
            entry.edge.active &&
            address(entry.edge.from) === `task:${taskId}` &&
            address(entry.edge.to) === `plan-stage:${stageId}`,
        );
        assert(previous, `исходное ребро task:${taskId} → plan-stage:${stageId}`);
        return expectedPlanMembership(taskId, plan.id, previous.edge, stage);
      });
    });
    assert.deepEqual(
      added.map(({ edge: { id: _id, ...rest }, slot }) => ({ slot, ...rest })),
      expected.map((edge) => ({ slot: "planning-membership", ...edge })),
    );
    for (const entry of added) {
      assert.match(
        entry.edge.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert(!sourceIds.has(entry.edge.id), "новое ребро не занимает прежний ID");
      created.push(entry.edge.id);
    }
  }
  assert.equal(new Set(created).size, created.length);
  assert.equal(
    created.length,
    stages
      .filter((stage) => !stage.deleted)
      .reduce((total, stage) => total + (stage.data!.taskIds as string[]).length, 0),
    "каждое включение этапа стало включением плана; WEB-1 в двух планах — два ребра",
  );
  for (const stage of stages) {
    const before = source.relations.get(`plan-stage:${stage.id}`);
    const after = result.relations.get(`plan-stage:${stage.id}`);
    if (stage.deleted) {
      assert.deepEqual(after, before, "набор удалённого этапа не трогается");
      continue;
    }
    assert.deepEqual(after!.entries, expectedStageRelations(before!.entries));
  }
  // Документные и диагностические связи с прежним этапом сохраняют ID, текст и активность.
  for (const [key, set] of source.relations)
    if (!key.startsWith("work-plan:") && !key.startsWith("plan-stage:"))
      assert.deepEqual(result.relations.get(key), set, key);
  // Oracle фикстуры: [вид цели, ID цели, текст пояснения] каждой связи документа DOC-2.
  const [kind, stageTarget, text] = (oracle.entities.D2.relations as string[][]).find(
    (relation) => relation[0] === "plan-stage",
  )!;
  const doc2 = result.records.get(`document:${oracle.entities.D2.id}`)!;
  assert(!("deleted" in doc2));
  assert.equal(
    markdown(
      (doc2.data.relations as { target: EntityRef; description: JsonValue }[]).find(
        (relation) => relation.target.kind === kind && relation.target.id === stageTarget,
      )!.description,
    ),
    text,
    "прикрепление документа к этапу сохранило точный текст",
  );
  const doc2Set = result.relations.get(`document:${oracle.entities.D2.id}`)!;
  const stageEdge = doc2Set.entries.find((entry) =>
    [address(entry.edge.from), address(entry.edge.to)].includes(`${kind}:${stageTarget}`),
  )!;
  assert.equal(stageEdge.edge.active, true);
  assert.equal(markdown(stageEdge.edge.description), text);
  // Конец связи — запись совместимости этапа, а не другая сущность.
  assert.equal(
    (result.records.get(`plan-stage:${stageTarget}`) as unknown as { data: { planId: string } })
      .data.planId,
    oracle.entities.P1.id,
  );
});

test("R4: равные rank упорядочены правилом старого reader на замороженной базе", async () => {
  const { state, source } = await historicalState(EQUAL_RANK);
  const oracle = JSON.parse(await readFile(join(FIXTURES, EQUAL_RANK, "oracle.json"), "utf8"));
  const stages = records(source, "plan-stage");
  assert(stages.every((stage) => stage.data!.rank === 5));
  const result = run(state).state;
  const plan = result.records.get(`work-plan:${oracle.plan.id}`)!;
  assert(!("deleted" in plan));
  const ids = (plan.data.stages as { id: string }[]).map((stage) => stage.id);
  assert.deepEqual(ids, oracle.oldReaderOrderAfter);
  assert.notDeepEqual(ids, [...ids].sort(), "порядок не совпадает с порядком кодовых точек");
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  assert.deepEqual(
    plan,
    expectedPlan(
      records(source, "work-plan")[0]!,
      (oracle.oldReaderOrderAfter as string[]).map((id) => byId.get(id)!),
    ),
  );
  assert.equal(
    markdown((plan.data as { goal: JsonValue }).goal),
    oracle.plan.goal,
    "Unicode и завершающие переводы строк сохранены",
  );
  // Правило не зависит от локали процесса: фиксированная коллация en.
  const sample = ["aa", "z", "ab", "B", "b", "A_1", "a-1"].map((id) => ({ rank: 0, id }));
  assert.deepEqual(
    [...sample].sort(compareStages).map((stage) => stage.id),
    ["A_1", "a-1", "aa", "ab", "b", "B", "z"],
  );
  assert.notDeepEqual(
    sample.map((stage) => stage.id).sort(new Intl.Collator("da").compare),
    [...sample].sort(compareStages).map((stage) => stage.id),
    "localeCompare без локали в da-DK дал бы другой порядок",
  );
});

test("R4: порядок этапов не зависит от локали процесса (C, ru_RU, da_DK, en_US)", async () => {
  const oracle = JSON.parse(await readFile(join(FIXTURES, EQUAL_RANK, "oracle.json"), "utf8"));
  const ids = [
    ...(oracle.oldReaderOrderAfter as string[]),
    "aa",
    "z",
    "ab",
    "B",
    "b",
    "A_1",
    "a-1",
  ];
  const module = pathToFileURL(
    join(import.meta.dirname, "../src/storage/data-model/transitions/planning-v1-to-v2.ts"),
  ).href;
  const code = `const { compareStages } = await import(${JSON.stringify(module)});
    const ids = ${JSON.stringify(ids)};
    console.log(JSON.stringify(ids.map((id) => ({ rank: 0, id })).sort(compareStages).map((s) => s.id)));`;
  const orders = ["C", "ru_RU.UTF-8", "da_DK.UTF-8", "en_US.UTF-8"].map((locale) =>
    execFileSync(
      process.execPath,
      ["--conditions=tasks-source", "--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, LANG: locale, LC_ALL: locale },
      },
    ).toString(),
  );
  assert.equal(new Set(orders).size, 1, orders.join(""));
  const order = JSON.parse(orders[0]!) as string[];
  assert.deepEqual(
    order.filter((id) => (oracle.oldReaderOrderAfter as string[]).includes(id)),
    oracle.oldReaderOrderAfter,
  );
});

// ---------- Синтетические сценарии отказа и границ ----------

const AT = "2026-09-24T10:00:00.000Z";
const LATER = "2026-09-25T10:00:00.000Z";
function entity(
  kind: string,
  id: string,
  data: Record<string, JsonValue>,
  extra: Partial<StoredRecord> = {},
): StoredRecord {
  return {
    schemaVersion: 3,
    dataVersion: 1,
    kind,
    id,
    revision: 2,
    key: ["release-snapshot", "release-snapshot-entry", "scope"].includes(kind)
      ? null
      : `${kind === "plan-stage" ? "STG" : kind === "work-plan" ? "PLN" : kind === "release" ? "REL" : "TASK"}-${id.replace(/\D/g, "") || "1"}`,
    aliases: [],
    data,
    createdAt: AT,
    createdBy: "alice",
    updatedAt: LATER,
    updatedBy: "bob",
    ...extra,
  } as StoredRecord;
}
const planData = (status = "active"): Record<string, JsonValue> => ({
  title: "План",
  summary: "",
  goal: [""],
  rationale: [""],
  boundaries: [""],
  expectedResult: [""],
  scope: [],
  participants: [],
  projectId: "PRJ",
  status,
  result: [""],
  startedAt: null,
  closedAt: null,
});
const stageData = (planId: string, rank: number, taskIds: string[]) => ({
  title: "Этап",
  summary: "",
  outcome: [""],
  completionConditions: [""],
  projectId: "PRJ",
  planId,
  rank,
  taskIds,
});
const taskRecord = (id: string) =>
  ({
    schemaVersion: 3,
    dataVersion: 1,
    kind: "task",
    id,
    revision: 1,
    key: `TASK-${id.replace(/\D/g, "")}`,
    aliases: [],
    data: {},
    createdAt: AT,
    createdBy: "alice",
    updatedAt: AT,
    updatedBy: "alice",
  }) as StoredRecord;
const edge = (
  id: string,
  from: EntityRef,
  to: EntityRef,
  options: { active?: boolean; slot?: string; description?: string[] } = {},
) => ({
  slot: options.slot ?? "planning-membership",
  edge: {
    id,
    type: "part-of",
    from,
    to,
    description: options.description ?? [""],
    revision: 1,
    source: "graph" as const,
    createdAt: AT,
    createdBy: "alice",
    active: options.active ?? true,
    updatedAt: AT,
    updatedBy: "alice",
  },
});
const set = (owner: EntityRef, entries: ReturnType<typeof edge>[]): RelationSet => ({
  schemaVersion: 1,
  owner,
  storage: "inline",
  entries,
});
/** Только проверка шага без текущих кодеков задач (синтетические задачи не полны). */
function apply(state: State) {
  const puts = new Map<string, StoredRecord>();
  const relations = new Map<string, RelationSet>();
  const removed: string[] = [];
  planningV1ToV2.apply(
    {
      records: (kind) => [...state.records.values()].filter((record) => record.kind === kind),
      relations: (owner) =>
        (structuredClone(state.relations.get(address(owner))) as unknown as JsonValue) ?? null,
      keyspaces: () => [],
      project: () => ({ id: state.projectId }),
    },
    {
      put: (record) => void puts.set(address(record), record),
      remove: (ref) => void removed.push(address(ref)),
      relations: (owner, value) =>
        void relations.set(address(owner), relationSetInlineV1.parse(value)),
      removeSource: () => assert.fail(),
      newId: (seed) => deterministicId(PLANNING_V1_TO_V2, seed),
    },
  );
  for (const record of puts.values())
    if (!("deleted" in record))
      assert(planningV1ToV2.outputs[record.kind]!.safeParse(record.data).success);
  return { puts, relations, removed };
}
const stateOf = (list: StoredRecord[], sets: RelationSet[] = []): State => ({
  records: new Map(list.map((record) => [address(record), record])),
  relations: new Map(sets.map((value) => [address(value.owner), value])),
  projectId: "PRJ",
});
function rejects(state: State, expected: [string, string | undefined, string | undefined][]) {
  let failure: unknown;
  assert.throws(
    () => apply(state),
    (error) => ((failure = error), error instanceof AppError),
  );
  assert.deepEqual(
    blockersOf(failure).map((item) => [item.code, item.owner, item.id]),
    expected,
  );
}

test("O3: повтор задачи в этапах одного плана и в двух текущих планах — блокер с ID", () => {
  rejects(
    stateOf([
      entity("work-plan", "W1", planData()),
      entity("plan-stage", "S1", stageData("W1", 0, ["T1"])),
      entity("plan-stage", "S2", stageData("W1", 1, ["T1"])),
      taskRecord("T1"),
    ]),
    [["STORAGE_MIGRATION_CONFLICT", "plan-stage", "S2"]],
  );
  rejects(
    stateOf([
      entity("work-plan", "W1", planData("active")),
      entity("work-plan", "W2", planData("draft")),
      entity("plan-stage", "S1", stageData("W1", 0, ["T1"])),
      entity("plan-stage", "S2", stageData("W2", 0, ["T1"])),
      taskRecord("T1"),
    ]),
    [["STORAGE_MIGRATION_CONFLICT", "work-plan", "W2"]],
  );
  // Закрытый и текущий план с одной задачей — корректная база (как WEB-1 в фикстуре).
  const ok = apply(
    stateOf([
      entity("work-plan", "W1", planData("completed")),
      entity("work-plan", "W2", planData("active")),
      entity("plan-stage", "S1", stageData("W1", 0, ["T1"])),
      entity("plan-stage", "S2", stageData("W2", 0, ["T1"])),
      taskRecord("T1"),
    ]),
  );
  assert.equal(ok.puts.size, 4);
});

test("Ссылки этапа: отсутствующий план, план v2, чужой проект, отсутствующая задача — блокеры", () => {
  const deletedTask = {
    ...taskRecord("T9"),
    deleted: { at: AT, actor: "alice" },
  } as unknown as StoredRecord;
  delete (deletedTask as Record<string, unknown>).data;
  rejects(
    stateOf([
      entity("work-plan", "W1", planData()),
      entity("work-plan", "W2", { ...planData(), stages: [] }, { dataVersion: 2 }),
      entity("plan-stage", "S1", stageData("W404", 0, [])),
      entity("plan-stage", "S2", stageData("W2", 0, [])),
      entity("plan-stage", "S3", { ...stageData("W1", 0, []), projectId: "OTHER" }),
      entity("plan-stage", "S4", stageData("W1", 1, ["T404", "T9"])),
      deletedTask,
    ]),
    [
      ["STORAGE_REFERENCE_BROKEN", "plan-stage", "S1"],
      ["STORAGE_MIGRATION_CONFLICT", "plan-stage", "S2"],
      ["STORAGE_REFERENCE_BROKEN", "plan-stage", "S3"],
      ["STORAGE_REFERENCE_BROKEN", "plan-stage", "S4"],
      ["STORAGE_REFERENCE_BROKEN", "plan-stage", "S4"],
    ],
  );
});

test("A12: отношения этапа — отзыв с прежними ID, новые включения, без дублей и без чужих слотов", () => {
  const plan = { kind: "work-plan", id: "W1" };
  const stage = { kind: "plan-stage", id: "S1" };
  const existing = edge("e-existing", { kind: "task", id: "T2" }, plan);
  const scope = edge("e-scope", plan, { kind: "project", id: "PRJ" }, { slot: "planning-scope" });
  const sources = [
    edge("e-stage", stage, plan),
    edge("e-t1", { kind: "task", id: "T1" }, stage, { description: ["Почему", "важно\r"] }),
    edge("e-t2", { kind: "task", id: "T2" }, stage),
    edge("e-old", { kind: "task", id: "T5" }, stage, { active: false }),
    edge("e-stale", { kind: "task", id: "T6" }, stage),
    edge("e-diag", { kind: "document", id: "D1" }, stage, { slot: "graph" }),
  ];
  const result = apply(
    stateOf(
      [
        entity("work-plan", "W1", planData()),
        entity("plan-stage", "S1", stageData("W1", 0, ["T1", "T2", "T3"])),
        taskRecord("T1"),
        taskRecord("T2"),
        taskRecord("T3"),
      ],
      [set(plan, [scope, existing]), set(stage, sources)],
    ),
  );
  const stageAfter = result.relations.get("plan-stage:S1")!.entries;
  assert.deepEqual(
    stageAfter.map((entry) => [entry.edge.id, entry.edge.active, entry.edge.revision]),
    [
      ["e-stage", false, 1],
      ["e-t1", false, 1],
      ["e-t2", false, 1],
      ["e-old", false, 1],
      ["e-stale", false, 1],
      ["e-diag", true, 1],
    ],
  );
  assert.deepEqual(stageAfter, expectedStageRelations(sources));
  const planAfter = result.relations.get("work-plan:W1")!.entries;
  assert.deepEqual(
    planAfter.slice(0, 2),
    [scope, existing],
    "существующее включение T2 не дублируется",
  );
  const added = planAfter.slice(2);
  assert.deepEqual(
    added.map((entry) => entry.edge.from.id),
    ["T1", "T3"],
  );
  const stageRecord = entity("plan-stage", "S1", stageData("W1", 0, [])) as SourceRecord;
  assert.deepEqual(
    (({ id: _id, ...rest }) => rest)(added[0]!.edge),
    expectedPlanMembership("T1", "W1", sources[1]!.edge, stageRecord),
  );
  assert.deepEqual(
    (({ id: _id, ...rest }) => rest)(added[1]!.edge),
    expectedPlanMembership("T3", "W1", undefined, stageRecord),
    "без прежнего ребра авторство — из оболочки этапа, не из часов",
  );
  assert.equal(
    added[0]!.edge.id,
    deterministicId(PLANNING_V1_TO_V2, "e-t1:part-of:task:T1:work-plan:W1"),
  );
});

test("Коллизия детерминированного ID связи — блокер, а не перезапись", () => {
  const plan = { kind: "work-plan", id: "W1" };
  const stage = { kind: "plan-stage", id: "S1" };
  const taken = deterministicId(PLANNING_V1_TO_V2, "e-t1:part-of:task:T1:work-plan:W1");
  rejects(
    stateOf(
      [
        entity("work-plan", "W1", planData()),
        entity("plan-stage", "S1", stageData("W1", 0, ["T1"])),
        taskRecord("T1"),
      ],
      [
        set(plan, [edge(taken, plan, { kind: "project", id: "PRJ" }, { slot: "planning-scope" })]),
        set(stage, [edge("e-t1", { kind: "task", id: "T1" }, stage)]),
      ],
    ),
    [["STORAGE_ADDRESS_COLLISION", "work-plan", taken]],
  );
});

test("A11: надгробия плана, этапа и релиза получают только новую dataVersion", () => {
  const tomb = (kind: string, id: string) => {
    const record = entity(kind, id, {}) as Record<string, unknown>;
    delete record.data;
    delete record.createdAt;
    delete record.createdBy;
    delete record.updatedAt;
    delete record.updatedBy;
    record.deleted = { at: AT, actor: "carol" };
    record.revision = 3;
    return record as unknown as StoredRecord;
  };
  const sources = [tomb("work-plan", "W1"), tomb("plan-stage", "S1"), tomb("release", "R1")];
  const result = apply(stateOf(sources));
  for (const record of sources)
    assert.deepEqual(result.puts.get(address(record)), expectedTombstone(record as SourceRecord));
});

test("R2: снимки выпуска сохраняются техническими записями; несвязные — блокер с ID", () => {
  const release = (snapshotId: string | null) => ({
    title: "Релиз",
    version: "1.0",
    summary: "",
    description: [""],
    planIds: ["W1"],
    plannedFor: "",
    projectId: "PRJ",
    status: snapshotId ? "released" : "planned",
    releasedAt: snapshotId ? AT : null,
    releasedBy: snapshotId ? "alice" : null,
    snapshotId,
  });
  const snapshot = (entryIds: string[], releaseId = "R1") =>
    entity("release-snapshot", "N1", {
      releaseId,
      capturedAt: AT,
      capturedBy: "alice",
      entryIds,
      planEntryIds: [],
      readiness: { total: 1, ready: 1, missing: 0, percent: 100, canRelease: true },
    });
  const item = (id: string, kind: string, source: string, revision: number) =>
    entity("release-snapshot-entry", id, {
      snapshotId: "N1",
      item: { kind, id: source, key: "TASK-1", revision, title: "x", reason: "y", content: ["#"] },
    });
  const base = [entity("work-plan", "W1", planData("completed")), taskRecord("T1")];

  // Снимок не удаляется и не меняется, даже если источник изменён после выпуска;
  // релиз теряет только snapshotId, принадлежность выражает releaseId снимка.
  const ok = apply(
    stateOf([
      ...base,
      entity("release", "R1", release("N1")),
      snapshot(["E1", "E2"]),
      item("E1", "task", "T1", 0),
      item("E2", "product", "passport", 0),
    ]),
  );
  assert.deepEqual(ok.removed, []);
  assert.deepEqual(
    [...ok.puts.keys()].filter((key) => key.startsWith("release-snapshot")),
    [],
  );
  const saved = ok.puts.get("release:R1")!;
  assert(!("deleted" in saved));
  assert(!("snapshotId" in saved.data));
  assert.equal(saved.data.status, "released");
  assert.equal(saved.data.releasedBy, "alice");
  // Снимок удалённого релиза (надгробие) — допустимое состояние, снимок сохраняется.
  const releaseTomb = {
    ...entity("release", "R1", {}),
    deleted: { at: AT, actor: "bob" },
  } as Record<string, unknown>;
  for (const field of ["data", "createdAt", "createdBy", "updatedAt", "updatedBy"])
    delete releaseTomb[field];
  const orphaned = apply(
    stateOf([
      ...base,
      releaseTomb as unknown as StoredRecord,
      snapshot(["E1"]),
      item("E1", "task", "T1", 1),
    ]),
  );
  assert.deepEqual(orphaned.removed, []);
  assert.deepEqual([...orphaned.puts.keys()], ["work-plan:W1", "release:R1"]);
  // Неизвестное поле снимка — повреждение, а не молчаливое сохранение.
  rejects(
    stateOf([
      ...base,
      entity("release", "R1", release("N1")),
      entity("release-snapshot", "N1", {
        ...(snapshot([]) as { data: Record<string, JsonValue> }).data,
        extra: 1,
      }),
    ]),
    [
      ["STORAGE_DATA_CORRUPT", "release-snapshot", "N1"],
      ["STORAGE_REFERENCE_BROKEN", "release", "R1"],
    ],
  );
  // Ссылка на отсутствующий снимок, сиротская запись, снимок чужого релиза, отношения снимка.
  rejects(stateOf([...base, entity("release", "R1", release("N404"))]), [
    ["STORAGE_REFERENCE_BROKEN", "release", "R1"],
  ]);
  rejects(stateOf([...base, item("E9", "task", "T1", 1)]), [
    ["STORAGE_REFERENCE_BROKEN", "release-snapshot-entry", "E9"],
  ]);
  rejects(
    stateOf([
      ...base,
      entity("release", "R1", release(null)),
      snapshot(["E1"]),
      item("E1", "task", "T1", 1),
    ]),
    [["STORAGE_REFERENCE_BROKEN", "release-snapshot", "N1"]],
  );
  rejects(
    stateOf(
      [...base, entity("release", "R1", release("N1")), snapshot([])],
      [set({ kind: "release-snapshot", id: "N1" }, [])],
    ),
    [["STORAGE_MIGRATION_CONFLICT", "release-snapshot", "N1"]],
  );
});

test("O2/R3: связь документа с прежним этапом читается и сохраняется, новое прикрепление запрещено", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const plans = new PlanningService(workspace);
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-INFRA", title: "Задача" }, requestId: "task" },
    "agent",
  );
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  const description = "Почему\r\nчитать";
  const doc = await engine.create(
    {
      data: {
        kind: "document",
        name: "Материал",
        summary: "",
        body: "Текст",
        documentKind: "description",
        relations: [{ target: task.ref, type: "references", description }],
      },
      requestId: "doc",
    },
    "agent",
  );
  // Состояние после миграции: запись совместимости этапа и сохранённая связь документа с ней.
  const root = dirname(new ProductRepository(workspace).root);
  const stageId = "Stage001";
  await mkdir(join(root, "entities/plan-stages"), { recursive: true });
  await writeFile(
    join(root, "entities/plan-stages", `${stageId}.json`),
    JSON.stringify({
      schemaVersion: 3,
      dataVersion: 2,
      kind: "plan-stage",
      id: stageId,
      revision: 2,
      key: "STG-1",
      aliases: [],
      data: { planId: plan.id },
      createdAt: AT,
      createdBy: "alice",
      updatedAt: LATER,
      updatedBy: "bob",
    }),
  );
  const docPath = join(root, "entities/documents", `${doc.ref.id}.json`);
  const disk = JSON.parse(await readFile(docPath, "utf8"));
  disk.data.relations[0].target = { kind: "plan-stage", id: stageId };
  await writeFile(docPath, JSON.stringify(disk));
  const setPath = join(root, "relations/documents", `${doc.ref.id}.json`);
  const relations = JSON.parse(await readFile(setPath, "utf8"));
  const attachment = relations.entries.find(
    (entry: { edge: { type: string } }) => entry.edge.type === "references",
  );
  attachment.edge.from = { kind: "plan-stage", id: stageId };
  await writeFile(setPath, JSON.stringify(relations));
  await new StorageService(workspace).reindex();

  // Граф и полный контекст показывают конец связи как прежний адрес этапа.
  const graph = new GraphService(workspace);
  const page = await graph.read({ root: doc.key });
  const node = page.nodes.find((entry) => entry.ref.kind === "plan-stage");
  assert.deepEqual(node && [node.ref.id, node.key, node.status], [stageId, "STG-1", "relocated"]);
  assert.equal(
    page.edges.find((entry) => entry.id === attachment.edge.id)?.description,
    description,
  );
  // Ссылка Web «связи цели» открывает граф от полного адреса прежнего этапа.
  const fromStage = await graph.read({ root: `plan-stage:${stageId}` });
  assert(fromStage.edges.some((entry) => entry.id === attachment.edge.id));
  await assert.rejects(graph.read({ root: "STG-1" }), { code: "ENTITY_NOT_FOUND" });
  // Публичный каталог и поиск не перечисляют технический вид.
  const listed = await engine.list({ q: "STG-1" });
  assert(!listed.items.some((item) => String(item.ref.kind) === "plan-stage"));
  const all = await engine.list({});
  assert(!all.items.some((item) => String(item.ref.kind) === "plan-stage"));

  // Обычное изменение документа сохраняет связь с прежним этапом без изменений.
  const edited = await engine.update(
    {
      ref: doc.key,
      ifRevision: doc.revision,
      requestId: "edit",
      changes: { kind: "document", name: "Материал 2" },
    },
    "agent",
  );
  const after = JSON.parse(await readFile(docPath, "utf8"));
  assert.deepEqual(after.data.relations, disk.data.relations);
  const afterSet = JSON.parse(await readFile(setPath, "utf8"));
  assert.deepEqual(
    afterSet.entries.find(
      (entry: { edge: { id: string } }) => entry.edge.id === attachment.edge.id,
    ),
    attachment,
  );
  // Повторное сохранение прикреплений с новым пояснением сохраняет ту же связь с этапом.
  const described = await engine.update(
    {
      ref: doc.key,
      ifRevision: edited.revision,
      requestId: "describe",
      changes: {
        kind: "document",
        relations: [
          {
            target: { kind: "plan-stage", id: stageId },
            type: "references",
            description: "Новое\r\nпояснение",
          },
        ],
      },
    },
    "agent",
  );
  const redescribed = JSON.parse(await readFile(setPath, "utf8")).entries.find(
    (entry: { edge: { id: string } }) => entry.edge.id === attachment.edge.id,
  );
  assert.deepEqual(
    [redescribed.edge.active, redescribed.edge.revision, redescribed.edge.description],
    [true, attachment.edge.revision + 1, ["Новое\r", "пояснение"]],
  );
  assert.deepEqual(JSON.parse(await readFile(docPath, "utf8")).data.relations[0].target, {
    kind: "plan-stage",
    id: stageId,
  });
  // Адресное чтение по refs: прежний этап пропускается, остальные refs читаются.
  const byRefs = await engine.list({ refs: [`plan-stage:${stageId}`, task.key] });
  assert.deepEqual(
    byRefs.items.map((item) => item.ref),
    [task.ref],
  );
  await assert.rejects(engine.list({ refs: ["plan-stage:Missing01"] }), {
    code: "ENTITY_NOT_FOUND",
  });
  // Новое прикрепление к этапу запрещено как при изменении, так и при создании.
  const after2 = JSON.parse(await readFile(docPath, "utf8"));
  await assert.rejects(
    engine.update(
      {
        ref: doc.key,
        ifRevision: described.revision,
        requestId: "attach",
        changes: {
          kind: "document",
          relations: [
            ...after2.data.relations.map((relation: { description: string[] }) => ({
              ...relation,
              description: relation.description.join("\n"),
            })),
            { target: { kind: "plan-stage", id: "Stage002" }, type: "documents", description: "" },
          ],
        },
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  await assert.rejects(
    engine.create(
      {
        data: {
          kind: "document",
          name: "Новый",
          summary: "",
          body: "Текст",
          documentKind: "description",
          relations: [
            { target: { kind: "plan-stage", id: stageId }, type: "references", description: "" },
          ],
        },
        requestId: "doc-2",
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
});

test("R2: релиз нельзя удалить каскадом со снимком; снимок со ссылкой на надгробие релиза допустим", async (t) => {
  const { workspace } = await fixture(t);
  const plan = await new PlanningService(workspace).create(
    { title: "План", requestId: "plan" },
    "agent",
  );
  const release = await new ReleasesService(workspace).create(
    { title: "Выпуск", version: "1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  const root = dirname(new ProductRepository(workspace).root);
  // Состояние после миграции: выпущенный релиз v2 и его снимок как технические записи v1.
  const releasePath = join(root, "entities/releases", `${release.id}.json`);
  const stored = JSON.parse(await readFile(releasePath, "utf8"));
  Object.assign(stored.data, { status: "released", releasedAt: AT, releasedBy: "alice" });
  await writeFile(releasePath, JSON.stringify(stored));
  const technical = (kind: string, id: string, data: Record<string, JsonValue>) => ({
    schemaVersion: 3,
    dataVersion: 1,
    kind,
    id,
    revision: 1,
    key: null,
    aliases: [],
    data,
    createdAt: AT,
    createdBy: "alice",
    updatedAt: AT,
    updatedBy: "alice",
  });
  const files = {
    [join(root, "entities/release-snapshots/Snap0001.json")]: technical(
      "release-snapshot",
      "Snap0001",
      {
        releaseId: release.id,
        capturedAt: AT,
        capturedBy: "alice",
        entryIds: ["Entry001"],
        planEntryIds: [],
        readiness: { total: 1, ready: 1, missing: 0, percent: 100, canRelease: true },
      },
    ),
    [join(root, "entities/release-snapshot-entries/Entry001.json")]: technical(
      "release-snapshot-entry",
      "Entry001",
      {
        snapshotId: "Snap0001",
        item: {
          kind: "document",
          id: "Doc00001",
          key: "DOC-1",
          revision: 1,
          title: "Документ",
          reason: "Прямой материал",
          content: ["Единственная копия\r", "текста", ""],
        },
      },
    ),
  };
  const bytes = new Map<string, string>();
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true });
    bytes.set(path, JSON.stringify(value, null, 2));
    await writeFile(path, bytes.get(path)!);
  }
  const storage = new StorageService(workspace);
  await storage.reindex();

  // Публичного удаления релиза нет: каскад не может затронуть снимок.
  await assert.rejects(
    new EntityDeletionService(workspace).preview({
      ref: release.id,
      kind: "release" as unknown as "task",
    }),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal("delete" in new ReleasesService(workspace), false);
  // Если релиз всё же стал надгробием (например, в исторической базе), снимок остаётся.
  const {
    data: _data,
    createdAt: _c,
    createdBy: _cb,
    updatedAt: _u,
    updatedBy: _ub,
    ...identity
  } = stored;
  await writeFile(
    releasePath,
    JSON.stringify({
      ...identity,
      revision: stored.revision + 1,
      deleted: { at: LATER, actor: "bob" },
    }),
  );
  // Удаление требует отозванных связей — как это делает штатное удаление сущности.
  const releaseSet = join(root, "relations/releases", `${release.id}.json`);
  const set = JSON.parse(await readFile(releaseSet, "utf8"));
  for (const entry of set.entries) entry.edge.active = false;
  await writeFile(releaseSet, JSON.stringify(set));
  for (const [path, content] of bytes)
    assert.equal(await readFile(path, "utf8"), content, "снимок сохранён побайтно");
  // Проверка целостности перестроением принимает снимок с releaseId на надгробие.
  await storage.reindex();
  const reopened = new EntityEngine(workspace);
  assert(
    !(await reopened.list({})).items.some((item) => String(item.ref.kind).startsWith("release-")),
  );
});
