import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  productOverviewMetricPageSchema,
  productOverviewMetrics,
  productOverviewSchema,
} from "@relay/core/domain/product";
import type { ProductOverview, ProductOverviewMetricPage } from "@relay/core/domain/product";
import { ProductQueries } from "@relay/core/application/product/queries";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { initialize } from "@relay/core/storage/workspace";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

test("HTTP продукта: scoped-маршруты, прямой Markdown, повторы и реальные ошибки", async (t) => {
  const { app, workspace } = await fixture(t);
  const projectId = (await app.inject("/api/v1/context")).json().data.projectId;
  const prefix = `/api/v1/projects/${projectId}/product`;
  const payload = {
    action: "create",
    requestId: "passport",
    fields: {
      kind: "passport",
      name: "Продукт",
      summary: "Назначение",
      description: "## Цель\n\nСохранить текст  \n",
    },
  };
  const response = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(response.statusCode, 200, response.body);
  const repeated = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(repeated.statusCode, 409, repeated.body);
  const records = await app.inject(`${prefix}/records?kind=passport&limit=1`);
  assert.equal(records.statusCode, 200, records.body);
  assert.equal(records.json().data.items[0].fields.description, payload.fields.description);
  assert.equal(records.json().data.nextOffset, null);
  assert.deepEqual(
    (await app.inject(`${prefix}/state`)).json().data,
    await new ProductQueries(workspace).state(),
  );
  const conflict = await app.inject({
    method: "POST",
    url: `${prefix}/records`,
    payload: { ...payload, action: "update", id: "passport", ifRevision: 7, requestId: "update" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, "REVISION_CONFLICT");
  const overview = (await app.inject(`${prefix}/overview`)).json().data;
  assert.equal(overview.items[0].name, "Продукт");
  assert.ok(!JSON.stringify(overview).includes("Сохранить текст"));
  const context = (await app.inject(`${prefix}/context`)).json().data;
  assert.equal(context.records[0].record.id, "passport");
});

/** Предметная часть обзора без времени формирования ответа. */
function withoutGeneratedAt(overview: ProductOverview) {
  const { generatedAt, ...rest } = overview;
  assert.ok(!Number.isNaN(Date.parse(generatedAt)));
  return rest;
}

test("HTTP обзора продукта: пустой проект, local/scoped, snapshotVersion и равенство с Core", async (t) => {
  const { app, root, workspace } = await fixture(t);
  const projectId = workspace.config.projectId!;
  const scoped = `/api/v1/projects/${projectId}`;
  const read = async (base = scoped) => {
    const response = await app.inject(`${base}/product/overview`);
    assert.equal(response.statusCode, 200, response.body);
    return productOverviewSchema.parse(response.json().data);
  };
  const empty = await read();
  assert.equal(empty.snapshot.passport.state, "missing");
  assert.deepEqual(empty.items, []);
  assert.equal(empty.snapshot.tasks.total, 0);
  assert.equal(empty.snapshot.plans.total, 0);
  assert.equal(empty.snapshot.releases.total, 0);
  assert.equal(empty.snapshot.project.id, projectId);
  assert.deepEqual(withoutGeneratedAt(await read("/api/v1")), withoutGeneratedAt(empty));
  assert.deepEqual(
    withoutGeneratedAt(await new ProductQueries(workspace).overview()),
    withoutGeneratedAt(empty),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeated = await read();
  assert.notEqual(repeated.generatedAt, empty.generatedAt);
  assert.equal(repeated.snapshotVersion, empty.snapshotVersion);

  const versions = [empty.snapshotVersion];
  const expectChanged = async (step: string) => {
    const current = await read();
    assert.ok(!versions.includes(current.snapshotVersion), `snapshotVersion не изменился: ${step}`);
    assert.equal(current.version, empty.version, `Версия состава продукта изменилась: ${step}`);
    versions.push(current.snapshotVersion);
    return current;
  };
  const write = async (method: "POST" | "PUT", url: string, payload: object) => {
    const response = await app.inject({ method, url: `${scoped}${url}`, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const task = await write("POST", "/board-tasks", {
    board: "product",
    title: "Задача обзора",
    requestId: "overview-task",
  });
  assert.equal((await expectChanged("создание задачи")).snapshot.tasks.total, 1);
  await write("POST", `/board-tasks/${task.id}/criteria`, {
    action: "add",
    title: "Критерий обзора",
    ifRevision: task.revision,
    requestId: "overview-criterion",
  });
  assert.equal((await expectChanged("критерий задачи")).snapshot.tasks.criteria.total, 1);
  const plan = await write("POST", "/plans", { title: "План обзора", requestId: "overview-plan" });
  await expectChanged("создание плана");
  await write("POST", `/plans/${plan.id}/update`, {
    title: "План обзора, уточнённый",
    ifRevision: plan.revision,
    requestId: "overview-plan-update",
  });
  await expectChanged("изменение плана");
  await write("POST", "/releases", {
    title: "Релиз обзора",
    version: "1.0.0",
    planIds: [plan.id],
    requestId: "overview-release",
  });
  assert.equal((await expectChanged("создание релиза")).snapshot.releases.total, 1);
  const settings = (await app.inject(`${scoped}/context/settings`)).json().data;
  await write("PUT", "/context/settings", {
    name: "Переименованный проект",
    slug: settings.slug,
    ifRevision: settings.revision,
  });
  const renamed = await expectChanged("имя проекта");
  assert.equal(renamed.snapshot.project.name, "Переименованный проект");

  await app.listen({ host: "127.0.0.1", port: 0 });
  const http = await createHttpBackend(await app.getUrl(), projectId);
  const local = await createLocalBackend(root);
  const [remote, direct] = await Promise.all([http.product.overview(), local.product.overview()]);
  assert.deepEqual(withoutGeneratedAt(remote), withoutGeneratedAt(direct));
  assert.equal(remote.snapshotVersion, renamed.snapshotVersion);
});

test("HTTP обзора продукта: проектные маршруты изолируют workspace A и B", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-overview-"));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "a" });
  await registerProject(registry.configPath, "b", { path: "b" });
  const server = await startServer({ cwd: root, actor: "test", port: 0 });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await new BoardTasksService(a).create(
    { board: "product", title: "Только в А", requestId: "only-a" },
    "test",
  );
  const read = async (project: string) => {
    const response = await server.app.inject(`/api/v1/projects/${project}/product/overview`);
    assert.equal(response.statusCode, 200, response.body);
    return productOverviewSchema.parse(response.json().data);
  };
  const [first, second] = await Promise.all([read("a"), read("b")]);
  assert.equal(first.snapshot.project.id, a.config.projectId);
  assert.equal(second.snapshot.project.id, b.config.projectId);
  assert.equal(first.snapshot.tasks.total, 1);
  assert.equal(second.snapshot.tasks.total, 0);
  assert.notEqual(first.snapshotVersion, second.snapshotVersion);
  const [remoteA, remoteB] = await Promise.all([
    createHttpBackend(server.url, "a"),
    createHttpBackend(server.url, "b"),
  ]);
  assert.equal((await remoteA.product.overview()).snapshotVersion, first.snapshotVersion);
  assert.equal((await remoteB.product.overview()).snapshotVersion, second.snapshotVersion);
  assert.equal(
    (await server.app.inject("/api/v1/projects/missing/product/overview")).statusCode,
    404,
  );
});

/** Страница детализации без времени формирования ответа. */
function pageWithoutGeneratedAt(page: ProductOverviewMetricPage) {
  const { generatedAt, ...rest } = page;
  assert.ok(!Number.isNaN(Date.parse(generatedAt)));
  return rest;
}

test("HTTP детализации метрик обзора: пусто, страницы, scoped, ошибки и VERSION_CONFLICT", async (t) => {
  const { app, root, workspace } = await fixture(t);
  const projectId = workspace.config.projectId!;
  const scoped = `/api/v1/projects/${projectId}`;
  const core = new ProductQueries(workspace);
  const get = async (path: string, status = 200, base = scoped) => {
    const response = await app.inject(`${base}/product/overview/metrics/${path}`);
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const page = async (path: string, base = scoped) =>
    productOverviewMetricPageSchema.parse((await get(path, 200, base)).data);
  const failure = async (path: string, status: number, code: string) => {
    const body = await get(path, status);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code, JSON.stringify(body));
    return body.error;
  };
  const write = async (url: string, payload: object) => {
    const response = await app.inject({ method: "POST", url: `${scoped}${url}`, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };

  // Пустой проект: каждая метрика — нормальный ответ с нулём и без продолжения.
  const empty = productOverviewSchema.parse(
    (await app.inject(`${scoped}/product/overview`)).json().data,
  );
  for (const metric of productOverviewMetrics.filter((entry) => entry !== "blocker-affected")) {
    const result = await page(`${metric}?version=${empty.snapshotVersion}`);
    assert.equal(result.metric, metric);
    assert.equal(result.blocker, null);
    assert.equal(result.nextCursor, null);
    // Системные доски существуют и в пустом проекте; остальные выборки пусты.
    if (metric === "board-work") {
      assert.equal(result.total, empty.snapshot.operator.boardWork.boards.total);
      assert.ok(result.items.every((board) => "tasks" in board && board.tasks.remaining === 0));
      continue;
    }
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.snapshotVersion, empty.snapshotVersion);
  }

  // Пять задач в review без обязательств и одна работа, заблокированная задачей-блокером.
  for (let index = 0; index < 5; index++)
    await write("/board-tasks", {
      board: "product",
      column: "review",
      title: `Проверка ${index}`,
      requestId: `review-${index}`,
    });
  const blocker = await write("/board-tasks", {
    board: "infrastructure",
    column: "ready",
    title: "Блокер",
    requestId: "blocker",
  });
  const blocked = await write("/board-tasks", {
    board: "product",
    column: "in-progress",
    title: "Заблокированная работа",
    requestId: "blocked",
  });
  await write(`/board-tasks/${blocked.id}/links`, {
    target: blocker.id,
    relation: "depends-on",
    ifRevision: blocked.revision,
    requestId: "blocked-link",
  });
  const plan = await write("/plans", { title: "План детализации", requestId: "metric-plan" });
  const release = await write("/releases", {
    title: "Релиз детализации",
    version: "1.0.0",
    planIds: [plan.id],
    requestId: "metric-release",
  });

  const overview = productOverviewSchema.parse(
    (await app.inject(`${scoped}/product/overview`)).json().data,
  );
  const version = overview.snapshotVersion;
  assert.equal(overview.snapshot.operator.review.obligationsMet.total, 5);

  // Пагинация: три страницы того же среза равны полной выборке Core и подборке обзора.
  const collected: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: "2", version });
    if (cursor) query.set("cursor", cursor);
    const current = await page(`review-obligations-met?${query}`);
    assert.equal(current.total, 5);
    assert.equal(current.snapshotVersion, version);
    collected.push(...current.items);
    cursor = current.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  const full = await core.overviewMetric({ metric: "review-obligations-met", limit: 100 });
  assert.deepEqual(collected, full.items);
  assert.deepEqual(
    collected.slice(0, overview.snapshot.operator.review.obligationsMet.shown),
    overview.snapshot.operator.review.obligationsMet.items,
  );

  // Local и scoped адреса дают одинаковый результат, равный Core.
  const local = await page("blocker-impact", "/api/v1");
  assert.deepEqual(
    pageWithoutGeneratedAt(await page("blocker-impact")),
    pageWithoutGeneratedAt(local),
  );
  assert.deepEqual(
    pageWithoutGeneratedAt(local),
    pageWithoutGeneratedAt(await core.overviewMetric({ metric: "blocker-impact" })),
  );
  assert.equal(local.total, 1);
  assert.equal(local.items[0]!.id, blocker.id);

  // blocker-affected принимает ключ блокера и возвращает прямо затронутую задачу.
  const affected = await page(`blocker-affected?blocker=${blocker.key}`);
  assert.equal(affected.metric, "blocker-affected");
  assert.equal(affected.blocker?.id, blocker.id);
  assert.equal(affected.total, 1);
  assert.equal(affected.items[0]!.id, blocked.id);
  assert.deepEqual(affected.metric === "blocker-affected" && affected.items[0]!.relations, [
    "dependency",
  ]);

  // Предметные ошибки транспорта.
  await failure("unknown-metric", 400, "UNKNOWN_METRIC");
  // Сегмент пути не уводит запрос в другой маршрут или проект.
  for (const path of ["..%2F..%2Fboard-work", "board-work%2F..", "%2F"])
    await failure(path, 400, "UNKNOWN_METRIC");
  // `..` и `%2E%2E` нормализуются клиентом до отправки и не находит маршрута — не 200.
  for (const path of ["..", "%2E%2E"]) {
    const dotted = await app.inject(`${scoped}/product/overview/metrics/${path}`);
    assert.equal(dotted.statusCode, 404, dotted.body);
  }
  const nested = await app.inject(`${scoped}/product/overview/metrics/board-work/extra`);
  assert.equal(nested.statusCode, 404, nested.body);
  await failure("blocker-affected?blocker=TASK-MISSING-404", 404, "NOT_FOUND");
  await failure(`review-obligations-met?blocker=${blocker.id}`, 400, "INVALID_ARGUMENT");
  await failure("blocker-affected", 400, "INVALID_ARGUMENT");
  await failure("review-obligations-met?limit=101", 400, "VALIDATION_ERROR");
  await failure("review-obligations-met?unexpected=1", 400, "VALIDATION_ERROR");
  await failure("review-obligations-met?cursor=broken", 400, "INVALID_CURSOR");
  const firstPage = await page(`review-obligations-met?limit=2&version=${version}`);
  await failure(
    `review-obligations-open?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    400,
    "INVALID_CURSOR",
  );

  // Изменение задачи, плана или релиза между страницами — конфликт продолжения.
  const changes: [string, () => Promise<unknown>][] = [
    [
      "задача",
      async () =>
        write(`/board-tasks/${blocker.id}/update`, {
          title: "Блокер, уточнённый",
          ifRevision: (await app.inject(`${scoped}/board-tasks/${blocker.id}`)).json().data
            .revision,
          requestId: "change-task",
        }),
    ],
    [
      "план",
      () =>
        write(`/plans/${plan.id}/update`, {
          title: "План детализации, уточнённый",
          ifRevision: plan.revision,
          requestId: "change-plan",
        }),
    ],
    [
      "релиз",
      () =>
        write(`/releases/${release.id}/transition`, {
          action: "cancel",
          ifRevision: release.revision,
          requestId: "change-release",
        }),
    ],
  ];
  for (const [subject, change] of changes) {
    const before = productOverviewSchema.parse(
      (await app.inject(`${scoped}/product/overview`)).json().data,
    ).snapshotVersion;
    const first = await page(`review-obligations-met?limit=2&version=${before}`);
    await change();
    const continued = await get(
      `review-obligations-met?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      409,
    );
    assert.equal(continued.error.code, "VERSION_CONFLICT", subject);
    assert.equal(continued.error.exitCode, 4, subject);
    const stale = await get(`review-obligations-met?version=${before}`, 409);
    assert.equal(stale.error.code, "VERSION_CONFLICT", subject);
  }

  // HTTP Backend (CLI/MCP) и local Backend читают одинаковую страницу.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const http = await createHttpBackend(await app.getUrl(), projectId);
  const direct = await createLocalBackend(root);
  const query = { metric: "blocker-affected", blocker: blocker.key, limit: 1 } as const;
  const [remote, same] = await Promise.all([
    http.product.overviewMetric(query),
    direct.product.overviewMetric(query),
  ]);
  assert.deepEqual(pageWithoutGeneratedAt(remote), pageWithoutGeneratedAt(same));
  await assert.rejects(http.product.overviewMetric({ metric: "nope" as "board-work" }), {
    code: "UNKNOWN_METRIC",
  });
});
