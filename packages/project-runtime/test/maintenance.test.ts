import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { readConfiguration } from "../src/config.js";
import { locateMaintenanceTarget, requireLocalMaintenance } from "../src/maintenance.js";
import { initializeRegistry, registerProject } from "../src/registry.js";

async function temporaryRoot(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-maintenance-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Побайтовый снимок дерева, включая runtime: поиск цели ничего не создаёт. */
async function digest(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, relative: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result[`${name}/`] = "dir";
        await walk(join(path, entry.name), name);
      } else
        result[name] = createHash("sha256")
          .update(await readFile(join(path, entry.name)))
          .digest("hex");
    }
  }
  await walk(directory, "");
  return result;
}

async function editJson(path: string, change: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(path, "utf8"));
  change(value);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

test("HTTP-режим возвращает LOCAL_REQUIRED до чтения файлов и сети", async (t) => {
  const root = await temporaryRoot(t);
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("сеть недоступна в тесте");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.throws(() => requireLocalMaintenance({ serverUrl: "http://127.0.0.1:4700" }), {
    code: "LOCAL_REQUIRED",
    exitCode: 2,
  });
  requireLocalMaintenance({ local: true, serverUrl: "http://127.0.0.1:4700" });
  requireLocalMaintenance({});
  await assert.rejects(
    locateMaintenanceTarget({
      cwd: join(root, "нет-такого-каталога"),
      serverUrl: "http://127.0.0.1:4700",
    }),
    (error: Error & { code?: string; details?: { code?: string; next?: unknown } }) => {
      assert.equal(error.code, "LOCAL_REQUIRED");
      assert.equal(error.details?.code, "LOCAL_REQUIRED");
      return true;
    },
  );
  // server.url в конфиге проекта тоже выбирает HTTP, как у обычного CLI.
  const workspace = await initialize(join(root, "app"), "tasks");
  await editJson(workspace.configPath, (config) => {
    config.server = { port: 4700, url: "http://127.0.0.1:4700" };
  });
  await assert.rejects(locateMaintenanceTarget({ cwd: join(root, "app") }), {
    code: "LOCAL_REQUIRED",
  });
  assert.equal(
    (await locateMaintenanceTarget({ cwd: join(root, "app"), local: true })).configPath,
    workspace.configPath,
  );
  assert.equal(requests, 0);
});

test("старая схема проекта и нестандартное имя конфига находятся без разбора и записи", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = await initialize(root, "tasks");
  await editJson(workspace.configPath, (config) => {
    config.boards = { product: { title: "Поле прежней схемы" } };
  });
  await mkdir(join(root, "src/deep"), { recursive: true });
  const before = await digest(root);
  await assert.rejects(readConfiguration(join(root, "src/deep")), { code: "VALIDATION_ERROR" });
  const found = await locateMaintenanceTarget({ cwd: join(root, "src/deep") });
  assert.equal(found.configPath, workspace.configPath);
  assert.equal(found.source.root, join(root, ".relay"));
  assert.equal(found.source.config?.projectId, workspace.config.projectId);

  const custom = join(root, ".relay/project-a.json");
  await rename(workspace.configPath, custom);
  const renamed = await digest(root);
  const explicit = await locateMaintenanceTarget({
    cwd: join(root, "src"),
    config: "../.relay/project-a.json",
    local: true,
  });
  assert.equal(explicit.configPath, custom);
  assert.equal(explicit.registry, undefined);
  await assert.rejects(
    locateMaintenanceTarget({ cwd: root, config: ".relay/project-a.json", project: "a" }),
    { code: "REGISTRY_REQUIRED" },
  );
  assert.deepEqual(await digest(root), renamed);
  assert.notDeepEqual(renamed, before);
});

test("база без конфига с незавершённой транзакцией находится без recovery", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = await initialize(root, "tasks");
  await rm(workspace.configPath);
  await mkdir(join(root, ".relay/transactions"), { recursive: true });
  await writeFile(join(root, ".relay/transactions/pending.json"), '{"version":1}\n');
  const before = await digest(root);
  const found = await locateMaintenanceTarget({ cwd: root, local: true });
  assert.equal(found.configPath, join(root, ".relay/config.json"));
  assert.equal(found.source.config, null);
  assert.deepEqual(await digest(root), before);
});

test("проект реестра выбирается точно через --project только локально; реестр не меняется", async (t) => {
  const root = await temporaryRoot(t);
  const a = await initialize(join(root, "a"), "tasks");
  await initialize(join(root, "b"), "tasks");
  await editJson(a.configPath, (config) => {
    config.boards = {};
  });
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "a" });
  await registerProject(registry.configPath, "b", { path: "b" });
  const before = await digest(root);
  const found = await locateMaintenanceTarget({ cwd: root, project: "a", local: true });
  assert.equal(found.configPath, a.configPath);
  assert.deepEqual(found.registry, { path: registry.configPath, project: "a" });
  const explicit = await locateMaintenanceTarget({
    cwd: join(root, "b"),
    config: "../relay.workspace.json",
    project: "b",
    local: true,
  });
  assert.equal(explicit.configPath, join(root, "b/.relay/config.json"));
  await assert.rejects(locateMaintenanceTarget({ cwd: root, project: "a" }), {
    code: "LOCAL_REQUIRED",
  });
  await assert.rejects(locateMaintenanceTarget({ cwd: root, local: true }), {
    code: "PROJECT_REQUIRED",
  });
  await assert.rejects(locateMaintenanceTarget({ cwd: root, project: "c", local: true }), {
    code: "PROJECT_NOT_FOUND",
  });
  // --project относится только к реестру и не меняет смысл конфига проекта.
  await assert.rejects(
    locateMaintenanceTarget({
      cwd: root,
      config: "a/.relay/config.json",
      project: "a",
      local: true,
    }),
    { code: "REGISTRY_REQUIRED" },
  );
  assert.deepEqual(await digest(root), before);
});
