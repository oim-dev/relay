import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { productOverviewSchema } from "@relay/core/domain/product";
import type { ProductOverview } from "@relay/core/domain/product";
import { ProductQueries } from "@relay/core/application/product/queries";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { initialize } from "@relay/core/storage/workspace";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

test("HTTP продукта: scoped-маршруты, прямой Markdown, повторы и реальные ошибки", async (t) => {
  const { app, workspace } = await fixture(t);
  const projectId = (await app.inject("/api/v1/context")).json().data.projectId;
  const prefix = `/api/v1/projects/${projectId}/product`;
  const payload = {
    action: "create",
    requestId: "passport",
    fields: {
      kind: "passport",
      name: "Продукт",
      summary: "Назначение",
      description: "## Цель\n\nСохранить текст  \n",
    },
  };
  const response = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(response.statusCode, 200, response.body);
  const repeated = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(repeated.statusCode, 409, repeated.body);
  const records = await app.inject(`${prefix}/records?kind=passport&limit=1`);
  assert.equal(records.statusCode, 200, records.body);
  assert.equal(records.json().data.items[0].fields.description, payload.fields.description);
  assert.equal(records.json().data.nextOffset, null);
  assert.deepEqual(
    (await app.inject(`${prefix}/state`)).json().data,
    await new ProductQueries(workspace).state(),
  );
  const conflict = await app.inject({
    method: "POST",
    url: `${prefix}/records`,
    payload: { ...payload, action: "update", id: "passport", ifRevision: 7, requestId: "update" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, "REVISION_CONFLICT");
  const overview = (await app.inject(`${prefix}/overview`)).json().data;
  assert.equal(overview.items[0].name, "Продукт");
  assert.ok(!JSON.stringify(overview).includes("Сохранить текст"));
  const context = (await app.inject(`${prefix}/context`)).json().data;
  assert.equal(context.records[0].record.id, "passport");
});

/** Предметная часть обзора без времени формирования ответа. */
function withoutGeneratedAt(overview: ProductOverview) {
  const { generatedAt, ...rest } = overview;
  assert.ok(!Number.isNaN(Date.parse(generatedAt)));
  return rest;
}

test("HTTP обзора продукта: пустой проект, local/scoped, snapshotVersion и равенство с Core", async (t) => {
  const { app, root, workspace } = await fixture(t);
  const projectId = workspace.config.projectId!;
  const scoped = `/api/v1/projects/${projectId}`;
  const read = async (base = scoped) => {
    const response = await app.inject(`${base}/product/overview`);
    assert.equal(response.statusCode, 200, response.body);
    return productOverviewSchema.parse(response.json().data);
  };
  const empty = await read();
  assert.equal(empty.snapshot.passport.state, "missing");
  assert.deepEqual(empty.items, []);
  assert.equal(empty.snapshot.tasks.total, 0);
  assert.equal(empty.snapshot.plans.total, 0);
  assert.equal(empty.snapshot.releases.total, 0);
  assert.equal(empty.snapshot.project.id, projectId);
  assert.deepEqual(withoutGeneratedAt(await read("/api/v1")), withoutGeneratedAt(empty));
  assert.deepEqual(
    withoutGeneratedAt(await new ProductQueries(workspace).overview()),
    withoutGeneratedAt(empty),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeated = await read();
  assert.notEqual(repeated.generatedAt, empty.generatedAt);
  assert.equal(repeated.snapshotVersion, empty.snapshotVersion);

  const versions = [empty.snapshotVersion];
  const expectChanged = async (step: string) => {
    const current = await read();
    assert.ok(!versions.includes(current.snapshotVersion), `snapshotVersion не изменился: ${step}`);
    assert.equal(current.version, empty.version, `Версия состава продукта изменилась: ${step}`);
    versions.push(current.snapshotVersion);
    return current;
  };
  const write = async (method: "POST" | "PUT", url: string, payload: object) => {
    const response = await app.inject({ method, url: `${scoped}${url}`, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const task = await write("POST", "/board-tasks", {
    board: "product",
    title: "Задача обзора",
    requestId: "overview-task",
  });
  assert.equal((await expectChanged("создание задачи")).snapshot.tasks.total, 1);
  await write("POST", `/board-tasks/${task.id}/criteria`, {
    action: "add",
    title: "Критерий обзора",
    ifRevision: task.revision,
    requestId: "overview-criterion",
  });
  assert.equal((await expectChanged("критерий задачи")).snapshot.tasks.criteria.total, 1);
  const plan = await write("POST", "/plans", { title: "План обзора", requestId: "overview-plan" });
  await expectChanged("создание плана");
  await write("POST", `/plans/${plan.id}/update`, {
    title: "План обзора, уточнённый",
    ifRevision: plan.revision,
    requestId: "overview-plan-update",
  });
  await expectChanged("изменение плана");
  await write("POST", "/releases", {
    title: "Релиз обзора",
    version: "1.0.0",
    planIds: [plan.id],
    requestId: "overview-release",
  });
  assert.equal((await expectChanged("создание релиза")).snapshot.releases.total, 1);
  const settings = (await app.inject(`${scoped}/context/settings`)).json().data;
  await write("PUT", "/context/settings", {
    name: "Переименованный проект",
    slug: settings.slug,
    ifRevision: settings.revision,
  });
  const renamed = await expectChanged("имя проекта");
  assert.equal(renamed.snapshot.project.name, "Переименованный проект");

  await app.listen({ host: "127.0.0.1", port: 0 });
  const http = await createHttpBackend(await app.getUrl(), projectId);
  const local = await createLocalBackend(root);
  const [remote, direct] = await Promise.all([http.product.overview(), local.product.overview()]);
  assert.deepEqual(withoutGeneratedAt(remote), withoutGeneratedAt(direct));
  assert.equal(remote.snapshotVersion, renamed.snapshotVersion);
});

test("HTTP обзора продукта: проектные маршруты изолируют workspace A и B", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-overview-"));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "a" });
  await registerProject(registry.configPath, "b", { path: "b" });
  const server = await startServer({ cwd: root, actor: "test", port: 0 });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await new BoardTasksService(a).create(
    { board: "product", title: "Только в А", requestId: "only-a" },
    "test",
  );
  const read = async (project: string) => {
    const response = await server.app.inject(`/api/v1/projects/${project}/product/overview`);
    assert.equal(response.statusCode, 200, response.body);
    return productOverviewSchema.parse(response.json().data);
  };
  const [first, second] = await Promise.all([read("a"), read("b")]);
  assert.equal(first.snapshot.project.id, a.config.projectId);
  assert.equal(second.snapshot.project.id, b.config.projectId);
  assert.equal(first.snapshot.tasks.total, 1);
  assert.equal(second.snapshot.tasks.total, 0);
  assert.notEqual(first.snapshotVersion, second.snapshotVersion);
  const [remoteA, remoteB] = await Promise.all([
    createHttpBackend(server.url, "a"),
    createHttpBackend(server.url, "b"),
  ]);
  assert.equal((await remoteA.product.overview()).snapshotVersion, first.snapshotVersion);
  assert.equal((await remoteB.product.overview()).snapshotVersion, second.snapshotVersion);
  assert.equal(
    (await server.app.inject("/api/v1/projects/missing/product/overview")).statusCode,
    404,
  );
});
