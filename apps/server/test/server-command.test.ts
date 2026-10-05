import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "../../cli/test/helpers/cli.js";
import { checkServerSurface, startServerProcess } from "../../cli/test/helpers/server-process.mjs";
import type { ApiSuccess, ContextResponse } from "@relay/contracts";
import { startServer } from "@relay/server-runtime";
import { defaultConfig } from "@relay/core/domain/config";

const binary = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("server раздаёт React-статику, API и Swagger из чужого каталога с общими данными CLI", async (t) => {
  const app = await fixture(t);
  const server = await startServerProcess(
    [binary, "--actor", "web-human", "--port", "0", "--format", "json"],
    app.root,
  );
  t.after(() => server.close());
  await checkServerSurface(server.url, { web: true });
  const context = (await (
    await fetch(`${server.url}/api/v1/context`)
  ).json()) as ApiSuccess<ContextResponse>;
  assert.equal(context.data.actor, "web-human");
  assert.equal(context.data.configPath, join(app.root, ".relay/config.json"));
  assert.equal(context.data.storagePath, join(app.root, ".relay"));
  const created = await fetch(`${server.url}/api/v1/board-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board: "product", title: "Создана через HTTP", requestId: "http-task" }),
  });
  assert.equal(created.status, 200);
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  const changed = await app.run([
    "task",
    "move",
    id,
    "--column",
    "review",
    "--if-revision",
    1,
    "--actor",
    "cli-human",
  ]);
  assert.equal(changed.code, 0);
  const task = (await (await fetch(`${server.url}/api/v1/board-tasks/${id}`)).json()) as {
    data: { column: string; updatedBy: string; revision: number };
  };
  assert.equal(task.data.column, "review");
  assert.equal(task.data.updatedBy, "cli-human");
  assert.equal(task.data.revision, 2);
  const second = await app.create("Вторая", ["--column", "review"]);
  const move = await fetch(`${server.url}/api/v1/board-tasks/${second}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column: "review", beforeId: id, ifRevision: 1, requestId: "move" }),
  });
  assert.equal(move.status, 200);
  const order = await app.run<{ items: { id: string }[] }>([
    "task",
    "list",
    "--board",
    "product",
    "--column",
    "review",
  ]);
  assert(order.body.ok);
  assert.deepEqual(
    order.body.data.items.map((item) => item.id),
    [second, id],
  );
  const forbidden = await fetch(`${server.url}/api/v1/context`, {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(((await forbidden.json()) as { ok: boolean }).ok, false);
  await server.close();
});

test("порт сервера: --port → RELAY_PORT → server.port из выбранного конфига", async (t) => {
  const app = await fixture(t);
  const occupied = createTcpServer();
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  assert(address && typeof address === "object");
  const config = join(app.root, "server.config.json");
  const nested = join(app.root, "nested");
  await mkdir(nested);

  for (const source of ["config", "environment", "argument"] as const) {
    await t.test(source, async () => {
      await writeFile(
        config,
        JSON.stringify({
          ...defaultConfig,
          server: { port: source === "config" ? 0 : address.port },
        }),
      );
      const server = await startServerProcess(
        [
          binary,
          "--actor",
          "port-check",
          "--config",
          "../server.config.json",
          "--format",
          "json",
          ...(source === "argument" ? ["--port", "0"] : []),
        ],
        nested,
        {
          RELAY_PORT: source === "config" ? undefined : source === "environment" ? "0" : "invalid",
          RELAY_CONFIG: undefined,
        },
      );
      try {
        assert.notEqual(Number(new URL(server.url).port), 4700);
        assert.notEqual(Number(new URL(server.url).port), address.port);
        const context = await (await fetch(`${server.url}/api/v1/context`)).json();
        assert.equal(context.data.configPath, config);
        assert.equal((await fetch(server.url)).status, 200);
      } finally {
        await server.close();
      }
    });
  }
});

test("ошибочный RELAY_PORT не заменяется портом из конфига", async (t) => {
  const app = await fixture(t);
  await writeFile(
    join(app.root, ".relay/config.json"),
    JSON.stringify({ ...defaultConfig, server: { port: 0 } }),
  );
  for (const port of ["", "invalid", "-1", "65536", "3000.5"]) {
    await assert.rejects(
      startServerProcess([binary, "--actor", "port-check", "--format", "json"], app.root, {
        RELAY_PORT: port,
        RELAY_CONFIG: undefined,
      }),
      /VALIDATION_ERROR/,
    );
  }
});

test("API-only runtime retains JSON 404 responses without web assets", async (t) => {
  const app = await fixture(t);
  const server = await startServer({ cwd: app.root, actor: "api-human", port: 0, webRoot: false });
  t.after(() => server.close());
  await checkServerSurface(server.url, { web: false });
});

test(
  "--open и оба формата вывода используют фактический порт после конфликта",
  {
    skip: process.platform !== "linux" && process.platform !== "darwin",
  },
  async (t) => {
    const app = await fixture(t);
    const occupied = createTcpServer();
    t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    assert(address && typeof address === "object");
    const bin = join(app.root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, process.platform === "darwin" ? "open" : "xdg-open"),
      '#!/bin/sh\nprintf "%s" "$1" > "$RELAY_TEST_OPEN_URL"\n',
      { mode: 0o755 },
    );
    for (const format of ["text", "json"]) {
      const opened = join(app.root, `opened-${format}`);
      const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
        process.execPath,
        [binary, "--port", String(address.port), "--open", "--format", format],
        {
          cwd: app.root,
          env: {
            ...process.env,
            RELAY_CONFIG: join(app.root, ".relay/config.json"),
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RELAY_TEST_OPEN_URL: opened,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exited = once(child, "exit");
      try {
        let url = "";
        const deadline = Date.now() + 15_000;
        while (!url && Date.now() < deadline) {
          assert.equal(child.exitCode, null, stderr);
          try {
            url = await readFile(opened, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!url || !stdout.includes("\n")) {
            url = "";
            await delay(25);
          }
        }
        assert(url, `Браузер не получил URL: ${stdout}\n${stderr}`);
        assert(Number(new URL(url).port) > address.port);
        if (format === "json") {
          assert.deepEqual(JSON.parse(stdout), { ok: true, data: { url, pid: child.pid } });
        } else {
          assert.equal(stdout, `Relay: ${url}\nSwagger: ${url}/api/docs\n`);
        }
        assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
      } finally {
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try {
          const [code, signal] = await exited;
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  },
);
