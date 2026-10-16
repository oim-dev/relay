import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { configSchema, defaultConfig } from "@relay/core/domain/config";
import { initialize } from "@relay/core/storage/workspace";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import {
  readConfiguration,
  readInitializationConfiguration,
  resolveProject,
  serverAddress,
} from "../src/config.js";
import { initializeRegistry, registerProject, unregisterProject } from "../src/registry.js";

test("поиск выбирает ближайший конфиг, реестр имеет приоритет в одном каталоге; чтение без записи", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tasks-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "app");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, ".relay"));
  await writeFile(join(project, ".relay/config.json"), JSON.stringify(defaultConfig));
  await initializeRegistry(root);
  const registry = join(root, "relay.workspace.json");
  await registerProject(registry, "app", { path: "app" });
  assert.equal((await readConfiguration(join(project, "src"))).kind, "project");
  assert.deepEqual(
    await readInitializationConfiguration(join(project, "src")),
    await readConfiguration(join(project, "src")),
  );
  const source = await readConfiguration(join(project, "src"), undefined, true);
  assert.equal(source.path, registry);
  assert.equal(source.value.server.port, 4700);
  assert.equal(source.value.mcp?.port, 4710);
  assert.equal(serverAddress(source), "http://127.0.0.1:4700");
  assert.equal(
    (await resolveProject(source, "app")).configPath,
    join(project, ".relay/config.json"),
  );
  assert.deepEqual((await readdir(project)).sort(), [".relay", "src"]);
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay/config.json"), JSON.stringify(defaultConfig));
  assert.equal((await readConfiguration(root)).kind, "registry");
  assert.deepEqual(await readInitializationConfiguration(root), await readConfiguration(root));
  assert.equal((await readConfiguration(root, ".relay/config.json")).kind, "project");
  assert.deepEqual(
    await readInitializationConfiguration(root, ".relay/config.json"),
    await readConfiguration(root, ".relay/config.json"),
  );
  await assert.rejects(resolveProject(source), { code: "PROJECT_REQUIRED" });
  await assert.rejects(resolveProject(source, "missing"), { code: "PROJECT_NOT_FOUND" });
  await mkdir(join(project, "src/.relay"));
  await writeFile(
    join(project, "src/.relay/config.json"),
    JSON.stringify({ version: 1, mode: "workspace", projects: {} }),
  );
  await assert.rejects(readConfiguration(join(project, "src")), { code: "VALIDATION_ERROR" });
  await assert.rejects(readInitializationConfiguration(join(project, "src")), {
    code: "VALIDATION_ERROR",
  });
});

test("init metadata читает только конфигурацию, не WAL, manifest и проекции проекта", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  await saveProjectSettings(workspace, {
    name: "Имя предметного проекта",
    slug: "metadata-project",
    ifRevision: 1,
  });
  const raw = configSchema.parse(JSON.parse(await readFile(workspace.configPath, "utf8")));
  assert.deepEqual((await readInitializationConfiguration(root)).value, raw);
  const ordinary = await readConfiguration(root);
  assert.equal(ordinary.kind, "project");
  if (ordinary.kind !== "project") throw new Error("Ожидался проект");
  assert.equal(ordinary.value.projectSettings?.name, "Имя предметного проекта");
  assert.notDeepEqual(ordinary.value, raw);

  const manifest = join(workspace.dataRoot, "storage.json");
  const pending = join(workspace.dataRoot, "transactions/pending.json");
  await writeFile(manifest, "некорректный manifest");
  await writeFile(pending, "некорректный WAL");
  const before = await directoryBytes(root);
  assert.deepEqual((await readInitializationConfiguration(root)).value, raw);
  assert.deepEqual(await directoryBytes(root), before);
  await assert.rejects(readConfiguration(root), { code: "STORAGE_DATA_CORRUPT" });
  assert.deepEqual(await directoryBytes(root), before);
});

test("init metadata сохраняет ошибки JSON/схемы, explicit missing и nearest без fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-metadata-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, "child");
  await mkdir(join(child, ".relay"), { recursive: true });
  await writeFile(join(root, "relay.workspace.json"), JSON.stringify({ version: 1, projects: {} }));
  const local = join(child, ".relay/config.json");
  const cases = [
    { path: local, bytes: "{broken", code: "INVALID_DATA" },
    {
      path: local,
      bytes: JSON.stringify({ ...defaultConfig, server: { url: "not-http" } }),
      code: "VALIDATION_ERROR",
    },
    { path: local, bytes: JSON.stringify({ version: 1, projects: {} }), code: "VALIDATION_ERROR" },
    {
      path: join(child, "relay.workspace.json"),
      bytes: JSON.stringify(defaultConfig),
      code: "VALIDATION_ERROR",
    },
  ];
  for (const item of cases) {
    await writeFile(item.path, item.bytes);
    const before = await directoryBytes(root);
    const errors = [];
    for (const read of [readConfiguration, readInitializationConfiguration]) {
      try {
        await read(child);
        assert.fail("Повреждённый ближайший конфиг должен остановить поиск");
      } catch (error) {
        const failure = error as { code: string; message: string; details: unknown };
        assert.equal(failure.code, item.code);
        errors.push({ code: failure.code, message: failure.message, details: failure.details });
      }
    }
    assert.deepEqual(errors[0], errors[1]);
    assert.deepEqual(await directoryBytes(root), before);
  }
  await assert.rejects(readInitializationConfiguration(child, "absent.json"), {
    code: "NOT_FOUND",
  });
});

async function directoryBytes(root: string): Promise<Record<string, Buffer | string>> {
  const result: Record<string, Buffer | string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        await visit(join(directory, entry.name), `${relative}/`);
      } else result[relative] = await readFile(join(directory, entry.name));
    }
  }
  await visit(root, "");
  return result;
}

test("параллельные регистрации сохраняются, повторы идемпотентны, замена явная", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tasks-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await initializeRegistry(root);
  await Promise.all(
    Array.from({ length: 12 }, (_, id) =>
      registerProject(configPath, `p${id}`, { path: `project-${id}` }),
    ),
  );
  await registerProject(configPath, "p0", { path: "project-0" });
  const before = await readFile(configPath, "utf8");
  await assert.rejects(registerProject(configPath, "p0", { path: "." }), {
    code: "PROJECT_EXISTS",
  });
  assert.equal(await readFile(configPath, "utf8"), before);
  const source = await readConfiguration(root);
  assert.equal(source.kind, "registry");
  if (source.kind === "registry") assert.equal(Object.keys(source.value.projects).length, 12);
  await registerProject(configPath, "p0", { path: "." }, true);
  assert.deepEqual(await unregisterProject(configPath, "p0"), { project: "p0", removed: true });
  assert.deepEqual(await unregisterProject(configPath, "p0"), { project: "p0", removed: false });
});
