import assert from "node:assert/strict";
import { legacyWorkspace } from "./helpers/workspace.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { projectSettings } from "../src/storage/project-settings.js";
import { saveProjectSettings } from "../src/application/project-settings/service.js";
import { StorageService } from "../src/application/storage/service.js";

test("настройки: случайный адрес, атомарное сохранение, повтор и конкуренция", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const initial = projectSettings(workspace.config, workspace.configPath);
  assert.match(initial.slug, /^project-[a-z0-9]{4}$/);
  const input = { name: "  Мой проект  ", slug: "my-project", ifRevision: initial.revision };
  const saved = await saveProjectSettings(workspace, input);
  assert.equal(saved.name, "Мой проект");
  assert.deepEqual(await saveProjectSettings(workspace, input), saved);
  const reopened = await openWorkspace(root);
  assert.deepEqual(projectSettings(reopened.config, reopened.configPath), saved);
  assert.equal(reopened.config.projectId, workspace.config.projectId);
  assert.deepEqual(reopened.config.statuses, workspace.config.statuses);
  const concurrent = await Promise.allSettled([
    saveProjectSettings(workspace, { name: "Первый", slug: "one", ifRevision: saved.revision }),
    saveProjectSettings(workspace, { name: "Второй", slug: "two", ifRevision: saved.revision }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const failure = concurrent.find((result) => result.status === "rejected");
  assert.equal(failure?.reason.code, "REVISION_CONFLICT");
  for (const slug of ["Upper", "../path", "with space", "-start", "end-", "double--dash", "язык"]) {
    await assert.rejects(saveProjectSettings(workspace, { ...input, slug }), {
      code: "VALIDATION_ERROR",
    });
  }
  await assert.rejects(saveProjectSettings(workspace, { ...input, name: "Первая\nВторая" }), {
    code: "VALIDATION_ERROR",
  });
});

test("старый конфиг читается без записи; первое сохранение не меняет ID и остальные параметры", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-old-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await legacyWorkspace(root);
  const { projectSettings: omitted, ...oldConfig } = workspace.config;
  await writeFile(workspace.configPath, JSON.stringify(oldConfig));
  const before = await readFile(workspace.configPath, "utf8");
  const legacy = await openWorkspace(root);
  const settings = projectSettings(legacy.config, legacy.configPath);
  assert.equal(settings.revision, 0);
  assert.deepEqual(projectSettings(legacy.config, legacy.configPath), settings);
  assert.equal(await readFile(workspace.configPath, "utf8"), before);
  const input = { name: "Прежний проект", slug: "legacy", ifRevision: 0 };
  await assert.rejects(saveProjectSettings(legacy, input), { code: "STORAGE_MIGRATION_REQUIRED" });
  assert.equal(await readFile(workspace.configPath, "utf8"), before);
  await new StorageService(legacy).migrate();
  await saveProjectSettings(legacy, input);
  const { projectSettings: stored, ...unchanged } = (await openWorkspace(root)).config;
  assert.deepEqual(unchanged, oldConfig);
  assert.equal(stored?.version, 3);
  assert.equal(stored?.revision, 1);
  assert.equal(stored?.events, undefined);
});
