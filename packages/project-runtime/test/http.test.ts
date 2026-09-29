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
