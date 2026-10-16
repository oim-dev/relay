import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import type { Backend } from "../src/backend/types.js";
import {
  createHttpBackend,
  ENTITY_SEARCH_CAPABILITY,
  WORK_READ_MODELS_CAPABILITY,
  PRODUCT_QUERIES_CAPABILITY,
  RELEASE_REFS_CAPABILITY,
} from "../src/backend/http.js";

function context(capabilities: string[] = []) {
  return {
    ok: true,
    data: {
      capabilities: ["relay-projects-v1", ...capabilities],
      projectId: "fixed-project",
      config: defaultConfig,
      configPath: "/project/.relay/config.json",
      storagePath: "/project/.relay",
    },
  };
}

const guarded: Array<[string, (backend: Backend) => Promise<unknown>]> = [
  ["plans.listCompact", (b) => b.plans.listCompact({ projection: "compact" })],
  ["releases.listCompact", (b) => b.releases.listCompact({ projection: "compact" })],
  [
    "releases.compositionCompact",
    (b) => b.releases.compositionCompact("REL-1", { projection: "compact" }),
  ],
  [
    "releases.previewCompact",
    (b) => b.releases.previewCompact({ projection: "compact", plans: [] }),
  ],
  [
    "releases.createByRefs",
    (b) =>
      b.releases.createByRefs(
        { title: "Выпуск", version: "1", plans: ["PLAN-1"], requestId: "create" },
        "author",
      ),
  ],
  [
    "releases.updateByRefs",
    (b) =>
      b.releases.updateByRefs(
        "REL-1",
        {
          title: "Выпуск",
          version: "1",
          plans: ["PLAN-1"],
          status: "planned",
          ifRevision: 1,
          requestId: "update",
        },
        "author",
      ),
  ],
  ["progress.taskDependencies", (b) => b.progress.taskDependencies({ ref: "TASK-1" })],
  ["product.validate", (b) => b.product.validate()],
  ["product.lint", (b) => b.product.lint()],
  ["product.overviewMap", (b) => b.product.overviewMap()],
  ["product.participation", (b) => b.product.participation({ application: "APP-1" })],
  ["product.implementation", (b) => b.product.implementation("WEB-FI-1")],
  [
    "product.replaceParticipation",
    (b) =>
      b.product.replaceParticipation(
        {
          application: "APP-1",
          selections: [],
          ifRevision: 0,
          ifVersion: "version",
          requestId: "replace",
        },
        "author",
      ),
  ],
  ["entities.search", (b) => b.entities.list({ q: "содержание" })],
  ["entities.FI", (b) => b.entities.list({ implementationTarget: "feature" })],
];

for (const [name, operation] of guarded)
  test(`HTTP ${name}: старый сервер даёт несовместимость без full get или local fallback`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json(context());
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
    await assert.rejects(operation(backend), { code: "SERVER_INCOMPATIBLE" });
    assert.equal(calls, 1, "Только handshake, ни предметного запроса, ни fallback");
  });

for (const [name, operation] of guarded)
  test(`HTTP ${name}: невалидный успешный ответ отклоняется без повторов`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: string) => {
      if (new URL(input).pathname.endsWith("/context"))
        return Response.json(
          context([
            ENTITY_SEARCH_CAPABILITY,
            WORK_READ_MODELS_CAPABILITY,
            PRODUCT_QUERIES_CAPABILITY,
            RELEASE_REFS_CAPABILITY,
          ]),
        );
      requests++;
      return Response.json({ ok: true, data: {} });
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
    await assert.rejects(operation(backend), { code: "INVALID_SERVER_RESPONSE" });
    assert.equal(requests, 1, "Ни повторов, ни чтений для подстановки отсутствующих полей");
  });

for (const [name, operation] of guarded.filter(([name]) =>
  ["releases.createByRefs", "releases.updateByRefs", "product.replaceParticipation"].includes(name),
)) {
  for (const failure of ["network", "500"] as const)
    test(`HTTP ${name}: неопределённый результат ${failure} не повторяет запись`, async (t) => {
      let writes = 0;
      t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/context"))
          return Response.json(context([PRODUCT_QUERIES_CAPABILITY, RELEASE_REFS_CAPABILITY]));
        writes++;
        assert.match(url.pathname, /^\/api\/v1\/projects\/fixed-project\//);
        assert.equal(init.method, "POST");
        const body = JSON.parse(String(init.body));
        assert.equal(body.actor, "author");
        assert.ok(body.requestId);
        if (failure === "network") throw new TypeError("Ответ потерян после отправки записи");
        return Response.json(
          { ok: false, error: { code: "TEST_ERROR", message: "Ответ записи не подтверждён" } },
          { status: 500 },
        );
      });
      const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
      await assert.rejects(operation(backend), {
        code: failure === "network" ? "SERVER_UNAVAILABLE" : "TEST_ERROR",
      });
      assert.equal(writes, 1);
    });
}

test("HTTP compact: projection на wire, закрепление projectId и строгая проверка результата", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/context"))
      return Response.json(context([WORK_READ_MODELS_CAPABILITY]));
    reads++;
    assert.equal(url.pathname, "/api/v1/projects/fixed-project/plans/compact");
    assert.equal(url.searchParams.get("projection"), "compact");
    assert.equal(url.searchParams.get("limit"), "1");
    return Response.json({
      ok: true,
      data: {
        items: [],
        total: 0,
        nextOffset: null,
        version: "v",
        statusCounts: { all: 0 },
        ...(reads > 1 ? { unexpected: true } : {}),
      },
    });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
  assert.equal((await backend.plans.listCompact({ projection: "compact", limit: 1 })).total, 0);
  await assert.rejects(backend.plans.listCompact({ projection: "compact", limit: 1 }), {
    code: "INVALID_SERVER_RESPONSE",
  });
  assert.equal(reads, 2, "Ошибка схемы не повторяется");
});

test("HTTP entities: FI-фильтр, карточки приложения/цели и updatedAt проходят одну схему", async (t) => {
  let calls = 0;
  const item = {
    ref: { kind: "implementation", id: "fi" },
    key: "WEB-FI-1",
    title: "Вклад",
    summary: "",
    revision: 1,
    status: "none",
    active: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
    implementation: {
      type: "FI",
      application: { ref: { kind: "application", id: "app" }, key: "APP-1", title: "Web" },
      target: { ref: { kind: "feature", id: "feature" }, key: "FEATURE-1", title: "Фича" },
    },
  };
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/context"))
      return Response.json(context([ENTITY_SEARCH_CAPABILITY]));
    calls++;
    assert.equal(url.searchParams.get("implementationTarget"), "feature");
    return Response.json({
      ok: true,
      data: {
        items: [{ ...item, ...(calls > 1 ? { updatedAt: "not-a-date" } : {}) }],
        total: 1,
        nextOffset: null,
        version: "entities-v2:v",
      },
    });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  const page = await backend.entities.list({ implementationTarget: "feature" });
  assert.deepEqual(page.items[0], item);
  await assert.rejects(backend.entities.list({ implementationTarget: "feature" }), {
    code: "INVALID_SERVER_RESPONSE",
  });
  assert.equal(calls, 2);
});
