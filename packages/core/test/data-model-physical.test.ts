/**
 * Составные физические переходы legacy → 4 и unified 1/2/3 → 4 (A03, A04, A10, A16).
 *
 * Каждый тест разворачивает замороженную фикстуру во временный каталог. Ожидания берутся из
 * независимого oracle фикстуры (`oracle.json`: ввод генератора и ответы старого CLI), а не из
 * результата самого перехода. Переход проверяется как чистое чтение: хеши исходного дерева
 * до и после равны, повторное чтение даёт тот же снимок.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import { AppError } from "../src/shared/errors.js";
import {
  physicalCatalog,
  productionTransitionRegistry,
} from "../src/storage/data-model/transitions/index.js";
import {
  physicalBlockers,
  physicalUnified1,
  physicalUnified2,
  physicalUnified3,
} from "../src/storage/data-model/transitions/physical-unified.js";
import { physicalLegacy } from "../src/storage/data-model/transitions/physical-legacy.js";
import { planningV1ToV2 } from "../src/storage/data-model/transitions/planning-v1-to-v2.js";
import { deterministicId } from "../src/storage/data-model/registry.js";
import type {
  ChangeSet,
  PhysicalSnapshot,
  PhysicalTransition,
  SnapshotView,
} from "../src/storage/data-model/types.js";
import { createFsSourceIo } from "../src/storage/migration/unified-sources.js";
import { frozenBase } from "./helpers/source-fixtures.js";

type Oracle = Record<string, unknown> & {
  entities: Record<string, Record<string, unknown>>;
  relations: Record<string, Record<string, unknown>>;
  deleted: { kind: string; id: string; key: string }[];
  aliases: Record<string, { previous: string[]; key: string }>;
};

const FIXTURES = join(import.meta.dirname, "fixtures/data-migrations");
const registry = productionTransitionRegistry();
const catalog = physicalCatalog(registry);
const text = (value: unknown) => (Array.isArray(value) ? value.join("\n") : value);
const address = (kind: string, id: string) => `${kind}:${id}`;

const CASES: Array<[string, PhysicalTransition]> = [
  ["legacy-c1c353f", physicalLegacy],
  ["legacy-5c7265b", physicalLegacy],
  ["physical1-90d7b26", physicalUnified1],
  ["physical2-plan-v1-43d683b", physicalUnified2],
  ["physical2-plan-v1-equal-rank-43d683b", physicalUnified2],
  ["physical2-v0.6.1-ec4a2cc", physicalUnified2],
  ["physical3-3875aee", physicalUnified3],
];

async function oracle(name: string): Promise<Oracle> {
  return JSON.parse(await readFile(join(FIXTURES, name, "oracle.json"), "utf8")) as Oracle;
}

async function hashes(root: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const visit = async (path: string) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        output.set(`${child}/`, "dir");
        await visit(child);
      } else
        output.set(
          child,
          createHash("sha256")
            .update(await readFile(join(root, child)))
            .digest("hex"),
        );
    }
  };
  await visit("");
  return output;
}

function io(root: string, transition: PhysicalTransition) {
  return createFsSourceIo({
    root,
    layout: transition.from,
    configName: "config.json",
    configPath: join(root, "config.json"),
    catalog,
  });
}

async function readFixture(
  t: TestContext,
  name: string,
  transition: PhysicalTransition,
): Promise<{ root: string; snapshot: PhysicalSnapshot }> {
  const { root } = await frozenBase(t, name);
  const before = await hashes(root);
  let checks = 0;
  const snapshot = await transition.read(io(root, transition), () => {
    checks++;
  });
  assert.ok(checks > 0, "переход проверяет владение замком");
  assert.deepEqual(await hashes(root), before, "переход не меняет исходное дерево");
  return { root, snapshot };
}

const records = (snapshot: PhysicalSnapshot) =>
  new Map(snapshot.records.map((record) => [address(record.kind, record.id), record]));
const live = (record: StoredRecord | undefined) => {
  assert(record, "запись существует");
  assert(!("deleted" in record), `${record.kind}:${record.id} не надгробие`);
  return record as Extract<StoredRecord, { data: unknown }>;
};

/** Сверка содержания с вводом генератора: точный текст, ключи, ссылки, комментарии. */
function checkEntity(
  alias: string,
  expected: Record<string, unknown>,
  byAddress: Map<string, StoredRecord>,
  deletedIds: Set<string>,
): void {
  const kind = String(expected.kind);
  const id = String(expected.id);
  if (deletedIds.has(id)) return;
  const record = live(byAddress.get(address(kind, id)));
  const data = record.data as Record<string, JsonValue>;
  const at = `${alias} ${kind}:${id}`;
  if (expected.key !== undefined && kind !== "project") assert.equal(record.key, expected.key, at);
  if (kind === "project") {
    assert.deepEqual(data.documentSections, expected.documentSections, at);
    return;
  }
  for (const field of [
    "name",
    "summary",
    "description",
    "body",
    "title",
    "goal",
    "rationale",
    "boundaries",
    "expectedResult",
    "result",
    "version",
    "plannedFor",
    "slug",
    "type",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "status",
    "column",
    "featureId",
    "applicationId",
    "scenarioId",
    "active",
    "parentId",
  ])
    if (expected[field] !== undefined)
      assert.deepEqual(text(data[field]), expected[field], `${at} ${field}`);
  for (const field of ["dependencies", "related", "planIds", "participants"])
    if (expected[field] !== undefined)
      assert.deepEqual(data[field], expected[field], `${at} ${field}`);
  if (expected.productLinks)
    assert.deepEqual(
      data.productLinks,
      (expected.productLinks as [string, string][]).map(([kind, id]) => ({ kind, id })),
      `${at} productLinks`,
    );
  if (expected.criteria) {
    const criteria = data.acceptanceCriteria as Record<string, JsonValue>[];
    assert.equal(criteria.length, (expected.criteria as unknown[]).length, `${at} criteria`);
    (expected.criteria as Record<string, unknown>[]).forEach((criterion, index) => {
      assert.equal(criteria[index]!.title, criterion.title, `${at} criterion`);
      assert.equal(text(criteria[index]!.description), criterion.description, `${at} criterion`);
      if (criterion.summary !== undefined)
        assert.equal(criteria[index]!.summary, criterion.summary, `${at} criterion summary`);
      if (criterion.completed !== undefined)
        assert.equal(Boolean(criteria[index]!.completed), criterion.completed, `${at} completed`);
    });
    if (expected.completedCriterionId)
      assert.equal(
        criteria.find((criterion) => criterion.id === expected.completedCriterionId)?.completed,
        true,
        `${at} completedCriterionId`,
      );
  }
  if (expected.comments) {
    const comments = (record.comments ?? []) as unknown as Record<string, JsonValue>[];
    const list = expected.comments as Record<string, unknown>[];
    assert.equal(comments.length, list.length, `${at} comments`);
    list.forEach((comment, index) => {
      const actual = comments[index]!;
      assert.equal(actual.title, comment.title, `${at} comment title`);
      assert.equal(text(actual.description), comment.description, `${at} comment text`);
      assert.equal(actual.actor, comment.actor, `${at} comment actor`);
      if (comment.actorRole) assert.equal(actual.actorRole, comment.actorRole, `${at} role`);
      if (comment.commentId) assert.equal(actual.id, comment.commentId, `${at} comment id`);
      assert.equal(actual.taskId, id, `${at} comment owner`);
    });
    const sequences = comments.map((comment) => Number(comment.sequence));
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
      `${at} order`,
    );
    assert.ok((record.commentSequence ?? 0) >= Math.max(0, ...sequences), `${at} sequence`);
  }
  if (expected.relations) {
    const relations = data.relations as Record<string, JsonValue>[];
    // Две формы oracle: {target, type, description} или [kind, id, description].
    const list = expected.relations as (Record<string, unknown> | [string, string, string])[];
    assert.equal(relations.length, list.length, `${at} relations`);
    list.forEach((relation, index) => {
      const actual = relations[index]!;
      const target = actual.target as { kind: string; id: string };
      if (Array.isArray(relation)) {
        assert.deepEqual([target.kind, target.id], relation.slice(0, 2), `${at} relation`);
        assert.equal(text(actual.description), relation[2], `${at} relation text`);
      } else {
        assert.deepEqual([target.kind, target.id], relation.target, `${at} relation`);
        assert.equal(actual.type, relation.type, `${at} relation type`);
        assert.equal(text(actual.description), relation.description, `${at} relation text`);
      }
    });
  }
  if (expected.relationCount !== undefined)
    assert.equal((data.relations as unknown[]).length, expected.relationCount, `${at} count`);
  if (expected.links)
    assert.deepEqual(
      (data.links as { kind: string; id: string }[]).map((link) => [link.kind, link.id]),
      expected.links,
      `${at} links`,
    );
  if (expected.scope && kind === "application") {
    const scope = live(
      byAddress.get(address("scope", String((expected.scope as { id: string }).id))),
    );
    assert.equal(scope.data.applicationId, id, `${at} scope`);
  }
}

for (const [name, transition] of CASES)
  test(`${name}: физический шаг проходит, сохраняет содержание по oracle и не меняет источник`, async (t) => {
    const { root, snapshot } = await readFixture(t, name, transition);
    const expected = await oracle(name);
    const byAddress = records(snapshot);
    for (const record of snapshot.records) {
      assert.equal(record.schemaVersion, 3);
      registry.validateRecord(record);
    }
    // Детерминизм: повторное чтение даёт тот же снимок.
    assert.deepEqual(await transition.read(io(root, transition), () => {}), snapshot);
    if (name.includes("equal-rank")) {
      const plan = live(
        byAddress.get(address("work-plan", String((expected.plan as { id: string }).id))),
      );
      assert.equal(plan.dataVersion, 1);
      for (const stage of expected.stages as { id: string; title: string; taskIds: string[] }[]) {
        const record = live(byAddress.get(address("plan-stage", stage.id)));
        assert.equal(record.dataVersion, 1);
        assert.equal(record.data.title, stage.title);
        assert.deepEqual(record.data.taskIds, stage.taskIds);
        assert.equal(record.data.planId, plan.id);
      }
      return;
    }
    const legacy = transition === physicalLegacy;
    const deletedIds = new Set(expected.deleted.map((entry) => entry.id));
    for (const [alias, entity] of Object.entries(expected.entities))
      checkEntity(alias, entity, byAddress, deletedIds);
    // Надгробия (единое хранилище) или резерв адреса без записи (legacy).
    const project = live(snapshot.records.find((record) => record.kind === "project"));
    for (const entry of expected.deleted) {
      const record = byAddress.get(address(entry.kind, entry.id));
      if (legacy) {
        assert.equal(record, undefined, `${entry.key} не оживает`);
        assert.ok(project.reservedKeys?.includes(entry.key), `${entry.key} зарезервирован`);
      } else {
        assert(record && "deleted" in record, `${entry.key} остаётся надгробием`);
        assert.equal(record.key, entry.key);
      }
    }
    for (const [id, alias] of Object.entries(expected.aliases)) {
      const record = snapshot.records.find((entry) => entry.id === id);
      assert(record, id);
      assert.equal(record.key, alias.key);
      for (const key of alias.previous) assert.ok(record.aliases.includes(key), `${id} ${key}`);
    }
    // Отношения: ID, активность, точный текст описания; сегментированный набор целиком.
    const edges = new Map<
      string,
      { owner: string; slot: string; edge: Record<string, JsonValue> }
    >();
    for (const set of snapshot.relations)
      for (const entry of (
        set.value as { entries: { slot: string; edge: Record<string, JsonValue> }[] }
      ).entries)
        edges.set(String(entry.edge.id), {
          owner: address(set.owner.kind, set.owner.id),
          slot: entry.slot,
          edge: entry.edge,
        });
    for (const key of ["diagnosticActive", "diagnosticRevoked"]) {
      const relation = expected.relations[key]!;
      const edge = edges.get(String(relation.id));
      assert(edge, `${key} ${String(relation.id)}`);
      assert.equal(edge.edge.active, relation.active);
      assert.equal(edge.edge.type, relation.type);
      assert.deepEqual(
        [(edge.edge.from as { kind: string }).kind, (edge.edge.from as { id: string }).id],
        relation.from,
      );
      if (relation.description !== undefined)
        assert.equal(text(edge.edge.description), relation.description);
    }
    const segmented = expected.relations.segmentedOwner;
    if (segmented) {
      const from = segmented.from as [string, string];
      const bulk = [...edges.values()].filter(
        (entry) =>
          entry.owner === address(from[0], from[1]) && String(entry.edge.type).startsWith("bulk-"),
      );
      assert.equal(bulk.length, segmented.diagnosticCount);
      const first = bulk.find((entry) => entry.edge.type === segmented.firstType);
      assert.equal(text(first?.edge.description), segmented.firstDescription);
    }
    // Удаление только по правилу: категории распознанных структур.
    const categories = new Set(snapshot.removeSources.map((entry) => entry.category));
    const allowed = new Set([
      "converted-source",
      "derived-index",
      "legacy-receipts",
      "task-activity-journal",
      "graph-history",
      "operation-journal",
      "history-journal",
      "journal-writer-state",
    ]);
    for (const category of categories) assert.ok(allowed.has(category), category);
    if (transition === physicalUnified1) assert.ok(categories.has("operation-journal"));
    if (transition === physicalUnified2) assert.ok(categories.has("history-journal"));
    if (transition === physicalUnified3) {
      assert.ok(snapshot.removed["record-receipts"]! > 0);
      assert.ok(snapshot.removed["planning-events"]! > 0);
    }
    for (const source of snapshot.removeSources)
      assert.ok(!source.path.startsWith("entities/"), "записи не удаляются физическим шагом");
  });

test("legacy-5c7265b: перенос legacy удаляет только распознанные квитанции и журналы", async (t) => {
  const { snapshot } = await readFixture(t, "legacy-5c7265b", physicalLegacy);
  const byCategory = (category: string) =>
    snapshot.removeSources
      .filter((entry) => entry.category === category)
      .map((entry) => entry.path);
  assert.ok(byCategory("legacy-receipts").every((path) => /\/(receipts|requests)\//.test(path)));
  assert.ok(byCategory("graph-history").every((path) => path.startsWith("relations/history/")));
  assert.ok(byCategory("task-activity-journal").every((path) => path.startsWith("task-activity/")));
  assert.ok(byCategory("derived-index").every((path) => path.includes(".indexes/")));
  assert.equal(snapshot.config && "projectSettings" in (snapshot.config as object), false);
  assert.equal(snapshot.productId, "fnWE4i8g");
  // Управляемые рёбра — детерминированные ID и время из данных владельца, без часов.
  const managed = snapshot.relations.flatMap((set) =>
    (set.value as { entries: { slot: string; edge: Record<string, JsonValue> }[] }).entries.filter(
      (entry) => entry.edge.createdBy === "relay",
    ),
  );
  assert.ok(managed.length > 0);
  const times = new Set(snapshot.records.flatMap((r) => ("updatedAt" in r ? [r.updatedAt] : [])));
  for (const entry of managed) assert.ok(times.has(String(entry.edge.createdAt)));
  const passport = managed.find((entry) => entry.slot === "product-links")!;
  assert.equal(
    passport.edge.id,
    deterministicId(
      "physical.legacy-to-4",
      `product:passport|product-links|${JSON.stringify(["part-of", "product:passport", "project:fnWE4i8g"])}|1`,
    ),
  );
});

test("physical2-plan-v1-43d683b: записи в исходных версиях подходят предметному переходу planning v1→v2", async (t) => {
  const { snapshot } = await readFixture(t, "physical2-plan-v1-43d683b", physicalUnified2);
  const expected = await oracle("physical2-plan-v1-43d683b");
  const present = new Map<string, Set<number>>();
  for (const record of snapshot.records)
    present.set(record.kind, (present.get(record.kind) ?? new Set()).add(record.dataVersion));
  for (const kind of [
    "work-plan",
    "release",
    "plan-stage",
    "release-snapshot",
    "release-snapshot-entry",
  ])
    assert.deepEqual([...present.get(kind)!], [1], kind);
  assert.deepEqual(
    registry.plan(present).map((step) => step.id),
    [planningV1ToV2.id],
  );
  // Прежнее тело DOC-4 живёт только в снимке выпуска: снимки не удаляются физическим шагом.
  const d4 = expected.entities.D4!;
  const entries = snapshot.records.filter((record) => record.kind === "release-snapshot-entry");
  assert.ok(
    entries.some((record) =>
      JSON.stringify("data" in record ? record.data : null).includes(
        JSON.stringify(String(d4.bodyOnlyInReleaseSnapshot).split("\n")[0]).slice(1, -1),
      ),
    ),
  );
  // Выход физического шага проходит предметный шаг без исключений и проверок вне снимка.
  const frozen = snapshot.records.map((record) => Object.freeze(structuredClone(record)));
  const relations = new Map(
    snapshot.relations.map((set) => [address(set.owner.kind, set.owner.id), set.value]),
  );
  const view: SnapshotView = {
    records: (kind) => frozen.filter((record) => record.kind === kind),
    relations: (owner) => structuredClone(relations.get(address(owner.kind, owner.id)) ?? null),
    keyspaces: () => snapshot.keyspaces,
    project: () => ({ id: frozen.find((record) => record.kind === "project")?.id ?? null }),
  };
  const puts: StoredRecord[] = [];
  const changes: ChangeSet = {
    put: (record) => void puts.push(record),
    remove: () => {},
    relations: () => {},
    removeSource: () => {},
    newId: (seed) => deterministicId(planningV1ToV2.id, seed),
  };
  planningV1ToV2.apply(view, changes);
  const plans = puts.filter((record) => record.kind === "work-plan");
  assert.equal(plans.length, 3);
  for (const record of plans) assert.equal(record.dataVersion, 2);
});

test("Синтетический legacy relations.json (граф v1): рёбра и их ID переносятся", async (t) => {
  // SYNTHETIC: ни один коммит истории не писал relations.json, но прежний reader его читал
  // (graph-migration.ts readLegacyGraph). База — legacy-5c7265b, граф v2 заменён на v1,
  // собранный по замороженной схеме legacyGraphSchema из тех же текущих рёбер.
  const { root } = await frozenBase(t, "legacy-5c7265b");
  const current: Record<string, JsonValue>[] = [];
  const shards = await readdir(join(root, "relations/current"));
  for (const shard of shards)
    for (const file of await readdir(join(root, "relations/current", shard)))
      current.push(
        JSON.parse(await readFile(join(root, "relations/current", shard, file), "utf8")) as Record<
          string,
          JsonValue
        >,
      );
  const graph = {
    schemaVersion: 1,
    revision: current.length,
    edges: current.filter((record) => record.active).map((record) => record.edge),
    events: current.map((record) => ({
      action: "add",
      revision: 1,
      actor: "fixture-author",
      at: (record.edge as { createdAt: string }).createdAt,
      edge: record.edge,
    })),
    requests: {},
  };
  await rm(join(root, "relations"), { recursive: true });
  await writeFile(join(root, "relations.json"), JSON.stringify(graph));
  let snapshot: PhysicalSnapshot;
  try {
    snapshot = await physicalLegacy.read(io(root, physicalLegacy), () => {});
  } catch (error) {
    // Форма события v1 задаётся текущей схемой graphEventSchema; несовпадение — дефект синтетики.
    assert.fail(`${(error as Error).message} ${JSON.stringify(physicalBlockers(error))}`);
  }
  const ids = new Set(
    snapshot.relations.flatMap((set) =>
      (set.value as { entries: { edge: { id: string } }[] }).entries.map((entry) => entry.edge.id),
    ),
  );
  for (const record of current) assert.ok(ids.has((record.edge as { id: string }).id));
  assert.ok(snapshot.removeSources.some((entry) => entry.path === "relations.json"));
});

/** Повреждения блокируют переход; исходные файлы не меняются (A16). */
const corruptions: Array<
  [string, string, PhysicalTransition, (root: string) => Promise<void>, string]
> = [
  [
    "неизвестный файл в каталоге записей",
    "physical3-3875aee",
    physicalUnified3,
    (root) => writeFile(join(root, "entities/tasks/notes.txt"), "заметка"),
    "STORAGE_FORMAT_UNKNOWN",
  ],
  [
    "неизвестная коллекция",
    "physical3-3875aee",
    physicalUnified3,
    async (root) => {
      await mkdir(join(root, "entities/widgets"));
      await writeFile(join(root, "entities/widgets/x.json"), "{}");
    },
    "UNKNOWN_ENTITY_KIND",
  ],
  [
    "некорректный UTF-8 в записи",
    "physical1-90d7b26",
    physicalUnified1,
    async (root) => {
      const directory = join(root, "entities/features");
      const [file] = (await readdir(directory)).sort();
      await writeFile(join(directory, file!), Buffer.from([0x7b, 0xff, 0x7d]));
    },
    "STORAGE_DATA_CORRUPT",
  ],
  [
    "конфликт комментариев с одним ID",
    "physical3-3875aee",
    physicalUnified3,
    async (root) => {
      const directory = join(root, "entities/tasks");
      for (const file of await readdir(directory)) {
        const raw = JSON.parse(await readFile(join(directory, file), "utf8"));
        if (!raw.comments?.length) continue;
        raw.comments.push({ ...raw.comments[0], title: "Другое содержание" });
        await writeFile(join(directory, file), JSON.stringify(raw));
        return;
      }
    },
    "STORAGE_MIGRATION_CONFLICT",
  ],
  [
    "потерянный файл журнала",
    "physical2-v0.6.1-ec4a2cc",
    physicalUnified2,
    async (root) => {
      const [stream] = await readdir(join(root, "history"));
      const [file] = await readdir(join(root, "history", stream!));
      await rm(join(root, "history", stream!, file!));
    },
    "STORAGE_RECORD_MISSING",
  ],
  [
    "неизвестный файл в legacy-доске",
    "legacy-5c7265b",
    physicalLegacy,
    (root) => writeFile(join(root, "boards/web/notes.md"), "# заметка"),
    "STORAGE_FORMAT_UNKNOWN",
  ],
  [
    "потерянная связь legacy-графа",
    "legacy-5c7265b",
    physicalLegacy,
    async (root) => {
      const [shard] = (await readdir(join(root, "relations/current"))).sort();
      const [file] = await readdir(join(root, "relations/current", shard!));
      await rm(join(root, "relations/current", shard!, file!));
    },
    "STORAGE_RECORD_MISSING",
  ],
  [
    "лента комментариев без задачи",
    "legacy-5c7265b",
    physicalLegacy,
    async (root) => {
      await mkdir(join(root, "task-activity/ZZZZZZZZ"), { recursive: true });
      await writeFile(
        join(root, "task-activity/ZZZZZZZZ/meta.json"),
        JSON.stringify({ version: 1, sequence: 1 }),
      );
    },
    "STORAGE_REFERENCE_BROKEN",
  ],
];

for (const [label, name, transition, corrupt, code] of corruptions)
  test(`A16: ${label} блокирует физический шаг (${code}) без изменения источника`, async (t) => {
    const { root } = await frozenBase(t, name);
    await corrupt(root);
    const before = await hashes(root);
    await assert.rejects(
      transition.read(io(root, transition), () => {}),
      (error: unknown) => {
        assert(error instanceof AppError, String(error));
        const blockers = physicalBlockers(error) ?? [];
        assert.ok(
          error.code === code || blockers.some((blocker) => blocker.code === code),
          `${error.code} ${JSON.stringify(blockers)}`,
        );
        return true;
      },
    );
    assert.deepEqual(await hashes(root), before);
  });

test("Утрата замка прерывает физический шаг", async (t) => {
  const { root } = await frozenBase(t, "physical1-90d7b26");
  const lost = new Error("Замок потерян");
  let calls = 0;
  await assert.rejects(
    physicalUnified1.read(io(root, physicalUnified1), () => {
      if (++calls > 5) throw lost;
    }),
    (error) => error === lost,
  );
});

test("Модули физических переходов не обращаются к ФС, часам и случайным ID", async () => {
  for (const file of ["physical-unified.ts", "physical-legacy.ts"]) {
    const source = await readFile(
      join(import.meta.dirname, "../src/storage/data-model/transitions", file),
      "utf8",
    );
    for (const forbidden of [
      /from "node:fs/,
      /from "\.\.\/\.\.\/files\.js"/,
      /new Date\(/,
      /Date\.now/,
      /randomUUID/,
      /Math\.random/,
    ])
      assert.ok(!forbidden.test(source), `${file}: ${forbidden}`);
  }
  assert.deepEqual(
    ["legacy", "unified-1", "unified-2", "unified-3"].map(
      (layout) => registry.physicalFrom(layout as never)?.id,
    ),
    [physicalLegacy.id, physicalUnified1.id, physicalUnified2.id, physicalUnified3.id],
  );
});

for (const [name, transition] of [
  ["physical1-90d7b26", physicalUnified1],
  ["physical2-v0.6.1-ec4a2cc", physicalUnified2],
] as const)
  test(`${name}: комментарии журнала задачи, удалённой до переноса, остаются в надгробии`, async (t) => {
    // Синтетика поверх замороженной базы: задача T1 с тремя комментариями журнала заменена
    // надгробием той же формы, что писало удаление формата 1/2. Ожидание — ввод генератора (oracle).
    const { root } = await frozenBase(t, name);
    const expected = await oracle(name);
    const task = expected.entities.T1!;
    const path = join(root, "entities/tasks", `${String(task.id)}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, JsonValue>;
    const tombstone = {
      schemaVersion: 1,
      dataVersion: 1,
      kind: "task",
      id: raw.id,
      revision: Number(raw.revision) + 1,
      key: raw.key,
      aliases: raw.aliases,
      deleted: { at: "2026-10-06T23:00:00.000Z", actor: "fixture-author" },
    };
    await writeFile(path, JSON.stringify(tombstone));
    const snapshot = await transition.read(io(root, transition), () => {});
    const record = snapshot.records.find((entry) => entry.kind === "task" && entry.id === task.id);
    assert(record && "deleted" in record, "надгробие сохраняется");
    registry.validateRecord(record);
    const comments = (record.comments ?? []) as unknown as Record<string, JsonValue>[];
    const list = task.comments as Record<string, unknown>[];
    assert.deepEqual(
      comments.map((comment) => [
        comment.id,
        comment.title,
        comment.actor,
        text(comment.description),
      ]),
      list.map((comment) => [comment.commentId, comment.title, comment.actor, comment.description]),
    );
    assert.ok(
      (record.commentSequence ?? 0) >= Math.max(...comments.map((c) => Number(c.sequence))),
    );
    assert.equal(snapshot.removed["deleted-task-comments"], undefined);
  });
