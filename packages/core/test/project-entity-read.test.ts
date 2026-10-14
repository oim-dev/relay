import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  defaultDocumentSections,
  entityDetailSchema,
  entityKinds,
} from "@relay/contracts/entities";
import type { EntityDetail, EntityGetQuery } from "@relay/contracts/entities";
import { EntityEngine } from "../src/application/entities/service.js";
import {
  readEntityCatalog,
  entitySummary,
  resolveEntity,
} from "../src/application/entities/catalog.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { saveProjectSettings } from "../src/application/project-settings/service.js";
import { BoardRepository } from "../src/storage/boards.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import { ProductRepository } from "../src/storage/product.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { openWorkspace } from "../src/storage/workspace.js";
import type { Workspace } from "../src/storage/workspace.js";
import { fixture, legacyFixture } from "./helpers/workspace.js";
import { treeHashes } from "./helpers/migration-bases.js";

const sections = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `sec-${index + 1}`,
    name: `Раздел ${index + 1} — похожие имена 🧪 東京`,
  }));
const persistent = (workspace: Workspace) =>
  treeHashes(workspace.dataRoot, (path) => path === "runtime" || path.startsWith("runtime/"));

async function catalogProject(workspace: Workspace, query: EntityGetQuery) {
  return workspace.locked(async (owned) => {
    const entry = resolveEntity(await readEntityCatalog(workspace, owned), query.ref, query.kind);
    return entityDetailSchema.parse({ ...entitySummary(entry), data: entry.data, references: [] });
  });
}
async function assertProject(workspace: Workspace, expected: EntityDetail, aliases: string[] = []) {
  const engine = new EntityEngine(workspace);
  assert.equal(expected.data.kind, "project");
  if (expected.data.kind !== "project") throw new Error("Ожидался проект");
  const refs = [expected.key, ...aliases, expected.ref.id];
  const queries: EntityGetQuery[] = [
    ...refs.flatMap((ref) => [
      { ref },
      { ref, kind: "project" as const },
      { ref: `project:${ref}` },
    ]),
    { ref: expected.data.slug, kind: "project" },
  ];
  for (const query of queries) {
    const actual = await engine.get(query);
    assert.deepEqual(actual, expected, JSON.stringify(query));
    assert.deepEqual(entityDetailSchema.parse(actual), expected);
  }
  assert.deepEqual(await catalogProject(workspace, { ref: "PROJECT", kind: "project" }), expected);
}

test("PROJECT: полный DTO пустой базы, все формы адреса и чтение без записи", async (t) => {
  const { root, workspace } = await fixture(t);
  const expected: EntityDetail = {
    ref: { kind: "project", id: workspace.config.projectId! },
    key: "PROJECT",
    title: basename(root),
    summary: "Область данных и настроек выбранного проекта",
    revision: 1,
    status: null,
    active: true,
    data: {
      kind: "project",
      name: basename(root),
      slug: workspace.config.projectSettings!.slug,
      documentSections: defaultDocumentSections,
    },
    references: [],
  };
  const before = await persistent(workspace);
  await assertProject(workspace, expected);
  assert.deepEqual(await persistent(workspace), before);
});

test("PROJECT: насыщенная база, rename/slug, 0/25/100 разделов и общая ревизия", async (t) => {
  const { root, workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const initial = await engine.get({ ref: "PROJECT" });
  await engine.create(
    {
      requestId: "product",
      data: {
        kind: "product",
        name: "Продукт",
        summary: "Сводка",
        description: "Описание\r\n",
      },
    },
    "agent",
  );
  const feature = await engine.create(
    {
      requestId: "feature",
      data: {
        kind: "feature",
        name: "Фича",
        summary: "",
        description: "Правила",
      },
    },
    "agent",
  );
  const scenario = await engine.create(
    {
      requestId: "scenario",
      data: {
        kind: "scenario",
        featureId: feature.key,
        name: "Сценарий",
        description: "Шаги",
      },
    },
    "agent",
  );
  const app = await engine.create(
    {
      requestId: "application",
      data: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        type: "frontend",
        summary: "",
        description: "Клиент",
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "feature-implementation",
      data: {
        kind: "implementation",
        application: app.key,
        target: feature.key,
        title: "Общий вклад",
        description: "Контракт фичи",
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "implementation",
      data: {
        kind: "implementation",
        application: app.key,
        target: scenario.key,
        title: "Реализация",
        description: "Содержание",
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "task",
      data: {
        kind: "task",
        board: "BOARD-WEB",
        title: "Работа",
      },
    },
    "agent",
  );
  const plan = await new PlanningService(workspace).create(
    { title: "План", requestId: "plan" },
    "agent",
  );
  await new ReleasesService(workspace).create(
    {
      title: "Релиз",
      version: "1",
      planIds: [plan.id],
      requestId: "release",
    },
    "agent",
  );
  for (let index = 0; index < 3; index++)
    await engine.create(
      {
        requestId: `document-${index}`,
        data: {
          kind: "document",
          name: `Документ ${index}`,
          summary: "",
          body: "Текст\r\n  Отступ\n",
          documentKind: "description",
          relations: [
            { target: initial.ref, type: "documents", description: "Паспорт" },
            ...(index === 0
              ? [{ target: initial.ref, type: "references" as const, description: "Читать" }]
              : []),
          ],
        },
      },
      "agent",
    );
  assert.deepEqual(
    new Set((await engine.list({ limit: 100 })).items.map((item) => item.ref.kind)),
    new Set(entityKinds),
  );
  await assertProject(workspace, initial);

  const renamed = await engine.rename(
    { ref: "PROJECT", key: "PROJECT-ALPHA", ifRevision: 1, requestId: "rename" },
    "agent",
  );
  let expected: EntityDetail = { ...initial, key: renamed.key, revision: 2 };
  await assertProject(workspace, expected, ["PROJECT"]);
  assert.equal(initial.data.kind, "project");
  if (initial.data.kind !== "project") throw new Error("Ожидался проект");
  await saveProjectSettings(workspace, {
    name: "  Альфа 🧪 東京  ",
    slug: "alpha-project",
    ifRevision: 2,
  });
  expected = {
    ...expected,
    title: "Альфа 🧪 東京",
    revision: 3,
    data: {
      ...initial.data,
      name: "Альфа 🧪 東京",
      slug: "alpha-project",
    },
  };
  await assertProject(workspace, expected, ["PROJECT"]);
  await assert.rejects(engine.get({ ref: initial.data.slug, kind: "project" }), {
    code: "ENTITY_NOT_FOUND",
  });

  // Тот же read-modify-write, которым пользуются потребители document sections.
  for (const count of [0, 25, 100]) {
    const current = await engine.get({ ref: "PROJECT", kind: "project" });
    const documentSections = sections(count).reverse();
    await engine.update(
      {
        ref: "PROJECT",
        ifRevision: current.revision,
        requestId: `sections-${count}`,
        changes: { kind: "project", documentSections },
      },
      "agent",
    );
    assert.equal(expected.data.kind, "project");
    if (expected.data.kind !== "project") throw new Error("Ожидался проект");
    expected = {
      ...expected,
      revision: current.revision + 1,
      data: { ...expected.data, documentSections },
    };
    await assertProject(workspace, expected, ["PROJECT"]);
    await assert.rejects(
      engine.update(
        {
          ref: "PROJECT",
          ifRevision: current.revision,
          requestId: `stale-${count}`,
          changes: { kind: "project", documentSections: [] },
        },
        "agent",
      ),
      { code: "REVISION_CONFLICT" },
    );
    assert.deepEqual(await engine.get({ ref: "PROJECT" }), expected);
  }
  const again = await engine.rename(
    { ref: "PROJECT", key: "ALPHA", ifRevision: expected.revision, requestId: "rename-again" },
    "agent",
  );
  expected = { ...expected, key: "ALPHA", revision: again.revision };
  await assertProject(await openWorkspace(root), expected, ["PROJECT", "PROJECT-ALPHA"]);
  for (const ref of ["PROJECT", "PROJECT-ALPHA", "ALPHA", initial.ref.id, "alpha-project"])
    assert.deepEqual(
      (await measureProject(t, workspace, { ref, kind: "project" })).result,
      expected,
    );
  assert.equal((await engine.list({ kind: "document", target: "PROJECT" })).total, 3);
});

async function measureProject(t: TestContext, workspace: Workspace, query: EntityGetQuery) {
  const forbidden = () => assert.fail("Адресное чтение проекта не обходит коллекции");
  const mocks = [
    t.mock.method(ProductRepository.prototype, "all", forbidden),
    t.mock.method(BoardRepository.prototype, "all", forbidden),
    t.mock.method(BoardTaskRepository.prototype, "all", forbidden),
    t.mock.method(StorageSession.prototype, "records", forbidden),
    t.mock.method(StorageSession.prototype, "indexEntries", forbidden),
  ];
  const read = StorageSession.prototype.readFile;
  const paths: string[] = [];
  const sessions = new Set<StorageSession>();
  const files = t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      sessions.add(this);
      paths.push(path);
      return read.call(this, path);
    },
  );
  const indexes = t.mock.method(StorageSession.prototype, "indexGet");
  try {
    const result = await new EntityEngine(workspace).get(query);
    assert.equal(sessions.size, 1);
    assert.equal([...sessions][0]!.changed, false);
    assert.deepEqual(
      [...new Set(paths.filter((path) => path.startsWith("entities/")))],
      [`entities/projects/${result.ref.id}.json`],
    );
    return {
      result,
      cost: {
        entityReads: [...sessions][0]!.store.metrics.entityReads,
        relationReads: [...sessions][0]!.store.metrics.relationReads,
        fileCalls: paths.length,
        indexGets: indexes.mock.callCount(),
        fullScans: mocks.reduce((sum, mock) => sum + mock.mock.callCount(), 0),
      },
    };
  } finally {
    for (const mock of [...mocks, files, indexes]) mock.mock.restore();
  }
}

test("PROJECT: число адресных чтений постоянно при росте чужих сущностей, без Repository.all и indexEntries", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const samples = [];
  let baseline: Awaited<ReturnType<typeof measureProject>> | undefined;
  for (const batches of [0, 1, 10]) {
    if (batches)
      await workspace.mutate(
        "project-read-fixture",
        { requestId: `batch-${batches}` },
        "agent",
        async () => {
          for (let index = 0; index < batches; index++) {
            const id = `${batches}-${index}`;
            await engine.create(
              {
                requestId: `app-${id}`,
                data: {
                  kind: "application",
                  name: `Приложение ${id}`,
                  slug: `app-${id}`,
                  prefix: `APP${batches}X${index}`,
                  type: "frontend",
                  summary: "",
                  description: "Клиент",
                },
              },
              "agent",
            );
            await engine.create(
              {
                requestId: `task-${id}`,
                data: { kind: "task", board: "BOARD-INFRA", title: `Работа ${id}` },
              },
              "agent",
            );
            await engine.create(
              {
                requestId: `doc-${id}`,
                data: {
                  kind: "document",
                  name: `Документ ${id}`,
                  summary: "",
                  body: "Содержание",
                  documentKind: "description",
                },
              },
              "agent",
            );
            const plan = await new PlanningService(workspace).create(
              { title: `План ${id}`, requestId: `plan-${id}` },
              "agent",
            );
            await new ReleasesService(workspace).create(
              { title: `Релиз ${id}`, version: id, planIds: [plan.id], requestId: `release-${id}` },
              "agent",
            );
          }
          return true;
        },
      );
    const total = (await engine.list({ limit: 1 })).total;
    const measured = await measureProject(t, workspace, { ref: "PROJECT", kind: "project" });
    baseline ??= measured;
    assert.deepEqual(measured, baseline);
    assert.equal(measured.cost.entityReads, 1);
    assert.equal(measured.cost.relationReads, 0);
    assert.equal(measured.cost.fullScans, 0);
    samples.push({ total, ...measured.cost });
    assert.deepEqual(
      (await measureProject(t, workspace, { ref: "PROJECT" })).result,
      measured.result,
    );
    assert.deepEqual(
      (await measureProject(t, workspace, { ref: measured.result.ref.id })).result,
      measured.result,
    );
  }
  assert.ok(samples[2]!.total > samples[1]!.total * 5);
  t.diagnostic(JSON.stringify(samples));
});

test("PROJECT: ошибки адреса/вида, отсутствие автоматического slug-алиаса и изоляция", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const before = await engine.get({ ref: "PROJECT" });
  for (const query of [
    { ref: "MISSING", kind: "project" as const },
    { ref: "project:MISSING" },
    { ref: workspace.config.projectSettings!.slug },
  ])
    await assert.rejects(engine.get(query), { code: "ENTITY_NOT_FOUND" });
  for (const query of [
    { ref: "BOARD-INFRA", kind: "project" as const },
    { ref: "board:BOARD-INFRA", kind: "project" as const },
    { ref: "PROJECT", kind: "task" as const },
  ])
    await assert.rejects(engine.get(query), { code: "ENTITY_KIND_MISMATCH" });
  await assert.rejects(engine.get({ ref: "project:a:b", kind: "project" }), {
    code: "INVALID_REFERENCE",
  });
  const other = new EntityEngine((await fixture(t)).workspace);
  await assert.rejects(other.get({ ref: before.ref.id, kind: "project" }), {
    code: "ENTITY_NOT_FOUND",
  });
  assert.deepEqual(await engine.get({ ref: "PROJECT" }), before);
});

test("PROJECT: общий индекс не скрывает неоднозначный адрес при выборе адресного reader", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const project = await engine.get({ ref: "PROJECT" });
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA", title: "Работа" } },
    "agent",
  );
  // Моделируем коллизию адресов после merge только в неподтверждённом индексе.
  await assert.rejects(
    workspace.locked(async () => {
      const session = workspace.storageSession!;
      const candidates = await session.indexGet("addresses", "PROJECT");
      assert.ok(Array.isArray(candidates));
      session.indexSet("addresses", "PROJECT", [
        ...candidates,
        { ref: task.ref, matches: ["alias"], deleted: false },
      ]);
      await assert.rejects(engine.get({ ref: "PROJECT" }), { code: "AMBIGUOUS_ENTITY_REFERENCE" });
      assert.deepEqual(await engine.get({ ref: "PROJECT", kind: "project" }), project);
      assert.deepEqual(await engine.get({ ref: `project:${project.ref.id}` }), project);
      throw new Error("Откат тестового индекса");
    }),
    /Откат тестового индекса/,
  );
  assert.deepEqual(await engine.get({ ref: "PROJECT" }), project);
});

test("PROJECT: чтение внутри общей сессии видит подготовленное изменение и не публикует откат", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const initial = await engine.get({ ref: "PROJECT" });
  const before = await persistent(workspace);
  await assert.rejects(
    workspace.mutate("project-read-test", { requestId: "rollback" }, "agent", async () => {
      const session = workspace.storageSession;
      await engine.rename(
        { ref: "PROJECT", key: "PROJECT-STAGED", ifRevision: 1, requestId: "rename" },
        "agent",
      );
      await saveProjectSettings(workspace, {
        name: "Подготовленное имя",
        slug: "staged-project",
        ifRevision: 2,
      });
      await engine.update(
        {
          ref: "PROJECT",
          ifRevision: 3,
          requestId: "sections",
          changes: { kind: "project", documentSections: [] },
        },
        "agent",
      );
      assert.equal(workspace.storageSession, session);
      const expected: EntityDetail = {
        ...initial,
        key: "PROJECT-STAGED",
        title: "Подготовленное имя",
        revision: 4,
        data: {
          kind: "project",
          name: "Подготовленное имя",
          slug: "staged-project",
          documentSections: [],
        },
      };
      for (const ref of ["PROJECT", "PROJECT-STAGED", initial.ref.id])
        assert.deepEqual(await engine.get({ ref }), expected);
      assert.equal(workspace.storageSession, session);
      throw new Error("Отказ составного действия");
    }),
    /Отказ составного действия/,
  );
  assert.deepEqual(await engine.get({ ref: "PROJECT" }), initial);
  assert.deepEqual(await persistent(workspace), before);
});

test("PROJECT: параллельный writer не меняет настройки между разрешением адреса и чтением записи", async (t) => {
  const { root, workspace } = await fixture(t);
  const writerWorkspace = await openWorkspace(root);
  const engine = new EntityEngine(workspace);
  const initial = await engine.get({ ref: "PROJECT" });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const reached = deferred();
  const proceed = deferred();
  const original = StorageSession.prototype.readFile;
  let intercepted = false;
  t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      if (!intercepted && path === `entities/projects/${initial.ref.id}.json`) {
        intercepted = true;
        reached.resolve();
        await proceed.promise;
      }
      return original.call(this, path);
    },
  );
  const reading = engine.get({ ref: "PROJECT", kind: "project" });
  await reached.promise;
  let published = false;
  const writing = saveProjectSettings(writerWorkspace, {
    name: "Конкурентное имя",
    slug: "concurrent-project",
    ifRevision: initial.revision,
  }).then(() => {
    published = true;
  });
  try {
    // Окно для конкурирующего writer, не измерение производительности или SLA.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(published, false);
  } finally {
    proceed.resolve();
    await Promise.allSettled([reading, writing]);
  }
  assert.deepEqual(await reading, initial);
  await writing;
  const changed = await engine.get({ ref: "PROJECT" });
  assert.equal(changed.revision, initial.revision + 1);
  assert.deepEqual(changed.data, {
    kind: "project",
    name: "Конкурентное имя",
    slug: "concurrent-project",
    documentSections: defaultDocumentSections,
  });
});

test("PROJECT: ошибки версии/индекса и повреждения записи не маскируются сохранённой карточкой", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const project = await engine.get({ ref: "PROJECT" });
  const path = join(workspace.dataRoot, "entities/projects", `${project.ref.id}.json`);
  const original = await readFile(path, "utf8");
  for (const [value, code] of [
    [{ ...JSON.parse(original), dataVersion: 99 }, "STORAGE_DATA_MIGRATION_REQUIRED"],
    [{ ...JSON.parse(original), data: { name: 123, slug: "invalid-project" } }, "INVALID_DATA"],
    [null, "ENTITY_NOT_FOUND"],
  ] as const) {
    if (value === null) await rm(path);
    else await writeFile(path, JSON.stringify(value));
    const before = await persistent(workspace);
    await assert.rejects(engine.get({ ref: "PROJECT", kind: "project" }), { code });
    assert.deepEqual(await persistent(workspace), before);
    await writeFile(path, original);
  }
  const manifestPath = join(workspace.dataRoot, "storage.json");
  const manifest = await readFile(manifestPath, "utf8");
  for (const [version, code] of [
    [1, "STORAGE_MIGRATION_REQUIRED"],
    [999, "STORAGE_VERSION_UNSUPPORTED"],
  ] as const) {
    await writeFile(
      manifestPath,
      JSON.stringify({ ...JSON.parse(manifest), dataModelVersion: version }),
    );
    const before = await persistent(workspace);
    await assert.rejects(engine.get({ ref: "PROJECT", kind: "project" }), { code });
    assert.deepEqual(await persistent(workspace), before);
  }
  await writeFile(manifestPath, manifest);
  await writeFile(join(workspace.dataRoot, "runtime/index-stale.json"), "{}");
  await assert.rejects(engine.get({ ref: "PROJECT", kind: "project" }), {
    code: "STORAGE_INDEX_STALE",
  });
});

test("PROJECT: совместимый legacy reader сохраняет DTO и ревизию 0 без миграции", async (t) => {
  const { workspace } = await legacyFixture(t);
  const engine = new EntityEngine(workspace);
  const config = JSON.parse(await readFile(workspace.configPath, "utf8"));
  delete config.projectSettings;
  await writeFile(workspace.configPath, JSON.stringify(config));
  const expected = await catalogProject(workspace, { ref: "PROJECT" });
  assert.equal(expected.revision, 0);
  assert.equal(expected.data.kind, "project");
  if (expected.data.kind !== "project") throw new Error("Ожидался проект");
  assert.deepEqual(expected.data.documentSections, defaultDocumentSections);
  const before = await persistent(workspace);
  assert.deepEqual(await engine.get({ ref: "PROJECT" }), expected);
  assert.deepEqual(await engine.get({ ref: "Legacy01", kind: "project" }), expected);
  assert.deepEqual(await persistent(workspace), before);
});
