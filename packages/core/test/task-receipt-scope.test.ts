import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fixture, legacyFixture, seedLegacyTask, seedLegacyComment } from "./helpers/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { StorageService } from "../src/application/storage/service.js";
import { openWorkspace } from "../src/storage/workspace.js";
import type { Workspace } from "../src/storage/workspace.js";
import { createBoardTaskSchema, updateBoardTaskSchema } from "../src/domain/board-task.js";
import { activityHash } from "../src/storage/task-activity.js";

async function remove(workspace: Workspace, ref: string, requestId: string) {
  const service = new EntityDeletionService(workspace);
  const preview = await service.preview({ ref, kind: "task" });
  return service.delete({ ref, kind: "task", ifVersion: preview.version, requestId }, "qa");
}

test("первый legacy retry после migrate→delete→reindex/reopen возвращает create/update/comment из tombstone", async (t) => {
  const { root, workspace } = await legacyFixture(t);
  const tasks = new BoardTasksService(workspace);
  const create = { board: "product", title: "Прежняя задача", description: "## Создано\r\n\n  исходный текст  \n", includeTask: true, requestId: "old-create" };
  const initial = await seedLegacyTask(workspace, { title: create.title, description: create.description, keys: ["OLD-1", "PRODUCT-1"] });
  const created = { id: initial.id, key: initial.key, boardId: initial.boardId, revision: 1, action: "create" as const, requestId: create.requestId, task: await tasks.get(initial.id) };
  const update = { title: "Изменённая задача", ifRevision: 1, requestId: "old-update" };
  const updated = { id: initial.id, key: initial.key, boardId: initial.boardId, revision: 2, action: "update" as const, requestId: update.requestId };
  const task = await seedLegacyTask(workspace, { ...initial, revision: 2, title: update.title, requests: {
    [activityHash(["qa", create.requestId])]: { hash: activityHash(["create", undefined, { ...createBoardTaskSchema.parse(create), actor: "qa" }]), result: created },
    [activityHash(["qa", update.requestId])]: { hash: activityHash(["update", initial.id, { ...updateBoardTaskSchema.parse(update), actor: "qa" }]), result: updated },
  } });
  const comment = { title: "Прежний комментарий", description: "## Комментарий\r\n\n  сообщение  \n", actor: "qa", actorRole: "worker" as const, requestId: "old-comment" };
  const published = await seedLegacyComment(workspace, task, comment);
  assert.equal((await new StorageService(workspace).migrate()).migrated, true);
  const path = join(dirname(workspace.configPath), "entities/tasks", `${task.id}.json`);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert(migrated.receipts.every((receipt: { namespace: string }) => receipt.namespace.startsWith("legacy:")));
  const state = JSON.parse(await readFile(join(dirname(workspace.configPath), ".indexes/state.json"), "utf8"));
  assert.equal(typeof state.roots["task-request-receipts"], "string", "Общий индекс создаётся при миграции, не при первом retry");
  await remove(workspace, task.key, "delete-first");
  await new StorageService(workspace).reindex();
  const reopened = await openWorkspace(root);
  const retry = new BoardTasksService(reopened);
  assert.deepEqual(await retry.create(create, "qa"), created);
  assert.deepEqual(await retry.update("OLD-1", update, "qa"), updated);
  assert.deepEqual(await retry.publishComment(task.key, comment), published);
  await assert.rejects(retry.create({ ...create, title: "Иное" }, "qa"), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(retry.update(task.key, { ...update, ifRevision: 2 }, "qa"), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(retry.publishComment(task.id, { ...comment, description: "Иное" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(retry.create({ ...create, requestId: comment.requestId }, "qa"), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(retry.publishComment(task.key, { ...comment, requestId: create.requestId }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual((await retry.list({ board: "product" })).items, []);
  const tombstone = JSON.parse(await readFile(path, "utf8"));
  assert(tombstone.deleted);
  assert.equal(tombstone.revision, 3);
  assert.equal(tombstone.data, undefined);
  await new StorageService(reopened).reindex();
  const again = new BoardTasksService(await openWorkspace(root));
  assert.deepEqual(await again.create(create, "qa"), created);
  assert.deepEqual(await again.publishComment("OLD-1", comment), published);
});

test("область task/comment actor+requestId сохраняется после удаления обоих владельцев", async (t) => {
  const { root, workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const create = { board: "product", title: "A", requestId: "same" };
  const a = await tasks.create(create, "qa");
  const b = await tasks.create({ board: "product", title: "B", requestId: "b" }, "qa");
  const comment = { title: "C", description: "## C\r\n  текст  \n", actor: "qa", actorRole: "worker" as const, requestId: "same" };
  await assert.rejects(tasks.publishComment(b.key, comment), { code: "IDEMPOTENCY_CONFLICT" });
  const other = await tasks.publishComment(b.key, { ...comment, actor: "other" });
  await remove(workspace, a.key, "delete-a");
  await new StorageService(workspace).reindex();
  const next = new BoardTasksService(await openWorkspace(root));
  await assert.rejects(next.publishComment(b.key, comment), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await next.publishComment(b.key, { ...comment, actor: "other" }), other);
  const first = await next.publishComment(b.key, { ...comment, requestId: "comment-first" });
  assert.equal(first.commentId, "2", "Отказы и повторы не расходуют номера комментариев");
  await assert.rejects(next.create({ board: "product", requestId: first.requestId }, "qa"), { code: "IDEMPOTENCY_CONFLICT" });
  await remove(workspace, b.key, "delete-b");
  await new StorageService(workspace).reindex();
  const after = new BoardTasksService(await openWorkspace(root));
  await assert.rejects(after.create({ board: "product", requestId: first.requestId }, "qa"), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(after.create({ board: "product", requestId: "same" }, "other"), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await after.create(create, "qa"), a);
  assert.deepEqual(await after.publishComment(b.key, { ...comment, actor: "other" }), other);
  const allowed = await after.create({ board: "product", requestId: "same" }, "third");
  assert.notEqual(allowed.id, a.id);
  assert.equal(allowed.key, "PRODUCT-3", "Повтор удалённой задачи не создаёт новую запись");
});

test("прежний v3-индекс без общей выборки не теряет область даже после частичного обновления", async (t) => {
  const { root, workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const a = await tasks.create({ board: "product", requestId: "same" }, "qa");
  const b = await tasks.create({ board: "product", requestId: "b" }, "qa");
  await remove(workspace, a.key, "delete");
  const path = join(dirname(workspace.configPath), ".indexes/state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  delete state.roots["task-request-receipts"];
  delete state.roots["receipt-index-meta"];
  await writeFile(path, JSON.stringify(state));
  const before = await readFile(path, "utf8");
  const next = new BoardTasksService(await openWorkspace(root));
  const comment = { title: "Комментарий", description: "Текст", actor: "qa", actorRole: "worker" as const, requestId: "same" };
  await assert.rejects(next.publishComment(b.key, comment), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(await readFile(path, "utf8"), before);
  await next.publishComment(b.key, { ...comment, actor: "other" });
  await assert.rejects(next.publishComment(b.key, comment), { code: "IDEMPOTENCY_CONFLICT" });
});
