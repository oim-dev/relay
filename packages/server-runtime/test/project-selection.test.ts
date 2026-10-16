import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { defaultConfig } from "@relay/core/domain/config";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import {
  initializeRegistry,
  registerProject,
  unregisterProject,
} from "@relay/project-runtime/registry";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { createServerApi } from "@relay/project-runtime/backend/server";
import { startServer } from "@relay/server-runtime";

test("подключённый клиент закрепляет базу при перенаправлении имени и не пишет в другой проект", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-selection-"));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "current", { path: "a" });
  await registerProject(registry.configPath, "original", { path: "a" });
  const server = await startServer({ cwd: root, actor: "test", port: 0 });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const backend = await createHttpBackend(server.url, "current");
  assert.equal(backend.workspace.projectId, a.config.projectId);
  await registerProject(registry.configPath, "current", { path: "b" }, true);
  const created = await backend.boardTasks.create(
    { board: "product", title: "Именно А", requestId: "original" },
    "test",
  );
  assert.equal((await new BoardTasksService(a).get(created.id)).title, "Именно А");
  assert.equal((await new BoardTasksService(b).list()).total, 0);
  await unregisterProject(registry.configPath, "original");
  await assert.rejects(
    backend.boardTasks.create(
      { board: "product", title: "Не переносить в Б", requestId: "rebound" },
      "test",
    ),
    {
      code: "PROJECT_NOT_FOUND",
    },
  );
  assert.equal((await new BoardTasksService(b).list()).total, 0);
  assert.equal(backend.workspace.projectId, a.config.projectId);
});

test("legacy HTTP: workspace ID берётся из context без config.projectId и сохраняет pinning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-legacy-identity-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ["a", "b"]) {
    await mkdir(join(root, key, ".relay"), { recursive: true });
    await writeFile(
      join(root, key, ".relay/config.json"),
      JSON.stringify({
        ...defaultConfig,
        projectSettings: { version: 1, name: `Проект ${key}`, slug: `legacy-${key}`, revision: 1 },
      }),
    );
  }
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "current", { path: "a" });
  await registerProject(registry.configPath, "original", { path: "a" });
  server = await startServer({ cwd: root, actor: "test", port: 0 });
  const response = await fetch(`${server.url}/api/v1/projects/current/context`);
  assert.equal(response.status, 200);
  const context = (await response.json()).data;
  assert.equal(context.config.projectId, undefined);
  assert.equal(typeof context.projectId, "string");
  assert(context.projectId.length > 0);
  const backend = await createHttpBackend(server.url, "current");
  assert.equal(backend.workspace.projectId, context.projectId);
  assert.deepEqual(backend.workspace.config, context.config);
  assert.equal(backend.workspace.configPath, context.configPath);
  assert.equal(backend.workspace.root, context.storagePath);
  await registerProject(registry.configPath, "current", { path: "b" }, true);
  assert.equal((await backend.projectSettings.get()).name, "Проект a");
  assert.equal(backend.workspace.projectId, context.projectId);
  await unregisterProject(registry.configPath, "original");
  await assert.rejects(backend.projectSettings.get(), { code: "PROJECT_NOT_FOUND" });
  assert.equal(backend.workspace.projectId, context.projectId);
});

test("разные базы с одинаковым projectId отклоняются при регистрации и ручной правке workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-identities-"));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  await writeFile(b.configPath, JSON.stringify({ ...b.config, projectId: a.config.projectId }));
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "a" });
  const server = await startServer({ cwd: root, actor: "test", port: 0 });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = createServerApi(server.url);
  await assert.rejects(api.projects.registerProject({ project: "b" }, { path: "b" }), {
    code: "DUPLICATE_PROJECT_ID",
  });
  const config = JSON.parse(await readFile(registry.configPath, "utf8"));
  await writeFile(
    registry.configPath,
    JSON.stringify({ ...config, projects: { a: { path: "a" }, b: { path: "b" } } }),
  );
  const context = (await api.server.getServerContext()).data;
  assert(context.projects.every((project) => !project.available));
  assert.equal((await server.app.inject("/api/v1/projects/b/board-tasks")).statusCode, 409);
});
