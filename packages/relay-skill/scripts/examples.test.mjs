import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { startMcp } from "../../../apps/mcp/src/server.ts";
import { repoRoot } from "./lib.mjs";

const DATA = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) });
const IDS = z.object({
  task: z.object({ id: z.string() }),
});
const OBSERVED = {
  sessionId: "fixture-session",
  worktree: "/example/code",
  branch: "example-branch",
  baseCommit: "fixture-base",
  commit: "fixture-verified",
  passed: true,
  command: "условная проверка внешней работы",
  environment: "test",
  details: "Фикстура результатов: тестируется протокол Relay",
  evidence: "Учебный результат, без реальной выкладки",
  result: "Внешняя работа представлена фикстурой",
  limitations: "Тест проверяет только документированный обмен с Relay",
  integrated: true,
  acceptance: "Учебное основание приёмки",
  version: "1.0-demo",
  rollback: "Учебная процедура",
  deployed: true,
  targetEnvironment: "example",
  deploymentEvidence: "Условное подтверждение установки",
  nextStep: "Продолжить учебный сценарий",
};

for (const passed of [true, false])
  test(`пример из собранного скилла выполняется через MCP: проверка ${passed ? "успешна" : "неуспешна"}`, async (t) => {
    const artifacts = join(repoRoot, ".artifacts");
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(join(artifacts, "skill-example-"));
    const cleanup = [];
    t.after(async () => {
      try {
        for (const close of cleanup.reverse()) await close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    await initialize(join(root, "app"), "tasks");
    const registry = await initializeRegistry(root);
    await registerProject(registry.configPath, "demo", { path: "app" });
    const api = await startServer({
      cwd: root,
      config: registry.configPath,
      actor: "test",
      port: 0,
    });
    cleanup.push(() => api.close());
    const mcp = await startMcp({ cwd: root, serverUrl: api.url, port: 0 });
    cleanup.push(() => mcp.close());
    const client = new Client({ name: "skill-example", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    cleanup.push(() => client.close());
    const relay = async (name, input) => {
      const response = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: input }),
      );
      assert.notEqual(
        response.isError,
        true,
        `${name}: ${JSON.stringify(response.structuredContent)}`,
      );
      return DATA.parse(response.structuredContent).data;
    };
    const markdown = await readFile(join(repoRoot, "skills/relay/references/EXAMPLES.md"), "utf8");
    const code = /```javascript\n(\/\/ relay-example: kanban[\s\S]*?)\n```/.exec(markdown)?.[1];
    assert(code, "В собранном руководстве отсутствует проверяемый сценарий");
    // Выполняется ровно опубликованный алгоритм; внешняя работа и установка представлены фикстурой.
    const execute = new Function(
      "relay",
      "project",
      "key",
      "observed",
      `return (async () => {${code}\n})();`,
    );
    const result = IDS.parse(await execute(relay, "demo", "example-1", { ...OBSERVED, passed }));
    const task = await relay("board_task_get", { project: "demo", reference: result.task.id });
    assert.equal(task.column, passed ? "review" : "in-progress");
    assert.equal(task.revision, 3);
    assert.ok(task.description.includes(OBSERVED.result));
    assert.ok(task.description.includes(OBSERVED.nextStep));
  });
