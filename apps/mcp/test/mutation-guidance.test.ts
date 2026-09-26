import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Backend } from "@relay/project-runtime/backend/types";
import { Projects } from "../src/projects.js";
import { createTools } from "../src/tools.js";

test("MCP: discovery не обещает дедупликацию; потеря ответа не повторяет мутацию", async (t) => {
  const projects = new Projects("http://127.0.0.1:1");
  let writes = 0;
  const backend = {
    workspace: {
      root: "/project",
      configPath: "/project/config.json",
      config: { output: { maxBytes: 16384 } },
    },
    boardTasks: {
      async create() {
        writes += 1;
        throw new Error("Ответ потерян после записи");
      },
    },
  } as unknown as Backend;
  const withBackend: Projects["withBackend"] = async (_project, action) =>
    action(backend, { project: "local", serverUrl: projects.url });
  t.mock.method(projects, "withBackend", withBackend);
  const server = createTools(projects);
  const client = new Client({ name: "проверка-семантики", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await projects.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.match(client.getInstructions() ?? "", /После потери ответа прочитайте текущее состояние/);
  const { tools } = await client.listTools();
  assert(!tools.some((tool) => /history|audit|receipt/i.test(tool.name)));
  for (const name of ["task_comment_publish", "task_comments_list", "task_comment_get"])
    assert(tools.some((tool) => tool.name === name));
  for (const tool of tools) {
    assert.equal(tool.annotations?.idempotentHint, tool.annotations?.readOnlyHint);
    if (!tool.annotations?.readOnlyHint)
      assert.match(tool.description ?? "", /не повторяйте запись вслепую/);
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.properties && typeof node.properties === "object")
        for (const [name, field] of Object.entries(node.properties)) {
          const description = (field as { description?: string }).description ?? "";
          assert.match(description, /[А-Яа-яЁё]/, `${tool.name}.${name}`);
          if (name === "requestId") assert.match(description, /не ключ дедупликации/);
        }
      Object.values(node).forEach(inspect);
    };
    inspect(tool.inputSchema);
  }
  for (const name of ["entity_history", "task_history_list", "task_history_get"])
    await assert.rejects(client.callTool({ name, arguments: {} }), { code: -32602 });
  const result = await client.callTool({
    name: "board_task_create",
    arguments: { board: "product", title: "Запись", actor: "agent", requestId: "correlation" },
  });
  assert.equal(result.isError, true);
  assert.equal(writes, 1);
});
