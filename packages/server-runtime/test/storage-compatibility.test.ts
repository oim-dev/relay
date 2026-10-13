import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ServerEvent } from "@relay/contracts";
import { initialize } from "@relay/core/storage/workspace";
import { PlanningService } from "@relay/core/application/planning/service";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { createServerApi } from "@relay/project-runtime/backend/server";
import { startServer } from "@relay/server-runtime";

/**
 * Временные базы формата 4, требующие явного обслуживания. Server не мигрирует их,
 * не выполняет recovery/reindex, не показывает пустой проект и сообщает код Core.
 */

async function temporaryRoot(t: TestContext, prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function entityFile(root: string, id: string) {
  const entities = join(root, ".relay/entities");
  for (const collection of await readdir(entities)) {
    const files = await readdir(join(entities, collection));
    if (files.includes(`${id}.json`)) return join(entities, collection, `${id}.json`);
  }
  throw new Error(`Запись ${id} не найдена`);
}

async function rewrite(path: string, change: (value: Record<string, unknown>) => void) {
  const original = await readFile(path);
  const value = JSON.parse(original.toString("utf8"));
  change(value);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
  return () => writeFile(path, original);
}

/** Проект, план которого записан прежней версией данных владельца (dataVersion 1 вместо 2). */
async function stalePlanProject(directory: string) {
  const workspace = await initialize(directory, "tasks");
  const plan = await new PlanningService(workspace).create(
    { title: "Исторический план", goal: "Цель", requestId: "plan" },
    "author",
  );
  const restore = await rewrite(await entityFile(directory, plan.id), (record) => {
    record.dataVersion = 1;
  });
  return { workspace, plan, restore };
}

/**
 * Запись настроек проекта другой версии данных при потерянном снимке индексов:
 * открытие проекта (чтение конфигурации) само сообщает несовместимость.
 */
async function blockedProject(directory: string) {
  const workspace = await initialize(directory, "tasks");
  const configDir = join(directory, ".relay");
  const record = join(configDir, "entities/projects", `${workspace.config.projectId}.json`);
  const restoreRecord = await rewrite(record, (value) => {
    value.dataVersion = 2;
  });
  const state = join(configDir, ".indexes/state.json");
  const stateBytes = await readFile(state);
  await rm(state);
  return {
    workspace,
    restore: async () => {
      await restoreRecord();
      await writeFile(state, stateBytes);
    },
  };
}

/** Конфигурация с полем вне текущей строгой схемы. */
async function oldConfigProject(directory: string) {
  const workspace = await initialize(directory, "tasks");
  await rewrite(workspace.configPath, (config) => {
    config.boards = { product: { title: "Продукт" } };
  });
  return workspace;
}

/** Снимок дерева без замков runtime: обычные запросы не меняют базу. */
async function digest(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, relative: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assert.notEqual(entry.name, "index-stale.json", `Server пометил индекс устаревшим: ${name}`);
      if (entry.isDirectory()) {
        if (entry.name !== "runtime") await walk(child, name);
      } else
        result[name] = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
    }
  }
  await walk(directory, "");
  return result;
}

/** Считает HTTP-запросы клиентов: ошибка совместимости не должна повторяться. */
function countRequests(t: TestContext) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = input instanceof Request ? input.url : String(input);
    calls.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url}`);
    return original(...args);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function failure(response: { statusCode: number; body: string; json(): unknown }) {
  return (response.json() as { error: { code: string; exitCode?: number; details?: unknown } })
    .error;
}

test(
  "workspace: несовместимые проекты остаются в реестре и сообщают код вместо 400/404",
  { timeout: 20000 },
  async (t) => {
    const root = await temporaryRoot(t, "relay-compat-workspace-");
    const current = await initialize(join(root, "current"), "tasks");
    const stale = await stalePlanProject(join(root, "stale"));
    const blocked = await blockedProject(join(root, "blocked"));
    const oldConfig = await oldConfigProject(join(root, "old-config"));
    const registry = await initializeRegistry(root);
    for (const key of ["current", "stale", "blocked", "old-config"])
      await registerProject(registry.configPath, key, { path: key });
    const before = await digest(root);
    const server = await startServer({ cwd: root, actor: "test", port: 0 });
    t.after(() => server.close());
    const app = server.app;

    const context = (await app.inject("/api/v1/server")).json().data as {
      projects: { key: string; available: boolean; error?: string }[];
    };
    const byKey = Object.fromEntries(context.projects.map((project) => [project.key, project]));
    assert.deepEqual(Object.keys(byKey).sort(), ["blocked", "current", "old-config", "stale"]);
    assert.equal(byKey.current?.available, true);
    assert.equal(byKey.stale?.available, true);
    assert.equal(byKey.blocked?.available, false);
    assert.match(byKey.blocked?.error ?? "", /^STORAGE_DATA_MIGRATION_REQUIRED: /);
    assert.equal(byKey["old-config"]?.available, false);
    assert.match(byKey["old-config"]?.error ?? "", /^INVALID_CONFIG: /);

    // Выбор по ключу и по постоянному ID не маскирует причину под VALIDATION_ERROR/PROJECT_NOT_FOUND.
    for (const selector of ["blocked", blocked.workspace.config.projectId!]) {
      const response = await app.inject(`/api/v1/projects/${selector}/context`);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(failure(response).code, "STORAGE_DATA_MIGRATION_REQUIRED");
      assert.equal(failure(response).exitCode, 4);
    }
    for (const selector of ["old-config", oldConfig.config.projectId!]) {
      const response = await app.inject(`/api/v1/projects/${selector}/board-tasks`);
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(failure(response).code, "INVALID_CONFIG");
      assert.ok(failure(response).details, "details с замечаниями схемы сохраняются");
    }
    const unknown = await app.inject("/api/v1/projects/missing/context");
    assert.equal(unknown.statusCode, 404);
    assert.equal(failure(unknown).code, "PROJECT_NOT_FOUND");

    // Старая запись плана не превращает проект в пустой: остальные данные читаются.
    for (const selector of ["stale", stale.workspace.config.projectId!]) {
      assert.equal((await app.inject(`/api/v1/projects/${selector}/context`)).statusCode, 200);
      assert.equal((await app.inject(`/api/v1/projects/${selector}/board-tasks`)).statusCode, 200);
      const plans = await app.inject(`/api/v1/projects/${selector}/plans`);
      assert.equal(plans.statusCode, 409, plans.body);
      assert.equal(failure(plans).code, "STORAGE_DATA_MIGRATION_REQUIRED");
      assert.equal(failure(plans).exitCode, 4);
    }
    assert.equal((await app.inject("/api/v1/projects/current/plans")).statusCode, 200);

    // HTTP Backend CLI/MCP: код и exit сохраняются, 409 не повторяется и не помечается как
    // неподтверждённая запись.
    const calls = countRequests(t);
    await assert.rejects(createHttpBackend(server.url, "blocked"), {
      code: "STORAGE_DATA_MIGRATION_REQUIRED",
      exitCode: 4,
    });
    assert.equal(calls.length, 1, calls.join("\n"));
    const backend = await createHttpBackend(server.url, "stale");
    calls.length = 0;
    await assert.rejects(backend.plans.list({}), {
      code: "STORAGE_DATA_MIGRATION_REQUIRED",
      exitCode: 4,
    });
    assert.equal(calls.length, 1, calls.join("\n"));
    calls.length = 0;
    await assert.rejects(
      backend.plans.update(
        stale.plan.id,
        { title: "Не записывать", ifRevision: stale.plan.revision, requestId: "update" },
        "agent",
      ),
      (error: Error & { code?: string; exitCode?: number }) => {
        assert.equal(error.code, "STORAGE_DATA_MIGRATION_REQUIRED");
        assert.equal(error.exitCode, 4);
        assert.doesNotMatch(error.message, /не подтверждён|могла завершиться/);
        return true;
      },
    );
    assert.equal(calls.length, 1, calls.join("\n"));

    // Клиент реестра сохраняет details ошибки сервера.
    await assert.rejects(
      createServerApi(server.url).projects.registerProject(
        { project: "again" },
        { path: "old-config" },
      ),
      (error: Error & { code?: string; details?: unknown }) => {
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.ok(error.details);
        return true;
      },
    );

    assert.deepEqual(await digest(root), before, "обычные запросы не изменяют базы и реестр");
    assert.equal(current.config.projectId !== undefined, true);
  },
);

test(
  "local: Server стартует на несовместимой базе без миграции и оживает после внешнего обслуживания",
  { timeout: 20000 },
  async (t) => {
    const root = await temporaryRoot(t, "relay-compat-local-");
    const blocked = await blockedProject(root);
    const before = await digest(root);
    const server = await startServer({ cwd: root, actor: "test", port: 0 });
    t.after(() => server.close());
    const app = server.app;

    const context = (await app.inject("/api/v1/server")).json().data as {
      mode: string;
      projects: { available: boolean; error?: string }[];
    };
    assert.equal(context.mode, "local");
    assert.equal(context.projects.length, 1);
    assert.equal(context.projects[0]?.available, false);
    assert.match(context.projects[0]?.error ?? "", /^STORAGE_DATA_MIGRATION_REQUIRED: /);
    for (const path of [
      "/api/v1/context",
      "/api/v1/board-tasks",
      `/api/v1/projects/${blocked.workspace.config.projectId}/context`,
    ]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 409, `${path}: ${response.body}`);
      assert.equal(failure(response).code, "STORAGE_DATA_MIGRATION_REQUIRED");
      assert.equal(failure(response).exitCode, 4);
    }

    const stream = await connect(server.url);
    t.after(() => stream.close());
    assert.equal((await stream.next()).type, "connected");
    const error = await stream.next((event) => event.type === "workspace-error");
    if (error.type === "workspace-error")
      assert.equal(error.data.code, "STORAGE_DATA_MIGRATION_REQUIRED");
    assert.deepEqual(await digest(root), before, "Server не мигрирует и не восстанавливает базу");

    // Внешнее обслуживание другим процессом: сервер подхватывает базу без перезапуска.
    await blocked.restore();
    await stream.next((event) => event.type === "changed");
    const restored = await app.inject("/api/v1/context");
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(
      (restored.json().data as { projectId: string }).projectId,
      blocked.workspace.config.projectId,
    );
    await assert.rejects(readFile(join(root, ".relay/runtime/index-stale.json")), {
      code: "ENOENT",
    });
  },
);

test(
  "профиль 1 без маркера: каталог не объявляет базу доступной, мутация и чтение дают одинаковые details",
  { timeout: 20000 },
  async (t) => {
    const root = await temporaryRoot(t, "relay-compat-profile-");
    const workspace = await initialize(join(root, "legacy-profile"), "tasks");
    const manifest = join(root, "legacy-profile/.relay/storage.json");
    await rewrite(manifest, (value) => {
      delete value.dataModelVersion;
    });
    await initialize(join(root, "current"), "tasks");
    const registry = await initializeRegistry(root);
    await registerProject(registry.configPath, "legacy-profile", { path: "legacy-profile" });
    await registerProject(registry.configPath, "current", { path: "current" });
    const before = await digest(root);
    const server = await startServer({ cwd: root, actor: "test", port: 0 });
    t.after(() => server.close());

    const projects = (await server.app.inject("/api/v1/server")).json().data.projects as {
      key: string;
      available: boolean;
      error?: string;
    }[];
    const legacy = projects.find((project) => project.key === "legacy-profile");
    assert.equal(legacy?.available, false);
    assert.match(legacy?.error ?? "", /^STORAGE_MIGRATION_REQUIRED: /);
    assert.equal(projects.find((project) => project.key === "current")?.available, true);

    const backend = await createHttpBackend(server.url, workspace.config.projectId);
    const calls = countRequests(t);
    const read = await backend.boardTasks.list({}).then(
      () => assert.fail("чтение должно отказать"),
      (error: Error & { code?: string; details?: Record<string, unknown> }) => error,
    );
    assert.equal(read.code, "STORAGE_MIGRATION_REQUIRED");
    assert.equal(typeof read.details?.next, "string");
    const write = await backend.boardTasks
      .create({ board: "product", title: "Не записывать", requestId: "write" }, "agent")
      .then(
        () => assert.fail("запись должна отказать"),
        (error: Error & { code?: string; exitCode?: number; details?: unknown }) => error,
      );
    assert.equal(write.code, "STORAGE_MIGRATION_REQUIRED");
    assert.equal(write.exitCode, 4);
    assert.deepEqual(write.details, read.details, "форма details мутации совпадает с чтением");
    assert.doesNotMatch(write.message, /не подтверждён|могла завершиться|повтор/);
    assert.equal(calls.length, 2, calls.join("\n"));
    assert.deepEqual(await digest(root), before);
  },
);

test("local: конфигурация вне текущей схемы останавливает запуск понятной ошибкой", async (t) => {
  const root = await temporaryRoot(t, "relay-compat-config-");
  await oldConfigProject(root);
  const before = await digest(root);
  await assert.rejects(startServer({ cwd: root, actor: "test", port: 0 }), {
    code: "VALIDATION_ERROR",
  });
  assert.deepEqual(await digest(root), before);
});

async function connect(url: string) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/v1/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(predicate: (event: ServerEvent) => boolean = () => true): Promise<ServerEvent> {
      const timer = setTimeout(() => controller.abort(new Error("SSE: событие не получено")), 8000);
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false, "SSE завершился до события");
            buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(
              /\r\n/g,
              "\n",
            );
            continue;
          }
          const lines = buffer.slice(0, boundary).split("\n");
          buffer = buffer.slice(boundary + 2);
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
