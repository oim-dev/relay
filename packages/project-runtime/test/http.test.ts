import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import { AppError } from "@relay/core/shared/errors";
import { createHttpBackend } from "../src/backend/http.js";

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
