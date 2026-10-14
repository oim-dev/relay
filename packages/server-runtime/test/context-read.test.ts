import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import { initialize, readWorkspaceConfig } from "@relay/core/storage/workspace";
import type { Workspace } from "@relay/core/storage/workspace";
import { projectSettings } from "@relay/core/storage/project-settings";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { EntityStore } from "@relay/core/storage/entity-store/store";
import { inspectPending } from "@relay/core/storage/entity-store/transaction";
import { workspaceStorageRegistry } from "@relay/core/storage/unified-adapter";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
// Runtime и DI-токен берём из одной реализации, независимо от условия tasks-source.
import { startServer } from "../src/bootstrap.js";
import { EventsService } from "../src/modules/events/events.service.js";

type Server = Awaited<ReturnType<typeof startServer>>;

/** Сравниваем также пустые каталоги и runtime, а не только постоянные JSON. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        await visit(join(directory, entry.name), `${relative}/`);
      } else {
        result[relative] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
      }
    }
  }
  await visit(root, "");
  return result;
}

async function fixture<T extends { configPath: string }>(
  t: TestContext,
  setup: (root: string) => Promise<T>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-context-read-")));
  let server: Server | undefined;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const target = await setup(root);
  const beforeStartup = await snapshot(root);
  server = await startServer({
    cwd: root,
    config: target.configPath,
    actor: "config-reader",
    port: 0,
  });
  const afterStartup = await snapshot(root);
  // Только тестовая изоляция GET: ждём завершения refresh и закрытия watcher/timer.
  // Сам запуск и наблюдатели намеренно сохраняют обычный lifecycle, проверенный отдельно.
  await server.app.get(EventsService).onModuleDestroy();
  return { root, target, server, beforeStartup, afterStartup };
}

async function get(server: Server, path: string) {
  const response = await fetch(`${server.url}${path}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}

function paths(prefixes: string[]) {
  return prefixes.flatMap((prefix) => [`${prefix}/context`, `${prefix}/context/settings`]);
}

async function bare(root: string) {
  const configPath = join(root, ".relay/config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      ...defaultConfig,
      projectId: randomUUID(),
      projectSettings: { version: 1, name: "Прежний проект", slug: "bare-project", revision: 7 },
    }),
  );
  return configPath;
}

for (const mode of ["local", "workspace"] as const) {
  test(`config GET ${mode}: bare без mkdir, включая выбор по ID и slug; startup отдельно`, async (t) => {
    const { root, target, server, beforeStartup, afterStartup } = await fixture(t, async (root) => {
      const projectConfig = await bare(mode === "local" ? root : join(root, "project"));
      if (mode === "local") return { configPath: projectConfig, projectConfig };
      const registry = await initializeRegistry(root);
      await registerProject(registry.configPath, "entry", { path: "project" });
      return { configPath: registry.configPath, projectConfig };
    });
    // Подготовка legacy-каталогов при startup не объявляется частью исправленного GET.
    assert.notDeepEqual(afterStartup, beforeStartup);
    const directory = dirname(target.projectConfig);
    await rm(join(directory, "tasks"), { recursive: true, force: true });
    await rm(join(directory, "runtime"), { recursive: true, force: true });
    assert.deepEqual(await snapshot(root), beforeStartup);
    const { config } = await readWorkspaceConfig(root, target.projectConfig);
    const settings = projectSettings(config, target.projectConfig);
    const prefixes =
      mode === "local" ? ["/api/v1", "/api/v1/projects/local"] : ["/api/v1/projects/entry"];
    prefixes.push(`/api/v1/projects/${config.projectId}`, `/api/v1/projects/${settings.slug}`);
    for (const path of paths(prefixes)) {
      const result = await get(server, path);
      assert.equal(result.status, 200, JSON.stringify(result));
      if (path.endsWith("/settings")) assert.deepEqual(result.body, { ok: true, data: settings });
      else
        assert.deepEqual(result.body, {
          ok: true,
          data: {
            project: settings.name,
            capabilities: [
              "relay-projects-v1",
              "relay-full-context-v1",
              "relay-overview-metrics-v1",
              "relay-document-library-v1",
              "relay-product-queries-v1",
              "relay-work-read-models-v1",
              "relay-release-refs-v1",
              "relay-entity-search-v2",
              "relay-project-catalog-v1",
            ],
            projectId: config.projectId,
            configPath: target.projectConfig,
            storagePath: join(directory, "tasks"),
            actor: "config-reader",
            config,
          },
        });
      assert.deepEqual(await snapshot(root), beforeStartup, path);
    }
    assert.equal(
      (await get(server, "/api/v1/projects/unknown/context")).body.error.code,
      "PROJECT_NOT_FOUND",
    );
    if (mode === "workspace")
      assert.equal((await get(server, "/api/v1/context")).body.error.code, "PROJECT_REQUIRED");
    assert.deepEqual(await snapshot(root), beforeStartup);
    if (mode === "local") {
      // Опция конфигурационного GET не сохраняется в общем ProjectContext для других методов.
      assert.equal((await get(server, "/api/v1/entities/types")).status, 200);
      assert.equal(await readFile(join(directory, "runtime/.gitignore"), "utf8"), "*\n");
      assert.deepEqual(await readdir(join(directory, "tasks")), []);
    }
  });
}

test("config GET current: актуальная PROJECT-проекция, custom config/dataRoot, свежесть и отсутствие mkdir", async (t) => {
  const { root, target, server } = await fixture(t, async (root) => {
    const project = await initialize(root, "absent/legacy/tasks", "custom/project.json");
    await saveProjectSettings(project, {
      name: "Имя PROJECT",
      slug: "current-project",
      ifRevision: 1,
    });
    return { configPath: project.configPath, project };
  });
  const project = target.project;
  await rm(join(project.dataRoot, "runtime"), { recursive: true });
  const before = await snapshot(root);
  const { config } = await readWorkspaceConfig(root, project.configPath);
  const settings = projectSettings(config, project.configPath);
  assert.notEqual(
    JSON.parse(await readFile(project.configPath, "utf8")).projectSettings?.name,
    settings.name,
  );
  for (const path of paths([
    "/api/v1",
    `/api/v1/projects/${config.projectId}`,
    `/api/v1/projects/${settings.slug}`,
  ])) {
    const result = await get(server, path);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.data.revision ?? result.body.data.config.projectSettings.revision, 2);
    if (path.endsWith("/settings")) assert.deepEqual(result.body.data, settings);
    else {
      assert.deepEqual(result.body.data.config, config);
      assert.equal(result.body.data.configPath, project.configPath);
      assert.equal(result.body.data.storagePath, dirname(project.configPath));
    }
    assert.deepEqual(await snapshot(root), before, path);
  }
  await saveProjectSettings(project, { name: "Следующее имя", slug: settings.slug, ifRevision: 2 });
  const afterWrite = await snapshot(root);
  const result = await get(server, "/api/v1/context/settings");
  assert.equal(result.body.data.name, "Следующее имя");
  assert.equal(result.body.data.revision, 3);
  assert.deepEqual(await snapshot(root), afterWrite);
});

for (const mode of ["local", "workspace"] as const) {
  test(`config GET ${mode}: отсутствие и повреждение конфига — прежние ошибки без создания файлов`, async (t) => {
    const { root, target, server } = await fixture(t, async (root) => {
      const project = await initialize(mode === "local" ? root : join(root, "project"), "tasks");
      if (mode === "local") return { configPath: project.configPath, project };
      const registry = await initializeRegistry(root);
      await registerProject(registry.configPath, "entry", { path: "project" });
      return { configPath: registry.configPath, project };
    });
    const project = target.project;
    await rm(join(project.dataRoot, "runtime"), { recursive: true });
    const raw = await readFile(project.configPath, "utf8");
    const routes = paths(
      mode === "local"
        ? ["/api/v1", `/api/v1/projects/${project.config.projectId}`]
        : ["/api/v1/projects/entry"],
    );
    for (const [content, status, code] of [
      [null, 404, "NOT_FOUND"],
      ["{broken", 500, "INVALID_DATA"],
      [JSON.stringify({ ...JSON.parse(raw), version: 99 }), 500, "INVALID_CONFIG"],
    ] as const) {
      if (content === null) await rm(project.configPath);
      else await writeFile(project.configPath, content);
      const before = await snapshot(root);
      let first;
      for (const path of routes) {
        const result = await get(server, path);
        assert.equal(result.status, status, JSON.stringify(result));
        assert.equal(result.body.error.code, code);
        first ??= result.body;
        assert.deepEqual(result.body, first);
        assert.deepEqual(await snapshot(root), before, path);
      }
    }
  });
}

async function pendingProjectUpdate(project: Workspace, name: string) {
  const store = await EntityStore.open(project.dataRoot, workspaceStorageRegistry(), (stage) => {
    if (stage === "intent") throw new Error("Остановка после intent");
  });
  await assert.rejects(
    store.run(
      { namespace: "test", actor: "reader", requestId: "pending", request: {} },
      async (session) => {
        const previous = await session.get({ kind: "project", id: project.config.projectId! });
        await session.put(
          { ...previous, revision: previous.revision + 1, data: { ...previous.data, name } },
          previous.revision,
        );
        return null;
      },
    ),
    /Остановка после intent/,
  );
  assert.equal((await inspectPending(project.dataRoot)).kind, "operation");
}

test("config GET: каждый local/scoped путь восстанавливает ordinary WAL до ответа, повтор не пишет", async (t) => {
  const { root, target, server } = await fixture(t, async (root) => {
    const project = await initialize(root, "tasks");
    return { configPath: project.configPath, project };
  });
  let revision = 1;
  for (const path of paths(["/api/v1", `/api/v1/projects/${target.project.config.projectId}`])) {
    const name = `Восстановлено ${++revision}`;
    await pendingProjectUpdate(target.project, name);
    const result = await get(server, path);
    assert.equal(result.status, 200, JSON.stringify(result));
    const settings = path.endsWith("/settings")
      ? result.body.data
      : result.body.data.config.projectSettings;
    assert.equal(settings.name, name);
    assert.equal(settings.revision, revision);
    assert.equal((await inspectPending(target.project.dataRoot)).kind, "none");
    const recovered = await snapshot(root);
    assert.deepEqual(await get(server, path), result);
    assert.deepEqual(await snapshot(root), recovered);
  }
});

test("config GET: manifest/миграционный WAL сохраняют ошибки и байты без runtime", async (t) => {
  const { root, target, server } = await fixture(t, async (root) => {
    const project = await initialize(root, "tasks");
    return { configPath: project.configPath, project };
  });
  const project = target.project;
  await rm(join(project.dataRoot, "runtime"), { recursive: true });
  const manifestPath = join(project.dataRoot, "storage.json");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const routes = paths(["/api/v1", `/api/v1/projects/${project.config.projectId}`]);
  const { dataModelVersion: _profile, ...unmarked } = current;
  for (const [manifest, status, code] of [
    [unmarked, 200, undefined],
    [{ format: "relay-entities", schemaVersion: 3 }, 200, undefined],
    [{ ...current, dataModelVersion: 3 }, 409, "STORAGE_VERSION_UNSUPPORTED"],
    [{ format: "unknown", schemaVersion: 4 }, 409, "STORAGE_FORMAT_UNKNOWN"],
  ] as const) {
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await snapshot(root);
    for (const path of routes) {
      const result = await get(server, path);
      assert.equal(result.status, status, JSON.stringify(result));
      assert.equal(result.body.error?.code, code);
      assert.deepEqual(await snapshot(root), before, path);
    }
  }
  await writeFile(manifestPath, JSON.stringify(current));
  const pendingPath = join(project.dataRoot, "transactions/pending.json");
  for (const [intent, code] of [
    [
      {
        schemaVersion: 2,
        changes: [],
        migration: {
          id: randomUUID(),
          registryDigest: "a".repeat(64),
          planFingerprint: "b".repeat(64),
          source: { layout: "unified-4", physical: 4, profile: 1 },
          target: { profile: 2 },
          transitions: ["profile-marker@1"],
          backup: { path: join(root, "backup"), manifestSha256: "c".repeat(64) },
          report: {
            entities: 0,
            steps: [],
            counts: { checked: 0, changed: 0, removedByRule: 0, owners: {} },
          },
        },
      },
      "STORAGE_RECOVERY_REQUIRED",
    ],
    [{ schemaVersion: 3, changes: [] }, "STORAGE_VERSION_UNSUPPORTED"],
  ] as const) {
    await writeFile(pendingPath, JSON.stringify(intent));
    const before = await snapshot(root);
    let first;
    for (const path of routes) {
      const result = await get(server, path);
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(result.body.error.code, code);
      first ??= result.body;
      assert.deepEqual(result.body, first);
      assert.deepEqual(await snapshot(root), before, path);
    }
  }
});

test("config GET: конфликт ordinary WAL и будущий профиль не скрываются и не меняют файлы", async (t) => {
  const { root, target, server } = await fixture(t, async (root) => {
    const project = await initialize(root, "tasks");
    return { configPath: project.configPath, project };
  });
  const project = target.project;
  await pendingProjectUpdate(project, "Ожидает восстановления");
  const recordPath = join(
    project.dataRoot,
    "entities/projects",
    `${project.config.projectId}.json`,
  );
  const recordBytes = await readFile(recordPath, "utf8");
  const record = JSON.parse(recordBytes);
  record.data.name = "Внешняя правка";
  await writeFile(recordPath, JSON.stringify(record));
  for (const code of ["STORAGE_RECOVERY_CONFLICT", "STORAGE_VERSION_UNSUPPORTED"]) {
    if (code === "STORAGE_VERSION_UNSUPPORTED") {
      await writeFile(recordPath, recordBytes);
      const manifestPath = join(project.dataRoot, "storage.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(manifestPath, JSON.stringify({ ...manifest, dataModelVersion: 3 }));
    }
    const before = await snapshot(root);
    let first;
    for (const path of paths(["/api/v1", `/api/v1/projects/${project.config.projectId}`])) {
      const result = await get(server, path);
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(result.body.error.code, code);
      first ??= result.body;
      assert.deepEqual(result.body, first);
      assert.deepEqual(await snapshot(root), before, path);
    }
  }
});
