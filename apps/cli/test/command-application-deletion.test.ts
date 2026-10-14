import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityDeletionPreview, EntitySaved } from "@relay/contracts/entities";
import { fixture, invoke, invokeRaw, successful, failed } from "./helpers/cli.js";
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
    const proxy = await httpProxy(t, async (request, response) => {
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
