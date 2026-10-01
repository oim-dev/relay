import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { PlanningService } from "@relay/core/application/planning/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { defaultConfig } from "@relay/core/domain/config";
import { AppError } from "@relay/core/shared/errors";
import { initialize } from "@relay/core/storage/workspace";
import { createHttpBackend } from "../src/backend/http.js";
import { createLocalBackend } from "../src/backend/local.js";

const context = {
  ok: true,
  data: {
    capabilities: ["relay-projects-v1"],
    projectId: "fixed-project",
    config: defaultConfig,
    configPath: "/project/.relay/config.json",
    storagePath: "/project/.relay",
  },
};

for (const failure of [
  "network",
  "500",
  "409",
  "400",
  "invalid-envelope",
  "invalid-json",
] as const) {
  test(`HTTP: мутация не повторяется при ${failure}, requestId остаётся корреляцией`, async (t) => {
    let writes = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/context")) return Response.json(context);
      assert.match(url, /\/projects\/fixed-project\/board-tasks$/);
      assert.equal(init.method, "POST");
      assert.equal(JSON.parse(String(init.body)).requestId, "correlation");
      writes++;
      if (failure === "network") throw new TypeError("Соединение разорвано после записи");
      if (failure === "invalid-envelope") return Response.json({ unexpected: true });
      if (failure === "invalid-json") return new Response("{", { status: 200 });
      return Response.json(
        { ok: false, error: { code: "TEST_ERROR", message: "Ошибка сервера" } },
        { status: Number(failure) },
      );
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700");
    await assert.rejects(
      backend.boardTasks.create({ board: "product", requestId: "correlation" }, "agent"),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(
          error.code,
          failure === "invalid-envelope"
            ? "INVALID_SERVER_RESPONSE"
            : failure === "network" || failure === "invalid-json"
              ? "SERVER_UNAVAILABLE"
              : "TEST_ERROR",
        );
        if (!["400", "409"].includes(failure)) assert.match(error.message, /Перечитайте состояние/);
        assert.deepEqual(
          error.details && (error.details as { requestId: string }).requestId,
          "correlation",
        );
        return true;
      },
    );
    assert.equal(writes, 1);
  });
}

test("HTTP: чтение повторяется не более двух раз после первой попытки", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    if (reads < 3) throw new TypeError("Нет соединения");
    return Response.json(context);
  });
  await createHttpBackend("http://127.0.0.1:4700");
  assert.equal(reads, 3);
});

test("HTTP: постоянный отказ чтения исчерпывает три попытки", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json(
      { ok: false, error: { code: "IO_ERROR", message: "Сбой чтения" } },
      { status: 503 },
    );
  });
  await assert.rejects(createHttpBackend("http://127.0.0.1:4700"), { code: "IO_ERROR" });
  assert.equal(reads, 3);
});

async function overviewWorkspace(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-overview-http-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  await new BoardTasksService(workspace).create(
    { board: "product", title: "Задача обзора", requestId: "overview-task" },
    "agent",
  );
  await new PlanningService(workspace).create(
    { title: "План обзора", goal: "## Цель\n\nОбщий срез", requestId: "overview-plan" },
    "agent",
  );
  return { root, workspace };
}

function serveOverview(t: TestContext, projectId: string, data: () => Promise<unknown>) {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/v1/context")) return Response.json(context);
    assert.equal(url, `http://127.0.0.1:4700/api/v1/projects/${projectId}/product/overview`);
    return Response.json({ ok: true, data: await data() });
  });
}

test("HTTP: обзор продукта семантически совпадает с local без generatedAt", async (t) => {
  const { root, workspace } = await overviewWorkspace(t);
  serveOverview(t, "fixed-project", () => new ProductQueries(workspace).overview());
  const remote = await (await createHttpBackend("http://127.0.0.1:4700")).product.overview();
  const local = await (await createLocalBackend(root)).product.overview();
  const { generatedAt: remoteAt, ...remoteData } = remote;
  const { generatedAt: localAt, ...localData } = local;
  assert.ok(!Number.isNaN(Date.parse(remoteAt)) && !Number.isNaN(Date.parse(localAt)));
  assert.deepEqual(remoteData, localData);
  assert.equal(remote.snapshot.tasks.total, 1);
  assert.equal(remote.snapshot.plans.total, 1);
});

test("HTTP: обзор прежнего сервера без snapshot даёт понятную ошибку несовместимости", async (t) => {
  const { workspace } = await overviewWorkspace(t);
  const current = await new ProductQueries(workspace).overview();
  const { productId, version, items, readiness } = current;
  serveOverview(t, "fixed-project", async () => ({ productId, version, items, readiness }));
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(backend.product.overview(), (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, "SERVER_INCOMPATIBLE");
    assert.equal(error.exitCode, 5);
    assert.match(error.message, /прежнего формата/);
    assert.match(error.message, /Обновите и перезапустите Relay Server/);
    return true;
  });
});

test("HTTP: повреждённый новый обзор остаётся ошибкой контракта ответа", async (t) => {
  const { workspace } = await overviewWorkspace(t);
  const current = await new ProductQueries(workspace).overview();
  serveOverview(t, "fixed-project", async () => ({ ...current, snapshotVersion: "old" }));
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(backend.product.overview(), { code: "INVALID_SERVER_RESPONSE" });
});

test("HTTP: обзор сервера без snapshot.operator — несовместимость версий, а не повреждение", async (t) => {
  const { workspace } = await overviewWorkspace(t);
  const current = await new ProductQueries(workspace).overview();
  const { operator: _operator, ...snapshot } = current.snapshot;
  serveOverview(t, "fixed-project", async () => ({ ...current, snapshot }));
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(backend.product.overview(), (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, "SERVER_INCOMPATIBLE");
    assert.equal(error.exitCode, 5);
    assert.match(error.message, /snapshot\.operator/);
    return true;
  });
});

/** Fixture детализации: задача-блокер задерживает работу, ещё две задачи ждут проверки. */
async function metricWorkspace(t: TestContext) {
  const { root, workspace } = await overviewWorkspace(t);
  const tasks = new BoardTasksService(workspace);
  for (const index of [1, 2])
    await tasks.create(
      { board: "product", column: "review", title: `Проверка ${index}`, requestId: `r-${index}` },
      "agent",
    );
  const blocker = await tasks.create(
    { board: "infrastructure", title: "Блокер", requestId: "blocker" },
    "agent",
  );
  const blocked = await tasks.create(
    { board: "product", column: "in-progress", title: "Работа", requestId: "blocked" },
    "agent",
  );
  await tasks.link(
    blocked.id,
    { target: blocker.id, relation: "depends-on", ifRevision: blocked.revision, requestId: "l" },
    "agent",
  );
  return { root, workspace, blocker: (await tasks.get(blocker.id)).key };
}

test("HTTP: детализация метрик обзора совпадает с local на одной fixture", async (t) => {
  const { root, workspace, blocker } = await metricWorkspace(t);
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/v1/context"))
      return Response.json({
        ...context,
        data: { ...context.data, capabilities: ["relay-projects-v1", "relay-overview-metrics-v1"] },
      });
    requested.push(url);
    const parsed = new URL(url);
    const prefix = "/api/v1/projects/fixed-project/product/overview/metrics/";
    assert(parsed.pathname.startsWith(prefix), url);
    const data = await new ProductQueries(workspace).overviewMetric({
      ...Object.fromEntries(parsed.searchParams),
      metric: parsed.pathname.slice(prefix.length) as "board-work",
    });
    return Response.json({ ok: true, data });
  });
  const remote = await createHttpBackend("http://127.0.0.1:4700");
  const local = await createLocalBackend(root);
  const queries = [
    { metric: "review-obligations-met", limit: 1 },
    { metric: "blocker-impact" },
    { metric: "blocker-affected", blocker },
    { metric: "unplanned-work" },
    { metric: "board-work", limit: 100 },
    { metric: "open-plans-complete" },
    { metric: "ready-releases" },
    { metric: "plans-outside-releases" },
  ] as const;
  for (const query of queries) {
    const [http, direct] = await Promise.all([
      remote.product.overviewMetric(query),
      local.product.overviewMetric(query),
    ]);
    const { generatedAt: _remoteAt, ...httpData } = http;
    const { generatedAt: _localAt, ...localData } = direct;
    assert.deepEqual(httpData, localData, query.metric);
  }
  // Продолжение передаётся как есть и читает следующую страницу того же среза.
  const first = await remote.product.overviewMetric({ metric: "review-obligations-met", limit: 1 });
  assert.equal(first.total, 2);
  const second = await remote.product.overviewMetric({
    metric: "review-obligations-met",
    limit: 1,
    cursor: first.nextCursor!,
    version: first.snapshotVersion,
  });
  assert.equal(second.nextCursor, null);
  assert.notDeepEqual(second.items, first.items);
  assert.match(requested.at(-1)!, /cursor=.+&version=[a-f0-9]{64}|version=[a-f0-9]{64}.*cursor=/);
  assert.match(requested[2]!, new RegExp(`/blocker-affected\\?blocker=${blocker}&limit=20$`));
});

test("HTTP: детализация метрик без возможности сервера — SERVER_INCOMPATIBLE до запроса", async (t) => {
  let detail = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/v1/context")) return Response.json(context);
    detail++;
    return Response.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Cannot GET" } },
      {
        status: 404,
      },
    );
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(
    backend.product.overviewMetric({ metric: "board-work" }),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, "SERVER_INCOMPATIBLE");
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /relay-overview-metrics-v1/);
      return true;
    },
  );
  assert.equal(detail, 0);
});

test("HTTP: метрика с обходом пути — UNKNOWN_METRIC без сетевого запроса", async (t) => {
  let detail = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/v1/context"))
      return Response.json({
        ...context,
        data: { ...context.data, capabilities: ["relay-projects-v1", "relay-overview-metrics-v1"] },
      });
    detail++;
    return Response.json({ ok: false, error: { code: "UNEXPECTED", message: "Запрос" } });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  for (const metric of [
    "../../../../b/product/overview/metrics/unplanned-work",
    "unplanned-work/../../x",
    "%2E%2E%2Funplanned-work",
    "board-work?x=1",
    "",
  ])
    await assert.rejects(
      backend.product.overviewMetric({ metric: metric as "board-work" }),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.code, "UNKNOWN_METRIC");
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  assert.equal(detail, 0);
});
