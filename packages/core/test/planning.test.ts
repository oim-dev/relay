import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { ProgressService } from "../src/application/progress/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { StorageService } from "../src/application/storage/service.js";
import { planningRecord, savePlanning } from "../src/storage/planning.js";
import { RECORD_BYTES } from "../src/storage/entity-store/format.js";
import { readOwned } from "../src/storage/entity-store/relations.js";
import { planSummarySchema } from "@relay/contracts/planning";
import type { PlanningSaved } from "@relay/contracts/planning";

async function fixture(t: TestContext, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "relay-planning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks", undefined, { legacy });
  return {
    root,
    workspace,
    plans: new PlanningService(workspace),
    releases: new ReleasesService(workspace),
    progress: new ProgressService(workspace),
    tasks: new BoardTasksService(workspace),
    entities: new EntityEngine(workspace),
  };
}

test("готовый план завершается без начала и допускает выпуск с сохранением связей и повтора", async (t) => {
  const { workspace, plans, tasks, releases } = await fixture(t);
  const plan = await plans.create({ title: "Простой план", requestId: "plan" }, "agent");
  const complete = {
    action: "complete" as const,
    result: "Готово",
    ifRevision: 1,
    requestId: "empty",
  };
  await assert.rejects(plans.transition(plan.id, complete, "agent"), { code: "PLAN_INCOMPLETE" });
  const task = await tasks.create(
    { board: "product", column: "ready", requestId: "task" },
    "agent",
  );
  const stage = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Этап" },
      ifRevision: plan.revision,
      requestId: "stage",
    },
    "agent",
  );
  const included = await plans.changeTasks(
    plan.id,
    {
      stage: stage.stageId,
      add: [task.id],
      ifRevision: stage.revision,
      requestId: "include",
    },
    "agent",
  );
  const command = { ...complete, ifRevision: included.revision, requestId: "complete" };
  await assert.rejects(plans.transition(plan.id, command, "agent"), { code: "PLAN_INCOMPLETE" });
  await tasks.move(
    task.id,
    { column: "done", ifRevision: task.revision, requestId: "done" },
    "agent",
  );
  await assert.rejects(
    plans.transition(plan.id, { ...command, result: "", requestId: "no-result" }, "agent"),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    plans.transition(plan.id, { ...command, ifRevision: 1, requestId: "stale" }, "agent"),
    { code: "REVISION_CONFLICT" },
  );
  const graphBefore = await new GraphService(workspace).context({ root: plan.id });
  const receipt = await plans.transition(plan.id, command, "agent");
  assert.deepEqual(await plans.transition(plan.id, command, "agent"), receipt);
  const completed = await plans.get(plan.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.startedAt, null);
  assert.equal(completed.result, "Готово");
  assert.equal((await plans.memberships(task.id)).items[0]?.current, false);
  const graphAfter = await new GraphService(workspace).context({ root: plan.id });
  assert.deepEqual(graphAfter.edges, graphBefore.edges);
  const release = await releases.create(
    { title: "Выпуск", version: "1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  assert.equal((await releases.get(release.id)).readiness.canRelease, true);
  const publish = {
    title: "Выпуск",
    version: "1",
    planIds: [plan.id],
    status: "released" as const,
    ifRevision: release.revision,
    requestId: "publish",
  };
  const published = await releases.update(release.id, publish, "agent");
  assert.deepEqual(await releases.update(release.id, publish, "agent"), published);
  assert.equal((await releases.get(release.id)).status, "released");
  assert.equal((await releases.composition(release.id)).items[0]?.id, plan.id);
  assert.equal("snapshotId" in (await releases.get(release.id)), false);
});

test("частичная правка этапа сохраняет остальные поля и повторяет исходную квитанцию после чужой правки", async (t) => {
  const { root, workspace, plans } = await fixture(t);
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  const fields = {
    title: "Исходный этап",
    summary: "Исходное описание",
    outcome: "## Результат\n\nТочный текст\n",
    completionConditions: "- Проверить результат\n",
  };
  const created = await plans.changeStage(
    plan.id,
    { action: "create", fields, ifRevision: plan.revision, requestId: "stage" },
    "agent",
  );
  const stage = created.stageId!;
  const titleOnly = {
    action: "update" as const,
    stage,
    fields: { title: "Новое название" },
    ifRevision: created.revision,
    requestId: "title-only",
  };
  const renamed = await plans.changeStage(plan.id, titleOnly, "agent");
  const content = async () => {
    const { counts: _counts, ...stage } = (await plans.stages(plan.id)).items[0]!;
    return stage;
  };
  assert.deepEqual(await content(), { ...fields, title: "Новое название", id: stage, taskIds: [] });
  const independent = await plans.changeStage(
    plan.id,
    {
      action: "update",
      stage,
      fields: { summary: "Независимо уточнённое описание" },
      ifRevision: renamed.revision,
      requestId: "summary-only",
    },
    "another-agent",
  );
  const path = join(workspace.root, "entities/work-plans", `${plan.id}.json`);
  const beforeRepeat = await readFile(path, "utf8");
  const reopened = new PlanningService(await openWorkspace(root));
  assert.deepEqual(await reopened.changeStage(plan.id, titleOnly, "agent"), renamed);
  assert.equal(await readFile(path, "utf8"), beforeRepeat);
  assert.equal((await reopened.get(plan.id)).revision, independent.revision);
  assert.deepEqual(await content(), {
    ...fields,
    title: "Новое название",
    summary: "Независимо уточнённое описание",
    id: stage,
    taskIds: [],
  });
  const cleared = await reopened.changeStage(
    plan.id,
    {
      action: "update",
      stage,
      fields: { summary: "", outcome: "", completionConditions: "" },
      ifRevision: independent.revision,
      requestId: "clear",
    },
    "agent",
  );
  assert.deepEqual(await content(), {
    id: stage,
    title: "Новое название",
    summary: "",
    outcome: "",
    completionConditions: "",
    taskIds: [],
  });
  const beforeEmpty = await readFile(path, "utf8");
  for (const [index, fields] of [{}, { summary: undefined }, undefined].entries()) {
    await assert.rejects(
      reopened.changeStage(
        plan.id,
        {
          action: "update",
          stage,
          ...(fields === undefined ? {} : { fields }),
          ifRevision: cleared.revision,
          requestId: `empty-${index}`,
        },
        "agent",
      ),
      { code: "INVALID_ARGUMENT" },
    );
  }
  assert.equal(await readFile(path, "utf8"), beforeEmpty);
  const restored = await reopened.changeStage(
    plan.id,
    { action: "update", stage, fields, ifRevision: cleared.revision, requestId: "full-fields" },
    "agent",
  );
  assert.deepEqual(await content(), { ...fields, id: stage, taskIds: [] });
  assert.equal(restored.revision, cleared.revision + 1);
});

test("создание этапа требует название и заполняет отсутствующие текстовые поля", async (t) => {
  const { plans } = await fixture(t);
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  await assert.rejects(
    plans.changeStage(
      plan.id,
      {
        action: "create",
        fields: { summary: "Без названия" },
        ifRevision: plan.revision,
        requestId: "no-title",
      },
      "agent",
    ),
    { name: "ZodError" },
  );
  assert.equal((await plans.get(plan.id)).revision, plan.revision);
  assert.equal((await plans.stages(plan.id)).total, 0);
  const created = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Новый этап" },
      ifRevision: plan.revision,
      requestId: "stage",
    },
    "agent",
  );
  const { counts: _counts, ...stage } = (await plans.stages(plan.id)).items[0]!;
  assert.deepEqual(stage, {
    id: created.stageId,
    title: "Новый этап",
    summary: "",
    outcome: "",
    completionConditions: "",
    taskIds: [],
  });
});

test("конкурентное включение: одна текущая принадлежность и сохранение отменённой истории", async (t) => {
  const { workspace, plans, tasks } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  const owners = [];
  for (const [index, title] of ["Первый", "Второй"].entries()) {
    const plan = await plans.create({ title, requestId: `plan-${index}` }, "agent");
    const stage = await plans.changeStage(
      plan.id,
      {
        action: "create",
        fields: { title: "Этап" },
        ifRevision: plan.revision,
        requestId: `plan-${index}-stage`,
      },
      "agent",
    );
    owners.push({ plan, stage });
  }
  const results = await Promise.allSettled(
    owners.map(({ plan, stage }, index) =>
      plans.changeTasks(
        plan.id,
        {
          stage: stage.stageId,
          add: [task.id],
          ifRevision: stage.revision,
          requestId: `race-${index}`,
        },
        "agent",
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert.equal(failure?.status === "rejected" ? failure.reason.code : null, "TASK_IN_PLAN");
  const active = (await plans.memberships(task.id)).items[0]!;
  const winner = await plans.get(active.planId);
  await plans.transition(
    winner.id,
    { action: "cancel", result: "Пересмотрено", ifRevision: winner.revision, requestId: "cancel" },
    "agent",
  );
  assert.equal((await plans.memberships(task.id)).items[0]?.current, false);
  const other = owners.find((entry) => entry.plan.id !== winner.id)!;
  const included = await plans.changeTasks(
    other.plan.id,
    {
      stage: other.stage.stageId,
      add: [task.id],
      ifRevision: other.stage.revision,
      requestId: "next",
    },
    "agent",
  );
  const history = await plans.memberships(task.id);
  assert.equal(history.total, 2);
  assert.equal(history.items.filter((item) => item.current).length, 1);
  const graph = new GraphService(workspace);
  await graph.mutate(
    {
      operations: [{ action: "add", type: "part-of", from: task.id, to: other.plan.id }],
      ifVersion: (await graph.context({ root: task.id })).version,
      requestId: "diagnostic",
    },
    "agent",
  );
  const owner = { kind: "work-plan", id: other.plan.id };
  const owned = await workspace.locked(() => readOwned(workspace.storageSession!, owner));
  const membership = owned.entries.find(
    (entry) => entry.slot === "planning-membership" && entry.edge.active,
  )!;
  assert.equal(membership.edge.from.id, task.id);
  assert.equal(membership.edge.to.id, other.plan.id);
  const before = await graph.context({ root: task.id });
  await plans.changeTasks(
    other.plan.id,
    {
      stage: other.stage.stageId!,
      remove: [task.id],
      ifRevision: included.revision,
      requestId: "exclude",
    },
    "agent",
  );
  const after = await graph.context({ root: task.id });
  assert.deepEqual(
    after.edges,
    before.edges.filter((edge) => edge.id !== membership.edge.id),
  );
  const revoked = await workspace.locked(() => readOwned(workspace.storageSession!, owner));
  assert.equal(
    revoked.entries.find((entry) => entry.edge.id === membership.edge.id)?.edge.active,
    false,
  );
  assert.equal((await plans.memberships(task.id)).total, 1);
  assert.equal((await plans.memberships(task.id)).items[0]?.planId, winner.id);
});

test("выпуск: прерывание публикации восстанавливает дату, автора и повтор без архивных сущностей", async (t) => {
  const { root, workspace, plans, tasks, releases, entities } = await fixture(t);
  const task = await tasks.create({ board: "product", column: "done", requestId: "task" }, "agent");
  let plan: PlanningSaved = await plans.create(
    {
      title: "Результат *буквально*",
      goal: "## Цель\n\nПроверить восстановление",
      requestId: "plan",
    },
    "agent",
  );
  const stage = await plans.changeStage(
    plan.id,
    { action: "create", fields: { title: "Этап" }, ifRevision: plan.revision, requestId: "stage" },
    "agent",
  );
  plan = await plans.changeTasks(
    plan.id,
    { stage: stage.stageId, add: [task.id], ifRevision: stage.revision, requestId: "include" },
    "agent",
  );
  plan = await plans.transition(
    plan.id,
    { action: "start", ifRevision: plan.revision, requestId: "start" },
    "agent",
  );
  plan = await plans.transition(
    plan.id,
    { action: "complete", result: "Проверено", ifRevision: plan.revision, requestId: "complete" },
    "agent",
  );
  const document = await entities.create(
    {
      data: {
        kind: "document",
        name: "Общие правила",
        summary: "Описание *обычным текстом*",
        body: "## Общее правило\n\nМатериалы паспорта тоже сохраняются.",
        documentKind: "rules",
        relations: [
          {
            target: { kind: "product", id: "passport" },
            type: "documents",
            description: "Обязательный контекст",
          },
        ],
      },
      requestId: "global-doc",
    },
    "agent",
  );
  const release = await releases.create(
    { title: "Выпуск", version: "1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  const command = {
    action: "release" as const,
    ifRevision: release.revision,
    requestId: "publish",
  };
  const publish = StorageTransaction.prototype.publish;
  const fault = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (
      this: StorageTransaction,
      ...[changes, owned]: Parameters<StorageTransaction["publish"]>
    ) {
      return publish.call(
        new StorageTransaction(this.root, (phase, path) => {
          if (phase === "file" && path?.startsWith("entities/releases/"))
            throw new Error("Отказ после записи релиза");
        }),
        changes,
        owned,
      );
    },
  );
  await assert.rejects(releases.transition(release.id, command, "agent"), /Отказ/);
  fault.mock.restore();
  const interrupted = JSON.parse(
    await readFile(join(workspace.root, "entities/releases", `${release.id}.json`), "utf8"),
  );
  const recovered = new ReleasesService(await openWorkspace(root));
  const receipt = await recovered.transition(release.id, command, "agent");
  assert.deepEqual(await recovered.transition(release.id, command, "agent"), receipt);
  const record = await recovered.get(release.id);
  assert.equal(record.releasedAt, interrupted.data.releasedAt);
  assert.equal(record.releasedBy, "agent");
  assert.equal((await recovered.list()).total, 1);
  assert.equal(
    (await recovered.composition(release.id)).items[0]?.plan?.title,
    "Результат *буквально*",
  );
  assert.equal((await entities.get({ ref: document.ref.id })).ref.id, document.ref.id);
  const collections = await readdir(join(workspace.root, "entities"));
  assert.deepEqual(collections.filter((name) => /plan|release/.test(name)).sort(), [
    "releases",
    "work-plans",
  ]);
  const rawPlan = JSON.parse(
    await readFile(join(workspace.root, "entities/work-plans", `${plan.id}.json`), "utf8"),
  );
  assert(Array.isArray(rawPlan.data.goal));
  assert(Array.isArray(rawPlan.data.stages[0].outcome));
});

test("планы: ревизии, одна текущая принадлежность, перенос, пагинация и отдельные связи", async (t) => {
  const { workspace, plans, tasks, progress, entities } = await fixture(t);
  const task = await tasks.create(
    { board: "product", title: "Работа", requestId: "task" },
    "agent",
  );
  const a = await plans.create(
    { title: "Первый", goal: "## Цель\n\n  Пробелы  \n", requestId: "a" },
    "agent",
  );
  const b = await plans.create({ title: "Второй", requestId: "b" }, "agent");
  const sa = await plans.changeStage(
    a.id,
    { action: "create", ifRevision: a.revision, fields: { title: "Этап A" }, requestId: "sa" },
    "agent",
  );
  const sb = await plans.changeStage(
    b.id,
    { action: "create", ifRevision: b.revision, fields: { title: "Этап B" }, requestId: "sb" },
    "agent",
  );
  const include = {
    stage: sa.stageId!,
    add: [task.key],
    ifRevision: sa.revision,
    requestId: "include",
  };
  const saved = await plans.changeTasks(a.id, include, "agent");
  assert.deepEqual(await plans.changeTasks(a.id, include, "agent"), saved);
  await assert.rejects(plans.changeTasks(a.id, { ...include, add: [] }, "agent"), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  await assert.rejects(
    plans.changeTasks(
      b.id,
      { stage: sb.stageId!, add: [task.id], ifRevision: sb.revision, requestId: "duplicate" },
      "agent",
    ),
    { code: "TASK_IN_PLAN", details: { taskId: task.id, stageId: sa.stageId } },
  );
  const before = await new GraphService(workspace).context({ root: task.key });
  assert(
    before.edges.some(
      (edge) => edge.from.id === task.id && edge.to.id === a.id && edge.type === "part-of",
    ),
  );
  assert.equal((await progress.task({ ref: task.id })).planning?.planId, a.id);
  await assert.rejects(
    new EntityDeletionService(workspace).preview({ ref: task.id, kind: "task" }),
    { code: "PLANNING_REFERENCE_IN_USE" },
  );
  const moved = await plans.transfer(
    a.id,
    {
      task: task.id,
      targetPlan: b.id,
      targetStage: sb.stageId!,
      ifRevision: saved.revision,
      targetRevision: sb.revision,
      reason: "Изменился ближайший результат",
      requestId: "transfer",
    },
    "agent",
  );
  assert.equal((await progress.task({ ref: task.id })).planning?.planId, b.id);
  const history = await entities.history({ ref: a.id });
  assert(
    history.items.some(
      (event) =>
        event.action === "transfer" && event.description?.includes("Изменился ближайший результат"),
    ),
  );
  assert.equal((await tasks.get(task.id)).column, "inbox");
  const after = await new GraphService(workspace).context({ root: task.id });
  assert(!after.edges.some((edge) => edge.from.id === task.id && edge.to.id === a.id));
  assert(after.edges.some((edge) => edge.from.id === task.id && edge.to.id === b.id));
  assert.equal((await plans.tasks(b.id, sb.stageId!)).total, 1);
  const page = await plans.list({ limit: 1 });
  assert.equal(page.total, 2);
  assert.equal((await plans.list({ offset: 1, limit: 1, version: page.version })).items.length, 1);
  await assert.rejects(plans.list({ offset: 1 }), { code: "INVALID_ARGUMENT" });
  await plans.update(
    a.id,
    { title: "Уточнённый", ifRevision: moved.revision, requestId: "edit" },
    "agent",
  );
  await assert.rejects(plans.list({ offset: 1, limit: 1, version: page.version }), {
    code: "PLANNING_CHANGED",
  });
  assert.equal((await entities.get({ ref: a.key })).data.kind, "work-plan");
  await assert.rejects(entities.get({ ref: sa.stageId! }), { code: "ENTITY_NOT_FOUND" });
  const raw = JSON.parse(
    await readFile(join(workspace.root, "entities/work-plans", `${a.id}.json`), "utf8"),
  );
  assert.deepEqual(raw.data.goal, ["## Цель", "", "  Пробелы  ", ""]);
  const repair = await new StorageService(workspace).reconcileRelations(
    { requestId: "repair" },
    "agent",
  );
  assert.equal(repair.added + repair.updated + repair.removed, 0);
});

test("релиз: актуальные планы и обязательства после выпуска и перезапуска, без снимков", async (t) => {
  const { root, workspace, plans, tasks, releases, progress, entities } = await fixture(t);
  const dependency = await tasks.create(
    { board: "infrastructure", title: "Инфраструктура", column: "done", requestId: "dependency" },
    "agent",
  );
  const task = await tasks.create(
    {
      board: "product",
      title: "Пользовательский сценарий",
      description: "## Исходное описание\n\nТочный текст",
      column: "done",
      dependencies: [dependency.id],
      requestId: "task",
    },
    "agent",
  );
  const plan = await plans.create({ title: "Результат", goal: "Цель", requestId: "plan" }, "agent");
  let saved: PlanningSaved = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Подготовка", outcome: "Проверенный результат" },
      ifRevision: 1,
      requestId: "stage",
    },
    "agent",
  );
  const stage = saved.stageId!;
  saved = await plans.changeTasks(
    plan.id,
    { stage, add: [task.id], ifRevision: saved.revision, requestId: "include" },
    "agent",
  );
  const release = await releases.create(
    { title: "Первый выпуск", version: "0.1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  await assert.rejects(
    releases.transition(
      release.id,
      { action: "release", ifRevision: release.revision, requestId: "early" },
      "agent",
    ),
    { code: "RELEASE_INCOMPLETE" },
  );
  saved = await plans.transition(
    plan.id,
    { action: "start", ifRevision: saved.revision, requestId: "start" },
    "agent",
  );
  saved = await plans.transition(
    plan.id,
    {
      action: "complete",
      result: "## Итог\n\nПроверено",
      ifRevision: saved.revision,
      requestId: "complete",
    },
    "agent",
  );
  const doc = await entities.create(
    {
      data: {
        kind: "document",
        name: "Требования выпуска",
        summary: "Материал",
        body: "## Правило\n\nИсходный Markdown",
        documentKind: "specification",
        relations: [
          {
            target: { kind: "work-plan", id: plan.id },
            type: "documents",
            description: "Основание",
          },
        ],
      },
      requestId: "doc",
    },
    "agent",
  );
  assert.equal((await progress.workPlan({ ref: plan.id })).completed, true);
  const command = {
    action: "release" as const,
    ifRevision: release.revision,
    requestId: "publish",
  };
  const published = await releases.transition(release.id, command, "agent");
  assert.equal((await releases.composition(release.id)).readiness.ready, 1);
  await entities.update(
    {
      ref: doc.ref.id,
      ifRevision: doc.revision,
      changes: { kind: "document", body: "Новое правило" },
      requestId: "change-doc",
    },
    "agent",
  );
  await tasks.move(
    dependency.id,
    { column: "review", ifRevision: dependency.revision, requestId: "reopen" },
    "agent",
  );
  assert.equal((await progress.workPlan({ ref: plan.id })).diverged, true);
  assert.equal((await releases.get(release.id)).status, "released");
  assert.equal((await progress.release({ ref: release.id })).completed, false);
  assert.equal((await releases.composition(release.id)).readiness.ready, 0);
  assert.deepEqual(await releases.transition(release.id, command, "agent"), published);
  await assert.rejects(
    releases.transition(
      release.id,
      { action: "cancel", ifRevision: published.revision, requestId: "cancel" },
      "agent",
    ),
    { code: "RELEASE_IMMUTABLE" },
  );
  const reopened = await openWorkspace(root);
  assert.deepEqual(
    await new ReleasesService(reopened).composition(release.id),
    await releases.composition(release.id),
  );
  const next = await plans.create({ title: "Продолжение", requestId: "next" }, "agent");
  const nextStage = await plans.changeStage(
    next.id,
    {
      action: "create",
      fields: { title: "Исправление" },
      ifRevision: next.revision,
      requestId: "next-stage",
    },
    "agent",
  );
  await plans.changeTasks(
    next.id,
    {
      stage: nextStage.stageId!,
      add: [task.id],
      ifRevision: nextStage.revision,
      requestId: "next-include",
    },
    "agent",
  );
  const memberships = await plans.memberships(task.id);
  assert.equal(memberships.total, 2);
  assert.equal(memberships.items.filter((item) => item.current).length, 1);
  assert.equal((await new GraphService(workspace).context({ root: release.id })).complete, true);
});

test("планирование: отказ до связей, восстановление WAL и повтор первоначальной квитанции", async (t) => {
  const { root, workspace, plans, tasks } = await fixture(t);
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  const stage = await plans.changeStage(
    plan.id,
    { action: "create", fields: { title: "Этап" }, ifRevision: 1, requestId: "stage" },
    "agent",
  );
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  const command = {
    stage: stage.stageId!,
    add: [task.id],
    ifRevision: stage.revision,
    requestId: "include",
  };
  const write = StorageSession.prototype.writeFile;
  const fail = t.mock.method(
    StorageSession.prototype,
    "writeFile",
    async function (
      this: StorageSession,
      ...[path, value]: Parameters<StorageSession["writeFile"]>
    ) {
      if (path.startsWith("relations/work-plans")) throw new Error("Отказ перед записью связей");
      return write.call(this, path, value);
    },
  );
  await assert.rejects(plans.changeTasks(plan.id, command, "agent"), /Отказ/);
  fail.mock.restore();
  assert.equal((await plans.tasks(plan.id, stage.stageId!)).total, 0);
  const publish = StorageTransaction.prototype.publish;
  const interrupted = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (
      this: StorageTransaction,
      ...[changes, owned]: Parameters<StorageTransaction["publish"]>
    ) {
      const crashing = new StorageTransaction(this.root, (phase, path) => {
        if (phase === "file" && path?.startsWith("entities/work-plans/"))
          throw new Error("Прерывание после предметной записи");
      });
      return publish.call(crashing, changes, owned);
    },
  );
  await assert.rejects(plans.changeTasks(plan.id, command, "agent"), /Прерывание/);
  interrupted.mock.restore();
  const recovered = new PlanningService(await openWorkspace(root));
  const receipt = await recovered.changeTasks(plan.id, command, "agent");
  assert.equal(receipt.revision, stage.revision + 1);
  assert.equal((await recovered.tasks(plan.id, stage.stageId!)).total, 1);
  const graph = await new GraphService(workspace).context({ root: task.id });
  assert.equal(
    graph.edges.filter((edge) => edge.from.id === task.id && edge.to.id === plan.id).length,
    1,
  );
});

test("вложенные этапы: только явные задачи, внутренние ID, единая ревизия и порядок", async (t) => {
  const { workspace, plans, tasks, entities } = await fixture(t);
  const parent = await tasks.create({ board: "product", requestId: "parent" }, "agent");
  const child = await tasks.create(
    { board: "product", parentId: parent.id, requestId: "child" },
    "agent",
  );
  const plan = await plans.create({ title: "Вложенный состав", requestId: "plan" }, "agent");
  const first = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Первый", outcome: "## Результат\n\n  Пробелы  \n" },
      ifRevision: plan.revision,
      requestId: "first",
    },
    "agent",
  );
  const second = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Второй" },
      ifRevision: first.revision,
      requestId: "second",
    },
    "agent",
  );
  const included = await plans.changeTasks(
    plan.id,
    {
      stage: first.stageId!,
      add: [parent.id],
      ifRevision: second.revision,
      requestId: "include",
    },
    "agent",
  );
  const path = join(workspace.root, "entities/work-plans", `${plan.id}.json`);
  const before = await readFile(path, "utf8");
  const stored = JSON.parse(before);
  assert.equal(stored.dataVersion, 2);
  assert.deepEqual(stored.data.stages[0].taskIds, [parent.id]);
  assert.deepEqual(stored.data.stages[0].outcome, ["## Результат", "", "  Пробелы  ", ""]);
  for (const stage of stored.data.stages) {
    for (const field of ["key", "revision", "kind", "rank", "planId"])
      assert.equal(field in stage, false);
  }
  assert(
    !(await readdir(join(workspace.root, "keyspaces"))).some((name) => name.includes("stage")),
  );
  const summary = await plans.get(plan.id);
  assert.equal("stages" in summary, false);
  planSummarySchema.parse(summary);
  const listed = (await plans.list()).items[0]!;
  assert.equal("stages" in listed, false);
  planSummarySchema.parse(listed);
  const full = await entities.get({ ref: plan.id });
  assert.equal(full.data.kind, "work-plan");
  assert(full.data.kind === "work-plan");
  assert.deepEqual(
    full.data.stages.map((stage) => stage.id),
    [first.stageId, second.stageId],
  );
  assert.deepEqual(full.data.stages[0]?.taskIds, [parent.id]);
  assert.equal(full.data.stages[0]?.outcome, "## Результат\n\n  Пробелы  \n");
  assert(full.references.some((entry) => entry.ref.id === parent.id));
  assert(!full.references.some((entry) => entry.ref.id === child.id));
  await assert.rejects(
    plans.changeTasks(
      plan.id,
      {
        stage: second.stageId!,
        add: [child.key, child.id],
        ifRevision: included.revision,
        requestId: "duplicate-add",
      },
      "agent",
    ),
    { code: "DUPLICATE_VALUE" },
  );
  await assert.rejects(
    plans.changeTasks(
      plan.id,
      {
        stage: first.stageId!,
        remove: [parent.key, parent.id],
        ifRevision: included.revision,
        requestId: "duplicate-remove",
      },
      "agent",
    ),
    { code: "DUPLICATE_VALUE" },
  );
  assert.equal((await plans.memberships(child.id)).total, 0);
  await plans.tasks(plan.id, first.stageId!);
  const graph = await new GraphService(workspace).context({ root: plan.id });
  assert(graph.nodes.some((node) => node.ref.id === child.id));
  assert(!graph.edges.some((edge) => edge.from.id === child.id && edge.to.id === plan.id));
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(
    (await plans.candidates({ plan: plan.key, stage: first.stageId! })).items.find(
      (task) => task.id === parent.id,
    )?.assignment?.planId,
    plan.id,
  );
  await assert.rejects(plans.candidates({ stage: first.stageId! }), { code: "INVALID_ARGUMENT" });
  const page = await plans.stages(plan.id, { limit: 1 });
  assert.equal(
    (await plans.stages(plan.id, { limit: 1, offset: 1, version: page.version })).items[0]?.id,
    second.stageId,
  );
  let moved = await plans.changeStage(
    plan.id,
    {
      action: "move",
      stage: second.stageId!,
      direction: "up",
      ifRevision: included.revision,
      requestId: "move",
    },
    "agent",
  );
  assert.equal((await plans.stages(plan.id)).items[0]?.id, second.stageId);
  await assert.rejects(plans.stages(plan.id, { limit: 1, offset: 1, version: page.version }), {
    code: "PLANNING_CHANGED",
  });
  moved = await plans.changeStage(
    plan.id,
    {
      action: "move",
      stage: second.stageId!,
      before: null,
      ifRevision: moved.revision,
      requestId: "move-last",
    },
    "agent",
  );
  assert.deepEqual(
    (await plans.stages(plan.id)).items.map((stage) => stage.id),
    [first.stageId, second.stageId],
  );
  moved = await plans.changeStage(
    plan.id,
    {
      action: "move",
      stage: second.stageId!,
      before: first.stageId!,
      ifRevision: moved.revision,
      requestId: "move-before",
    },
    "agent",
  );
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).data.stages.map((stage: { id: string }) => stage.id),
    [second.stageId, first.stageId],
  );
  await assert.rejects(
    plans.changeStage(
      plan.id,
      {
        action: "remove",
        stage: first.stageId!,
        ifRevision: moved.revision,
        requestId: "remove-full",
      },
      "agent",
    ),
    { code: "STAGE_NOT_EMPTY" },
  );
  const transfer = {
    task: parent.id,
    targetPlan: plan.key,
    targetStage: second.stageId!,
    ifRevision: moved.revision,
    targetRevision: moved.revision,
    reason: "Следующий этап",
    requestId: "transfer",
  };
  const transferBefore = await readFile(path, "utf8");
  await assert.rejects(
    plans.transfer(
      plan.id,
      { ...transfer, targetRevision: moved.revision - 1, requestId: "stale-same-target" },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
  await assert.rejects(
    plans.transfer(
      plan.id,
      { ...transfer, ifRevision: moved.revision - 1, requestId: "stale-same-source" },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(await readFile(path, "utf8"), transferBefore);
  const graphBeforeTransfer = await new GraphService(workspace).context({ root: plan.id });
  const transferred = await plans.transfer(plan.id, transfer, "agent");
  assert.deepEqual(await plans.transfer(plan.id, transfer, "agent"), transferred);
  assert.equal(transferred.revision, moved.revision + 1);
  assert.equal(transferred.targetRevision, transferred.revision);
  assert.deepEqual(
    (await new GraphService(workspace).context({ root: plan.id })).edges,
    graphBeforeTransfer.edges,
  );
  const removed = await plans.changeStage(
    plan.id,
    {
      action: "remove",
      stage: first.stageId!,
      ifRevision: transferred.revision,
      requestId: "remove",
    },
    "agent",
  );
  const explicit = await plans.changeTasks(
    plan.id,
    {
      stage: second.stageId!,
      add: [child.id],
      ifRevision: removed.revision,
      requestId: "explicit-child",
    },
    "agent",
  );
  assert.deepEqual((await plans.stages(plan.id)).items[0]?.taskIds, [parent.id, child.id]);
  const excluded = await plans.changeTasks(
    plan.id,
    {
      stage: second.stageId!,
      remove: [parent.id, child.id],
      ifRevision: explicit.revision,
      requestId: "exclude",
    },
    "agent",
  );
  const after = await new GraphService(workspace).context({ root: plan.id });
  assert(!after.edges.some((edge) => edge.to.id === plan.id && edge.from.kind === "task"));
  assert.equal((await plans.get(plan.id)).revision, excluded.revision);
  const types = await entities.types({ limit: 100 });
  assert(!types.items.some((entry) => String(entry.kind) === "plan-stage"));
});

test("совпавшие локальные ID этапов разных планов не смешивают подбор, прогресс и перенос", async (t) => {
  const { workspace, plans, tasks, progress } = await fixture(t);
  const taskA = await tasks.create({ board: "product", requestId: "task-a" }, "agent");
  const taskB = await tasks.create({ board: "product", requestId: "task-b" }, "agent");
  const a = await plans.create({ title: "Первый план", requestId: "a" }, "agent");
  const b = await plans.create({ title: "Второй план", requestId: "b" }, "agent");
  const sa = await plans.changeStage(
    a.id,
    {
      action: "create",
      fields: { title: "Первый этап" },
      ifRevision: a.revision,
      requestId: "sa",
    },
    "agent",
  );
  await plans.changeStage(
    b.id,
    {
      action: "create",
      fields: { title: "Другой этап" },
      ifRevision: b.revision,
      requestId: "sb",
    },
    "agent",
  );
  // Локальные ID намеренно совпадают: это допустимые данные разных планов.
  const seeded = await workspace.locked(async () => {
    const plan = await planningRecord(workspace, b.id, "work-plan");
    plan.stages[0]!.id = sa.stageId!;
    return savePlanning(workspace, plan, "agent", "stage-update");
  });
  const onlyB = await plans.changeStage(
    b.id,
    {
      action: "create",
      fields: { title: "Только во втором плане" },
      ifRevision: seeded.revision,
      requestId: "only-b",
    },
    "agent",
  );
  const includedA = await plans.changeTasks(
    a.id,
    {
      stage: sa.stageId!,
      add: [taskA.id],
      ifRevision: sa.revision,
      requestId: "include-a",
    },
    "agent",
  );
  const includedB = await plans.changeTasks(
    b.id,
    {
      stage: sa.stageId!,
      add: [taskB.id],
      ifRevision: onlyB.revision,
      requestId: "include-b",
    },
    "agent",
  );
  assert.equal((await plans.stages(b.id)).items[0]?.id, sa.stageId);
  assert.deepEqual(
    (await plans.candidates({ plan: a.key, stage: sa.stageId! })).items.map((task) => task.id),
    [taskA.id],
  );
  assert.deepEqual(
    (await plans.candidates({ plan: b.key, stage: sa.stageId! })).items.map((task) => task.id),
    [taskB.id],
  );
  const candidates = await plans.candidates({ availableOnly: "false" });
  assert.equal(candidates.items.find((task) => task.id === taskA.id)?.assignment?.planId, a.id);
  assert.equal(candidates.items.find((task) => task.id === taskB.id)?.assignment?.planId, b.id);
  assert.equal((await progress.task({ ref: taskA.id })).planning?.planId, a.id);
  assert.equal((await progress.task({ ref: taskB.id })).planning?.planId, b.id);
  assert.deepEqual(
    (await plans.tasks(a.id, sa.stageId!)).items.map((task) => task.id),
    [taskA.id],
  );
  assert.deepEqual(
    (await plans.tasks(b.id, sa.stageId!)).items.map((task) => task.id),
    [taskB.id],
  );
  await assert.rejects(plans.candidates({ plan: a.id, stage: onlyB.stageId! }), {
    code: "INVALID_REFERENCE",
  });
  const command = {
    task: taskA.id,
    targetPlan: b.key,
    targetStage: sa.stageId!,
    ifRevision: includedA.revision,
    targetRevision: includedB.revision,
    reason: "Передача работы",
    requestId: "transfer",
  };
  const files = [a.id, b.id].map((id) => join(workspace.root, "entities/work-plans", `${id}.json`));
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
  await assert.rejects(
    plans.transfer(
      a.id,
      {
        ...command,
        targetPlan: a.id,
        targetRevision: includedA.revision,
        targetStage: onlyB.stageId!,
        requestId: "wrong-plan",
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  await assert.rejects(
    plans.transfer(a.id, { ...command, targetPlan: taskB.id, requestId: "wrong-kind" }, "agent"),
    { code: "ENTITY_KIND_MISMATCH" },
  );
  await assert.rejects(
    plans.transfer(
      a.id,
      { ...command, targetStage: "missing", requestId: "missing-stage" },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  await assert.rejects(
    plans.transfer(
      a.id,
      { ...command, targetRevision: includedB.revision - 1, requestId: "stale-target" },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
  await assert.rejects(
    plans.transfer(a.id, { ...command, task: taskB.id, requestId: "wrong-source" }, "agent"),
    { code: "INVALID_REFERENCE" },
  );
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);
  const saved = await plans.transfer(a.id, command, "agent");
  assert.deepEqual(await plans.transfer(a.id, command, "agent"), saved);
  assert.equal(saved.revision, includedA.revision + 1);
  assert.equal(saved.targetRevision, includedB.revision + 1);
  assert.deepEqual((await plans.stages(a.id)).items[0]?.taskIds, []);
  assert.deepEqual((await plans.stages(b.id)).items[0]?.taskIds, [taskB.id, taskA.id]);
  assert.equal((await plans.memberships(taskA.id)).items[0]?.planId, b.id);
  assert.equal((await progress.task({ ref: taskA.id })).planning?.planId, b.id);
  const graph = await new GraphService(workspace).context({ root: taskA.id });
  assert(!graph.edges.some((edge) => edge.from.id === taskA.id && edge.to.id === a.id));
  assert.equal(
    graph.edges.filter((edge) => edge.from.id === taskA.id && edge.to.id === b.id).length,
    1,
  );
});

test("переполнение файла целевого плана отклоняет перенос атомарно, включая связи и квитанцию", async (t) => {
  const { root, workspace, plans, tasks } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  const source = await plans.create({ title: "Исходный план", requestId: "source" }, "agent");
  const stage = await plans.changeStage(
    source.id,
    {
      action: "create",
      fields: { title: "Исходный этап" },
      ifRevision: source.revision,
      requestId: "stage",
    },
    "agent",
  );
  const included = await plans.changeTasks(
    source.id,
    {
      stage: stage.stageId!,
      add: [task.id],
      ifRevision: stage.revision,
      requestId: "include",
    },
    "agent",
  );
  const target = await plans.create({ title: "Большой план", requestId: "target" }, "agent");
  // Подготовка граничного агрегата без десятков промежуточных записей больших текстов.
  const targetRevision = await workspace.locked(async () => {
    const session = workspace.storageSession!;
    const prior = await session.get({ kind: "work-plan", id: target.id });
    const record = {
      ...prior,
      revision: prior.revision + 1,
      data: {
        ...prior.data,
        goal: "x".repeat(256 * 1024),
        rationale: "",
        stages: Array.from({ length: 31 }, (_, index) => ({
          id: `stage-${index}`,
          title: `Этап ${index}`,
          summary: "",
          outcome: "x".repeat(256 * 1024),
          completionConditions: "x".repeat(256 * 1024),
          taskIds: [],
        })),
      },
    };
    const size = Buffer.byteLength(
      JSON.stringify(session.store.registry.encode(record), null, 2) + "\n",
    );
    record.data.rationale = "x".repeat(RECORD_BYTES - size - 1);
    await session.put(record, prior.revision);
    return record.revision;
  });
  const files = [
    `entities/work-plans/${source.id}.json`,
    `entities/work-plans/${target.id}.json`,
    `relations/work-plans/${source.id}.json`,
    `relations/work-plans/${target.id}.json`,
    ".indexes/state.json",
  ];
  const read = () => Promise.all(files.map((path) => readFile(join(workspace.root, path), "utf8")));
  const before = await read();
  assert.equal(Buffer.byteLength(before[1]!), RECORD_BYTES - 1);
  const command = {
    task: task.id,
    targetPlan: target.id,
    targetStage: "stage-0",
    ifRevision: included.revision,
    targetRevision,
    reason: "Передача работы",
    requestId: "transfer",
  };
  await assert.rejects(plans.transfer(source.id, command, "agent"), {
    code: "STORAGE_LIMIT_EXCEEDED",
  });
  assert.deepEqual(await read(), before);
  await assert.rejects(readFile(join(workspace.root, "transactions/pending.json")), {
    code: "ENOENT",
  });
  const reopened = new PlanningService(await openWorkspace(root));
  assert.equal((await reopened.memberships(task.id)).items[0]?.planId, source.id);
  const reduced = await reopened.changeStage(
    target.id,
    {
      action: "update",
      stage: "stage-0",
      fields: { title: "Уточнённый этап", outcome: "", completionConditions: "" },
      ifRevision: targetRevision,
      requestId: "reduce",
    },
    "agent",
  );
  const retry = { ...command, targetRevision: reduced.revision };
  const saved = await reopened.transfer(source.id, retry, "agent");
  assert.deepEqual(await reopened.transfer(source.id, retry, "agent"), saved);
  assert.equal((await reopened.memberships(task.id)).items[0]?.planId, target.id);
});

test("старый формат: существующие задачи доступны, планирование требует явного перехода", async (t) => {
  const { workspace, plans, tasks } = await fixture(t, true);
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  await assert.rejects(plans.create({ title: "План", requestId: "plan" }, "agent"), {
    code: "STORAGE_MIGRATION_REQUIRED",
  });
  assert.equal((await tasks.get(task.id)).revision, task.revision);
  await new StorageService(workspace).migrate();
  assert.equal((await plans.create({ title: "План", requestId: "plan" }, "agent")).revision, 1);
  assert.equal((await tasks.get(task.id)).id, task.id);
});
