import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DeleteEntity,
  EntityDeleted,
  EntityDeletionPreview,
  EntityDeletionQuery,
} from "@relay/contracts/entities";
import { defaultConfig } from "@relay/core/domain/config";
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
const target = {
  ref: { kind: "application" as const, id: "app" },
  key: "WEB",
  title: "東京 🧪",
  summary: "Кратко\nполностью",
  revision: 7,
  status: null,
  active: true,
  context: "Контекст",
};
const preview: EntityDeletionPreview = {
  target,
  version: "original-version",
  deleted: [target],
  relations: 2,
  detached: [
    {
      ...target,
      ref: { kind: "document", id: "doc" },
      key: "DOC-1",
      document: {
        kind: "rules",
        format: "markdown",
        tags: [],
        status: "active",
        sectionId: null,
        pinned: true,
        updatedAt: "2026-10-14T00:00:00.000Z",
        linkCount: 2,
        excerpt: "Полный фрагмент",
      },
    },
  ],
};
const receipt: EntityDeleted = {
  action: "delete",
  ref: target.ref,
  requestId: "correlation",
  deleted: 1,
  detached: 1,
  relations: 2,
};
const command = {
  kind: "application" as const,
  ref: "WEB",
  ifVersion: preview.version,
  requestId: "correlation",
};

test("deletion HTTP: полный preview до контрактного предела не превращается в страницу", async (t) => {
  const full = {
    ...preview,
    deleted: Array.from({ length: 1000 }, (_, index) => ({
      ...target,
      ref: { ...target.ref, id: `removed-${index}` },
    })),
    detached: Array.from({ length: 1000 }, (_, index) => ({
      ...preview.detached[0]!,
      ref: { kind: "document" as const, id: `retained-${index}` },
    })),
  };
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(url.endsWith("/context") ? context : { ok: true, data: full }),
  );
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  assert.deepEqual(await backend.deletion.preview({ kind: "application", ref: "WEB" }), full);
  full.deleted.push(target);
  await assert.rejects(backend.deletion.preview({ kind: "application", ref: "WEB" }), {
    code: "INVALID_SERVER_RESPONSE",
  });
});

test("deletion HTTP: SDK сохраняет полный preview, metadata, actor/defaultActor, requestId и исходную версию", async (t) => {
  const calls: { method: string | undefined; url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method,
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/projects/registration/context")) return Response.json(context);
    assert.match(url, /^http:\/\/127.0.0.1:4700\/api\/v1\/projects\/fixed-project\/entities\//);
    if (init.method === "GET") {
      const parsed = new URL(url);
      assert.equal(parsed.pathname.split("/").at(-1), "deletion-preview");
      assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        kind: "application",
        ref: "application:app",
      });
      return Response.json({ ok: true, data: preview });
    }
    assert.equal(init.method, "POST");
    assert(url.endsWith("/delete"));
    return Response.json({ ok: true, data: receipt });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
  const result: EntityDeletionPreview = await backend.deletion.preview({
    kind: "application",
    ref: "application:app",
  });
  assert.deepEqual(result, preview);
  assert.deepEqual(
    await backend.deletion.delete({ ...command, actor: "body-author" }, "fallback"),
    receipt,
  );
  assert.deepEqual(await backend.deletion.delete(command, "default-author"), receipt);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2]?.body, { ...command, actor: "body-author" });
  assert.deepEqual(calls[3]?.body, { ...command, actor: "default-author" });
  assert.equal(backend.workspace.projectId, "fixed-project");
});

for (const kind of [
  "feature",
  "scenario",
  "application",
  "implementation",
  "task",
  "document",
] as const)
  test(`deletion HTTP: контракт SDK допускает ${kind}`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/context")) return Response.json(context);
      calls++;
      const ref = { kind, id: "target" };
      if (init.method === "GET") {
        assert.equal(new URL(url).searchParams.get("kind"), kind);
        return Response.json({
          ok: true,
          data: { ...preview, target: { ...target, ref }, deleted: [{ ...target, ref }] },
        });
      }
      assert.deepEqual(JSON.parse(String(init.body)), { ...command, kind, actor: "author" });
      return Response.json({ ok: true, data: { ...receipt, ref } });
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700");
    await backend.deletion.preview({ kind, ref: command.ref });
    assert.equal((await backend.deletion.delete({ ...command, kind }, "author")).ref.kind, kind);
    assert.equal(calls, 2);
  });

test("deletion HTTP: board и неверные метаданные отклоняются до предметного запроса", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(context);
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  const query = { kind: "board", ref: "BOARD-PRODUCT" } as unknown as EntityDeletionQuery;
  await assert.rejects(backend.deletion.preview(query), { code: "VALIDATION_ERROR" });
  await assert.rejects(backend.deletion.delete({ ...command, ...query }, "author"), {
    code: "VALIDATION_ERROR",
  });
  await assert.rejects(backend.deletion.delete({ ...command, ifVersion: "" }, "author"), {
    code: "VALIDATION_ERROR",
  });
  await assert.rejects(backend.deletion.delete({ ...command, requestId: "" }, "author"), {
    code: "VALIDATION_ERROR",
  });
  await assert.rejects(backend.deletion.delete(command, ""), { code: "VALIDATION_ERROR" });
  await assert.rejects(
    backend.deletion.delete({ ...command, actor: null } as unknown as DeleteEntity, "author"),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(calls, 1);
});

for (const failure of ["network", "500", "409", "400", "envelope", "json", "data"] as const)
  test(`deletion HTTP: один POST при ${failure}, без скрытого preview/retry/fallback`, async (t) => {
    let writes = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/context")) return Response.json(context);
      assert.equal(init.method, "POST");
      writes++;
      assert.deepEqual(JSON.parse(String(init.body)), { ...command, actor: "author" });
      if (failure === "network") throw new TypeError("Ответ потерян");
      if (failure === "envelope") return Response.json({ unexpected: true });
      if (failure === "json") return new Response("{", { status: 200 });
      if (failure === "data")
        return Response.json({ ok: true, data: { ...receipt, detached: "1" } });
      return Response.json(
        {
          ok: false,
          error: {
            code: "TEST_REFUSAL",
            message: "Отказ",
            exitCode: 4,
            details: { expected: "original-version", actual: "new-version", refs: [target.ref] },
          },
        },
        { status: Number(failure) },
      );
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700");
    await assert.rejects(backend.deletion.delete(command, "author"), {
      code: ["network", "json"].includes(failure)
        ? "SERVER_UNAVAILABLE"
        : ["envelope", "data"].includes(failure)
          ? "INVALID_SERVER_RESPONSE"
          : "TEST_REFUSAL",
      ...(["400", "409", "500"].includes(failure)
        ? {
            exitCode: 4,
            details: {
              serverDetails: {
                expected: "original-version",
                actual: "new-version",
                refs: [target.ref],
              },
              requestId: command.requestId,
              url: "http://127.0.0.1:4700",
            },
          }
        : {}),
    });
    assert.equal(writes, 1);
  });

for (const failure of ["network", "500", "409", "data", "envelope"] as const)
  test(`deletion HTTP: ограниченная политика чтения preview при ${failure}`, async (t) => {
    let reads = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/context")) return Response.json(context);
      assert.equal(init.method, "GET");
      reads++;
      if (failure === "network") throw new TypeError("Нет соединения");
      if (failure === "data")
        return Response.json({
          ok: true,
          data: { ...preview, detached: [{ ...preview.detached[0], document: { pinned: true } }] },
        });
      if (failure === "envelope") return Response.json({ ok: true });
      return Response.json(
        { ok: false, error: { code: "READ_FAILURE", message: "Отказ чтения" } },
        { status: Number(failure) },
      );
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700");
    await assert.rejects(backend.deletion.preview({ kind: "application", ref: "WEB" }), {
      code:
        failure === "network"
          ? "SERVER_UNAVAILABLE"
          : ["data", "envelope"].includes(failure)
            ? "INVALID_SERVER_RESPONSE"
            : "READ_FAILURE",
    });
    assert.equal(reads, ["network", "500"].includes(failure) ? 3 : 1);
  });
