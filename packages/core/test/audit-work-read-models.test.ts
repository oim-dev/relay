import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { ProgressService } from "../src/application/progress/service.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import { BoardRepository } from "../src/storage/boards.js";
import { ProductRepository } from "../src/storage/product.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { readOwned } from "../src/storage/entity-store/relations.js";
import {
  plansPageSchema,
  plansCompactPageSchema,
  plansCompactQuerySchema,
  planCompactSchema,
  planningTasksPageSchema,
  planningCandidatesPageSchema,
} from "@relay/contracts/planning";
import {
  releasesPageSchema,
  releasesCompactPageSchema,
  releaseCompactSchema,
  releaseCompositionSchema,
  releaseCompositionCompactSchema,
  saveReleaseByRefsSchema,
  updateReleaseByRefsSchema,
} from "@relay/contracts/releases";
import { taskDependenciesPageSchema, releaseProgressSchema } from "@relay/contracts/progress";

async function fixture(t: TestContext) {
  const root = await mkdtemp("/tmp/opencode/relay-work-read-models-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  return {
    root,
    workspace,
    tasks: new BoardTasksService(workspace),
    plans: new PlanningService(workspace),
    releases: new ReleasesService(workspace),
    progress: new ProgressService(workspace),
  };
}

/**
 * Считаем реальные построения byId в taskCompletions на непустых фикстурах.
 * Эта карта создаётся ровно раз на расчёт. Сам Map и алгоритм не подменяются;
 * Proxy лишь наблюдает конструктор и всегда восстанавливается в finally.
 * Счётчик не зависит от JIT-счётчиков V8 и не требует production-хука для тестов.
 */
async function measured<T>(operation: () => Promise<T>) {
  const NativeMap = globalThis.Map;
  let completions = 0,
    planningBuilds = 0;
  globalThis.Map = new Proxy(NativeMap, {
    construct(target, args, newTarget) {
      if (Array.isArray(args[0]) && args[0][0]?.[1]?.acceptanceCriteria) {
        const stack = new Error().stack;
        if (stack?.includes("at taskCompletions")) {
          completions++;
          if (stack.includes("at readPlanningState")) planningBuilds++;
        }
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    return { value: await operation(), completions, planningBuilds };
  } finally {
    globalThis.Map = NativeMap;
  }
}

test("TASK-03 / PLAN-04: один completion и постоянное число all для страниц 1/20/100", async (t) => {
  const { workspace, tasks, plans } = await fixture(t);
  const dependency = await tasks.create(
    { board: "infrastructure", column: "done", requestId: "dependency" },
    "agent",
  );
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  const stage = await plans.changeStage(
    plan.id,
    { action: "create", fields: { title: "Этап" }, ifRevision: 1, requestId: "stage" },
    "agent",
  );
  const ids: string[] = [];
  // Одна публикация фикстуры; сами записи создаются публичными предметными действиями.
  await workspace.mutate("fixture", { requestId: "fixture" }, "agent", async () => {
    for (let index = 0; index < 100; index++) {
      ids.push(
        (
          await tasks.create(
            {
              board: "product",
              title: `Задача ${index}`,
              column: "ready",
              dependencies: [dependency.id],
              related: [dependency.id],
              requestId: `task-${index}`,
            },
            "agent",
          )
        ).id,
      );
    }
    return ids;
  });
  await plans.changeTasks(
    plan.id,
    { stage: stage.stageId!, add: ids, ifRevision: stage.revision, requestId: "include" },
    "agent",
  );
  const taskAll = t.mock.method(BoardTaskRepository.prototype, "all");
  const boardAll = t.mock.method(BoardRepository.prototype, "all");
  for (const limit of [1, 20, 100]) {
    for (const [name, read] of [
      ["list", () => tasks.list({ board: "product", limit })],
      ["links", () => tasks.links(dependency.id, { limit })],
      ["tasks", () => plans.tasks(plan.id, stage.stageId!, { limit })],
      [
        "candidates",
        () => plans.candidates({ board: "product", plan: plan.id, stage: stage.stageId!, limit }),
      ],
    ] as const) {
      const beforeTasks = taskAll.mock.callCount(),
        beforeBoards = boardAll.mock.callCount();
      const result = await measured(async () => read());
      assert.equal(result.completions, 1, `${name}/${limit}: completion`);
      assert.equal(taskAll.mock.callCount() - beforeTasks, 1, `${name}/${limit}: tasks.all`);
      assert.equal(boardAll.mock.callCount() - beforeBoards, 1, `${name}/${limit}: boards.all`);
      assert.equal(result.value.items.length, limit);
      assert.equal(result.value.total, name === "links" ? 200 : 100);
    }
  }
  taskAll.mock.restore();
  boardAll.mock.restore();
  const expected = await tasks.get(ids[0]!);
  const { description: _description, ...summary } = expected;
  const composition = await plans.tasks(plan.id, stage.stageId!);
  planningTasksPageSchema.parse(composition);
  assert.deepEqual(composition.items[0], { ...summary, completed: false });
  const candidates = await plans.candidates({
    board: "product",
    plan: plan.id,
    stage: stage.stageId!,
  });
  planningCandidatesPageSchema.parse(candidates);
  assert.equal(candidates.items[0]?.assignment?.stageId, stage.stageId);
  await tasks.move(
    dependency.id,
    { column: "review", ifRevision: dependency.revision, requestId: "reopen" },
    "agent",
  );
  assert.equal((await plans.tasks(plan.id, stage.stageId!)).items[0]?.blocked, true);
  assert.equal(
    (await plans.candidates({ availableOnly: "false" })).items.find((task) => ids.includes(task.id))
      ?.canComplete,
    false,
  );
  await assert.rejects(
    plans.tasks(plan.id, stage.stageId!, { offset: 1, version: composition.version }),
    { code: "PLANNING_CHANGED" },
  );
  await assert.rejects(
    plans.candidates({
      board: "product",
      plan: plan.id,
      stage: stage.stageId!,
      offset: 1,
      version: candidates.version,
    }),
    { code: "PLANNING_CHANGED" },
  );
  t.diagnostic(
    "Для list/links/tasks/candidates при limit=1,20,100: tasks.all=1, boards.all=1, taskCompletions=1",
  );
});

test("TASK-04: узкая страница сохраняет порядок/выполнение зависимостей без продукта и соседних коллекций", async (t) => {
  const { tasks, progress } = await fixture(t);
  const child = await tasks.create(
    { board: "infrastructure", column: "done", requestId: "child" },
    "agent",
  );
  const dependency = await tasks.create(
    { board: "product", column: "done", dependencies: [child.id], requestId: "dependency" },
    "agent",
  );
  const cancelled = await tasks.create(
    { board: "infrastructure", column: "cancelled", requestId: "cancelled" },
    "agent",
  );
  const root = await tasks.create(
    {
      board: "product",
      dependencies: [dependency.id, cancelled.id],
      acceptanceCriteria: [{ title: "Условие" }],
      requestId: "root",
    },
    "agent",
  );
  await tasks.create({ board: "product", parentId: root.id, requestId: "other-child" }, "agent");
  const full = await progress.task({ ref: root.id, limit: 1 });
  const productAll = t.mock.method(ProductRepository.prototype, "all", async () => {
    throw new Error("Не нужен продукт");
  });
  const boardAll = t.mock.method(BoardRepository.prototype, "all", async () => {
    throw new Error("Не нужны доски");
  });
  const first = await measured(() => progress.taskDependencies({ ref: root.key, limit: 1 }));
  assert.equal(first.completions, 1);
  taskDependenciesPageSchema.parse(first.value);
  assert.deepEqual(first.value.items, full.dependencies.items);
  assert.deepEqual(Object.keys(first.value).sort(), [
    "entity",
    "items",
    "nextOffset",
    "total",
    "version",
  ]);
  assert.equal(first.value.total, 2);
  const second = await progress.taskDependencies({
    ref: root.id,
    offset: 1,
    limit: 1,
    version: first.value.version,
  });
  assert.deepEqual(
    second.items.map((item) => [item.id, item.completed]),
    [[cancelled.id, false]],
  );
  assert.equal(second.nextOffset, null);
  await assert.rejects(progress.taskDependencies({ ref: root.id, offset: 1 }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(
    progress.taskDependencies({ ref: root.id, offset: 1, limit: 2, version: first.value.version }),
    { code: "PROGRESS_CHANGED" },
  );
  assert.equal(productAll.mock.callCount(), 0);
  assert.equal(boardAll.mock.callCount(), 0);
  productAll.mock.restore();
  boardAll.mock.restore();
  await tasks.move(
    child.id,
    { column: "review", ifRevision: child.revision, requestId: "reopen" },
    "agent",
  );
  await assert.rejects(
    progress.taskDependencies({ ref: root.id, limit: 1, offset: 1, version: first.value.version }),
    { code: "PROGRESS_CHANGED" },
  );
  const reopened = await progress.taskDependencies({ ref: root.id });
  assert.equal(reopened.items[0]?.column, "done");
  assert.equal(reopened.items[0]?.completed, false);
  assert.deepEqual(reopened.items, (await progress.task({ ref: root.id })).dependencies.items);
  assert.equal((await progress.taskDependencies({ ref: cancelled.id })).total, 0);
});

test("PLAN-05 / REL-02,03: явные compact DTO, полный default/get, поиск description до страницы и guards", async (t) => {
  const { plans, releases } = await fixture(t);
  const markdown = "## Полный текст\r\n\n  Содержание  \n".repeat(1000);
  const plan = await plans.create(
    {
      title: "План",
      summary: "Кратко",
      goal: markdown,
      rationale: markdown,
      boundaries: markdown,
      expectedResult: markdown,
      requestId: "plan",
    },
    "agent",
  );
  const other = await plans.create({ title: "Другой", requestId: "other" }, "agent");
  const release = await releases.createByRefs(
    {
      title: "Выпуск",
      version: "1",
      summary: "Кратко",
      description: `${markdown}УникальныйМаркер`,
      plans: [plan.key, `work-plan:${other.id}`],
      requestId: "release",
    },
    "agent",
  );
  await releases.createByRefs(
    {
      title: "Ещё",
      version: "2",
      description: "уникальныймаркер",
      plans: [other.id],
      requestId: "release2",
    },
    "agent",
  );
  assert.equal(plansCompactQuerySchema.safeParse({}).success, false);
  const full = await plans.list({ limit: 1 });
  plansPageSchema.parse(full);
  const compact = await plans.listCompact({ projection: "compact", limit: 1 });
  plansCompactPageSchema.parse(compact);
  assert.deepEqual(
    compact.items,
    full.items.map((item) => planCompactSchema.strip().parse(item)),
  );
  assert.deepEqual(compact.statusCounts, full.statusCounts);
  assert.equal(compact.total, 2);
  assert.notEqual(compact.version, full.version);
  assert.equal(
    (
      await plans.listCompact({
        projection: "compact",
        limit: 1,
        offset: 1,
        version: compact.version,
      })
    ).items.length,
    1,
  );
  await assert.rejects(
    plans.listCompact({ projection: "compact", limit: 1, offset: 1, version: full.version }),
    { code: "PLANNING_CHANGED" },
  );
  assert.equal((await plans.get(plan.id)).goal, markdown);
  const fullRelease = await releases.list({ q: "УНИКАЛЬНЫЙМАРКЕР", limit: 1 });
  releasesPageSchema.parse(fullRelease);
  const compactRelease = await releases.listCompact({
    projection: "compact",
    q: "УНИКАЛЬНЫЙМАРКЕР",
    limit: 1,
  });
  releasesCompactPageSchema.parse(compactRelease);
  assert.equal(fullRelease.total, 2);
  assert.deepEqual(
    compactRelease.items,
    fullRelease.items.map((item) => releaseCompactSchema.strip().parse(item)),
  );
  const next = await releases.listCompact({
    projection: "compact",
    q: "УНИКАЛЬНЫЙМАРКЕР",
    limit: 1,
    offset: 1,
    version: compactRelease.version,
  });
  assert.notEqual(next.items[0]?.id, compactRelease.items[0]?.id);
  assert.equal(next.nextOffset, null);
  for (const read of [
    () => releases.composition(release.id, { limit: 1 }),
    () => releases.preview({ plans: [plan.id, other.id], limit: 1 }),
  ])
    releaseCompositionSchema.parse(await read());
  const composition = await releases.compositionCompact(release.id, {
    projection: "compact",
    limit: 1,
  });
  const preview = await releases.previewCompact({
    projection: "compact",
    plans: [plan.id, other.key],
    limit: 1,
  });
  for (const value of [composition, preview]) {
    releaseCompositionCompactSchema.parse(value);
    assert.equal(value.total, 2);
    assert.equal(value.readiness.total, 2);
    assert.equal("goal" in value.items[0]!.plan!, false);
    assert.equal(JSON.stringify(value).includes("Полный текст"), false);
  }
  assert.deepEqual(composition.items, preview.items);
  assert.deepEqual(composition.readiness, preview.readiness);
  assert.equal((await releases.composition(release.id)).items[0]?.plan?.goal, markdown);
  assert.equal((await releases.get(release.id)).description, `${markdown}УникальныйМаркер`);
  assert.equal(
    (await releases.previewCompact({ projection: "compact", plans: [] })).readiness.canRelease,
    false,
  );
  assert(
    JSON.stringify(await plans.listCompact({ projection: "compact" })).length <
      JSON.stringify(await plans.list()).length / 10,
  );
  await plans.update(
    plan.id,
    { summary: "Изменилось", ifRevision: plan.revision, requestId: "change" },
    "agent",
  );
  await assert.rejects(
    releases.compositionCompact(release.id, {
      projection: "compact",
      limit: 1,
      offset: 1,
      version: composition.version,
    }),
    { code: "PLANNING_CHANGED" },
  );
  await assert.rejects(
    releases.previewCompact({
      projection: "compact",
      plans: [plan.id, other.id],
      limit: 1,
      offset: 1,
      version: preview.version,
    }),
    { code: "PLANNING_CHANGED" },
  );
});

test("REL-04: refs разрешаются внутри мутации, без изменения ID-контракта, с CAS и атомарным отказом", async (t) => {
  const { workspace, plans, releases, tasks } = await fixture(t);
  const a = await plans.create({ title: "Первый", requestId: "a" }, "agent");
  const b = await plans.create({ title: "Второй", requestId: "b" }, "agent");
  const closed = await plans.create({ title: "Отменённый", requestId: "closed" }, "agent");
  await plans.transition(
    closed.id,
    { action: "cancel", result: "Не нужен", ifRevision: 1, requestId: "cancel" },
    "agent",
  );
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  const command = {
    title: "Выпуск",
    version: "1",
    description: "  Точный\r\n\nMarkdown\n",
    plans: [a.key, `work-plan:${b.id}`],
    requestId: "create",
  };
  assert.equal(saveReleaseByRefsSchema.safeParse({ ...command, planIds: [a.id] }).success, false);
  assert.equal(saveReleaseByRefsSchema.safeParse({ ...command, plans: [] }).success, false);
  assert.equal(
    saveReleaseByRefsSchema.safeParse({ ...command, plans: Array(201).fill(a.id) }).success,
    false,
  );
  assert.equal(updateReleaseByRefsSchema.safeParse({ ...command, ifRevision: 1 }).success, false);
  const mutate = t.mock.method(workspace, "mutate");
  const resolve = StorageSession.prototype.resolve;
  const resolution = t.mock.method(
    StorageSession.prototype,
    "resolve",
    async function (this: StorageSession, ...args: Parameters<StorageSession["resolve"]>) {
      assert.equal(workspace.storageSession, this, "Разрешение в той же общей сессии");
      return resolve.apply(this, args);
    },
  );
  const created = await releases.createByRefs(command, "agent");
  assert.equal(mutate.mock.callCount(), 1);
  for (const ref of command.plans)
    assert(resolution.mock.calls.some((call) => call.arguments[0] === ref));
  mutate.mock.restore();
  resolution.mock.restore();
  assert.deepEqual((await releases.get(created.id)).planIds, [a.id, b.id]);
  const bodyPath = join(workspace.root, "entities/releases", `${created.id}.json`);
  const relations = () =>
    workspace.locked(() =>
      readOwned(workspace.storageSession!, { kind: "release", id: created.id }),
    );
  const before = await readFile(bodyPath, "utf8");
  const links = await relations();
  await assert.rejects(
    releases.createByRefs({ ...command, status: "released", requestId: "incomplete" }, "agent"),
    { code: "RELEASE_INCOMPLETE" },
  );
  assert.equal((await releases.list()).total, 1, "Неудачный выпуск не оставляет созданную запись");
  await assert.rejects(
    releases.updateByRefs(
      created.id,
      { ...command, status: "released", ifRevision: created.revision },
      "agent",
    ),
    { code: "RELEASE_INCOMPLETE" },
  );
  assert.equal(await readFile(bodyPath, "utf8"), before);
  assert.deepEqual(await relations(), links);
  for (const [refs, code] of [
    [[a.key, a.id], "DUPLICATE_VALUE"],
    [[task.key], "ENTITY_KIND_MISMATCH"],
    [["PLN-9999"], "ENTITY_NOT_FOUND"],
    [[closed.id], "PLAN_CLOSED"],
  ] as const) {
    await assert.rejects(
      releases.updateByRefs(
        created.id,
        { ...command, plans: [...refs], status: "planned", ifRevision: created.revision },
        "agent",
      ),
      { code },
    );
    assert.equal(await readFile(bodyPath, "utf8"), before);
    assert.deepEqual(await relations(), links);
  }
  const updated = await releases.updateByRefs(
    created.id,
    { ...command, plans: [b.key], status: "cancelled", ifRevision: created.revision },
    "agent",
  );
  await assert.rejects(
    releases.updateByRefs(
      created.id,
      { ...command, status: "planned", ifRevision: created.revision },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
  const value = await releases.get(created.id);
  assert.equal(value.revision, updated.revision);
  assert.equal(value.status, "cancelled");
  assert.equal(value.description, command.description);
  assert.deepEqual(value.planIds, [b.id]);
  assert.deepEqual(
    (await relations()).entries
      .filter((entry) => entry.edge.active && entry.edge.type === "includes")
      .map((entry) => entry.edge.to.id),
    [b.id],
  );
});

test("REL-04: отказ до отношений не публикует состав; WAL восстанавливает refs и отношения совместно", async (t) => {
  const { root, workspace, plans, releases } = await fixture(t);
  const a = await plans.create({ title: "Первый", requestId: "a" }, "agent");
  const b = await plans.create({ title: "Второй", requestId: "b" }, "agent");
  const release = await releases.createByRefs(
    { title: "Релиз", version: "1", plans: [a.key], requestId: "r" },
    "agent",
  );
  const command = {
    title: "Обновлён",
    version: "2",
    plans: [`work-plan:${b.id}`],
    status: "planned" as const,
    ifRevision: release.revision,
    requestId: "update",
  };
  const write = StorageSession.prototype.writeFile;
  const fault = t.mock.method(
    StorageSession.prototype,
    "writeFile",
    async function (this: StorageSession, ...args: Parameters<StorageSession["writeFile"]>) {
      if (args[0].startsWith("relations/releases")) throw new Error("Отказ до отношений");
      return write.apply(this, args);
    },
  );
  await assert.rejects(releases.updateByRefs(release.id, command, "agent"), /Отказ/);
  fault.mock.restore();
  assert.deepEqual((await releases.get(release.id)).planIds, [a.id]);
  assert.equal((await releases.get(release.id)).revision, release.revision);
  const publish = StorageTransaction.prototype.publish;
  const crash = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (this: StorageTransaction, ...args: Parameters<StorageTransaction["publish"]>) {
      return publish.apply(
        new StorageTransaction(this.root, (phase, path) => {
          if (phase === "file" && path?.startsWith("entities/releases"))
            throw new Error("Прерывание WAL");
        }),
        args,
      );
    },
  );
  await assert.rejects(releases.updateByRefs(release.id, command, "agent"), /Прерывание WAL/);
  crash.mock.restore();
  const reopened = await openWorkspace(root);
  const service = new ReleasesService(reopened);
  const actual = await service.get(release.id);
  assert.deepEqual(actual.planIds, [b.id]);
  assert.equal(actual.revision, release.revision + 1);
  const owned = await reopened.locked(() =>
    readOwned(reopened.storageSession!, { kind: "release", id: release.id }),
  );
  assert.deepEqual(
    owned.entries
      .filter((entry) => entry.edge.active && entry.edge.type === "includes")
      .map((entry) => entry.edge.to.id),
    [b.id],
  );
  await assert.rejects(service.updateByRefs(release.id, command, "agent"), {
    code: "REVISION_CONFLICT",
  });
  await assert.rejects(readFile(join(workspace.root, "transactions/pending.json")), {
    code: "ENOENT",
  });
});

test("REL-05: progress использует один PlanningState и сохраняет released при потере текущей готовности", async (t) => {
  const { plans, releases, tasks, progress } = await fixture(t);
  const dependency = await tasks.create(
    { board: "infrastructure", column: "done", requestId: "dep" },
    "agent",
  );
  const task = await tasks.create(
    { board: "product", column: "done", dependencies: [dependency.id], requestId: "task" },
    "agent",
  );
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const plan = await plans.create(
      { title: `План ${index}`, requestId: `plan-${index}` },
      "agent",
    );
    const stage = await plans.changeStage(
      plan.id,
      { action: "create", fields: { title: "Этап" }, ifRevision: 1, requestId: `stage-${index}` },
      "agent",
    );
    const included = await plans.changeTasks(
      plan.id,
      {
        stage: stage.stageId!,
        add: [task.id],
        ifRevision: stage.revision,
        requestId: `include-${index}`,
      },
      "agent",
    );
    await plans.transition(
      plan.id,
      {
        action: "complete",
        result: "Проверено",
        ifRevision: included.revision,
        requestId: `complete-${index}`,
      },
      "agent",
    );
    ids.push(plan.id);
  }
  const release = await releases.createByRefs(
    { title: "Выпуск", version: "1", plans: ids, status: "released", requestId: "release" },
    "agent",
  );
  const published = await releases.get(release.id);
  const all = t.mock.method(BoardTaskRepository.prototype, "all");
  const first = await measured(() => progress.release({ ref: release.id, limit: 1 }));
  assert.equal(first.completions, 1);
  assert.equal(first.planningBuilds, 1);
  assert.equal(all.mock.callCount(), 1);
  all.mock.restore();
  releaseProgressSchema.parse(first.value);
  assert.equal(first.value.completed, true);
  assert.equal(first.value.readiness.canRelease, false);
  const second = await progress.release({
    ref: release.id,
    limit: 1,
    offset: 1,
    version: first.value.version,
  });
  assert.equal(second.plans.items[0]?.id, ids[1]);
  assert.equal(second.reasons.items.length, 0);
  await tasks.move(
    dependency.id,
    { column: "review", ifRevision: dependency.revision, requestId: "reopen" },
    "agent",
  );
  await assert.rejects(
    progress.release({ ref: release.id, limit: 1, offset: 1, version: first.value.version }),
    { code: "PROGRESS_CHANGED" },
  );
  const diverged = await progress.release({ ref: release.id, limit: 1 });
  assert.equal(diverged.status, "released");
  assert.equal(diverged.completed, false);
  assert.equal(diverged.readiness.ready, 0);
  assert.equal(diverged.reasons.total, 3);
  const reasons = await progress.release({
    ref: release.id,
    limit: 1,
    offset: 2,
    version: diverged.version,
  });
  assert.equal(reasons.plans.items.length, 0);
  assert.equal(reasons.reasons.items.length, 1);
  const current = await releases.get(release.id);
  for (const key of ["revision", "releasedAt", "releasedBy", "status"] as const)
    assert.equal(current[key], published[key]);
  await assert.rejects(
    releases.updateByRefs(
      release.id,
      {
        title: "Другой",
        version: "2",
        plans: ids,
        status: "planned",
        ifRevision: current.revision,
        requestId: "immutable",
      },
      "agent",
    ),
    { code: "RELEASE_IMMUTABLE" },
  );
  t.diagnostic(
    "progress.release: tasks.all=1, taskCompletions=1 (один путь построения PlanningState)",
  );
});

test("read-модели не скрывают отсутствующие ссылки и циклы за пагинацией", async (t) => {
  const { tasks, plans, progress } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  const original = BoardTaskRepository.prototype.all;
  const broken = t.mock.method(
    BoardTaskRepository.prototype,
    "all",
    async function (this: BoardTaskRepository) {
      return (await original.call(this)).map((entry) => ({ ...entry, dependencies: ["missing"] }));
    },
  );
  await assert.rejects(tasks.list({ q: "Нет совпадения", limit: 1 }), {
    code: "INVALID_REFERENCE",
  });
  await assert.rejects(plans.candidates({ limit: 1 }), { code: "INVALID_REFERENCE" });
  await assert.rejects(progress.taskDependencies({ ref: task.id, limit: 1 }), {
    code: "INVALID_REFERENCE",
  });
  broken.mock.restore();
  const other = await tasks.create({ board: "product", requestId: "other" }, "agent");
  const cycle = t.mock.method(
    BoardTaskRepository.prototype,
    "all",
    async function (this: BoardTaskRepository) {
      return (await original.call(this)).map((entry) =>
        entry.id === task.id ? { ...entry, dependencies: [other.id], parentId: other.id } : entry,
      );
    },
  );
  // Канбан сохраняет совместимое чтение старого смешанного цикла для его ремонта.
  assert.equal((await tasks.list({ readiness: "blocked" })).total, 2);
  await assert.rejects(plans.candidates({ limit: 1 }), { code: "DEPENDENCY_CYCLE" });
  await assert.rejects(progress.taskDependencies({ ref: task.id, limit: 1 }), {
    code: "DEPENDENCY_CYCLE",
  });
  cycle.mock.restore();
});
