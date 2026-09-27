import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "@relay/core/storage/workspace";
import { startServer } from "@relay/server-runtime";

test(
  "stdio: EOF завершает процесс без принудительного убийства клиентом",
  { timeout: 10000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=tasks-source",
        "--import",
        "tsx",
        resolve("src/main.ts"),
        "--transport",
        "stdio",
        "--server-url",
        "http://127.0.0.1:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const exited = once(child, "exit");
    child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  },
);

test(
  "stdio: клиент запускает процесс, читает проект и закрывает его; API не запускается MCP",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relay-stdio-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await initialize(root, "tasks");
    const api = await startServer({ cwd: root, actor: "test", port: 0 });
    t.after(() => api.close());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--conditions=tasks-source",
        "--import",
        "tsx",
        resolve("src/main.ts"),
        "--transport",
        "stdio",
        "--server-url",
        api.url,
      ],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    t.after(() => client.close());
    await client.connect(transport);
    assert((await client.listTools()).tools.some((tool) => tool.name === "projects_list"));
    const result = await client.callTool({ name: "boards_list", arguments: {} });
    assert.notEqual(result.isError, true);
    await api.close();
    const failure = await client.callTool({ name: "projects_list", arguments: {} });
    assert.equal(failure.isError, true);
    assert((await client.listTools()).tools.length > 0);
    await client.close();
  },
);

test(
  "stdio: discovery без доступного API, stdout остаётся протоколом даже с --format json",
  { timeout: 30000 },
  async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--conditions=tasks-source",
        "--import",
        "tsx",
        resolve("src/main.ts"),
        "--transport",
        "stdio",
        "--format",
        "json",
        "--server-url",
        "http://127.0.0.1:1",
      ],
      stderr: "pipe",
    });
    const client = new Client({ name: "offline-test", version: "1" });
    t.after(() => client.close());
    await client.connect(transport);
    assert((await client.listTools()).tools.length > 0);
    assert.equal((await client.callTool({ name: "projects_list", arguments: {} })).isError, true);
  },
);
