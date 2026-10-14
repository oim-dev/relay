import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { StorageService } from "../src/application/storage/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { ProductQueries } from "../src/application/product/queries.js";
import { GraphService } from "../src/application/graph/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { migrationBackupDir } from "./helpers/migration-bases.js";

test("100 смен статуса задачи: размер и число файлов стабильны, все владельцы и tombstone без аудита", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-status-growth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const tasks = new BoardTasksService(workspace);
  const task = await tasks.create({ board: "product", title: "Тест", requestId: "same" }, "agent");
  const plan = await new PlanningService(workspace).create(
    { title: "План", requestId: "same" },
    "agent",
  );
  await new ReleasesService(workspace).create(
    { title: "Релиз", version: "1", planIds: [plan.id], requestId: "same" },
    "agent",
  );
  const storage = dirname(workspace.configPath);
  const snapshot = async () => {
    let bytes = 0,
      files = 0,
      fields = 0,
      arrays = 0;
    const check = (value: unknown): void => {
      if (Array.isArray(value)) {
        arrays++;
        value.forEach(check);
      } else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value)) {
          fields++;
          assert(
            !["receipts", "requests", "events", "planningEvents", "audit", "history"].includes(key),
            key,
          );
          check(item);
        }
    };
    const visit = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await visit(join(path, entry.name));
        else if (entry.name.endsWith(".json")) {
          const raw = await readFile(join(path, entry.name), "utf8");
          files++;
          bytes += Buffer.byteLength(raw);
          check(JSON.parse(raw));
        }
      }
    };
    await visit(storage);
    return { bytes, files, fields, arrays };
  };
  const before = await snapshot();
  for (let i = 0; i < 100; i++)
    await tasks.move(
      task.id,
      { column: i % 2 ? "inbox" : "ready", ifRevision: i + 1, requestId: "same" },
      "agent",
    );
  const after = await snapshot();
  assert.equal(after.files, before.files);
  assert.equal(after.fields, before.fields);
  assert.equal(after.arrays, before.arrays);
  assert(after.bytes - before.bytes < 100, `${before.bytes} → ${after.bytes}`);
  assert.equal((await tasks.listComments(task.id)).items.length, 0);
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.id, kind: "task" });
  await deletion.delete(
    { ref: task.id, kind: "task", ifVersion: preview.version, requestId: "same" },
    "agent",
  );
  await snapshot();
  t.diagnostic(
    `Задача, 100 статусов: ${before.files} → ${after.files} JSON, ${before.bytes} → ${after.bytes} байт; поля ${before.fields} → ${after.fields}; массивы ${before.arrays} → ${after.arrays}`,
  );
});

test("init/read/reindex не создают общего журнала; правки и граф не создают комментариев", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-without-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const tasks = new BoardTasksService(workspace);
  const first = await tasks.create({ board: "product", requestId: "first" }, "agent");
  const second = await tasks.create({ board: "product", requestId: "second" }, "agent");
  await tasks.update(first.id, { title: "Новое", ifRevision: 1, requestId: "edit" }, "agent");
  const graph = new GraphService(workspace);
  await graph.mutate(
    {
      ifVersion: (await graph.read()).version,
      requestId: "link",
      operations: [
        { action: "add", type: "references", from: first.id, to: second.id, description: "" },
      ],
    },
    "agent",
  );
  assert.deepEqual((await tasks.listComments(first.id)).items, []);
  assert.equal((await tasks.listComments(first.id)).snapshot, 0);
  const message = {
    title: "Ответ",
    description: "## Итог\r\n\n  точный текст  \n",
    actor: "worker",
    actorRole: "worker" as const,
    requestId: "message",
  };
  const [published, repeated] = await Promise.all([
    tasks.publishComment(first.id, message),
    tasks.publishComment(first.id, message),
  ]);
  assert.notEqual(published.commentId, repeated.commentId);
  await tasks.move(
    first.id,
    { board: "infrastructure", column: "done", ifRevision: 2, requestId: "move" },
    "agent",
  );
  assert.notEqual((await tasks.publishComment(first.key, message)).commentId, published.commentId);
  assert.equal(
    (await tasks.getComment(first.id, published.commentId)).description,
    message.description,
  );
  await new ProductQueries(workspace).entities();
  await new StorageService(workspace).reindex();
  const reopened = await openWorkspace(root);
  assert.equal(
    (await new BoardTasksService(reopened).getComment(first.id, published.commentId)).description,
    message.description,
  );
  const storage = dirname(workspace.configPath);
  for (const directory of [
    "tasks",
    "boards",
    "product",
    "operations",
    "history",
    "task-activity",
    "audit",
    "receipts",
  ])
    assert(!(await readdir(storage)).includes(directory), directory);
  assert(!(await readdir(join(storage, "runtime"))).includes("history-writer.json"));
  const raw = JSON.parse(
    await readFile(join(storage, "entities/tasks", `${first.id}.json`), "utf8"),
  );
  assert.equal(raw.comments.length, 3);
  assert.deepEqual(raw.comments[0].description, message.description.split("\n"));
  assert.equal(raw.events, undefined);
  assert.equal(raw.requests, undefined);
});

test("прямой init через symlink публикует конфигурацию в каноническом каталоге базы", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "real");
  await mkdir(directory);
  const alias = join(root, "alias");
  await symlink(directory, alias);
  const initialized = await initialize(alias, "tasks");
  const reopened = await openWorkspace(directory);
  assert.equal(initialized.configPath, reopened.configPath);
  assert.equal(initialized.runtime, reopened.runtime);
  const storage = dirname(initialized.configPath);
  // Новая база сразу несёт маркер текущего профиля: прежний строгий parser её отвергает.
  assert.deepEqual(JSON.parse(await readFile(join(storage, "storage.json"), "utf8")), {
    format: "relay-entities",
    schemaVersion: 4,
    productId: initialized.config.projectId,
    dataModelVersion: 2,
  });
  const task = await new BoardTasksService(reopened).create(
    { board: "product", requestId: "init-write" },
    "agent",
  );
  assert.equal(
    JSON.parse(await readFile(join(storage, "entities/tasks", `${task.id}.json`), "utf8"))
      .schemaVersion,
    3,
  );
  assert.equal(
    (await new StorageService(reopened).migrate({ backupDir: await migrationBackupDir() }))
      .migrated,
    false,
  );
});
