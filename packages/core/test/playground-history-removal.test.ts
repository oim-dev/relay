import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { withStorageLock } from "../src/storage/lock.js";
import { digest, jsonValue } from "../src/storage/entity-store/format.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { StorageService } from "../src/application/storage/service.js";

async function files(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory())
      for (const [key, value] of await files(root, path)) result.set(key, value);
    else if (entry.isFile()) result.set(path, await readFile(join(root, path), "utf8"));
    else throw new Error(`Неожиданный источник: ${path}`);
  }
  return result;
}
function current(raw: string) {
  const value = JSON.parse(raw);
  delete value.schemaVersion;
  for (const key of ["receipts", "requests", "events", "planningEvents"]) {
    delete value[key];
    if (value.data) delete value.data[key];
  }
  return value;
}

function measure(all: Map<string, string>) {
  let bytes = 0,
    fields = 0,
    arrays = 0;
  const check = (value: unknown): void => {
    if (Array.isArray(value)) {
      arrays++;
      value.forEach(check);
    } else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        assert(!["receipts", "requests", "events", "planningEvents"].includes(key), key);
        fields++;
        check(item);
      }
  };
  for (const [path, raw] of all) {
    bytes += Buffer.byteLength(raw);
    if (path.endsWith(".json")) check(JSON.parse(raw));
  }
  return { files: all.size, bytes, fields, arrays };
}

test(
  "playground: явная миграция только временной копии сохраняет тексты, комментарии, ID и отношения",
  { skip: !process.env.RELAY_MIGRATION_SOURCE },
  async (t) => {
    const source = resolve(process.env.RELAY_MIGRATION_SOURCE!);
    const before = await files(source);
    const root = await mkdtemp(join(tmpdir(), "relay-migration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(source, root, { recursive: true, force: false });
    const store = await EntityStore.open(root, workspaceStorageRegistry());
    await withStorageLock(root, (owned) => store.migrateFormat(owned), join(root, "runtime"));
    const after = await files(root);
    let entities = 0,
      relations = 0;
    for (const [path, raw] of before) {
      if (path.startsWith("entities/") && path.endsWith(".json")) {
        assert.deepEqual(current(after.get(path)!), current(raw), path);
        entities++;
      }
      if (/^(relations|keyspaces)\//.test(path) && path.endsWith(".json")) {
        assert.equal(after.get(path), raw, path);
        relations++;
      }
    }
    for (const [path, raw] of after)
      if (path.endsWith(".json")) {
        assert(!/^(history|operations|audit|receipts|requests)\//.test(path), path);
        const check = (value: unknown): void => {
          if (Array.isArray(value)) value.forEach(check);
          else if (value && typeof value === "object")
            for (const [key, item] of Object.entries(value)) {
              assert(
                !["receipts", "requests", "events", "planningEvents"].includes(key),
                `${path}: ${key}`,
              );
              check(item);
            }
        };
        check(JSON.parse(raw));
      }
    await store.reindex();
    const taskId = process.env.RELAY_MIGRATION_TASK;
    if (taskId) {
      const workspace = await openWorkspace(root, join(root, "config.json"));
      // Публичный reindex включает предметные карточки; низкоуровневый store выше
      // проверяет только воспроизводимость физических индексов.
      await new StorageService(workspace).reindex();
      const tasks = new BoardTasksService(workspace);
      const task = await tasks.get(taskId);
      const baseline = await files(root);
      const path = `entities/tasks/${task.id}.json`;
      const initial = JSON.parse(baseline.get(path)!);
      for (let i = 0; i < 100; i++)
        await tasks.update(
          task.id,
          {
            title: i % 2 ? task.title : "Проверка отсутствия истории",
            ifRevision: task.revision + i,
            requestId: "same-correlation",
          },
          task.updatedBy,
        );
      const final = await files(root);
      const initialSize = measure(baseline),
        finalSize = measure(final);
      assert.equal(finalSize.files, initialSize.files);
      assert.equal(finalSize.fields, initialSize.fields);
      assert.equal(finalSize.arrays, initialSize.arrays);
      assert(finalSize.bytes - initialSize.bytes < 200, JSON.stringify({ initialSize, finalSize }));
      const last = JSON.parse(final.get(path)!);
      assert.equal(last.revision, initial.revision + 100);
      assert.deepEqual(
        { ...last, revision: initial.revision, updatedAt: initial.updatedAt },
        initial,
      );
      t.diagnostic(
        `${task.id}: исходник ${before.get(path)!.split("\n").length - 1} строк/${Buffer.byteLength(before.get(path)!)} Б; после миграции ${baseline.get(path)!.split("\n").length - 1} строк/${Buffer.byteLength(baseline.get(path)!)} Б; после 100 обновлений ${final.get(path)!.split("\n").length - 1} строк/${Buffer.byteLength(final.get(path)!)} Б; вся копия ${JSON.stringify(initialSize)} → ${JSON.stringify(finalSize)}`,
      );
    }
    assert.deepEqual(await files(source), before, "Исходная база не должна изменяться");
    const size = (all: Map<string, string>) =>
      [...all]
        .filter(([path]) => path.startsWith("entities/"))
        .reduce((sum, [, value]) => sum + Buffer.byteLength(value), 0);
    t.diagnostic(
      `Сохранено ${entities} сущностей, ${relations} файлов связей/ключей; entities ${size(before)} → ${size(after)} байт; источник ${digest(jsonValue([...before]))} неизменён`,
    );
  },
);
