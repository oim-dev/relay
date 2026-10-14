import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  entitiesPageSchema,
  entitiesQuerySchema,
  entityDetailSchema,
  entityMatchSchema,
} from "@relay/contracts/entities";
import type {
  CreateEntity,
  EntitiesQuery,
  EntityRef,
  EntitySummary,
} from "@relay/contracts/entities";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { compareEntitySummaries } from "../src/application/entities/query.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { ProductRepository } from "../src/storage/product.js";
import { ProductService } from "../src/application/product/service.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { forgetStorageSegments } from "../src/storage/entity-store/hash-index.js";
import { AppError } from "../src/shared/errors.js";
import { fixture } from "./helpers/workspace.js";

const body = (marker: string) =>
  `# Знание\r\n\n  ${marker} 🧪 雪\t  \n\n\`\`\`\nне команда\n\`\`\`\n`;
async function seed(t: TestContext) {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  let n = 0;
  const create = (data: CreateEntity["data"]) =>
    engine.create({ data, requestId: `create-${++n}` }, "creator");
  const product = await create({
    kind: "product",
    name: "Паспорт",
    summary: "Аннотация",
    description: body("DESC_PRODUCT"),
  });
  const feature = await create({
    kind: "feature",
    name: "Требование",
    summary: "Сводка",
    description: body("DESC_FEATURE"),
  });
  const scenario = await create({
    kind: "scenario",
    name: "Действие",
    featureId: feature.key,
    description: body("DESC_SCENARIO"),
  });
  const application = await create({
    kind: "application",
    name: "Приложение",
    slug: "client",
    prefix: "CLI",
    type: "frontend",
    summary: "Клиент",
    description: body("DESC_APPLICATION"),
  });
  const fi = await create({
    kind: "implementation",
    application: application.key,
    target: feature.key,
    title: "Вклад",
    description: body("DESC_FI"),
    status: "done",
  });
  const si = await create({
    kind: "implementation",
    application: application.key,
    target: scenario.key,
    title: "Вклад",
    description: body("DESC_SI"),
  });
  const task = await create({
    kind: "task",
    board: "BOARD-PRODUCT",
    title: "Работа",
    targets: [feature.key],
    description: body("DESC_TASK"),
    acceptanceCriteria: [{ title: "Не искать критерии", description: "CRITERION_ONLY" }],
  });
  const document = await create({
    kind: "document",
    name: "Материал",
    summary: "Когда читать",
    body: body("BODY_DOCUMENT"),
    documentKind: "description",
    sectionId: null,
  });
  await create({
    kind: "document",
    name: "В разделе",
    summary: "",
    body: "Иное содержание",
    documentKind: "description",
    sectionId: "product",
  });
  const plans = new PlanningService(workspace);
  const savedPlan = await plans.create(
    { requestId: "plan", title: "План", goal: body("GOAL_PLAN") },
    "creator",
  );
  const plan = { ...savedPlan, ref: { kind: "work-plan" as const, id: savedPlan.id } };
  const releases = new ReleasesService(workspace);
  const savedRelease = await releases.create(
    {
      requestId: "release",
      title: "Выпуск",
      version: "VERSION_RELEASE",
      description: body("DESC_RELEASE"),
      planIds: [plan.ref.id],
    },
    "creator",
  );
  const release = { ...savedRelease, ref: { kind: "release" as const, id: savedRelease.id } };
  return {
    workspace,
    engine,
    create,
    product,
    feature,
    scenario,
    application,
    fi,
    si,
    task,
    document,
    plan,
    release,
    plans,
  };
}

test("S-01: явные поля всех видов, сохранность Markdown, новые схемы и отсутствие поиска критериев", async (t) => {
  const f = await seed(t);
  for (const [marker, saved] of [
    ["DESC_PRODUCT", f.product],
    ["DESC_FEATURE", f.feature],
    ["DESC_SCENARIO", f.scenario],
    ["DESC_APPLICATION", f.application],
    ["DESC_FI", f.fi],
    ["DESC_SI", f.si],
    ["DESC_TASK", f.task],
    ["BODY_DOCUMENT", f.document],
    ["GOAL_PLAN", f.plan],
    ["VERSION_RELEASE", f.release],
    ["DESC_RELEASE", f.release],
  ] as const) {
    const page = entitiesPageSchema.parse(await f.engine.list({ q: marker.toLowerCase() }));
    assert.equal(page.total, 1, marker);
    assert.deepEqual(page.items[0]!.ref, saved.ref, marker);
    assert(!JSON.stringify(page).includes(body(marker)), "Полное тело не входит в краткую выдачу");
  }
  assert.equal((await f.engine.list({ q: "CRITERION_ONLY" })).total, 0);
  const detail = entityDetailSchema.parse(await f.engine.get({ ref: f.feature.key }));
  assert.equal(detail.data.kind === "feature" && detail.data.description, body("DESC_FEATURE"));
  assert.equal(detail.metadata?.createdBy, "creator");
  const { metadata: _metadata, ...oldResponse } = detail;
  assert.deepEqual(entityDetailSchema.parse(oldResponse), oldResponse);
  assert(!entityDetailSchema.safeParse({ ...detail, metadata: { updatedBy: "x" } }).success);
  assert(!entitiesQuerySchema.safeParse({ implementationTarget: "FI" }).success);
});

test("S-02/APP-06/FTR-02/04/SC-02/05/IMP-05: собственные даты, обновление и независимые FI/SI", async (t) => {
  const f = await seed(t);
  for (const saved of [f.product, f.feature, f.scenario, f.application, f.fi, f.si]) {
    const detail = await f.engine.get({ ref: saved.key });
    const record = await f.workspace.locked(() => f.workspace.storageSession!.get(saved.ref));
    const { createdAt, createdBy, updatedAt, updatedBy } = record;
    assert.deepEqual(detail.metadata, { createdAt, createdBy, updatedAt, updatedBy });
    if (saved.ref.kind === "implementation") assert.equal(detail.savedStatus, record.data.status);
    else assert.equal(detail.savedStatus, undefined);
    assert.equal(
      (await f.engine.list({ refs: [saved.key], sort: "updated" })).items[0]!.updatedAt,
      updatedAt,
    );
  }
  // Собственная правка FI не меняет метаданные SI, даже когда общий scope изменён.
  const siBefore = (await f.engine.get({ ref: f.si.key })).metadata;
  const fiDetail = await f.engine.get({ ref: f.fi.key });
  assert.equal(fiDetail.savedStatus, "done");
  assert.equal(fiDetail.data.kind === "implementation" && fiDetail.data.status, "none");
  await f.engine.update(
    {
      ref: f.fi.key,
      ifRevision: f.fi.revision,
      requestId: "fi-update",
      changes: { kind: "implementation", description: "Новая версия вклада" },
    },
    "editor",
  );
  assert.deepEqual((await f.engine.get({ ref: f.si.key })).metadata, siBefore);
  const sorted = await f.engine.list({ kind: "implementation", sort: "updated" });
  assert.equal(sorted.items[0]!.key, f.fi.key);
  assert.equal((await f.engine.get({ ref: f.fi.key })).metadata?.updatedBy, "editor");
  const all = await f.engine.list({ sort: "updated", limit: 100 });
  assert(
    all.items.every((item) => item.updatedAt),
    "Все сохранённые текущие виды имеют собственную дату",
  );
  for (let i = 1; i < all.items.length; i++)
    assert(compareEntitySummaries(all.items[i - 1]!, all.items[i]!, "updated") <= 0);
  for (const saved of [f.feature, f.scenario, f.application]) {
    const detail = await f.engine.get({ ref: saved.key });
    assert(["feature", "scenario", "application"].includes(detail.data.kind));
    await f.engine.update(
      {
        ref: saved.key,
        ifRevision: detail.revision,
        requestId: `update-${saved.key}`,
        changes: {
          kind: detail.data.kind as "feature" | "scenario" | "application",
          description: "Изменённое содержание",
        },
      },
      "editor",
    );
    assert.equal((await f.engine.list({ sort: "updated" })).items[0]!.key, saved.key);
  }
  const original = all.items[0]!;
  const same: EntitySummary[] = [
    { ...original, ref: { kind: "feature", id: "Z" }, updatedAt: "2026-01-01T00:00:00.000Z" },
    { ...original, ref: { kind: "feature", id: "A" }, updatedAt: "2026-01-01T00:00:00.000Z" },
    { ...original, ref: { kind: "feature", id: "B" }, updatedAt: undefined },
  ];
  assert.deepEqual(
    same.sort((a, b) => compareEntitySummaries(a, b, "updated")).map((item) => item.ref.id),
    ["A", "Z", "B"],
  );
});

test("S-03/IMP-02/03: применимость, FI/SI независимо от ключей, адреса и страницы", async (t) => {
  const f = await seed(t);
  await f.engine.rename(
    { ref: f.fi.key, ifRevision: f.fi.revision, key: "CUSTOM-IMPL", requestId: "rename" },
    "editor",
  );
  const fi = (await f.engine.list({ implementationTarget: "feature" })).items;
  assert.equal(fi.length, 1);
  assert.equal(fi[0]!.key, "CUSTOM-IMPL");
  assert.deepEqual(fi[0]!.implementation, {
    type: "FI",
    application: { ref: f.application.ref, key: f.application.key, title: "Приложение" },
    target: { ref: f.feature.ref, key: f.feature.key, title: "Требование" },
  });
  assert.equal(
    (await f.engine.list({ implementationTarget: "scenario" })).items[0]!.implementation?.type,
    "SI",
  );
  assert.equal((await f.engine.get({ ref: f.fi.key })).implementation?.type, "FI");
  assert.equal((await f.engine.list({ q: f.feature.key, kind: "implementation" })).total, 1);
  const none = await f.engine.list({ section: "none" });
  assert.deepEqual(
    none.items.map((item) => item.ref),
    [f.document.ref],
  );
  assert.equal((await f.engine.list({ active: "true" })).total, 2);
  assert.equal((await f.engine.list({ active: "false" })).total, 0);
  assert.equal((await f.engine.list({ active: "true", section: "none" })).total, 0);
  await assert.rejects(f.engine.list({ kind: "task", implementationTarget: "feature" }), {
    code: "UNSUPPORTED_ENTITY_FILTER",
  });
  await assert.rejects(f.engine.list({ kind: "feature", section: "none" }), {
    code: "UNSUPPORTED_ENTITY_FILTER",
  });
  const first = await f.engine.list({ active: "true", limit: 1 });
  const second = await f.engine.list({
    active: "true",
    limit: 1,
    offset: first.nextOffset!,
    version: first.version,
  });
  assert.notEqual(first.items[0]!.key, second.items[0]!.key);
  assert.equal(second.nextOffset, null);
  await f.engine.update(
    {
      ref: f.feature.key,
      ifRevision: f.feature.revision,
      requestId: "change",
      changes: { kind: "feature", summary: "Новая сводка" },
    },
    "editor",
  );
  await assert.rejects(
    f.engine.list({ active: "true", offset: 1, limit: 1, version: first.version }),
    { code: "ENTITIES_CHANGED" },
  );
  await assert.rejects(f.engine.list({ refs: [f.feature.key, "UNKNOWN"] }), {
    code: "ENTITY_NOT_FOUND",
  });
  const product = new ProductService(f.workspace);
  const state = await product.state();
  const scope = state.records.find((record) => record.fields.kind === "scope")!;
  await product.mutate(
    {
      action: "update",
      id: scope.id,
      ifRevision: scope.revision,
      ifVersion: state.version,
      requestId: "remove-participation",
      fields: { kind: "scope", applicationId: f.application.ref.id, contracts: [] },
    },
    "editor",
  );
  const inactive = await f.engine.list({ active: "false" });
  assert.equal(inactive.total, 2);
  assert(inactive.items.every((item) => item.ref.kind === "implementation" && !item.active));
  assert.equal((await f.engine.list({ active: "true" })).total, 0);
});

test("D-05: узкий каталог читает только кандидатов; прежние индексы и dirty-результат эквивалентны", async (t) => {
  const f = await seed(t);
  const queries: EntitiesQuery[] = [
    {},
    { q: "DESC_" },
    { kind: "feature", sort: "updated" },
    { active: "true" },
    { implementationTarget: "scenario" },
    { application: f.application.key },
    { target: f.feature.key },
    { section: "none" },
    { archived: "false" },
    { refs: [f.feature.key, f.si.key] },
  ];
  for (const query of queries) {
    const { version: _indexed, ...actual } = await f.engine.list(query);
    const logical = await f.workspace.locked(async () => {
      const changed = t.mock.getter(f.workspace.storageSession!, "changed", () => true);
      try {
        return await f.engine.list(query);
      } finally {
        changed.mock.restore();
      }
    });
    const { version: _logical, ...expected } = logical;
    assert.deepEqual(actual, expected, JSON.stringify(query));
  }
  forgetStorageSegments(f.workspace.dataRoot);
  const files = new Set<string>();
  const scans: string[] = [];
  const original = StorageSession.prototype.readFile;
  const read = t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      if (path.startsWith("entities/")) files.add(path);
      return original.call(this, path);
    },
  );
  const originalEntries = StorageSession.prototype.indexEntries;
  const entries = t.mock.method(
    StorageSession.prototype,
    "indexEntries",
    async function (this: StorageSession, index: string) {
      scans.push(index);
      return originalEntries.call(this, index);
    },
  );
  const snapshot = t.mock.method(ProductRepository.prototype, "snapshot", () =>
    assert.fail("Общий продуктовый снимок не нужен"),
  );
  try {
    const page = await f.engine.list({ kind: "feature", q: "DESC_FEATURE", limit: 1 });
    assert.equal(page.total, 1);
    assert.deepEqual([...files], [`entities/features/${f.feature.ref.id}.json`]);
    assert.deepEqual(scans, ["records"]);
    t.diagnostic(
      JSON.stringify({
        candidateBodies: files.size,
        scans,
        dtoBytes: Buffer.byteLength(JSON.stringify(page)),
      }),
    );
    files.clear();
    scans.length = 0;
    await f.engine.list({ refs: [f.feature.key] });
    assert.equal(files.size, 1);
    assert.deepEqual(scans, [], "Адресная выборка не обходит общий реестр");
  } finally {
    read.mock.restore();
    entries.mock.restore();
    snapshot.mock.restore();
  }
  await f.workspace.locked(async () => {
    const card = (await f.workspace.storageSession!.indexGet(
      "cards",
      `implementation:${f.fi.ref.id}`,
    )) as object;
    assert(
      !("implementation" in card) && !("updatedAt" in card),
      "Новые DTO не меняют формат хранимых карточек",
    );
  });
});

test("D-05: повреждение выбранной записи диагностируется, writer не обходит чужую ошибку", async (t) => {
  const f = await seed(t);
  const path = join(f.workspace.dataRoot, "entities/features", `${f.feature.ref.id}.json`);
  const before = await readFile(path, "utf8");
  const damaged = JSON.parse(before);
  damaged.data.description = ["Внешняя правка без reindex"];
  await writeFile(path, JSON.stringify(damaged));
  await assert.rejects(f.engine.list({ kind: "feature" }), { code: "STORAGE_INDEX_STALE" });
  damaged.data.description = 123;
  await writeFile(path, JSON.stringify(damaged));
  assert.equal(
    (await f.engine.list({ kind: "application" })).total,
    1,
    "Узкое чтение не является doctor",
  );
  await assert.rejects(
    f.engine.update(
      {
        ref: f.application.key,
        ifRevision: f.application.revision,
        requestId: "writer",
        changes: { kind: "application", summary: "Не записывать" },
      },
      "editor",
    ),
    { code: "INVALID_DATA" },
  );
  await writeFile(path, before);
  assert.equal((await f.engine.get({ ref: f.application.key })).revision, f.application.revision);
  const statePath = join(f.workspace.dataRoot, ".indexes/state.json");
  const stateBytes = await readFile(statePath, "utf8");
  const state = JSON.parse(stateBytes);
  for (const root of ["records", "cards", "addresses", "file-hashes"]) {
    await writeFile(
      statePath,
      JSON.stringify({ ...state, roots: { ...state.roots, [root]: null } }),
    );
    for (const query of [{ kind: "feature" }, { refs: [] }] satisfies EntitiesQuery[])
      await assert.rejects(f.engine.list(query), { code: "STORAGE_INDEX_CORRUPT" });
    assert.equal(
      JSON.parse(await readFile(statePath, "utf8")).roots[root],
      null,
      "Чтение не ремонтирует индекс",
    );
    await writeFile(statePath, stateBytes);
  }
});

test("PLAN-07: открытый scope имеет адресный путь, закрытый не обещает невозможный пересмотр", async (t) => {
  const f = await seed(t);
  const deletion = new EntityDeletionService(f.workspace);
  await f.plans.update(
    f.plan.key,
    {
      requestId: "scope",
      ifRevision: f.plan.revision,
      scope: [{ kind: "feature", id: f.feature.ref.id }],
    },
    "editor",
  );
  const error = async () => {
    try {
      await deletion.preview({ kind: "feature", ref: f.feature.key });
      assert.fail("Нужен отказ");
    } catch (e) {
      assert(e instanceof AppError);
      assert.equal(e.code, "PLANNING_REFERENCE_IN_USE");
      return e;
    }
  };
  const open = await error();
  assert.match(open.message, /scope/);
  assert.match(open.message, new RegExp(f.plan.key));
  assert.equal((open.details as { editable: boolean }).editable, true);
  await f.plans.transition(
    f.plan.key,
    { requestId: "cancel", ifRevision: 2, action: "cancel", result: "Отмена" },
    "editor",
  );
  const closed = await error();
  assert.match(closed.message, /Закрытый план неизменяем/);
  assert.match(closed.message, /не поддерживаются/);
  assert.equal((closed.details as { editable: boolean }).editable, false);
  assert.deepEqual((closed.details as { scope: EntityRef[] }).scope, [f.feature.ref]);
});

test("PLAN-07: включение задачи указывает этап; completed остаётся неизменяемым", async (t) => {
  const f = await seed(t);
  const done = await f.create({
    kind: "task",
    board: "BOARD-PRODUCT",
    title: "Выполнено",
    column: "done",
  });
  const stage = await f.plans.changeStage(
    f.plan.key,
    { requestId: "stage", action: "create", ifRevision: 1, fields: { title: "Этап" } },
    "editor",
  );
  await f.plans.changeTasks(
    f.plan.key,
    { requestId: "include", ifRevision: stage.revision, stage: stage.stageId, add: [done.key] },
    "editor",
  );
  const deletion = new EntityDeletionService(f.workspace);
  await assert.rejects(deletion.preview({ kind: "task", ref: done.key }), (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, "PLANNING_REFERENCE_IN_USE");
    assert(error.message.includes(stage.stageId));
    assert.equal((error.details as { editable: boolean }).editable, true);
    return true;
  });
  await f.plans.transition(
    f.plan.key,
    { requestId: "complete", ifRevision: 3, action: "complete", result: "Результат" },
    "editor",
  );
  await assert.rejects(deletion.preview({ kind: "task", ref: done.key }), (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, "PLANNING_REFERENCE_IN_USE");
    assert.match(error.message, /Закрытый план неизменяем/);
    assert.equal((error.details as { status: string }).status, "completed");
    assert.deepEqual((error.details as { stages: unknown }).stages, [
      { id: stage.stageId, taskIds: [done.ref.id] },
    ]);
    return true;
  });
});

test("FTR-06/D-02: точное основание summary/alias/description, без get и с общей dirty-проекцией", async (t) => {
  const f = await seed(t);
  const summary = "👩‍💻".repeat(230) + "  TAIL_SUMMARY_雪 — зачем читать эту запись";
  const description = body("DESCRIPTION_ONLY").repeat(100);
  const updated = await f.engine.update(
    {
      ref: f.feature.key,
      ifRevision: f.feature.revision,
      requestId: "long-summary",
      changes: { kind: "feature", summary, description },
    },
    "editor",
  );
  await f.engine.rename(
    {
      ref: f.feature.key,
      ifRevision: updated.revision,
      key: "RENAMED-FEATURE",
      requestId: "alias",
    },
    "editor",
  );
  await f.engine.rename(
    {
      ref: f.document.key,
      ifRevision: f.document.revision,
      key: "RENAMED-DOCUMENT",
      requestId: "doc-alias",
    },
    "editor",
  );
  const guard = (await f.engine.list()).version;
  const forbiddenGet = t.mock.method(EntityEngine.prototype, "get", () =>
    assert.fail("Поиск не делает дополнительный get"),
  );
  try {
    for (const [query, field, marker] of [
      [{ kind: "feature", q: "tail_summary_雪" }, "summary", "TAIL_SUMMARY_雪"],
      [{ kind: "feature", q: f.feature.key }, "alias", f.feature.key],
      [{ kind: "feature", q: "DESCRIPTION_ONLY" }, "description", "DESCRIPTION_ONLY"],
      [{ kind: "feature", q: "RENAMED-FEATURE" }, "key", "RENAMED-FEATURE"],
      [{ kind: "feature", q: "Требование" }, "title", "Требование"],
      [{ kind: "document", q: f.document.key }, "alias", f.document.key],
      [{ kind: "document", q: "BODY_DOCUMENT" }, "body", "BODY_DOCUMENT"],
      [{ q: "BODY_DOCUMENT" }, "body", "BODY_DOCUMENT"],
    ] as const) {
      const page = entitiesPageSchema.parse(await f.engine.list(query));
      assert.equal(page.total, 1, JSON.stringify(query));
      const item = page.items[0]!;
      assert.equal(item.match?.field, field);
      assert(item.match?.text.includes(marker));
      assert(item.match.text.length <= 240);
      assert.deepEqual(entityMatchSchema.parse(item.match), item.match);
      if (field === "summary") {
        assert.equal(item.summary, summary, "Сохранённая summary не заменяется фрагментом");
        assert.equal(item.match.truncated, true);
        assert(summary.includes(item.match.text), "Фрагмент точно принадлежит исходному полю");
      }
      if (field === "description") {
        assert.equal(item.match.truncated, true);
        assert(description.includes(item.match.text));
        assert.notEqual(item.match.text, description, "Полный description не входит в snippet");
      }
      if (field === "alias")
        assert.deepEqual(item.match, { field, text: marker, truncated: false });
      if (field === "body")
        assert(item.document?.excerpt?.includes(marker), "Прежний excerpt сохраняется");
      if (query.kind !== "document") assert.equal(page.version, guard, "Основание не меняет guard");
      const logical = await f.workspace.locked(async () => {
        const changed = t.mock.getter(f.workspace.storageSession!, "changed", () => true);
        try {
          return await f.engine.list(query);
        } finally {
          changed.mock.restore();
        }
      });
      const { version: _a, ...actual } = page;
      const { version: _b, ...expected } = logical;
      assert.deepEqual(actual, expected, JSON.stringify(query));
    }
    for (const q of [undefined, "   "])
      assert(
        (await f.engine.list({ ...(q === undefined ? {} : { q }) })).items.every(
          (item) => item.match === undefined,
        ),
      );
    for (const q of ["НЕСУЩЕСТВУЮЩИЙ-МАРКЕР", "CRITERION_ONLY", "creator"])
      assert.equal(
        (await f.engine.list({ q })).total,
        0,
        "Не ищем отсутствующее и метаданные автора",
      );
    const before = (await f.engine.list({ refs: [f.feature.key] })).items[0]!;
    assert.equal(before.match, undefined);
    // Прежний document-reader допускает совпадение на стыке своей составной строки.
    // Фильтр сохраняем, но не приписываем его несуществующему совпадению отдельного поля.
    const composite = await f.engine.list({
      kind: "document",
      q: `RENAMED-DOCUMENT ${f.document.key}`,
    });
    assert.equal(composite.total, 1);
    assert.equal(composite.items[0]!.match, undefined);
    assert(
      !entityMatchSchema.safeParse({ field: "createdBy", text: "creator", truncated: false })
        .success,
    );
    assert(
      !entityMatchSchema.safeParse({ field: "summary", text: "x".repeat(241), truncated: true })
        .success,
    );
  } finally {
    forbiddenGet.mock.restore();
  }
  assert.equal((await f.engine.get({ ref: f.feature.key })).data.kind, "feature");
});

test("D-02: Unicode lowercase expansion не сдвигает фрагмент мимо настоящего совпадения", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const summary = "İ".repeat(210) + " TAIL_МАРКЕР " + "ж".repeat(250);
  await engine.create(
    {
      requestId: "unicode",
      data: { kind: "feature", name: "Unicode", summary, description: "Описание" },
    },
    "author",
  );
  const match = (await engine.list({ q: "tail_маркер" })).items[0]!.match!;
  assert.equal(match.field, "summary");
  assert(match.text.includes("TAIL_МАРКЕР"));
  assert(summary.includes(match.text));
  assert.equal(match.truncated, true);
});

test("D-05: инструментальный mixed-каталог, limit 1/20, повтор и продолжение не равны O(limit)", async (t) => {
  const f = await seed(t);
  for (let i = 0; i < 8; i++) {
    await f.create({
      kind: "feature",
      name: `Дополнение ${i}`,
      summary: "Кратко",
      description: body(`GROW_FEATURE_${i}`),
    });
    await f.create({
      kind: "task",
      board: "BOARD-PRODUCT",
      title: `Работа ${i}`,
      description: body(`GROW_TASK_${i}`),
    });
  }
  const expected = await f.engine.list({ limit: 100 });
  assert(expected.total > 20);
  assert.equal(new Set(expected.items.map((item) => item.ref.kind)).size, 11);
  const evidence: unknown[] = [];
  const measure = async (name: string, query: EntitiesQuery, cold = false) => {
    if (cold) forgetStorageSegments(f.workspace.dataRoot);
    const bodies = new Set<string>();
    const scans: { index: string; entries: number }[] = [];
    const sessions = new Set<StorageSession>();
    const originalRead = StorageSession.prototype.readFile;
    const originalEntries = StorageSession.prototype.indexEntries;
    const read = t.mock.method(
      StorageSession.prototype,
      "readFile",
      async function (this: StorageSession, path: string) {
        sessions.add(this);
        if (path.startsWith("entities/") && !this.files.has(path) && !this.originals.has(path))
          bodies.add(path);
        return originalRead.call(this, path);
      },
    );
    const index = t.mock.method(
      StorageSession.prototype,
      "indexEntries",
      async function (this: StorageSession, name: string) {
        sessions.add(this);
        const result = await originalEntries.call(this, name);
        scans.push({ index: name, entries: result.length });
        return result;
      },
    );
    const snapshot = t.mock.method(ProductRepository.prototype, "snapshot", () =>
      assert.fail("Полный продуктовый снимок не нужен"),
    );
    try {
      const result = await f.engine.list(query);
      const kinds: Record<string, number> = {};
      for (const path of bodies) {
        const kind = path.split("/")[1]!;
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
      assert([...sessions].every((session) => !session.changed));
      evidence.push({
        name,
        query,
        total: result.total,
        returned: result.items.length,
        bodies: bodies.size,
        kinds,
        scans,
        coldSegments: [...sessions].reduce(
          (sum, session) => sum + session.index.metrics.segmentReads,
          0,
        ),
        dtoBytes: Buffer.byteLength(JSON.stringify(result)),
      });
      return { result, bodies: bodies.size, scans };
    } finally {
      read.mock.restore();
      index.mock.restore();
      snapshot.mock.restore();
    }
  };
  const one = await measure("mixed-1-cold", { limit: 1 }, true);
  const twenty = await measure("mixed-20-cold", { limit: 20 }, true);
  const repeat = await measure("mixed-20-repeat-warm", {
    limit: 20,
    version: twenty.result.version,
  });
  const next = await measure("mixed-20-next-warm", {
    limit: 20,
    offset: twenty.result.nextOffset!,
    version: twenty.result.version,
  });
  assert.equal(one.bodies, expected.total);
  assert.equal(twenty.bodies, one.bodies);
  assert.equal(repeat.bodies, one.bodies);
  assert.equal(next.bodies, one.bodies);
  assert.deepEqual(repeat.result, twenty.result);
  assert.deepEqual([...twenty.result.items, ...next.result.items], expected.items);
  for (const measured of [one, twenty, repeat, next])
    assert.deepEqual(
      measured.scans.map((scan) => scan.index),
      ["records"],
    );
  const narrow = await measure("feature-1-cold", { kind: "feature", limit: 1 }, true);
  assert.equal(narrow.bodies, 9, "Читаются все кандидаты-фичи, а не только одна строка страницы");
  const refs = await measure("refs-1-cold", { refs: [f.feature.key], limit: 1 }, true);
  assert.equal(refs.bodies, 1);
  assert.deepEqual(refs.scans, []);
  t.diagnostic(JSON.stringify(evidence));
});
