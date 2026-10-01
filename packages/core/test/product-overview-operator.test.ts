import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  productOverviewMetricPageSchema,
  productOverviewSchema,
} from "@relay/contracts/entities/product";
import type {
  ProductOverviewMetricPage,
  ProductOverviewMetricQuery,
} from "@relay/contracts/entities/product";
import { ProductQueries } from "../src/application/product/queries.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import {
  buildOverviewWithIndex,
  overviewSnapshotVersion,
  readOverviewSources,
} from "../src/application/product/overview.js";
import { overviewCompletion } from "../src/application/product/operator.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { BoardRepository } from "../src/storage/boards.js";
import { BoardTaskRepository } from "../src/storage/board-tasks.js";
import type { ProductMutation } from "../src/domain/product.js";
import type { WorkPlan } from "@relay/contracts/planning";
import { fixture, legacyFixture } from "./helpers/workspace.js";

/** Сервисы одного временного проекта; рабочая база пользователя не используется. */
async function project(t: TestContext) {
  const { workspace, root } = await fixture(t);
  const product = new ProductQueries(workspace);
  const tasks = new BoardTasksService(workspace);
  const plans = new PlanningService(workspace);
  const releases = new ReleasesService(workspace);
  const id = () => randomUUID();
  const write = (fields: ProductMutation["fields"]) =>
    product.mutate({ action: "create", requestId: id(), fields }, "agent");
  const application = (slug: string) =>
    write({
      kind: "application",
      slug,
      name: slug,
      summary: "",
      description: `Приложение ${slug}`,
      type: "frontend",
    });
  const task = async (board: string, column: string, extra: Record<string, unknown> = {}) =>
    (
      await tasks.create(
        { board, column: column as "inbox", title: `Задача ${column}`, requestId: id(), ...extra },
        "agent",
      )
    ).id;
  const move = async (ref: string, column: string, board?: string) =>
    tasks.move(
      ref,
      {
        column: column as "done",
        ...(board ? { board } : {}),
        ifRevision: (await tasks.get(ref)).revision,
        requestId: id(),
      },
      "agent",
    );
  const completeCriterion = async (ref: string, index: number) => {
    const criteria = await tasks.listCriteria(ref);
    return tasks.changeCriterion(
      ref,
      {
        action: "complete",
        criterionId: criteria.items[index]!.id,
        completed: true,
        ifRevision: (await tasks.get(ref)).revision,
        requestId: id(),
      },
      "agent",
    );
  };
  const link = async (ref: string, target: string, relation: "depends-on" | "parent") =>
    tasks.link(
      ref,
      { target, relation, ifRevision: (await tasks.get(ref)).revision, requestId: id() },
      "agent",
    );
  /** План с заданными этапами; каждый этап — явный список ID задач. */
  const plan = async (
    title: string,
    stages: string[][],
    finalState: "draft" | "active" | "completed" | "cancelled" = "draft",
  ) => {
    const created = await plans.create({ title, goal: `Цель: ${title}`, requestId: id() }, "agent");
    let revision = created.revision;
    const stageIds: string[] = [];
    for (const taskIds of stages) {
      const stage = await plans.changeStage(
        created.id,
        { action: "create", fields: { title: "Этап" }, ifRevision: revision, requestId: id() },
        "agent",
      );
      revision = stage.revision;
      stageIds.push(stage.stageId!);
      if (taskIds.length)
        revision = (
          await plans.changeTasks(
            created.id,
            { stage: stage.stageId!, add: taskIds, ifRevision: revision, requestId: id() },
            "agent",
          )
        ).revision;
    }
    if (finalState === "active")
      await plans.transition(
        created.id,
        { action: "start", ifRevision: revision, requestId: id() },
        "agent",
      );
    if (finalState === "completed" || finalState === "cancelled")
      await plans.transition(
        created.id,
        {
          action: finalState === "completed" ? "complete" : "cancel",
          result: "Итог",
          ifRevision: revision,
          requestId: id(),
        },
        "agent",
      );
    return { id: created.id, stageIds };
  };
  const release = async (
    title: string,
    planIds: string[],
    plannedFor = "",
    action?: "release" | "cancel",
  ) => {
    const created = await releases.create(
      { title, version: title, planIds, plannedFor, requestId: id() },
      "agent",
    );
    if (action)
      await releases.transition(
        created.id,
        { action, ifRevision: created.revision, requestId: id() },
        "agent",
      );
    return created.id;
  };
  const overview = async () => productOverviewSchema.parse(await product.overview());
  const metric = async (query: ProductOverviewMetricQuery): Promise<ProductOverviewMetricPage> =>
    productOverviewMetricPageSchema.parse(await product.overviewMetric(query));
  /** Все страницы метрики подряд; проверяет отсутствие пропусков и повторов. */
  const allPages = async (query: ProductOverviewMetricQuery) => {
    const items: { id: string }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let total = -1;
    do {
      const page = await metric({ ...query, ...(cursor ? { cursor } : {}) });
      total = page.total;
      items.push(...(page.items as { id: string }[]));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(items.length, total);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    return { ids: items.map((item) => item.id), pages, items };
  };
  return {
    workspace,
    root,
    product,
    tasks,
    plans,
    releases,
    id,
    application,
    task,
    move,
    completeCriterion,
    link,
    plan,
    release,
    overview,
    metric,
    allPages,
  };
}

type Project = Awaited<ReturnType<typeof project>>;

/**
 * Малая fixture с пересечениями. Ожидаемые числа выписаны вручную в тестах ниже,
 * а не вычисляются тем же алгоритмом.
 *
 * Доски: product (P), web (A), infrastructure (I), empty (E, без задач).
 * T1 review, критерий выполнен; T2 review, критерий не выполнен; T3 review → dep T6;
 * T4 review, ребёнок T7; T5 review без критериев; T6/T9/T18 in-progress;
 * T7/T11/T12/T13 ready (T11 → dep T12, T13 related T6); T8 inbox → dep T6 и T9,
 * T9 — одновременно ребёнок T8; T10 inbox → dep T11; T14 cancelled (блокер T15);
 * T15 done → dep T14; T16 cancelled → dep T6; T17, T19–T24 done выполнены.
 */
async function seed(p: Project) {
  const { application, task, move, completeCriterion, link, plan, release } = p;
  await application("web");
  await application("empty");
  const T14 = await task("web", "done");
  const T15 = await task("web", "done", { dependencies: [T14] });
  const T17 = await task("infrastructure", "done");
  const [T19, T20, T21, T22, T23, T24] = [
    await task("infrastructure", "done"),
    await task("infrastructure", "done"),
    await task("infrastructure", "done"),
    await task("infrastructure", "done"),
    await task("infrastructure", "done"),
    await task("infrastructure", "done"),
  ];
  const T18 = await task("web", "done");
  const T6 = await task("web", "in-progress");
  const T3 = await task("web", "review", { dependencies: [T6] });
  const T4 = await task("web", "review");
  const T7 = await task("web", "ready", { parentId: T4 });
  const T1 = await task("product", "review", { acceptanceCriteria: [{ title: "Проверено" }] });
  await completeCriterion(T1, 0);
  const T2 = await task("product", "review", {
    acceptanceCriteria: [{ title: "Первый" }, { title: "Второй" }],
  });
  await completeCriterion(T2, 0);
  const T5 = await task("web", "review");
  const T9 = await task("web", "in-progress");
  const T8 = await task("product", "inbox", { dependencies: [T6, T9] });
  await link(T9, T8, "parent");
  const T12 = await task("product", "ready");
  const T11 = await task("product", "ready", { dependencies: [T12] });
  const T10 = await task("product", "inbox", { dependencies: [T11] });
  const T13 = await task("product", "ready", { related: [T6] });
  const T16 = await task("web", "inbox", { dependencies: [T6] });
  await move(T16, "cancelled");
  await move(T14, "cancelled");

  const PL3 = await plan("PL3", [[T18, T17]], "completed");
  await move(T18, "in-progress");
  const PL1 = await plan("PL1", [[T6, T8], []], "active");
  const PL2 = await plan("PL2", [[T1]]);
  const PL4 = await plan("PL4", [[T2]], "cancelled");
  const PL5 = await plan("PL5", [[T19]], "active");
  const PL6 = await plan("PL6", []);
  const PL7 = await plan("PL7", [[T20], []]);
  const PL8 = await plan("PL8", [[T21]], "completed");
  const PL9 = await plan("PL9", [[T22]], "completed");
  const PL10 = await plan("PL10", [[T23]], "completed");
  const PL11 = await plan("PL11", [[T24]], "completed");

  const R1 = await release("R1", [PL8.id], "2026-10-10");
  const R2 = await release("R2", [PL9.id], "", "release");
  const R3 = await release("R3", [PL9.id]);
  const R4 = await release("R4", [PL10.id], "", "cancel");
  const R5 = await release("R5", [PL3.id]);
  const R6 = await release("R6", [PL1.id]);
  return {
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    T17,
    T18,
    T19,
    T20,
    T21,
    T22,
    T23,
    T24,
    PL1,
    PL2,
    PL3,
    PL4,
    PL5,
    PL6,
    PL7,
    PL8,
    PL9,
    PL10,
    PL11,
    R1,
    R2,
    R3,
    R4,
    R5,
    R6,
  };
}

/** Отпечаток всех файлов временного проекта: путь, размер и содержимое. */
async function storageDigest(root: string) {
  const hash = createHash("sha256");
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).sort(
    (left, right) =>
      join(left.parentPath, left.name).localeCompare(join(right.parentPath, right.name)),
  )) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest("hex");
}

const sorted = (ids: string[]) => [...ids].sort();
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

test("M-T01: пустой проект — все показатели оператора нулевые, системные доски пустые, чтение не пишет", async (t) => {
  const p = await project(t);
  const files = await storageDigest(p.root);
  const before = await p.overview();
  await p.metric({ metric: "board-work" });
  const again = await p.overview();
  assert.equal(await storageDigest(p.root), files, "чтение не меняет файлы хранилища");
  assert.equal(before.snapshotVersion, again.snapshotVersion);
  const operator = before.snapshot.operator;
  const empty = { total: 0, shown: 0, hasMore: false, items: [] };
  assert.deepEqual(operator.review, { total: 0, obligationsMet: empty, obligationsOpen: empty });
  assert.deepEqual(operator.blockerImpact, empty);
  assert.deepEqual(operator.unplannedWork, { ...empty, byColumn: { "in-progress": 0, review: 0 } });
  assert.deepEqual(operator.openPlansComplete, empty);
  assert.deepEqual(operator.releasePreparation, {
    readyReleases: empty,
    completedPlansOutsideReleases: empty,
  });
  // Факт: новый проект содержит две системные доски — продукта и инфраструктуры.
  assert.equal(operator.boardWork.remaining, 0);
  assert.equal(operator.boardWork.blockedRemaining, 0);
  assert.equal(operator.boardWork.boards.total, 2);
  for (const board of operator.boardWork.boards.items)
    assert.deepEqual(board.tasks, {
      total: 0,
      byColumn: { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 },
      completed: 0,
      remaining: 0,
      blockedRemaining: 0,
      readyToStart: 0,
    });
  // Пустой план не готов.
  await p.plan("Пустой", []);
  await p.plan("Пустой этап", [[]]);
  assert.equal((await p.overview()).snapshot.operator.openPlansComplete.total, 0);
  const page = await p.metric({ metric: "unplanned-work" });
  assert.deepEqual([page.total, page.items, page.nextCursor], [0, [], null]);
});

test("M-T01: прежний формат без планирования — работа вне планов равна исполняемой работе", async (t) => {
  const { workspace } = await legacyFixture(t);
  const product = new ProductQueries(workspace);
  const overview = productOverviewSchema.parse(await product.overview());
  assert.equal(overview.snapshot.operator.openPlansComplete.total, 0);
  assert.equal(overview.snapshot.operator.releasePreparation.readyReleases.total, 0);
  const page = await product.overviewMetric({ metric: "board-work" });
  assert.equal(page.total, overview.snapshot.boards.total);
});

test("M-T02…M-T08: точные значения M-01…M-06 на малой fixture", async (t) => {
  const p = await project(t);
  const f = await seed(p);
  const { snapshot } = await p.overview();
  const { operator, tasks } = snapshot;

  // Прежние показатели не меняют смысла.
  assert.equal(tasks.total, 24);
  assert.deepEqual(tasks.byColumn, {
    inbox: 2,
    ready: 4,
    "in-progress": 3,
    review: 5,
    done: 8,
    cancelled: 2,
  });
  assert.equal(tasks.completed, 7);
  assert.equal(tasks.doneWithOpenObligations, 1);
  assert.equal(tasks.readyToStart, 3);
  assert.equal(tasks.blocked, 7);

  // M-01: 5 = 2 + 3, причины из Core.
  assert.equal(operator.review.total, 5);
  assert.deepEqual(sorted(ids(operator.review.obligationsMet.items)), sorted([f.T1, f.T5]));
  assert.equal(operator.review.obligationsOpen.total, 3);
  const reasons = Object.fromEntries(
    operator.review.obligationsOpen.items.map((item) => [item.id, item.reasons]),
  );
  assert.deepEqual(reasons, {
    [f.T2]: ["CRITERION_INCOMPLETE"],
    [f.T3]: ["DEPENDENCY_INCOMPLETE"],
    [f.T4]: ["CHILD_INCOMPLETE"],
  });
  for (const item of operator.review.obligationsMet.items) assert.deepEqual(item.reasons, []);

  // M-02: прямые блокеры без дублей; related, отменённый потребитель и транзитивность не учитываются.
  assert.equal(operator.blockerImpact.total, 6);
  assert.equal(operator.blockerImpact.shown, 5);
  assert.equal(operator.blockerImpact.hasMore, true);
  const impact = await p.allPages({ metric: "blocker-impact", limit: 4 });
  assert.equal(impact.pages, 2);
  assert.deepEqual(impact.ids, [f.T6, ...sorted([f.T7, f.T9, f.T11, f.T12, f.T14])]);
  const affected = Object.fromEntries(
    (impact.items as unknown as ProductOverviewMetricPage["items"]).map((item) => {
      const entry = item as { id: string; column: string; affected: { total: number } };
      return [entry.id, [entry.affected.total, entry.column]];
    }),
  );
  assert.deepEqual(affected, {
    [f.T6]: [2, "in-progress"],
    [f.T7]: [1, "ready"],
    [f.T9]: [1, "in-progress"],
    [f.T11]: [1, "ready"],
    [f.T12]: [1, "ready"],
    [f.T14]: [1, "cancelled"],
  });
  const ofT6 = await p.allPages({ metric: "blocker-affected", blocker: f.T6, limit: 1 });
  assert.equal(ofT6.pages, 2);
  assert.deepEqual(sorted(ofT6.ids), sorted([f.T3, f.T8]));
  const ofT9 = await p.metric({ metric: "blocker-affected", blocker: f.T9 });
  assert.deepEqual(
    ofT9.items.map((item) => [item.id, (item as { relations: string[] }).relations]),
    [[f.T8, ["dependency", "subtask"]]],
  );
  assert.deepEqual(ids((await p.metric({ metric: "blocker-affected", blocker: f.T12 })).items), [
    f.T11,
  ]);
  // Блокер, который никого не задерживает, — нормальный пустой ответ.
  const none = await p.metric({ metric: "blocker-affected", blocker: f.T13 });
  assert.equal(none.total, 0);
  assert.equal(none.blocker?.id, f.T13);
  assert.equal(operator.boardWork.blockedRemaining, 6);

  // M-03: W = 8, вне открытых планов 6.
  assert.equal(operator.unplannedWork.total, 6);
  assert.deepEqual(operator.unplannedWork.byColumn, { "in-progress": 2, review: 4 });
  const unplanned = await p.allPages({ metric: "unplanned-work", limit: 4 });
  assert.equal(unplanned.pages, 2);
  assert.deepEqual(sorted(unplanned.ids), sorted([f.T9, f.T18, f.T2, f.T3, f.T4, f.T5]));

  // M-04: все доски, суммы совпадают с проектом, remaining не равен прежнему open.
  const boards = await new BoardRepository(p.workspace).all();
  const bySlug = Object.fromEntries(boards.map((board) => [board.slug, board.id]));
  const work = operator.boardWork;
  assert.equal(work.remaining, 15);
  assert.equal(work.boards.total, 4);
  assert.deepEqual(ids(work.boards.items), [
    bySlug.web!,
    bySlug.product!,
    ...sorted([bySlug.infrastructure!, bySlug.empty!]),
  ]);
  const board = (slug: string) => work.boards.items.find((item) => item.slug === slug)!.tasks;
  assert.deepEqual(board("web"), {
    total: 10,
    byColumn: { inbox: 0, ready: 1, "in-progress": 3, review: 3, done: 1, cancelled: 2 },
    completed: 0,
    remaining: 8,
    blockedRemaining: 3,
    readyToStart: 1,
  });
  assert.deepEqual(board("product"), {
    total: 7,
    byColumn: { inbox: 2, ready: 3, "in-progress": 0, review: 2, done: 0, cancelled: 0 },
    completed: 0,
    remaining: 7,
    blockedRemaining: 3,
    readyToStart: 2,
  });
  assert.equal(board("infrastructure").completed, 7);
  assert.equal(board("infrastructure").remaining, 0);
  assert.equal(board("empty").total, 0);
  const oldWeb = snapshot.boards.catalog.items.find((item) => item.slug === "web")!;
  assert.deepEqual(oldWeb.tasks, { total: 10, open: 7 });

  // M-05: только открытые планы с выполненным непустым составом.
  // Порядок: последнее изменение по убыванию — PL7 создан после запуска PL5.
  assert.deepEqual(ids(operator.openPlansComplete.items), [f.PL7.id, f.PL5.id]);
  const pl7 = operator.openPlansComplete.items.find((item) => item.id === f.PL7.id)!;
  assert.equal(pl7.status, "draft");
  assert.deepEqual(pl7.stages, { total: 2, completed: 1 });
  assert.equal(pl7.counts.total, 1);
  assert.equal(snapshot.plans.completedNotReady, 1);

  // M-06: готовые planned-релизы и готовые завершённые планы вне planned/released.
  assert.deepEqual(ids(operator.releasePreparation.readyReleases.items), [f.R1, f.R3]);
  // Порядок: PL11 изменён последним; ссылка отменённого релиза R4 план не меняет.
  assert.deepEqual(ids(operator.releasePreparation.completedPlansOutsideReleases.items), [
    f.PL11.id,
    f.PL10.id,
  ]);

  // Повторное открытие задачи убирает релиз из готовых, статусы записей не меняются.
  await p.move(f.T21, "review");
  const reopened = (await p.overview()).snapshot;
  assert.deepEqual(ids(reopened.operator.releasePreparation.readyReleases.items), [f.R3]);
  assert.equal((await p.releases.get(f.R1)).status, "planned");
  assert.equal((await p.plans.get(f.PL8.id)).status, "completed");
  assert.equal(reopened.operator.review.total, 6);
});

/**
 * Расширение малой fixture. Новые задачи: Y (web, done → in-progress); X (web, done,
 * зависит от Y) — done с открытыми обязательствами и сам блокер; Z (product, inbox,
 * зависит от X); Q (web, ready) блокирует только отменённую C2; R (web, review) с
 * отменённым ребёнком CH; T25 (infrastructure, done) в завершённом PL12.
 * Релизы: R7 planned [PL12] 2026-10-05; R9 planned [PL12] 2026-10-10 — та же дата, что у R1;
 * R8 cancelled [PL12].
 *
 * Ожидания, выведенные вручную:
 * задач 32, completed 8, doneWithOpenObligations 2 (T15, X), прежний blocked 11
 * (7 + X, Z, R, C2), readyToStart 4 (+Q);
 * M-01: review 6 = 2 + 4, R — CHILD_INCOMPLETE;
 * M-02: 9 = 6 + Y (→X), X (→Z), CH (→R); Q не блокирует незавершённую работу;
 * M-03: 8 = in-progress 3 (T9, T18, Y) + review 5 (T2, T3, T4, T5, R);
 * M-04: remaining 20 (web 12, product 8), blockedRemaining 9 (web 5, product 4);
 * M-06: релизы R7, затем R1 и R9 по ID, затем R3 без даты; вне релизов PL11, PL10 —
 * PL12 исключён planned-релизами, отменённый R8 этого не меняет.
 */
test("M-T02…M-T08: расширенная fixture — done-блокер, отменённые связи, общий план релизов", async (t) => {
  const p = await project(t);
  const f = await seed(p);
  const Y = await p.task("web", "done");
  const X = await p.task("web", "done", { dependencies: [Y] });
  const Z = await p.task("product", "inbox", { dependencies: [X] });
  await p.move(Y, "in-progress");
  const Q = await p.task("web", "ready");
  const C2 = await p.task("web", "inbox", { dependencies: [Q] });
  await p.move(C2, "cancelled");
  const R = await p.task("web", "review");
  const CH = await p.task("web", "inbox", { parentId: R });
  await p.move(CH, "cancelled");
  const T25 = await p.task("infrastructure", "done");
  const PL12 = await p.plan("PL12", [[T25]], "completed");
  const R7 = await p.release("R7", [PL12.id], "2026-10-05");
  const R9 = await p.release("R9", [PL12.id], "2026-10-10");
  await p.release("R8", [PL12.id], "", "cancel");

  const { snapshot } = await p.overview();
  const { operator, tasks } = snapshot;
  assert.equal(tasks.total, 32);
  assert.equal(tasks.completed, 8);
  assert.equal(tasks.doneWithOpenObligations, 2);
  assert.equal(tasks.blocked, 11);
  assert.equal(tasks.readyToStart, 4);

  assert.equal(operator.review.total, 6);
  assert.equal(operator.review.obligationsMet.total, 2);
  assert.equal(operator.review.obligationsOpen.total, 4);
  const open = await p.allPages({ metric: "review-obligations-open" });
  const reasonOfR = (open.items as unknown as { id: string; reasons: string[] }[]).find(
    (item) => item.id === R,
  )!;
  assert.deepEqual(reasonOfR.reasons, ["CHILD_INCOMPLETE"]);

  const impact = await p.allPages({ metric: "blocker-impact", limit: 3 });
  assert.equal(impact.pages, 3);
  assert.deepEqual(impact.ids, [f.T6, ...sorted([f.T7, f.T9, f.T11, f.T12, f.T14, Y, X, CH])]);
  const columns = Object.fromEntries(
    (impact.items as unknown as { id: string; column: string; affected: { total: number } }[]).map(
      (item) => [item.id, [item.column, item.affected.total]],
    ),
  );
  assert.deepEqual(columns[X], ["done", 1]);
  assert.deepEqual(columns[CH], ["cancelled", 1]);
  assert.deepEqual(columns[Y], ["in-progress", 1]);
  assert.equal(columns[Q], undefined);
  assert.deepEqual(ids((await p.metric({ metric: "blocker-affected", blocker: X })).items), [Z]);
  assert.deepEqual(ids((await p.metric({ metric: "blocker-affected", blocker: CH })).items), [R]);
  assert.equal((await p.metric({ metric: "blocker-affected", blocker: Q })).total, 0);

  assert.equal(operator.unplannedWork.total, 8);
  assert.deepEqual(operator.unplannedWork.byColumn, { "in-progress": 3, review: 5 });

  assert.equal(operator.boardWork.remaining, 20);
  assert.equal(operator.boardWork.blockedRemaining, 9);
  const board = (slug: string) =>
    operator.boardWork.boards.items.find((item) => item.slug === slug)!.tasks;
  assert.deepEqual([board("web").remaining, board("web").blockedRemaining], [12, 5]);
  assert.deepEqual([board("product").remaining, board("product").blockedRemaining], [8, 4]);

  // Релизы: дата по возрастанию, равная дата — по ID, без даты в конце.
  assert.deepEqual(ids(operator.releasePreparation.readyReleases.items), [
    R7,
    ...sorted([f.R1, R9]),
    f.R3,
  ]);
  assert.deepEqual(ids(operator.releasePreparation.completedPlansOutsideReleases.items), [
    f.PL11.id,
    f.PL10.id,
  ]);
  assert.deepEqual(ids(operator.openPlansComplete.items), [f.PL7.id, f.PL5.id]);
});

test("M-T05/M-T07: включение по ID, перенос доски, исключение из плана, отсутствующий итог", async (t) => {
  const p = await project(t);
  const f = await seed(p);
  // Перенос на другую доску не меняет включение: сравнение по постоянному ID.
  await p.move(f.T6, "in-progress", "product");
  await p.move(f.T3, "review", "product");
  let operator = (await p.overview()).snapshot.operator;
  assert.equal(operator.unplannedWork.total, 6);
  const moved = (await p.allPages({ metric: "unplanned-work" })).ids;
  assert.ok(moved.includes(f.T3), "перенесённая задача вне плана остаётся в показателе");
  assert.ok(!moved.includes(f.T6), "перенесённая задача плана остаётся включённой");
  // Исключение из открытого плана возвращает задачу в показатель.
  const current = await p.plans.get(f.PL1.id);
  await p.plans.changeTasks(
    f.PL1.id,
    {
      stage: f.PL1.stageIds[0]!,
      remove: [f.T6],
      ifRevision: current.revision,
      requestId: p.id(),
    },
    "agent",
  );
  operator = (await p.overview()).snapshot.operator;
  assert.equal(operator.unplannedWork.total, 7);
  assert.deepEqual(operator.unplannedWork.byColumn, { "in-progress": 3, review: 4 });
  // Завершение без итога отклоняется правилами планирования; план остаётся в M-05.
  const pl5 = await p.plans.get(f.PL5.id);
  await assert.rejects(
    p.plans.transition(
      f.PL5.id,
      { action: "complete", ifRevision: pl5.revision, requestId: p.id() },
      "agent",
    ),
  );
  const open = (await p.overview()).snapshot.operator.openPlansComplete.items;
  assert.equal(open.find((item) => item.id === f.PL5.id)?.status, "active");
});

test("M-T09/M-T10: равные значения сортировки, совпадение preview и detail, одно чтение и один расчёт", async (t) => {
  const p = await project(t);
  const f = await seed(p);
  const sources = await p.workspace.locked((owned) => readOverviewSources(p.workspace, owned));
  // Выполнение задач считается один раз: берётся из снимка планирования.
  assert.equal(overviewCompletion(sources), sources.planning!.completion);
  const at = "2026-09-01T00:00:00.000Z";
  const tied = {
    ...sources,
    tasks: sources.tasks.map((task) => ({ ...task, updatedAt: at })),
    plans: sources.plans.map((plan) => ({ ...plan, updatedAt: at })),
  };
  const summaries = new Map<string, number>();
  const planning = {
    ...tied.planning!,
    plans: tied.plans,
    summary: (plan: WorkPlan) => {
      summaries.set(plan.id, (summaries.get(plan.id) ?? 0) + 1);
      return sources.planning!.summary(plan);
    },
  };
  const { overview, index } = buildOverviewWithIndex({ ...tied, planning }, at);
  assert.ok(
    [...summaries.values()].every((count) => count === 1),
    "summary плана один раз",
  );
  assert.deepEqual(
    ids(index.lists["unplanned-work"]),
    sorted([f.T9, f.T18, f.T2, f.T3, f.T4, f.T5]),
  );
  assert.deepEqual(ids(index.lists["review-obligations-open"]), sorted([f.T2, f.T3, f.T4]));
  assert.deepEqual(ids(index.lists["open-plans-complete"]), sorted([f.PL5.id, f.PL7.id]));
  assert.deepEqual(ids(index.affected.get(f.T6)!), sorted([f.T3, f.T8]));
  assert.deepEqual(
    ids(overview.snapshot.operator.unplannedWork.items),
    ids(index.lists["unplanned-work"]).slice(0, 5),
  );

  // Обзор и детализация читают задачи и доски одним обращением к хранилищу.
  const taskReads = t.mock.method(BoardTaskRepository.prototype, "all");
  const boardReads = t.mock.method(BoardRepository.prototype, "all");
  const live = await p.overview();
  assert.equal(taskReads.mock.callCount(), 1);
  assert.equal(boardReads.mock.callCount(), 1);
  const detail = await p.metric({ metric: "board-work", limit: 100 });
  assert.equal(taskReads.mock.callCount(), 2);
  assert.equal(boardReads.mock.callCount(), 2);
  assert.equal(detail.snapshotVersion, live.snapshotVersion);
  assert.deepEqual(detail.items, live.snapshot.operator.boardWork.boards.items);
  // Повреждённый источник прерывает расчёт, а не превращается в нули.
  assert.throws(
    () =>
      buildOverviewWithIndex(
        {
          ...sources,
          tasks: sources.tasks.map((task, index) =>
            index === 0 ? { ...task, boardId: "missing" } : task,
          ),
        },
        at,
      ),
    { code: "INVALID_DATA" },
  );
  // Неизменное состояние даёт ту же версию; hash привязан к формату обзора /2.
  assert.equal(overviewSnapshotVersion(sources), live.snapshotVersion);
});

test("M-T12: продолжение связано с метрикой, блокером, проектом и версией полного среза", async (t) => {
  const p = await project(t);
  const f = await seed(p);
  const first = await p.metric({ metric: "unplanned-work", limit: 2 });
  assert.ok(first.nextCursor);
  const { snapshotVersion } = first;
  // Контекст продолжения.
  await assert.rejects(
    p.metric({ metric: "review-obligations-open", limit: 2, cursor: first.nextCursor! }),
    { code: "INVALID_CURSOR" },
  );
  const affected = await p.metric({ metric: "blocker-affected", blocker: f.T6, limit: 1 });
  await assert.rejects(
    p.metric({ metric: "blocker-affected", blocker: f.T9, limit: 1, cursor: affected.nextCursor! }),
    { code: "INVALID_CURSOR" },
  );
  const other = await project(t);
  await assert.rejects(other.metric({ metric: "unplanned-work", cursor: first.nextCursor! }), {
    code: "INVALID_CURSOR",
  });
  // Ключ блокера разрешается в тот же ID.
  const byKey = await p.metric({
    metric: "blocker-affected",
    blocker: (await p.tasks.get(f.T6)).key,
    limit: 1,
    cursor: affected.nextCursor!,
  });
  assert.equal(byKey.blocker?.id, f.T6);
  // Ошибки входа.
  await assert.rejects(p.metric({ metric: "nonexistent" as "board-work" }), {
    code: "UNKNOWN_METRIC",
  });
  await assert.rejects(p.metric({ metric: "blocker-affected" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(p.metric({ metric: "board-work", blocker: f.T6 }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(p.metric({ metric: "blocker-affected", blocker: "ZZZ-404" }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(p.metric({ metric: "board-work", cursor: "не курсор" }), {
    code: "INVALID_CURSOR",
  });
  // Первая страница связывается с отображаемым срезом.
  assert.equal((await p.metric({ metric: "board-work", version: snapshotVersion })).total, 4);
  await assert.rejects(p.metric({ metric: "board-work", version: "0".repeat(64) }), {
    code: "VERSION_CONFLICT",
  });

  // Изменение только задачи, только плана или только релиза между страницами.
  const changes: [string, () => Promise<unknown>][] = [
    [
      "задача",
      async () =>
        p.tasks.update(
          f.T13,
          { title: "Новое", ifRevision: (await p.tasks.get(f.T13)).revision, requestId: p.id() },
          "agent",
        ),
    ],
    [
      "план",
      async () =>
        p.plans.update(
          f.PL2.id,
          {
            title: "Новое",
            ifRevision: (await p.plans.get(f.PL2.id)).revision,
            requestId: p.id(),
          },
          "agent",
        ),
    ],
    [
      "релиз",
      async () =>
        p.releases.update(
          f.R5,
          {
            title: "R5 новое",
            version: "R5",
            status: "planned",
            planIds: [f.PL3.id],
            ifRevision: (await p.releases.get(f.R5)).revision,
            requestId: p.id(),
          },
          "agent",
        ),
    ],
  ];
  for (const [label, change] of changes) {
    const page = await p.metric({ metric: "unplanned-work", limit: 2 });
    await change();
    await assert.rejects(
      p.metric({ metric: "unplanned-work", limit: 2, cursor: page.nextCursor! }),
      { code: "VERSION_CONFLICT" },
      label,
    );
    const version = (await p.overview()).snapshotVersion;
    assert.notEqual(version, page.snapshotVersion, label);
  }
});

test("M-T06/M-T09: больше 50 досок и больше страницы задач — суммы по доскам равны проектным", async (t) => {
  const p = await project(t);
  const slugs: string[] = [];
  for (let index = 0; index < 52; index++) {
    const slug = `app-${String(index).padStart(2, "0")}`;
    await p.application(slug);
    slugs.push(slug);
  }
  const columns = ["inbox", "ready", "in-progress", "review", "done", "cancelled"];
  for (let index = 0; index < 45; index++)
    await p.task(slugs[index % 7]!, columns[index % columns.length]!);
  const { snapshot } = await p.overview();
  const boards = await p.allPages({ metric: "board-work", limit: 20 });
  assert.equal(boards.pages, 3);
  assert.equal(boards.ids.length, 54);
  const items = boards.items as unknown as {
    id: string;
    tasks: {
      total: number;
      completed: number;
      remaining: number;
      byColumn: Record<string, number>;
    };
  }[];
  const sum = (pick: (item: (typeof items)[number]) => number) =>
    items.reduce((total, item) => total + pick(item), 0);
  assert.equal(
    sum((item) => item.tasks.total),
    45,
  );
  assert.equal(
    sum((item) => item.tasks.completed),
    snapshot.tasks.completed,
  );
  for (const column of columns)
    assert.equal(
      sum((item) => item.tasks.byColumn[column]!),
      snapshot.tasks.byColumn[column as "inbox"],
    );
  // 45 задач: done и cancelled по 7, незавершённых 31.
  assert.equal(
    sum((item) => item.tasks.remaining),
    31,
  );
  assert.equal(snapshot.operator.boardWork.remaining, 31);
  // Порядок: remaining по убыванию, затем ID; пустые доски в конце по ID.
  for (let index = 1; index < items.length; index++) {
    const [left, right] = [items[index - 1]!, items[index]!];
    assert.ok(
      left.tasks.remaining > right.tasks.remaining ||
        (left.tasks.remaining === right.tasks.remaining && left.id < right.id),
    );
  }
  assert.deepEqual(ids(snapshot.operator.boardWork.boards.items), boards.ids.slice(0, 5));
});

test("M-T12: продолжение после удаления блокера и смены версии — VERSION_CONFLICT, а не NOT_FOUND", async (t) => {
  const p = await project(t);
  const blocker = await p.task("infrastructure", "ready");
  await p.task("product", "inbox", { dependencies: [blocker] });
  await p.task("product", "inbox", { dependencies: [blocker] });
  const key = (await p.tasks.get(blocker)).key;
  for (const reference of [blocker, key]) {
    const first = await p.metric({ metric: "blocker-affected", blocker: reference, limit: 1 });
    assert.equal(first.total, 2);
    assert.ok(first.nextCursor);
    if (reference === key) {
      // Удаление блокера вместе с его связями.
      const deletion = new EntityDeletionService(p.workspace);
      const preview = await deletion.preview({ ref: blocker, kind: "task" });
      await deletion.delete(
        { ref: blocker, kind: "task", ifVersion: preview.version, requestId: p.id() },
        "agent",
      );
    } else {
      await p.tasks.update(
        blocker,
        { title: "Новое", ifRevision: (await p.tasks.get(blocker)).revision, requestId: p.id() },
        "agent",
      );
    }
    await assert.rejects(
      p.metric({
        metric: "blocker-affected",
        blocker: reference,
        limit: 1,
        cursor: first.nextCursor!,
      }),
      { code: "VERSION_CONFLICT" },
    );
    // Та же проверка версии из query предшествует разрешению блокера.
    await assert.rejects(
      p.metric({
        metric: "blocker-affected",
        blocker: reference,
        version: first.snapshotVersion,
      }),
      { code: "VERSION_CONFLICT" },
    );
  }
  // Без курсора и версии удалённый блокер — обычная ошибка поиска задачи.
  await assert.rejects(p.metric({ metric: "blocker-affected", blocker }), { code: "NOT_FOUND" });
  // Блокер, которого не было в срезе курсора, при той же версии — чужой курсор.
  const other = await p.task("infrastructure", "ready");
  await p.task("product", "inbox", { dependencies: [other] });
  await p.task("product", "inbox", { dependencies: [other] });
  const page = await p.metric({ metric: "blocker-affected", blocker: other, limit: 1 });
  await assert.rejects(
    p.metric({
      metric: "blocker-affected",
      blocker: "ZZZ-404",
      limit: 1,
      cursor: page.nextCursor!,
    }),
    { code: "INVALID_CURSOR" },
  );
});

test("M-T10: обзор и страница детализации считают выполнение задач ровно один раз", async () => {
  // Структурная проверка без таймингов: taskCompletions подменяется счётчиком
  // в отдельном процессе с module mocks.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--no-warnings",
      "--conditions=tasks-source",
      "--import",
      "tsx",
      new URL("./helpers/count-completions.ts", import.meta.url).pathname,
    ],
    { cwd: new URL("..", import.meta.url).pathname },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), { overview: 1, metric: 1 });
});
