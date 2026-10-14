import assert from "node:assert/strict";
import fs from "node:fs";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv } from "ajv";
import { createServer } from "@relay/server-runtime";
import { serverContextResponseSchema } from "@relay/contracts/server-context";
import { initialize } from "@relay/core/storage/workspace";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { ProjectCatalog } from "../src/modules/workspace/catalog.js";

test("WSP-02: общий каталог соответствует фактической OpenAPI для list/server/add/remove", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-openapi-"));
  const registry = await initializeRegistry(root);
  await initialize(join(root, "a"), "tasks");
  const app = await createServer({ cwd: root, config: registry.configPath, actor: "test" });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = (await app.inject("/api/openapi.json")).json();
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const [method, path, url, payload] of [
    ["get", "/api/v1/projects", "/api/v1/projects"],
    ["get", "/api/v1/server", "/api/v1/server"],
    ["put", "/api/v1/projects/{project}", "/api/v1/projects/alpha", { path: "a" }],
    ["delete", "/api/v1/projects/{project}", "/api/v1/projects/alpha"],
  ] as const) {
    const result = await app.inject({
      method: method.toUpperCase() as "GET" | "PUT" | "DELETE",
      url,
      ...(payload ? { payload } : {}),
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(serverContextResponseSchema.safeParse(result.json()).success);
    const schema = document.paths[path][method].responses[200].content["application/json"].schema;
    const validate = ajv.compile({ ...schema, components: document.components });
    assert.ok(validate(result.json()), JSON.stringify(validate.errors));
  }
});

test("WSP-08: context читает config один раз на realpath, aliases не создают коллизий и кеш не переживает запрос", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  await saveProjectSettings(a, { name: "А", slug: "alpha-web", ifRevision: 1 });
  await saveProjectSettings(b, { name: "Б", slug: "beta-web", ifRevision: 1 });
  await symlink(join(root, "a"), join(root, "alias"), "dir");
  const registry = await initializeRegistry(root);
  for (const [key, path] of [
    ["a", "a"],
    ["alias", "alias"],
    ["again", "a"],
    ["b", "b"],
  ])
    await registerProject(registry.configPath, key!, { path: path! });
  const catalog = new ProjectCatalog({
    cwd: root,
    configPath: registry.configPath,
    actor: "test",
    mode: "workspace",
  });
  const calls: string[] = [];
  const original = fs.promises.readFile;
  fs.promises.readFile = ((path: any, ...args: any[]) => {
    calls.push(String(path));
    return (original as any)(path, ...args);
  }) as typeof original;
  syncBuiltinESMExports();
  let listed;
  try {
    listed = await catalog.context();
  } finally {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  }
  const counts = {
    a: calls.filter((path) => path === a.configPath).length,
    b: calls.filter((path) => path === b.configPath).length,
  };
  t.diagnostic(`readFile config context: ${JSON.stringify(counts)}; registrations=4, realpaths=2`);
  assert.deepEqual(counts, { a: 1, b: 1 });
  assert.equal(listed.projects.length, 4);
  assert.ok(listed.projects.every((item) => item.available));
  assert.ok(
    listed.projects
      .filter((item) => item.id === a.config.projectId)
      .every((item) => item.slug === "alpha-web" && item.configPath === a.configPath),
  );
  assert.equal((await catalog.select("alpha-web")).projectId, a.config.projectId);
  await saveProjectSettings(a, { name: "Новое имя", slug: "alpha-new", ifRevision: 2 });
  assert.equal((await catalog.context()).projects[0]!.name, "Новое имя");
  await assert.rejects(catalog.select("alpha-web"), { code: "PROJECT_NOT_FOUND" });
  assert.equal((await catalog.select("alpha-new")).projectId, a.config.projectId);
  await saveProjectSettings(b, { name: "Б", slug: "alpha-new", ifRevision: 2 });
  assert.ok((await catalog.context()).projects.every((item) => item.slug === undefined));
  await assert.rejects(catalog.select("alpha-new"), { code: "PROJECT_SLUG_TAKEN" });
  assert.equal((await catalog.select(a.config.projectId)).projectId, a.config.projectId);
});

test("WSP-08: недоступные, duplicate ID и slug→key/ID сохраняют диагностику и порядок", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-collisions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  await saveProjectSettings(a, { name: "А", slug: "beta", ifRevision: 1 });
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "alpha", { path: "a" });
  await registerProject(registry.configPath, "beta", { path: "b" });
  await registerProject(registry.configPath, "broken", { path: "missing" });
  const catalog = new ProjectCatalog({
    cwd: root,
    configPath: registry.configPath,
    actor: "test",
    mode: "workspace",
  });
  let data = await catalog.context();
  assert.deepEqual(
    data.projects.map((item) => item.key),
    ["alpha", "beta", "broken"],
  );
  assert.equal(data.projects[0]!.slug, undefined, "Чужой key скрывает конфликтующий slug");
  assert.equal(data.projects[2]!.available, false);
  assert.ok(data.projects[2]!.error);
  assert.equal(
    (await catalog.select("beta")).projectId,
    b.config.projectId,
    "Ключ приоритетнее slug",
  );
  await cp(join(root, "a"), join(root, "copy"), { recursive: true });
  const raw = JSON.parse(await readFile(registry.configPath, "utf8"));
  await writeFile(
    registry.configPath,
    JSON.stringify({ ...raw, projects: { ...raw.projects, copy: { path: "copy" } } }),
  );
  data = await catalog.context();
  const duplicates = data.projects.filter((item) => item.id === a.config.projectId);
  assert.equal(duplicates.length, 2);
  assert.ok(
    duplicates.every((item) => !item.available && item.error?.startsWith("DUPLICATE_PROJECT_ID")),
  );
  await assert.rejects(catalog.select("alpha"), { code: "DUPLICATE_PROJECT_ID" });
});
