import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import type { Workspace } from "@relay/core/storage/workspace";
import { inspectPending } from "@relay/core/storage/entity-store/transaction";
import { EntityStore } from "@relay/core/storage/entity-store/store";
import { workspaceStorageRegistry } from "@relay/core/storage/unified-adapter";
import { createLocalBackend } from "../src/backend/local.js";

const options = { createLegacyDirectories: false };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-local-config-read-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Включает пустые каталоги и symlink: отсутствие новых файлов само по себе недостаточно. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        result[`${path}/`] = "directory";
        await visit(absolute, `${path}/`);
      } else if (entry.isSymbolicLink()) result[path] = `link:${await readlink(absolute)}`;
      else
        result[path] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
    }
  }
  await visit(root, "");
  return result;
}

async function bare(directory: string, storageDir = "tasks") {
  const configPath = join(directory, ".relay/config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ ...defaultConfig, storageDir }));
  return configPath;
}

for (const storageDir of ["tasks", "missing/nested/tasks"]) {
  test(`local config read: bare ${storageDir} не создаёт каталоги; default совместим`, async (t) => {
    const directory = await fixture(t);
    const configPath = await bare(directory, storageDir);
    const before = await snapshot(directory);
    const backend = await createLocalBackend(directory, undefined, options);
    assert.equal(Object.hasOwn(backend.workspace, "projectId"), false);
    assert.equal(backend.workspace.configPath, configPath);
    assert.equal(backend.workspace.root, join(dirname(configPath), storageDir));
    assert.deepEqual(
      backend.workspace.config,
      (await openWorkspace(directory, undefined, options)).config,
    );
    assert.deepEqual(await snapshot(directory), before);

    const ordinary = await createLocalBackend(directory);
    assert.equal(ordinary.workspace.root, backend.workspace.root);
    assert.deepEqual(ordinary.workspace.config, backend.workspace.config);
    assert.equal(
      await readFile(join(ordinary.localWorkspace!.runtime, ".gitignore"), "utf8"),
      "*\n",
    );
    assert.deepEqual(await readdir(ordinary.workspace.root), []);
  });
}

test("local config read: реальные config/dataRoot через symlink и отсутствующих потомков", async (t) => {
  const directory = await fixture(t);
  const project = join(directory, "project");
  const target = join(directory, "data");
  await mkdir(target);
  const configPath = await bare(project, "../linked/missing/tasks");
  await symlink(target, join(project, "linked"));
  const alias = join(directory, "alias");
  await symlink(project, alias);
  const before = await snapshot(directory);
  const backend = await createLocalBackend(directory, "alias/.relay/config.json", options);
  assert.equal(backend.workspace.configPath, configPath);
  assert.equal(backend.workspace.root, join(target, "missing/tasks"));
  assert.deepEqual(await snapshot(directory), before);
  assert.equal((await openWorkspace(alias)).dataRoot, backend.workspace.root);
});

test("local config read: текущая PROJECT-проекция, настоящий корень и свежесть следующего открытия", async (t) => {
  const directory = await fixture(t);
  const workspace = await initialize(directory, "never/legacy/tasks", "custom/project.json");
  const saved = await saveProjectSettings(workspace, {
    name: "Актуальное имя PROJECT",
    slug: "actual-project",
    ifRevision: 1,
  });
  // Сырой config не является источником предметных настроек.
  assert.notEqual(
    JSON.parse(await readFile(workspace.configPath, "utf8")).projectSettings?.name,
    saved.name,
  );
  await rm(join(workspace.dataRoot, "runtime"), { recursive: true });
  const before = await snapshot(directory);
  const backend = await createLocalBackend(directory, workspace.configPath, options);
  assert.equal(backend.workspace.projectId, workspace.config.projectId);
  assert.equal(backend.workspace.root, dirname(workspace.configPath));
  assert.equal(backend.workspace.configPath, workspace.configPath);
  assert.equal(backend.workspace.config.projectSettings?.name, saved.name);
  assert.equal(backend.workspace.config.projectSettings?.slug, saved.slug);
  assert.equal(backend.workspace.config.projectSettings?.revision, saved.revision);
  assert.deepEqual(await snapshot(directory), before);
  await saveProjectSettings(workspace, {
    name: "Следующее имя",
    slug: saved.slug,
    ifRevision: saved.revision,
  });
  const next = await createLocalBackend(directory, workspace.configPath, options);
  assert.equal(next.workspace.config.projectSettings?.name, "Следующее имя");
  assert.equal(next.workspace.config.projectSettings?.revision, saved.revision + 1);
});

test("local config read: отсутствующий и повреждённый config не создаёт файлов", async (t) => {
  const directory = await fixture(t);
  const empty = await snapshot(directory);
  await assert.rejects(createLocalBackend(directory, undefined, options), {
    code: "CONFIG_NOT_FOUND",
  });
  await assert.rejects(createLocalBackend(directory, "absent/config.json", options), {
    code: "NOT_FOUND",
  });
  assert.deepEqual(await snapshot(directory), empty);
  const path = await bare(directory);
  await writeFile(path, "{broken");
  const broken = await snapshot(directory);
  await assert.rejects(createLocalBackend(directory, undefined, options), { code: "INVALID_DATA" });
  assert.deepEqual(await snapshot(directory), broken);
});

test("local config read: совместимость manifest не ослаблена и старый профиль не мигрирует", async (t) => {
  const directory = await fixture(t);
  const workspace = await initialize(directory, "tasks");
  const manifestPath = join(workspace.dataRoot, "storage.json");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const { dataModelVersion: _profile, ...unmarked } = current;
  for (const manifest of [unmarked, { format: "relay-entities", schemaVersion: 3 }]) {
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await snapshot(directory);
    const backend = await createLocalBackend(directory, undefined, options);
    // Конфигурация остаётся доступной, как раньше; предметный вход требует миграцию.
    assert.deepEqual(backend.workspace.config, (await openWorkspace(directory)).config);
    await assert.rejects(backend.projectSettings.get(), { code: "STORAGE_MIGRATION_REQUIRED" });
    assert.deepEqual(await snapshot(directory), before);
  }
  for (const [manifest, code] of [
    [{ ...current, dataModelVersion: 3 }, "STORAGE_VERSION_UNSUPPORTED"],
    [{ format: "relay-entities", schemaVersion: 5 }, "STORAGE_VERSION_UNSUPPORTED"],
    [{ format: "unknown", schemaVersion: 4 }, "STORAGE_FORMAT_UNKNOWN"],
  ] as const) {
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await snapshot(directory);
    await assert.rejects(createLocalBackend(directory, undefined, options), { code });
    assert.deepEqual(await snapshot(directory), before);
  }
});

/** Настоящий publisher прерывается после долговечной записи обычного intent. */
async function pendingProjectUpdate(workspace: Workspace) {
  const store = await EntityStore.open(workspace.dataRoot, workspaceStorageRegistry(), (stage) => {
    if (stage === "intent") throw new Error("Остановка после обычного intent");
  });
  await assert.rejects(
    store.run(
      { namespace: "test", actor: "agent", requestId: "pending", request: {} },
      async (session) => {
        const previous = await session.get({ kind: "project", id: workspace.config.projectId! });
        await session.put(
          {
            ...previous,
            revision: previous.revision + 1,
            data: { ...previous.data, name: "Имя после recovery" },
          },
          previous.revision,
        );
        return null;
      },
    ),
    /Остановка после обычного intent/,
  );
  assert.equal((await inspectPending(workspace.dataRoot)).kind, "operation");
}

test("local config read: обычный WAL восстанавливается до проекции, повтор не пишет", async (t) => {
  const directory = await fixture(t);
  const workspace = await initialize(directory, "tasks");
  await pendingProjectUpdate(workspace);
  const backend = await createLocalBackend(directory, undefined, options);
  assert.equal(backend.workspace.config.projectSettings?.name, "Имя после recovery");
  assert.equal(backend.workspace.config.projectSettings?.revision, 2);
  assert.equal((await inspectPending(workspace.dataRoot)).kind, "none");
  const recovered = await snapshot(directory);
  assert.deepEqual(
    (await createLocalBackend(directory, undefined, options)).workspace,
    backend.workspace,
  );
  assert.deepEqual(await snapshot(directory), recovered);
});

test("local config read: обычный WAL не затирает внешнюю правку и не обходит будущий профиль", async (t) => {
  const directory = await fixture(t);
  const workspace = await initialize(directory, "tasks");
  await pendingProjectUpdate(workspace);
  const projectPath = join(
    workspace.dataRoot,
    "entities/projects",
    `${workspace.config.projectId}.json`,
  );
  const projectBytes = await readFile(projectPath, "utf8");
  const record = JSON.parse(projectBytes);
  record.data.name = "Чужая правка";
  await writeFile(projectPath, JSON.stringify(record));
  const before = await snapshot(directory);
  await assert.rejects(createLocalBackend(directory, undefined, options), {
    code: "STORAGE_RECOVERY_CONFLICT",
  });
  assert.deepEqual(await snapshot(directory), before);
  await writeFile(projectPath, projectBytes);
  const manifestPath = join(workspace.dataRoot, "storage.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, dataModelVersion: 3 }));
  const future = await snapshot(directory);
  await assert.rejects(createLocalBackend(directory, undefined, options), {
    code: "STORAGE_VERSION_UNSUPPORTED",
  });
  assert.deepEqual(await snapshot(directory), future);
});

test("local config read: миграционный и неизвестный WAL не открывается и не создаёт runtime", async (t) => {
  const directory = await fixture(t);
  const configPath = await bare(directory);
  const root = dirname(configPath);
  await mkdir(join(root, "transactions"));
  const pending = join(root, "transactions/pending.json");
  for (const [intent, code] of [
    [
      {
        schemaVersion: 2,
        changes: [],
        migration: {
          id: randomUUID(),
          registryDigest: "a".repeat(64),
          planFingerprint: "b".repeat(64),
          source: { layout: "legacy", physical: null, profile: null },
          target: { profile: 2 },
          transitions: ["physical.legacy-to-4@1"],
          backup: { path: join(directory, "backup"), manifestSha256: "c".repeat(64) },
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
    await writeFile(pending, JSON.stringify(intent));
    const before = await snapshot(directory);
    await assert.rejects(createLocalBackend(directory, undefined, options), { code });
    assert.deepEqual(await snapshot(directory), before);
  }
});
