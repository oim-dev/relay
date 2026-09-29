import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import lockfile from "proper-lockfile";
import { productOverviewSchema } from "@relay/contracts/entities/product";
import type { ProductOverview } from "@relay/contracts/entities/product";
import { ProductQueries } from "../src/application/product/queries.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { saveProjectSettings } from "../src/application/project-settings/service.js";
import { BoardRepository } from "../src/storage/boards.js";
import { projectSettings } from "../src/storage/project-settings.js";
import type { ProductMutation } from "../src/domain/product.js";
import { fixture, legacyFixture } from "./helpers/workspace.js";

/** Сервисы одного временного проекта; рабочая база пользователя не используется. */
async function project(t: TestContext) {
  const { workspace } = await fixture(t);
  const product = new ProductQueries(workspace);
  const tasks = new BoardTasksService(workspace);
  const plans = new PlanningService(workspace);
  const releases = new ReleasesService(workspace);
  const id = () => randomUUID();
  const write = (fields: ProductMutation["fields"]) =>
    product.mutate({ action: "create", requestId: id(), fields }, "agent");
  const task = (board: string, column: string, extra: Record<string, unknown> = {}) =>
    tasks.create(
      { board, column: column as "inbox", title: `Задача ${column}`, requestId: id(), ...extra },
      "agent",
    );
  const move = async (ref: string, column: string) => {
    const current = await tasks.get(ref);
    return tasks.move(
      ref,
      { column: column as "done", ifRevision: current.revision, requestId: id() },
      "agent",
    );
  };
  const document = (
    name: string,
    extra: {
      documentStatus?: "draft" | "active" | "archived";
      pinned?: boolean;
      sectionId?: string | null;
    } = {},
  ) =>
    write({
      kind: "document",
      name,
      summary: `Кратко: ${name}`,
      body: `# ${name}\n\nТекст.\n`,
      documentKind: "description",
      links: [],
      ...extra,
    });
  /** План с одним этапом и заданными задачами; при необходимости начат или закрыт. */
  const plan = async (
    title: string,
    taskIds: string[],
    finalState: "draft" | "active" | "completed" | "cancelled" = "draft",
  ) => {
    const created = await plans.create({ title, goal: `Цель: ${title}`, requestId: id() }, "agent");
    const stage = await plans.changeStage(
      created.id,
      {
        action: "create",
        fields: { title: "Этап" },
        ifRevision: created.revision,
        requestId: id(),
      },
      "agent",
    );
    let revision = stage.revision;
    if (taskIds.length)
      revision = (
        await plans.changeTasks(
          created.id,
          { stage: stage.stageId!, add: taskIds, ifRevision: revision, requestId: id() },
          "agent",
        )
      ).revision;
    if (finalState === "active")
      revision = (
        await plans.transition(
          created.id,
          { action: "start", ifRevision: revision, requestId: id() },
          "agent",
        )
      ).revision;
    if (finalState === "completed" || finalState === "cancelled")
      revision = (
        await plans.transition(
          created.id,
          {
            action: finalState === "completed" ? "complete" : "cancel",
            result: "Итог",
            ifRevision: revision,
            requestId: id(),
          },
          "agent",
        )
      ).revision;
    return { id: created.id, stageId: stage.stageId!, revision };
  };
  const overview = async () => productOverviewSchema.parse(await product.overview());
  return {
    workspace,
    product,
    tasks,
    plans,
    releases,
    id,
    write,
    task,
    move,
    document,
    plan,
    overview,
  };
}

const zeroColumns = { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 };

test("O-01: пустой проект — нули, пустые подборки, отсутствующий паспорт и системные доски", async (t) => {
  const { workspace, overview } = await project(t);
  const first = await overview();
  const { snapshot } = first;
  const settings = projectSettings(workspace.config, workspace.configPath);
  assert.deepEqual(snapshot.project, {
    id: workspace.config.projectId ?? null,
    name: settings.name,
    slug: settings.slug,
  });
  assert.deepEqual(snapshot.passport, { state: "missing" });
  assert.deepEqual(first.items, []);
  assert.deepEqual(first.readiness, []);
  assert.match(first.snapshotVersion, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.boards.byKind, { product: 1, application: 0, infrastructure: 1 });
  assert.deepEqual(
    snapshot.boards.catalog.items.map((board) => [board.kind, board.tasks]),
    [
      ["product", { total: 0, open: 0 }],
      ["infrastructure", { total: 0, open: 0 }],
    ],
  );
  assert.deepEqual(snapshot.tasks, {
    total: 0,
    byColumn: zeroColumns,
    completed: 0,
    doneWithOpenObligations: 0,
    readyToStart: 0,
    blocked: 0,
    criteria: { total: 0, completed: 0, pending: 0, tasksWithPending: 0 },
  });
  const empty = { total: 0, shown: 0, hasMore: false, items: [] };
  assert.deepEqual(snapshot.attention, { inProgress: empty, review: empty, blocked: empty });
  assert.deepEqual(snapshot.documents.byStatus, { draft: 0, active: 0, archived: 0 });
  assert.equal(snapshot.documents.total, 0);
  assert.equal(snapshot.documents.sections.total, 5);
  assert.ok(snapshot.documents.sections.items.every((section) => section.documents === 0));
  assert.deepEqual(snapshot.documents.pinnedActive, empty);
  assert.deepEqual(snapshot.plans, {
    total: 0,
    byStatus: { draft: 0, active: 0, completed: 0, cancelled: 0 },
    completedNotReady: 0,
    active: empty,
  });
  assert.deepEqual(snapshot.releases, {
    total: 0,
    byStatus: { planned: 0, released: 0, cancelled: 0 },
    upcoming: empty,
    recent: empty,
  });
  const zeroKnowledge = { none: 0, partial: 0, done: 0 };
  assert.deepEqual(snapshot.knowledge.features, { total: 0, byStatus: zeroKnowledge });
  assert.deepEqual(snapshot.knowledge.featureImplementations, {
    total: 0,
    active: 0,
    withdrawn: 0,
    byStatus: zeroKnowledge,
  });
  // Повторное чтение неизменного состояния сохраняет обе версии; generatedAt в них не входит.
  const second = await overview();
  assert.equal(second.snapshotVersion, first.snapshotVersion);
  assert.equal(second.version, first.version);
});

test("O-01: паспорт без summary даёт фрагмент описания, заполненный — summary; запись не меняется", async (t) => {
  const { product, write, overview } = await project(t);
  const description = `## Цель\n\n${"Длинное описание продукта. ".repeat(40)}`;
  const saved = await write({ kind: "passport", name: "Relay", summary: "", description });
  const before = await product.entity(saved.id);
  const { snapshot } = await overview();
  assert.equal(snapshot.passport.state, "no-summary");
  assert.ok(snapshot.passport.state === "no-summary");
  assert.equal(snapshot.passport.name, "Relay");
  assert.equal(snapshot.passport.excerpt.truncated, true);
  assert.equal([...snapshot.passport.excerpt.text].length <= 600, true);
  assert.ok(description.startsWith(snapshot.passport.excerpt.text));
  assert.deepEqual(await product.entity(saved.id), before);
  await product.mutate(
    {
      action: "update",
      id: saved.id,
      ifRevision: saved.revision,
      requestId: randomUUID(),
      fields: { kind: "passport", name: "Relay", summary: "Кратко", description },
    },
    "agent",
  );
  const filled = (await overview()).snapshot.passport;
  assert.equal(filled.state, "filled");
  assert.ok(filled.state === "filled");
  assert.equal(filled.summary, "Кратко");
  assert.equal(filled.revision, saved.revision + 1);
});

test("O-01: прежний формат без планирования читается без ложных ошибок, планы и релизы — нули", async (t) => {
  const { workspace } = await legacyFixture(t);
  const result = productOverviewSchema.parse(await new ProductQueries(workspace).overview());
  assert.equal(result.snapshot.plans.total, 0);
  assert.equal(result.snapshot.releases.total, 0);
  assert.equal(result.snapshot.boards.total, 2);
});

test("O-02: точные totals знаний и досок; снятые FI/SI и технические scope учтены отдельно", async (t) => {
  const { product, write, task, overview } = await project(t);
  const featureA = await write({
    kind: "feature",
    name: "Поиск",
    summary: "",
    description: "Искать",
  });
  const featureB = await write({
    kind: "feature",
    name: "Заказ",
    summary: "",
    description: "Заказ",
  });
  const scenarioA = await write({
    kind: "scenario",
    featureId: featureA.id,
    name: "Найти",
    description: "Шаги",
  });
  await write({ kind: "scenario", featureId: featureB.id, name: "Оформить", description: "Шаги" });
  const web = await write({
    kind: "application",
    slug: "web",
    name: "Web",
    summary: "",
    description: "Клиент",
    type: "frontend",
  });
  await write({
    kind: "application",
    slug: "api",
    name: "API",
    summary: "",
    description: "Сервер",
    type: "backend",
  });
  const contract = (featureId: string, scenarioId: string | null, title: string) => ({
    featureId,
    scenarioId,
    title,
    description: `Вклад: ${title}`,
    status: "none" as const,
  });
  await product.mutate(
    {
      action: "create",
      requestId: randomUUID(),
      ifVersion: (await product.state()).version,
      fields: {
        kind: "scope",
        applicationId: web.id,
        contracts: [
          contract(featureA.id, null, "FI поиска"),
          contract(featureA.id, scenarioA.id, "SI поиска"),
          contract(featureB.id, null, "FI заказа"),
        ],
      },
    },
    "agent",
  );
  // Замена состава без FI заказа снимает реализацию, но сохраняет её для истории.
  const state = await product.state();
  const scope = state.records.find((record) => record.fields.kind === "scope")!;
  assert.ok(scope.fields.kind === "scope");
  await product.mutate(
    {
      action: "update",
      id: scope.id,
      ifRevision: scope.revision,
      ifVersion: state.version,
      requestId: randomUUID(),
      fields: {
        kind: "scope",
        applicationId: web.id,
        contracts: scope.fields.contracts
          .filter((entry) => entry.featureId === featureA.id)
          .map(({ id: _id, active: _active, basis: _basis, ...entry }) => ({ ...entry })),
      },
    },
    "agent",
  );
  const after = await product.state();
  const fiSearch = after.records
    .flatMap((record) => (record.fields.kind === "scope" ? record.fields.contracts : []))
    .find((entry) => entry.active && entry.scenarioId === null)!;
  await task("web", "done", { productLinks: [{ kind: "implementation", id: fiSearch.id }] });
  const { snapshot, items } = await overview();
  assert.deepEqual(snapshot.knowledge.applications, {
    total: 2,
    byType: { frontend: 1, backend: 1, internal: 0 },
  });
  assert.equal(snapshot.knowledge.features.total, 2);
  assert.equal(snapshot.knowledge.scenarios.total, 2);
  // Задача FI выполнена, но SI того же приложения без работ: по правилу Core FI частично готова.
  assert.deepEqual(snapshot.knowledge.featureImplementations, {
    total: 2,
    active: 1,
    withdrawn: 1,
    byStatus: { none: 0, partial: 1, done: 0 },
  });
  assert.deepEqual(snapshot.knowledge.scenarioImplementations, {
    total: 1,
    active: 1,
    withdrawn: 0,
    byStatus: { none: 1, partial: 0, done: 0 },
  });
  // Готовность требований совпадает с действующим расчётом Core, а не с колонкой.
  const expected = { none: 0, partial: 0, done: 0 };
  for (const entry of (await product.state()).readiness)
    if (entry.id === featureA.id || entry.id === featureB.id) expected[entry.status]++;
  assert.deepEqual(snapshot.knowledge.features.byStatus, expected);
  assert.equal(snapshot.knowledge.features.byStatus.none, 1, "у снятой FI заказа нет работ");
  // Технический scope остаётся в прежней карте, но не является пользовательской сущностью.
  assert.equal(items.filter((item) => item.kind === "scope").length, 1);
  assert.deepEqual(snapshot.boards.byKind, { product: 1, application: 2, infrastructure: 1 });
  assert.equal(snapshot.boards.total, 4);
  assert.deepEqual(
    snapshot.boards.catalog.items.map((board) => [board.slug, board.tasks.total, board.tasks.open]),
    [
      ["product", 0, 0],
      ["web", 1, 0],
      ["api", 0, 0],
      ["infrastructure", 0, 0],
    ],
  );
  assert.equal(snapshot.boards.catalog.items[1]!.applicationId, web.id);
});

test("O-03/O-04: шесть колонок, повторно открытое обязательство, блокеры, готовность и критерии", async (t) => {
  const { tasks, task, move, overview, id } = await project(t);
  const inbox = await task("product", "inbox");
  const ready = await task("product", "ready");
  const blockedReady = await task("product", "ready", { dependencies: [inbox.id] });
  const progress = await task("product", "in-progress");
  const review = await task("infrastructure", "review");
  const cancelled = await task("product", "cancelled", {
    acceptanceCriteria: [{ title: "Не считается" }],
  });
  const waitsCancelled = await task("product", "inbox", { dependencies: [cancelled.id] });
  const parent = await task("product", "inbox");
  const child = await task("product", "done", { parentId: parent.id });
  await move(parent.id, "done");
  const doneClean = await task("product", "done");
  let snapshot = (await overview()).snapshot;
  assert.equal(snapshot.tasks.completed, 3);
  assert.equal(snapshot.tasks.doneWithOpenObligations, 0);
  // Повторное открытие подзадачи: колонка done сохраняется, фактическое выполнение — нет.
  await move(child.id, "in-progress");
  const withCriteria = await tasks.get(progress.id);
  const added = await tasks.changeCriterion(
    progress.id,
    { action: "add", title: "Первый", ifRevision: withCriteria.revision, requestId: id() },
    "agent",
  );
  const second = await tasks.changeCriterion(
    progress.id,
    { action: "add", title: "Второй", ifRevision: added.revision, requestId: id() },
    "agent",
  );
  await tasks.changeCriterion(
    progress.id,
    {
      action: "complete",
      criterionId: added.criterionId!,
      completed: true,
      ifRevision: second.revision,
      requestId: id(),
    },
    "agent",
  );
  const result = await overview();
  snapshot = result.snapshot;
  assert.deepEqual(snapshot.tasks.byColumn, {
    inbox: 2,
    ready: 2,
    "in-progress": 2,
    review: 1,
    done: 2,
    cancelled: 1,
  });
  assert.equal(snapshot.tasks.total, 10);
  assert.equal(
    Object.values(snapshot.tasks.byColumn).reduce((sum, value) => sum + value, 0),
    snapshot.tasks.total,
  );
  assert.equal(snapshot.tasks.completed, 1, "только чистая done-задача фактически выполнена");
  assert.equal(snapshot.tasks.doneWithOpenObligations, 1);
  assert.equal(snapshot.tasks.readyToStart, 1);
  assert.equal(snapshot.tasks.blocked, 3, "ready с зависимостью, ожидание отмены и родитель");
  assert.deepEqual(snapshot.tasks.criteria, {
    total: 2,
    completed: 1,
    pending: 1,
    tasksWithPending: 1,
  });
  // Выборки внимания: текущие, проверка и блокеры с адресными причинами.
  assert.deepEqual(
    snapshot.attention.inProgress.items.map((entry) => entry.id).sort(),
    [child.id, progress.id].sort(),
  );
  const current = snapshot.attention.inProgress.items.find((entry) => entry.id === progress.id)!;
  assert.deepEqual(current.acceptance, { total: 2, completed: 1 });
  assert.equal(current.board.slug, "product");
  assert.deepEqual(
    snapshot.attention.review.items.map((entry) => [entry.id, entry.board.slug]),
    [[review.id, "infrastructure"]],
  );
  const blocked = snapshot.attention.blocked;
  assert.equal(blocked.total, snapshot.tasks.blocked);
  // Порядок по смысловому приоритету колонки: ready раньше inbox, inbox раньше done.
  assert.deepEqual(
    blocked.items.map((entry) => entry.column),
    ["ready", "inbox", "done"],
  );
  const reasons = Object.fromEntries(
    blocked.items.map((entry) => [
      entry.id,
      entry.blockers.items.map((reason) => [reason.id, reason.relation, reason.column]),
    ]),
  );
  assert.deepEqual(reasons[blockedReady.id], [[inbox.id, "dependency", "inbox"]]);
  assert.deepEqual(reasons[waitsCancelled.id], [[cancelled.id, "dependency", "cancelled"]]);
  assert.deepEqual(reasons[parent.id], [[child.id, "subtask", "in-progress"]]);
  const parentCard = blocked.items.find((entry) => entry.id === parent.id)!;
  assert.equal(parentCard.completed, false);
  assert.equal(parentCard.column, "done");
  assert.ok(![ready.id, doneClean.id].some((ref) => blocked.items.some((e) => e.id === ref)));
});

test("O-05: документы всех состояний, pinned и разделы без дублей; прикрепление не меняет готовность", async (t) => {
  const { product, write, document, overview } = await project(t);
  const feature = await write({ kind: "feature", name: "Фича", summary: "", description: "Текст" });
  await document("Черновик", { documentStatus: "draft", sectionId: "product" });
  const pinnedActive = await document("Правила", {
    documentStatus: "active",
    pinned: true,
    sectionId: "architecture",
  });
  await document("Действующий", { documentStatus: "active", sectionId: null });
  await document("Архив", { documentStatus: "archived", pinned: true, sectionId: "product" });
  const before = await overview();
  const { documents } = before.snapshot;
  assert.equal(documents.total, 4);
  assert.deepEqual(documents.byStatus, { draft: 1, active: 2, archived: 1 });
  assert.equal(documents.pinned, 2);
  assert.equal(documents.sections.unsectioned, 1);
  assert.deepEqual(
    documents.sections.items.map((section) => [section.id, section.documents]),
    [
      ["product", 2],
      ["architecture", 1],
      ["development", 0],
      ["infrastructure", 0],
      ["processes", 0],
    ],
  );
  assert.equal(
    documents.sections.items.reduce((sum, section) => sum + section.documents, 0) +
      documents.sections.unsectioned,
    documents.total,
  );
  assert.deepEqual(
    documents.pinnedActive.items.map((entry) => [entry.id, entry.sectionId]),
    [[pinnedActive.id, "architecture"]],
  );
  // Связь документа с фичей меняет срез, но не готовность требований.
  const current = await product.entity(pinnedActive.id);
  assert.ok(current.fields.kind === "document");
  await product.mutate(
    {
      action: "update",
      id: pinnedActive.id,
      ifRevision: current.revision,
      requestId: randomUUID(),
      fields: {
        kind: "document",
        name: current.fields.name,
        summary: current.fields.summary,
        body: current.fields.body,
        documentKind: current.fields.documentKind,
        links: [{ kind: "feature", id: feature.id }],
      },
    },
    "agent",
  );
  const after = await overview();
  assert.notEqual(after.snapshotVersion, before.snapshotVersion);
  assert.deepEqual(after.readiness, before.readiness);
  assert.deepEqual(after.snapshot.knowledge, before.snapshot.knowledge);
  assert.equal(after.snapshot.documents.total, 4);
});

test("O-06: планы и релизы всех состояний; собственный статус отличается от фактической готовности", async (t) => {
  const { releases, task, move, plan, overview, id } = await project(t);
  const done = async () => (await task("product", "done")).id;
  await plan("Черновик", []);
  const activeTask = await done();
  const activeOpen = (await task("product", "in-progress")).id;
  const active = await plan("Активный", [activeTask, activeOpen], "active");
  const completed = await plan("Завершённый", [await done()], "completed");
  const divergedTask = await done();
  const diverged = await plan("Разошедшийся", [divergedTask], "completed");
  await plan("Отменённый", [], "cancelled");
  const release = (title: string, planIds: string[], plannedFor = "") =>
    releases.create({ title, version: title, planIds, plannedFor, requestId: id() }, "agent");
  const releasedEntry = await release("1.0", [diverged.id]);
  await releases.transition(
    releasedEntry.id,
    { action: "release", ifRevision: releasedEntry.revision, requestId: id() },
    "agent",
  );
  const later = await release("1.2", [completed.id], "2026-12-01");
  const sooner = await release("1.1", [completed.id], "2026-10-01");
  const undated = await release("1.3", [active.id]);
  const cancelledEntry = await release("0.9", [completed.id]);
  await releases.transition(
    cancelledEntry.id,
    { action: "cancel", ifRevision: cancelledEntry.revision, requestId: id() },
    "agent",
  );
  // После выпуска задача снова открыта: план остаётся completed, но состав не выполнен.
  await move(divergedTask, "in-progress");
  const { snapshot } = await overview();
  assert.deepEqual(snapshot.plans.byStatus, { draft: 1, active: 1, completed: 2, cancelled: 1 });
  assert.equal(snapshot.plans.total, 5);
  assert.equal(snapshot.plans.completedNotReady, 1);
  assert.equal(snapshot.plans.active.total, 1);
  const card = snapshot.plans.active.items[0]!;
  assert.equal(card.id, active.id);
  assert.equal(card.status, "active");
  assert.equal(card.ready, false);
  assert.deepEqual(card.goal, { text: "Цель: Активный", truncated: false });
  assert.deepEqual([card.counts.total, card.counts.completed, card.counts.active], [2, 1, 1]);
  assert.deepEqual(card.stages, { total: 1, completed: 0 });
  assert.equal(card.nextStage?.id, active.stageId);
  assert.deepEqual(snapshot.releases.byStatus, { planned: 3, released: 1, cancelled: 1 });
  assert.deepEqual(
    snapshot.releases.upcoming.items.map((entry) => [entry.id, entry.plannedFor]),
    [
      [sooner.id, "2026-10-01"],
      [later.id, "2026-12-01"],
      [undated.id, null],
    ],
  );
  assert.equal(snapshot.releases.upcoming.items[0]!.readiness.canRelease, true);
  assert.equal(snapshot.releases.upcoming.items[2]!.readiness.ready, 0);
  const released = snapshot.releases.recent.items[0]!;
  assert.equal(released.id, releasedEntry.id);
  assert.equal(released.status, "released");
  assert.ok(released.releasedAt);
  assert.deepEqual([released.readiness.ready, released.readiness.total], [0, 1]);
  assert.equal(released.readiness.canRelease, false);
  assert.equal("applicationId" in released, false);
});

test("O-07: более 100 задач и документов, более 5 планов — полные totals и явное продолжение", async (t) => {
  const { task, document, plan, overview } = await project(t);
  const inProgress: string[] = [];
  for (let index = 0; index < 105; index++) {
    const column = index % 15 === 0 ? "in-progress" : index % 2 ? "done" : "inbox";
    const created = await task("product", column);
    if (column === "in-progress") inProgress.push(created.id);
  }
  for (let index = 0; index < 102; index++)
    await document(`Документ ${index}`, {
      documentStatus: index % 3 === 0 ? "archived" : "active",
      pinned: index % 10 === 1,
    });
  const planTasks: string[] = [];
  for (let index = 0; index < 7; index++) {
    const taskId = (await task("infrastructure", "ready")).id;
    planTasks.push(taskId);
    await plan(`План ${index}`, [taskId], "active");
  }
  const { snapshot } = await overview();
  assert.equal(snapshot.tasks.total, 112);
  assert.equal(snapshot.tasks.byColumn["in-progress"], 7);
  assert.equal(snapshot.tasks.byColumn.done, 49);
  assert.equal(snapshot.tasks.byColumn.inbox, 49);
  assert.equal(snapshot.tasks.byColumn.ready, 7);
  assert.deepEqual(snapshot.boards.catalog.items[0]!.tasks, { total: 105, open: 56 });
  const attention = snapshot.attention.inProgress;
  assert.deepEqual([attention.total, attention.shown, attention.hasMore], [7, 5, true]);
  // Порядок стабилен: новые изменения первыми, затем постоянный ID.
  const expectedOrder = [...inProgress].reverse().slice(0, 5);
  assert.deepEqual(
    attention.items.map((entry) => entry.id),
    expectedOrder,
  );
  assert.equal(snapshot.documents.total, 102);
  assert.deepEqual(snapshot.documents.byStatus, { draft: 0, active: 68, archived: 34 });
  assert.equal(snapshot.documents.pinned, 11);
  const pinned = snapshot.documents.pinnedActive;
  assert.equal(pinned.total, 8, "архивные закреплённые не попадают в подборку");
  assert.deepEqual([pinned.shown, pinned.hasMore], [5, true]);
  const plans = snapshot.plans.active;
  assert.deepEqual(
    [snapshot.plans.total, plans.total, plans.shown, plans.hasMore],
    [7, 7, 5, true],
  );
  const updated = plans.items.map((entry) => entry.updatedAt);
  assert.deepEqual(updated, [...updated].sort().reverse());
});

test("O-08: срез согласован при пересечении с записью, без ожидания по времени", async (t) => {
  const { task, overview, product } = await project(t);
  for (let index = 0; index < 3; index++) await task("product", "inbox");
  const before = await overview();
  const original = {
    all: BoardRepository.prototype.all,
    lock: lockfile.lock,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const readerInside = new Promise<void>((resolve) => (reached = resolve));
  let attempted!: () => void;
  const writerAttempted = new Promise<void>((resolve) => (attempted = resolve));
  let armed = true;
  let gateClosed = false;
  t.after(() => {
    BoardRepository.prototype.all = original.all;
    lockfile.lock = original.lock;
  });
  // Читатель останавливается внутри блокировки после чтения записей и задач.
  BoardRepository.prototype.all = async function (this: BoardRepository) {
    if (armed) {
      armed = false;
      gateClosed = true;
      reached();
      await gate;
    }
    return original.all.call(this);
  };
  // Писатель подтверждает попытку захвата блокировки, пока читатель её держит.
  lockfile.lock = (async (...args: Parameters<typeof lockfile.lock>) => {
    if (gateClosed) attempted();
    return original.lock(...args);
  }) as typeof lockfile.lock;
  const reading = product.overview();
  await readerInside;
  let written = false;
  const writing = task("product", "review").then((saved) => {
    written = true;
    return saved;
  });
  await writerAttempted;
  assert.equal(written, false);
  gateClosed = false;
  release();
  const during = productOverviewSchema.parse(await reading);
  await writing;
  // Весь срез принадлежит состоянию до записи: версия и все блоки совпадают.
  assert.equal(during.snapshotVersion, before.snapshotVersion);
  assert.deepEqual(during.snapshot, before.snapshot);
  assert.equal(
    during.snapshot.boards.catalog.items.reduce((sum, board) => sum + board.tasks.total, 0),
    during.snapshot.tasks.total,
  );
  const after = await overview();
  assert.equal(after.snapshot.tasks.total, before.snapshot.tasks.total + 1);
  assert.equal(after.snapshot.tasks.byColumn.review, 1);
  assert.notEqual(after.snapshotVersion, before.snapshotVersion);
  assert.equal(after.version, before.version, "задача не меняет версию продуктового состава");
  assert.equal((await overview()).snapshotVersion, after.snapshotVersion);
});

test("O-09: каждое изменение данных среза меняет snapshotVersion; неизменное чтение её сохраняет", async (t) => {
  const context = await project(t);
  const { product, tasks, plans, releases, write, task, document, plan, overview, id, workspace } =
    context;
  const passport = await write({ kind: "passport", name: "P", summary: "S", description: "D" });
  const feature = await write({ kind: "feature", name: "F", summary: "", description: "D" });
  const app = await write({
    kind: "application",
    slug: "web",
    name: "Web",
    summary: "",
    description: "D",
    type: "frontend",
  });
  const scope = await product.mutate(
    {
      action: "create",
      requestId: id(),
      ifVersion: (await product.state()).version,
      fields: {
        kind: "scope",
        applicationId: app.id,
        contracts: [
          {
            featureId: feature.id,
            scenarioId: null,
            title: "FI",
            description: "Вклад",
            status: "none",
          },
        ],
      },
    },
    "agent",
  );
  const withCriterion = await task("product", "ready", { acceptanceCriteria: [{ title: "К" }] });
  const doc = await document("Док", { documentStatus: "active" });
  const planTask = await task("product", "done");
  const workPlan = await plan("План", [planTask.id], "completed");
  const releaseEntry = await releases.create(
    { title: "R", version: "1", planIds: [workPlan.id], requestId: id() },
    "agent",
  );
  const draft = await plan("Черновик", []);
  const revision = async (ref: string) => (await tasks.get(ref)).revision;
  const cases: [string, boolean, () => Promise<unknown>][] = [
    [
      "задача",
      false,
      async () =>
        tasks.update(
          withCriterion.id,
          { title: "Новое", ifRevision: await revision(withCriterion.id), requestId: id() },
          "agent",
        ),
    ],
    [
      "критерий",
      false,
      async () => {
        const current = await tasks.get(withCriterion.id);
        const criteria = await tasks.listCriteria(withCriterion.id);
        return tasks.changeCriterion(
          withCriterion.id,
          {
            action: "complete",
            criterionId: criteria.items[0]!.id,
            completed: true,
            ifRevision: current.revision,
            requestId: id(),
          },
          "agent",
        );
      },
    ],
    [
      "перенос задачи на другую доску",
      false,
      async () =>
        tasks.move(
          withCriterion.id,
          {
            board: "infrastructure",
            column: "ready",
            ifRevision: await revision(withCriterion.id),
            requestId: id(),
          },
          "agent",
        ),
    ],
    [
      "доска (новое приложение)",
      true,
      () =>
        write({
          kind: "application",
          slug: "api",
          name: "API",
          summary: "",
          description: "D",
          type: "backend",
        }),
    ],
    [
      "документ",
      true,
      async () => {
        const current = await product.entity(doc.id);
        assert.ok(current.fields.kind === "document");
        return product.mutate(
          {
            action: "update",
            id: doc.id,
            ifRevision: current.revision,
            requestId: id(),
            fields: {
              kind: "document",
              name: "Док 2",
              summary: current.fields.summary,
              body: current.fields.body,
              documentKind: current.fields.documentKind,
              links: [],
            },
          },
          "agent",
        );
      },
    ],
    [
      "реализация",
      true,
      async () => {
        const state = await product.state();
        const record = state.records.find((entry) => entry.id === scope.id)!;
        assert.ok(record.fields.kind === "scope");
        return product.mutate(
          {
            action: "update",
            id: scope.id,
            ifRevision: record.revision,
            ifVersion: state.version,
            requestId: id(),
            fields: {
              kind: "scope",
              applicationId: app.id,
              contracts: record.fields.contracts.map(
                ({ id: _id, active: _active, basis: _basis, ...entry }) => ({
                  ...entry,
                  title: "FI 2",
                }),
              ),
            },
          },
          "agent",
        );
      },
    ],
    [
      "план",
      false,
      async () =>
        plans.update(
          draft.id,
          {
            summary: "Новое описание",
            ifRevision: (await plans.get(draft.id)).revision,
            requestId: id(),
          },
          "agent",
        ),
    ],
    [
      "этап",
      false,
      async () =>
        plans.changeStage(
          draft.id,
          {
            action: "update",
            stage: draft.stageId,
            fields: { title: "Этап 2" },
            ifRevision: (await plans.get(draft.id)).revision,
            requestId: id(),
          },
          "agent",
        ),
    ],
    [
      "релиз",
      false,
      async () =>
        releases.update(
          releaseEntry.id,
          {
            title: "R2",
            version: "1",
            status: "planned",
            planIds: [workPlan.id],
            ifRevision: (await releases.get(releaseEntry.id)).revision,
            requestId: id(),
          },
          "agent",
        ),
    ],
    [
      "имя проекта",
      false,
      async () => {
        const settings = projectSettings(workspace.config, workspace.configPath);
        return saveProjectSettings(workspace, {
          name: "Новое имя проекта",
          slug: settings.slug,
          ifRevision: settings.revision,
        });
      },
    ],
    [
      "паспорт",
      true,
      () =>
        product.mutate(
          {
            action: "update",
            id: passport.id,
            ifRevision: passport.revision,
            requestId: id(),
            fields: { kind: "passport", name: "P", summary: "S2", description: "D" },
          },
          "agent",
        ),
    ],
  ];
  for (const [name, changesProduct, change] of cases)
    await t.test(name, async () => {
      const before: ProductOverview = await overview();
      await change();
      const after = await overview();
      assert.notEqual(after.snapshotVersion, before.snapshotVersion, `${name}: версия среза`);
      assert.equal(
        after.version !== before.version,
        changesProduct,
        `${name}: версия продуктового состава`,
      );
      const again = await overview();
      assert.equal(again.snapshotVersion, after.snapshotVersion, `${name}: повторное чтение`);
    });
  assert.equal((await overview()).snapshot.project.name, "Новое имя проекта");
});
