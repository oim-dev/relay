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

test("init/read/reindex не создают общего журнала; правки и граф не создают комментариев", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-without-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const tasks = new BoardTasksService(workspace);
  const first = await tasks.create({ board: "product", requestId: "first" }, "agent");
  const second = await tasks.create({ board: "product", requestId: "second" }, "agent");
  await tasks.update(first.id, { title: "Новое", ifRevision: 1, requestId: "edit" }, "agent");
  const graph = new GraphService(workspace);
  await graph.mutate({ ifVersion: (await graph.read()).version, requestId: "link",
    operations: [{ action: "add", type: "references", from: first.id, to: second.id, description: "" }] }, "agent");
  assert.deepEqual((await tasks.listComments(first.id)).items, []);
  assert.equal((await tasks.listComments(first.id)).snapshot, 0);
  const message = { title: "Ответ", description: "## Итог\r\n\n  точный текст  \n", actor: "worker", actorRole: "worker" as const, requestId: "message" };
  const [published, repeated] = await Promise.all([tasks.publishComment(first.id, message), tasks.publishComment(first.id, message)]);
  assert.deepEqual(published, repeated);
  await tasks.move(first.id, { board: "infrastructure", column: "done", ifRevision: 2, requestId: "move" }, "agent");
  assert.deepEqual(await tasks.publishComment(first.key, message), published);
  assert.equal((await tasks.getComment(first.id, published.commentId)).description, message.description);
  await new ProductQueries(workspace).entities();
  await new StorageService(workspace).reindex();
  const reopened = await openWorkspace(root);
  assert.equal((await new BoardTasksService(reopened).getComment(first.id, published.commentId)).description, message.description);
  const storage = dirname(workspace.configPath);
  for (const directory of ["tasks", "boards", "product", "operations", "history", "task-activity", "audit", "receipts"])
    assert(!(await readdir(storage)).includes(directory), directory);
  assert(!(await readdir(join(storage, "runtime"))).includes("history-writer.json"));
  const raw = JSON.parse(await readFile(join(storage, "entities/tasks", `${first.id}.json`), "utf8"));
  assert.equal(raw.comments.length, 1);
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
  assert.equal((await new StorageService(reopened).migrate()).migrated, false);
});
