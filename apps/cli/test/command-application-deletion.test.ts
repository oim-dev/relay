import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EntityDeletionPreview, EntitySaved } from "@relay/contracts/entities";
import { startServer } from "@relay/server-runtime";
import {
  fixture,
  fixtureCleanup,
  invoke,
  invokeRaw,
  successful,
  failed,
  type FixtureContext,
} from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

test(
  "application delete HTTP: 503 и потеря ответа не повторяют POST; результат проверяется чтением",
  { timeout: 90_000 },
  async (t) => {
    const app = await fixture(t);
    const target = successful(
      await app.run<EntitySaved>([
        "application",
        "create",
        "--name",
        "Удаление без повтора",
        "--slug",
        "lost",
        "--prefix",
        "LOST",
        "--description",
        "Изолированный каскад",
      ]),
    ).data;
    successful(await app.run(["task", "create", "--board", "lost", "--title", "Удалить с доской"]));
    const server = await httpServer(t, app.root);
    const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    let mode: "503" | "lost" = "503";
    const proxy = await httpProxy(t, async (request, response, signal) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: request.method!,
        url: request.url!,
        ...(body ? { body: JSON.parse(body) } : {}),
      });
      const deletion = request.method === "POST" && request.url!.endsWith("/entities/delete");
      if (deletion && mode === "503") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error: { code: "SERVER_UNAVAILABLE", message: "Ответ записи неизвестен" },
          }),
        );
        return;
      }
      const upstream = await fetch(`${server.url}${request.url}`, {
        signal,
        method: request.method!,
        ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
      });
      const text = await upstream.text();
      if (deletion) {
        assert.equal(upstream.status, 200, text);
        assert.equal(JSON.parse(text).data.deleted, 3);
        // Server завершил запись. Клиент не получает квитанцию и не должен посылать POST снова.
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(text);
    });
    const preview = successful(
      await invoke<EntityDeletionPreview>(app.root, [
        "--server-url",
        proxy.url,
        "application",
        "delete-preview",
        target.key,
      ]),
    ).data;
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "GET"],
    );
    requests.length = 0;
    const humanFailure = await invokeRaw(app.root, [
      "--server-url",
      proxy.url,
      "application",
      "delete",
      target.key,
      "--if-version",
      preview.version,
      "--request-id",
      "human-failure",
    ]);
    assert.equal(humanFailure.code, 5, humanFailure.stdout);
    assert.equal(humanFailure.stderr, "");
    assert.match(humanFailure.stdout.replace(/\s+/g, " "), /не повторяйте POST вслепую/);
    assert.match(humanFailure.stdout, /application list/);
    assert.match(humanFailure.stdout, /board list/);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "POST"],
    );
    successful(await app.run(["application", "get", target.key]));
    for (const failure of ["503", "lost"] as const) {
      mode = failure;
      requests.length = 0;
      const result = await invoke(
        app.root,
        [
          "--server-url",
          proxy.url,
          "application",
          "delete",
          target.key,
          "--if-version",
          preview.version,
          "--request-id",
          `correlation-${failure}`,
        ],
        { env: { RELAY_ACTOR: "deletion-env-author" } },
      );
      failed(result, "SERVER_UNAVAILABLE", 5);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["GET", "POST"],
        JSON.stringify(requests),
      );
      assert.deepEqual(requests[1]!.body, {
        kind: "application",
        ref: target.key,
        ifVersion: preview.version,
        actor: "deletion-env-author",
        requestId: `correlation-${failure}`,
      });
      if (failure === "503") successful(await app.run(["application", "get", target.key]));
      else {
        failed(await app.run(["application", "get", target.key]), "ENTITY_NOT_FOUND", 3);
        failed(await app.run(["board", "get", "BOARD-LOST"]), "ENTITY_NOT_FOUND", 3);
        failed(await app.run(["task", "get", "LOST-1"]), "NOT_FOUND", 3);
        const remaining = successful(
          await invoke<{ total: number }>(app.root, ["--server-url", proxy.url, "board", "list"]),
        );
        assert.equal(remaining.data.total, 2);
      }
    }
    const readback = await invokeRaw(app.root, ["--server-url", proxy.url, "application", "list"]);
    assert.equal(readback.code, 0, readback.stdout + readback.stderr);
    assert.equal(readback.stderr, "");
    assert.match(readback.stdout, /Показано: 0/);
  },
);

test("CLI fixtures: обратный порядок cleanup и сохранение всех ошибок", async (t) => {
  const { scope, hooks, cleanup } = cleanupScope(t);
  const order: string[] = [];
  const first = new Error("Ошибка закрытия прокси");
  const second = new Error("Ошибка закрытия Server");
  fixtureCleanup(scope, () => {
    order.push("directory");
  });
  fixtureCleanup(scope, async () => {
    order.push("server");
    throw second;
  });
  fixtureCleanup(scope, () => {
    order.push("proxy");
    throw first;
  });
  assert.equal(hooks.length, 1, "Node прекращает цепочку отдельных after после первой ошибки");
  await assert.rejects(cleanup(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
  assert.deepEqual(order, ["proxy", "server", "directory"]);
});

test("HTTP fixtures: ошибка прокси не оставляет Server и каталог открытыми", async (t) => {
  const { scope, hooks, cleanup } = cleanupScope(t);
  const app = await fixture(scope);
  let serverUrl = "";
  let proxyUrl = "";
  fixtureCleanup(scope, async () => {
    await access(app.root);
    for (const url of [proxyUrl, serverUrl]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2_000) }), /fetch failed/);
    }
  });
  serverUrl = (await httpServer(scope, app.root)).url;
  const failure = new Error("Контрольная ошибка обработчика HTTP fixture");
  proxyUrl = (
    await httpProxy(scope, async () => {
      throw failure;
    })
  ).url;
  await assert.rejects(fetch(proxyUrl), /fetch failed/);
  assert.equal(hooks.length, 1);
  await assert.rejects(cleanup(), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.actual, [failure]);
    return true;
  });
  await assert.rejects(access(app.root), { code: "ENOENT" });
});

test("HTTP fixtures: teardown отменяет upstream и дожидается обработчиков", async (t) => {
  const { scope, cleanup } = cleanupScope(t);
  const deadline = AbortSignal.timeout(5_000);
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  let upstreamDrained = false;
  let proxyDrained = false;
  const upstream = await httpProxy(scope, async (_request, _response, signal) => {
    received();
    const cancelled = AbortSignal.any([signal, deadline]);
    if (!cancelled.aborted) {
      await new Promise<void>((resolve) =>
        cancelled.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    assert.equal(signal.aborted, true, "Обработчик должен завершиться по отмене teardown");
    upstreamDrained = true;
  });
  const proxy = await httpProxy(scope, async (_request, _response, signal) => {
    try {
      await fetch(upstream.url, { signal: AbortSignal.any([signal, deadline]) });
      assert.fail("Upstream не должен вернуть ответ до отмены");
    } finally {
      proxyDrained = true;
    }
  });
  const controller = new AbortController();
  const client = fetch(proxy.url, {
    signal: AbortSignal.any([controller.signal, deadline]),
  }).catch((error: unknown) => error);
  fixtureCleanup(scope, async () => {
    controller.abort();
    await client;
  });
  await Promise.race([
    started,
    client.then(() => assert.fail("Клиент завершился до получения запроса upstream")),
  ]);
  await cleanup();
  assert.equal(await client, controller.signal.reason);
  assert.equal(proxyDrained, true);
  assert.equal(upstreamDrained, true);
});

for (const manual of ["startServer", "mkdtemp"] as const) {
  test(`HTTP fixtures: ${manual} и общий helper закрывают Server до удаления корня`, async (t) => {
    const { scope, hooks, cleanup } = cleanupScope(t);
    let root: string;
    if (manual === "mkdtemp") {
      root = await mkdtemp(join(tmpdir(), "relay-cli-lifecycle-"));
      fixtureCleanup(scope, () => rm(root, { recursive: true, force: true }));
      successful(await invoke(root, ["init"]));
    } else root = (await fixture(scope)).root;

    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let checked = false;
    fixtureCleanup(scope, async () => {
      if (!server) return;
      await access(root);
      assert.equal(server.app.getHttpServer().listening, false);
      checked = true;
    });
    try {
      if (manual === "startServer") {
        server = await startServer({ cwd: root, actor: "test-agent", port: 0 });
        const owned = server;
        fixtureCleanup(scope, () => owned.close());
      } else server = await httpServer(scope, root);
      assert.equal(server.app.getHttpServer().listening, true);
      assert.equal(hooks.length, 1, "Ручные ресурсы и helpers используют один cleanup");
      await cleanup();
      assert.equal(checked, true, "После закрытия Server корень ещё существует");
      await assert.rejects(access(root), { code: "ENOENT" });
    } finally {
      // Регрессия порядка не должна сама оставлять слушатель и скрывать стек ошибки.
      if (server?.app.getHttpServer().listening) await server.close();
      await cleanup();
    }
  });
}

function cleanupScope(t: TestContext) {
  const hooks: NonNullable<Parameters<TestContext["after"]>[0]>[] = [];
  const scope: FixtureContext = { after: (hook) => hooks.push(hook!) };
  // Если проверка оборвётся раньше, реальные ресурсы всё равно принадлежат этому тесту.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const hook of hooks) await hook(t, assert.fail);
  };
  t.after(cleanup);
  return { scope, hooks, cleanup };
}
