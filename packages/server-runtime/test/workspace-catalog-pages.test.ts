import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv } from "ajv";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import {
  PROJECT_CATALOG_CAPABILITY,
  projectCatalogPageSchema,
  projectRegistrationReceiptSchema,
  projectUnregistrationReceiptSchema,
} from "@relay/contracts/server-context";
import { createServer } from "@relay/server-runtime";
import { ProjectCatalog } from "../src/modules/workspace/catalog.js";

test("WSP-08: source страницы передают диапазон, сохраняют guard, старый каталог и компактные записи", async (t) => {
  const root = await mkdtemp("/tmp/opencode/relay-workspace-pages-");
  const a = await initialize(join(root, "a"), "tasks");
  const b = await initialize(join(root, "b"), "tasks");
  const registry = await initializeRegistry(root);
  for (let n = 0; n < 30; n++)
    await registerProject(registry.configPath, `project-${n}`, { path: n % 2 ? "b" : "a" });
  const app = await createServer({ cwd: root, actor: "test", config: registry.configPath });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const catalog = app.get(ProjectCatalog);
  const originalContext = catalog.context.bind(catalog);
  let catalogReads = 0;
  t.mock.method(catalog, "context", async () => {
    catalogReads++;
    return originalContext();
  });
  const caps = await app.inject("/api/v1/server/capabilities");
  assert.equal(caps.statusCode, 200);
  assert.ok(caps.json().data.capabilities.includes(PROJECT_CATALOG_CAPABILITY));
  assert.equal(catalogReads, 0, "Handshake не читает каталог");
  const context = await app.inject("/api/v1/projects/project-0/context");
  assert.equal(context.statusCode, 200, context.body);
  for (const capability of [
    "relay-product-queries-v1",
    "relay-work-read-models-v1",
    "relay-release-refs-v1",
    "relay-entity-search-v2",
    PROJECT_CATALOG_CAPABILITY,
  ])
    assert.ok(context.json().data.capabilities.includes(capability));

  const full = await app.inject("/api/v1/projects");
  assert.equal(full.json().data.projects.length, 30);
  const first = await app.inject("/api/v1/projects/page?limit=2");
  assert.equal(first.statusCode, 200, first.body);
  const page = projectCatalogPageSchema.parse(first.json().data);
  assert.equal(page.catalog.mode, "workspace");
  assert.equal(page.catalog.configPath, registry.configPath);
  assert.equal(page.catalog.defaultProject, null);
  assert.equal(page.catalog.projects.length, 2);
  assert.equal(page.total, 30);
  assert.ok(Buffer.byteLength(first.body) < Buffer.byteLength(full.body) / 4);
  const keys = page.catalog.projects.map((project) => project.key);
  let offset = page.nextOffset;
  while (offset !== null) {
    const response = await app.inject(
      `/api/v1/projects/page?limit=2&offset=${offset}&version=${page.version}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const next = projectCatalogPageSchema.parse(response.json().data);
    assert.equal(next.version, page.version);
    assert.equal(next.catalog.projects.length, 2);
    keys.push(...next.catalog.projects.map((project) => project.key));
    offset = next.nextOffset;
  }
  assert.deepEqual(
    keys,
    full.json().data.projects.map((project: { key: string }) => project.key),
  );
  assert.equal(new Set(keys).size, 30);
  const pastEnd = await app.inject(`/api/v1/projects/page?offset=30&version=${page.version}`);
  assert.deepEqual(pastEnd.json().data.catalog.projects, []);
  assert.equal(pastEnd.json().data.nextOffset, null);
  assert.equal((await app.inject("/api/v1/projects/page?limit=0")).statusCode, 400);
  assert.equal((await app.inject("/api/v1/projects/page?offset=-1")).statusCode, 400);

  const added = await app.inject({
    method: "PUT",
    url: "/api/v1/projects/extra/registration",
    payload: { path: "a" },
  });
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(projectRegistrationReceiptSchema.parse(added.json().data), {
    action: "register",
    key: "extra",
    configPath: registry.configPath,
    entry: { path: "a" },
  });
  assert.ok(Buffer.byteLength(added.body) < 500);
  assert.equal(added.json().data.projects, undefined);
  const changed = await app.inject(`/api/v1/projects/page?offset=2&version=${page.version}`);
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, "VERSION_CONFLICT");
  const oldAdd = await app.inject({
    method: "PUT",
    url: "/api/v1/projects/old",
    payload: { path: "a" },
  });
  assert.equal(oldAdd.statusCode, 200);
  assert.equal(oldAdd.json().data.projects.length, 32, "Default REST сохраняет полный каталог");
  for (const removed of [true, false]) {
    const result = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/extra/registration",
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(projectUnregistrationReceiptSchema.parse(result.json().data), {
      action: "unregister",
      key: "extra",
      configPath: registry.configPath,
      removed,
    });
  }
  const oldRemove = await app.inject({ method: "DELETE", url: "/api/v1/projects/old" });
  assert.equal(oldRemove.json().data.projects.length, 30);
  const beforeAvailability = (await app.inject("/api/v1/projects/page?limit=2")).json().data;
  const savedConfig = await readFile(a.configPath, "utf8");
  await rm(a.configPath);
  assert.equal(
    (await app.inject(`/api/v1/projects/page?offset=2&version=${beforeAvailability.version}`))
      .statusCode,
    409,
  );
  await writeFile(a.configPath, savedConfig);
  const beforeIdentity = (await app.inject("/api/v1/projects/page?limit=2")).json().data;
  await registerProject(registry.configPath, "project-0", { path: "b" }, true);
  assert.equal(
    (await app.inject(`/api/v1/projects/page?offset=2&version=${beforeIdentity.version}`))
      .statusCode,
    409,
  );
  assert.ok(await readFile(b.configPath));
  t.diagnostic(
    `wire bytes: full(30)=${Buffer.byteLength(full.body)}, page(2)=${Buffer.byteLength(first.body)}, compact add=${Buffer.byteLength(added.body)}`,
  );

  const document = (await app.inject("/api/openapi.json")).json();
  assert.equal(document.paths["/api/v1/projects/{project}/server/capabilities"], undefined);
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const [method, path, response, id] of [
    ["get", "/api/v1/server/capabilities", caps, "getServerCapabilities"],
    ["get", "/api/v1/projects/page", first, "getProjectCatalogPage"],
    ["put", "/api/v1/projects/{project}/registration", added, "registerProjectCompact"],
    [
      "delete",
      "/api/v1/projects/{project}/registration",
      await app.inject({ method: "DELETE", url: "/api/v1/projects/extra/registration" }),
      "unregisterProjectCompact",
    ],
  ] as const) {
    const operation = document.paths[path][method];
    assert.equal(operation.operationId, id);
    const schema = operation.responses[200].content["application/json"].schema;
    const validate = ajv.compile({ ...schema, components: document.components });
    assert.ok(validate(response.json()), JSON.stringify(validate.errors));
  }
});

test("WSP-08: source local page сообщает настоящий defaultProject, compact mutations недоступны", async (t) => {
  const root = await mkdtemp("/tmp/opencode/relay-local-page-");
  const project = await initialize(root, "tasks");
  const app = await createServer({ cwd: root, actor: "test" });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await app.inject("/api/v1/projects/page?limit=1");
  assert.equal(response.statusCode, 200);
  const page = projectCatalogPageSchema.parse(response.json().data);
  assert.equal(page.catalog.mode, "local");
  assert.equal(page.catalog.defaultProject, project.config.projectId);
  assert.equal(page.catalog.configPath, project.configPath);
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, null);
  const remove = await app.inject({ method: "DELETE", url: "/api/v1/projects/local/registration" });
  assert.equal(remove.statusCode, 400);
  assert.equal(remove.json().error.code, "WORKSPACE_REQUIRED");
});
