import assert from "node:assert/strict";
import { ProductQueries } from "@relay/core/application/product/queries";
import { GraphService } from "@relay/core/application/graph/service";
import { test } from "node:test";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEvent } from "@relay/contracts";
import { fixture } from "./helpers/server.js";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { ProductService } from "@relay/core/application/product/service";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";

test("SSE замечает прямую запись имени и slug через Core", { timeout: 10000 }, async (t) => {
  const { app, workspace } = await fixture(t);
  await app.listen(0, "127.0.0.1");
  const stream = await connect(await app.getUrl());
  try {
    await stream.next();
    await saveProjectSettings(workspace, {
      name: "Обновлённый проект",
      slug: "sse-project",
      ifRevision: 1,
    });
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    const context = (await app.inject("/api/v1/projects/sse-project/context")).json().data;
    assert.equal(context.project, "Обновлённый проект");
    assert.equal(context.projectId, workspace.config.projectId);
  } finally {
    await stream.close();
  }
});

test(
  "SSE замечает локальную публикацию без изменения ревизии карточки",
  { timeout: 10000 },
  async (t) => {
    const { app, tasks, root } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    try {
      await stream.next();
      const task = await tasks.create({ board: "product", requestId: "task" }, "worker");
      await stream.next((event) => event.type === "changed" && event.data.source === "storage");
      const before = await tasks.get(task.id);
      await tasks.publishComment(task.id, {
        title: "Локальный отчёт",
        description: "Проверено",
        actor: "worker",
        actorRole: "worker",
        requestId: "local-report",
      });
      await stream.next((event) => event.type === "changed" && event.data.source === "storage");
      assert.deepEqual(await tasks.get(task.id), before);
      await assert.rejects(access(join(root, ".relay/history")), { code: "ENOENT" });
      assert.equal(
        (await app.inject(`/api/v1/board-tasks/${task.id}/comments`)).json().data.items[0].title,
        "Локальный отчёт",
      );
    } finally {
      await stream.close();
    }
  },
);

test(
  "SSE замечает новые отношения после прямой записи через Core",
  { timeout: 10000 },
  async (t) => {
    const { app, workspace } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    try {
      await stream.next();
      const service = new GraphService(workspace);
      const graph = await service.read();
      await service.mutate(
        {
          ifVersion: graph.version,
          requestId: "sse-graph",
          operations: [
            {
              action: "add",
              type: "references",
              from: graph.nodes[0]!.ref,
              to: graph.nodes[1]!.ref,
            },
          ],
        },
        "cli-agent",
      );
      await stream.next((event) => event.type === "changed" && event.data.source === "storage");
      assert.equal(
        (await app.inject("/api/v1/graph")).json().data.totalEdges,
        graph.totalEdges + 1,
      );
    } finally {
      await stream.close();
    }
  },
);

async function connect(url: string, project?: string) {
  const controller = new AbortController();
  const path =
    project === undefined
      ? "/api/v1/events"
      : `/api/v1/projects/${encodeURIComponent(project)}/events`;
  const response = await fetch(`${url}${path}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(
      predicate: (event: ServerEvent) => boolean = () => true,
      timeout = 5000,
    ): Promise<ServerEvent> {
      const timer = setTimeout(
        () => controller.abort(new Error("SSE: событие не получено")),
        timeout,
      );
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = frame.split("\n");
            const type = lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!type || !data) continue;
            const event = { type, data: JSON.parse(data) } as ServerEvent;
            if (predicate(event)) return event;
          } else {
            const chunk = await reader.read();
            assert.equal(chunk.done, false, "SSE завершился до события");
            buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(
              /\r\n/g,
              "\n",
            );
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async end() {
      const timer = setTimeout(() => controller.abort(new Error("SSE не завершился")), 5000);
      try {
        while (!(await reader.read()).done) {
          /* Дочитываем уведомления перед shutdown. */
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

test(
  "SSE доставляет изменения API и атомарные записи через Core",
  { timeout: 15000 },
  async (t) => {
    const { app, tasks } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    t.after(() => stream.close());
    const connected = await stream.next();
    assert.equal(connected.type, "connected");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/board-tasks",
      payload: { board: "product", title: "API", requestId: "api-task" },
    });
    const api = await stream.next(
      (event) => event.type === "changed" && event.data.source === "api",
    );
    assert.equal(api.type, "changed");
    assert.equal(created.statusCode, 200);
    const external = await tasks.create(
      { board: "product", title: "CLI", requestId: "cli-task" },
      "cli",
    );
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    assert.equal((await app.inject(`/api/v1/board-tasks/${external.id}`)).json().data.title, "CLI");
  },
);

test("SSE замечает продуктовые записи, созданные через local Core", async (t) => {
  const { app, workspace } = await fixture(t);
  await app.listen(0, "127.0.0.1");
  const stream = await connect(await app.getUrl());
  t.after(() => stream.close());
  await stream.next((event) => event.type === "connected");
  await new ProductService(workspace).mutate(
    {
      action: "create",
      requestId: "passport",
      fields: {
        kind: "passport",
        name: "Новый продукт",
        summary: "Назначение",
        description: "Описание",
      },
    },
    "cli",
  );
  const changed = await stream.next(
    (event) => event.type === "changed" && event.data.source === "storage",
  );
  assert.equal(changed.type, "changed");
  assert.equal(
    (await app.inject("/api/v1/product/records?id=passport")).json().data.items[0].fields.name,
    "Новый продукт",
  );
});

test("SSE замечает обновление Markdown в подкаталоге features", async (t) => {
  const { app, workspace } = await fixture(t);
  const service = new ProductService(workspace);
  const fields = {
    kind: "feature" as const,
    name: "Каталог",
    summary: "Поиск",
    description: "## Цель\n\nНайти вещь.",
  };
  const created = await service.mutate(
    { action: "create", requestId: "nested-create", fields },
    "cli",
  );
  await app.listen(0, "127.0.0.1");
  const stream = await connect(await app.getUrl());
  t.after(() => stream.close());
  await stream.next((event) => event.type === "connected");
  const description = "## Цель\n\nНайти доступную вещь.\n";
  await service.mutate(
    {
      action: "update",
      id: created.id,
      ifRevision: created.revision,
      requestId: "nested-update",
      fields: { ...fields, description },
    },
    "cli",
  );
  await stream.next((event) => event.type === "changed" && event.data.source === "storage");
  const response = (await app.inject(`/api/v1/product/records?id=${created.id}`)).json();
  assert.equal(response.data.items[0].fields.description, description);
  assert.equal(response.data.items[0].revision, 2);
});

test("SSE замечает независимую реализацию во вложенном каталоге приложения", async (t) => {
  const { app, workspace } = await fixture(t);
  const service = new ProductQueries(workspace);
  const feature = await service.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "Требования" },
    },
    "cli",
  );
  const application = await service.mutate(
    {
      action: "create",
      requestId: "app",
      fields: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        summary: "",
        description: "Интерфейс",
        type: "frontend",
      },
    },
    "cli",
  );
  await service.mutate(
    {
      action: "create",
      requestId: "scope",
      ifVersion: (await service.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: feature.id,
            scenarioId: null,
            title: "Вклад",
            description: "Описание",
            status: "none",
          },
        ],
      },
    },
    "cli",
  );
  const implementation = await service.entity("WEB-FI-1");
  await app.listen(0, "127.0.0.1");
  const stream = await connect(await app.getUrl());
  t.after(() => stream.close());
  await stream.next((event) => event.type === "connected");
  await service.updateImplementation(
    {
      ref: implementation.id,
      ifRevision: implementation.revision,
      description: "## Новый вклад\n\nПроверка nested SSE.",
      requestId: "nested",
    },
    "cli",
  );
  await stream.next((event) => event.type === "changed" && event.data.source === "storage");
  const response = await app.inject("/api/v1/product/entity?ref=WEB-FI-1");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.revision, implementation.revision + 1);
});

test(
  "workspace изолирует SSE проектов и освобождает удалённую регистрацию",
  { timeout: 15000 },
  async (t) => {
    const { root, tasks } = await fixture(t);
    await tasks.create({ board: "product", title: "Исходная А", requestId: "first" }, "test");
    await initialize(join(root, "b"), "tasks");
    const registry = await initializeRegistry(root);
    await registerProject(registry.configPath, "a", { path: "." });
    await registerProject(registry.configPath, "b", { path: "b" });
    const server = await startServer({ cwd: root, actor: "test", port: 0 });
    const a = await connect(server.url, "a");
    const b = await connect(server.url, "b");
    try {
      const first = await a.next();
      const second = await b.next();
      assert.equal(first.type, "connected");
      assert.equal(second.type, "connected");
      assert.notDeepEqual(first.data, second.data);
      const createdA = await server.app.inject({
        method: "POST",
        url: "/api/v1/projects/a/board-tasks",
        payload: { board: "product", title: "Вторая А", requestId: "second" },
      });
      assert.equal(createdA.statusCode, 200, createdA.body);
      const eventA = await a.next(
        (event) => event.type === "changed" && event.data.source === "api",
      );
      assert.equal(eventA.type, "changed");
      const createdB = await server.app.inject({
        method: "POST",
        url: "/api/v1/projects/b/board-tasks",
        payload: { board: "product", title: "Первая Б", requestId: "first" },
      });
      assert.equal(createdB.statusCode, 200, createdB.body);
      const eventB = await b.next(
        (event) => event.type === "changed" && event.data.source === "api",
      );
      assert.equal(eventB.type, "changed");
      assert.equal(
        (await server.app.inject({ method: "DELETE", url: "/api/v1/projects/b" })).statusCode,
        200,
      );
      await b.end();
      assert.equal(
        (await server.app.inject(`/api/v1/projects/b/board-tasks/${createdB.json().data.id}`))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await server.app.inject(`/api/v1/projects/a/board-tasks/${createdA.json().data.id}`)
        ).json().data.title,
        "Вторая А",
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
      await server.close();
    }
  },
);

test(
  "SSE замечает замену конфига, сообщает ошибку и восстанавливается",
  { timeout: 15000 },
  async (t) => {
    const { app, workspace, root } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    t.after(() => stream.close());
    await stream.next();
    const config = structuredClone(workspace.config);
    config.statuses.todo!.color = "green";
    const temporary = join(root, "config.tmp");
    await writeFile(temporary, JSON.stringify(config));
    await rename(temporary, workspace.configPath);
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    assert.equal(
      (await app.inject("/api/v1/context")).json().data.config.statuses.todo.color,
      "green",
    );
    await writeFile(temporary, "{");
    await rename(temporary, workspace.configPath);
    const failure = await stream.next((event) => event.type === "workspace-error");
    if (failure.type === "workspace-error") assert.equal(failure.data.code, "INVALID_DATA");
    assert.equal((await app.inject("/api/v1/context")).statusCode, 500);
    const reconnect = await connect(await app.getUrl());
    try {
      assert.equal((await reconnect.next()).type, "connected");
      assert.equal((await reconnect.next()).type, "workspace-error");
    } finally {
      await reconnect.close();
    }
    await writeFile(temporary, JSON.stringify(config));
    await rename(temporary, workspace.configPath);
    await stream.next((event) => event.type === "changed");
    assert.equal((await app.inject("/api/v1/context")).statusCode, 200);
  },
);

test(
  "наблюдение обнаруживает внешнюю замену ID-каталога и восстанавливается после reindex",
  { timeout: 15000 },
  async (t) => {
    const { app, tasks, workspace, root } = await fixture(t);
    const task = await tasks.create(
      { board: "product", title: "Исходная", requestId: "original" },
      "cli",
    );
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    t.after(() => stream.close());
    await stream.next();
    const tasksRoot = join(root, ".relay/entities/tasks");
    const taskPath = join(tasksRoot, `${task.id}.json`);
    const original = JSON.parse(await readFile(taskPath, "utf8"));
    await rename(tasksRoot, join(root, "old-storage"));
    await mkdir(tasksRoot, { recursive: true });
    await writeFile(
      taskPath,
      JSON.stringify({ ...original, data: { ...original.data, title: "External, same revision" } }),
    );
    const stale = await stream.next((event) => event.type === "workspace-error");
    if (stale.type === "workspace-error") assert.equal(stale.data.code, "STORAGE_INDEX_STALE");
    await new GraphService(workspace).reindex();
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    assert.equal(
      (await app.inject(`/api/v1/board-tasks/${task.id}`)).json().data.title,
      "External, same revision",
    );
    await tasks.update(
      task.id,
      { title: "После замены", ifRevision: 1, requestId: "update" },
      "cli",
    );
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    await writeFile(
      workspace.configPath,
      JSON.stringify({ ...workspace.config, storageDir: ".other-tasks" }),
    );
    const context = (await app.inject("/api/v1/context")).json().data;
    assert.equal(context.storagePath, join(root, ".relay"));
    await stream.next((event) => event.type === "changed" && event.data.source === "storage");
    assert.equal((await app.inject("/api/v1/board-tasks")).json().data.total, 1);
  },
);

test(
  "SSE поддерживает соединение heartbeat при отсутствии изменений задач",
  { timeout: 25000 },
  async (t) => {
    const { app } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const stream = await connect(await app.getUrl());
    t.after(() => stream.close());
    assert.equal((await stream.next()).type, "connected");
    const heartbeat = await stream.next(() => true, 20_000);
    assert.equal(heartbeat.type, "heartbeat");
    if (heartbeat.type === "heartbeat")
      assert(Number.isFinite(Date.parse(heartbeat.data.timestamp)));
    await app.inject({
      method: "POST",
      url: "/api/v1/board-tasks",
      payload: { board: "product", title: "После простоя", requestId: "after-heartbeat" },
    });
    assert.equal((await stream.next()).type, "changed");
  },
);

test(
  "отключение клиента освобождает подписку, shutdown завершает активные SSE",
  { timeout: 15000 },
  async (t) => {
    const { app } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const first = await connect(await app.getUrl());
    const second = await connect(await app.getUrl());
    t.after(async () => {
      await first.close();
      await second.close();
    });
    await first.next();
    await second.next();
    await first.close();
    await app.inject({
      method: "POST",
      url: "/api/v1/board-tasks",
      payload: { board: "product", title: "Активный клиент", requestId: "active" },
    });
    await second.next((event) => event.type === "changed" && event.data.source === "api");
    await Promise.all([app.close(), second.end()]);
  },
);
