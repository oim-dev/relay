import assert from "node:assert/strict";
import { legacyFixture, seedLegacyTask, seedLegacyComment } from "./helpers/workspace.js";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskCommentSchema,
  taskCommentsQuerySchema,
  taskCommentsPageSchema,
} from "@relay/contracts/entities/task-comments";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { StorageService } from "@relay/core/application/storage/service";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { fixture } from "./helpers/workspace.js";

const message = {
  title: "Результат проверки",
  description: "## Результат\r\n\r\n  Значимые пробелы  \r\n\n",
  actor: "worker",
  actorRole: "worker" as const,
  requestId: "comment",
};

test("контракт комментариев не принимает аудит и сохраняет прежнюю форму сообщения", () => {
  const comment = {
    id: "5",
    taskId: "task",
    sequence: 5,
    at: "2026-09-26T10:00:00.000Z",
    actor: "worker",
    actorRole: "worker",
    action: "comment-publish",
    title: message.title,
    operationId: "operation",
    revision: 2,
    legacy: false,
    fields: [],
    changes: [],
    description: message.description,
  };
  assert.deepEqual(taskCommentSchema.parse(comment), comment);
  assert.equal(taskCommentSchema.safeParse({ ...comment, action: "update" }).success, false);
  assert.equal(taskCommentSchema.safeParse({ ...comment, fields: ["title"] }).success, false);
  assert.equal(taskCommentSchema.safeParse({ ...comment, changes: [{}] }).success, false);
  assert.equal(taskCommentsQuerySchema.safeParse({ action: "create" }).success, false);
  assert.deepEqual(taskCommentsQuerySchema.parse({ limit: "2", after: "5" }), {
    limit: 2,
    after: 5,
  });
  assert.deepEqual(taskCommentsQuerySchema.parse({}), { limit: 20 });
  assert.equal(
    taskCommentsPageSchema.safeParse({ items: [comment], snapshot: 5, nextCursor: null }).success,
    false,
  );
});

test("комментарийный Core API: изоляция от аудита, точный wire shape, снимок, фильтр и алиас", async (t) => {
  const { workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const task = await tasks.create({ board: "product", requestId: "task" }, "worker");
  const empty = await tasks.listComments(task.id);
  assert.deepEqual(empty.items, []);
  assert.equal("listActivity" in tasks, false);
  await assert.rejects(tasks.getComment(task.id, "1"), { code: "NOT_FOUND" });
  await assert.rejects(tasks.listComments(task.id, { action: "update" } as never), {
    code: "VALIDATION_ERROR",
  });
  const first = await tasks.publishComment(task.id, message);
  assert.equal((await tasks.getComment(task.id, first.commentId)).action, "comment-publish");
  assert.equal((await tasks.getComment(task.id, first.commentId)).description, message.description);
  assert.equal((await tasks.get(task.id)).revision, 1);
  await tasks.update(
    task.id,
    { title: "Другая задача", ifRevision: 1, requestId: "update" },
    "worker",
  );
  await tasks.publishComment(task.id, { ...message, requestId: "second" });
  const page = await tasks.listComments(task.id, { limit: 1 });
  assert.ok(page.nextCursor);
  assert(page.items.every((entry) => entry.action === "comment-publish"));
  const latest = await tasks.publishComment(task.id, {
    ...message,
    actor: "operator",
    actorRole: "operator",
    requestId: "third",
  });
  const next = await tasks.listComments(task.id, { limit: 1, cursor: page.nextCursor });
  assert.equal(next.snapshot, page.snapshot);
  assert.equal(next.items[0]!.id, first.commentId);
  assert.equal("description" in next.items[0]!, false);
  assert.deepEqual(
    (await tasks.listComments(task.id, { after: page.snapshot })).items.map((item) => item.id),
    [latest.commentId],
  );
  assert.deepEqual(
    (await tasks.listComments(task.id, { actor: "operator", action: "comment-publish" })).items.map(
      (item) => item.id,
    ),
    [latest.commentId],
  );
  await tasks.move(
    task.id,
    { board: "infrastructure", column: "inbox", ifRevision: 2, requestId: "move" },
    "worker",
  );
  assert.notEqual((await tasks.publishComment(task.key, message)).commentId, first.commentId);
  assert.equal(
    (await tasks.getComment(task.key, first.commentId)).description,
    message.description,
  );
});

test("комментарии: временная legacy-база, существующая миграция, reindex и повтор после удаления", async (t) => {
  const { root, workspace } = await legacyFixture(t);
  const tasks = new BoardTasksService(workspace);
  const task = await seedLegacyTask(workspace);
  const saved = await seedLegacyComment(workspace, task, message);
  const before = await tasks.getComment(task.id, saved.commentId);
  await new StorageService(workspace).migrate();
  const reopened = await openWorkspace(root);
  const migrated = new BoardTasksService(reopened);
  assert.deepEqual(await migrated.getComment(task.id, saved.commentId), before);
  assert.notEqual((await migrated.publishComment(task.id, message)).commentId, saved.commentId);
  await new StorageService(reopened).reindex();
  assert.deepEqual(await migrated.getComment(task.id, saved.commentId), before);
  // После удаления публикация не возвращает прежний результат.
  const input = { ...message, requestId: "after-migration" };
  await migrated.publishComment(task.key, input);
  const deletion = new EntityDeletionService(reopened);
  const preview = await deletion.preview({ ref: task.key, kind: "task" });
  await deletion.delete(
    { ref: task.key, kind: "task", ifVersion: preview.version, requestId: "delete" },
    "worker",
  );
  await new StorageService(reopened).reindex();
  await assert.rejects(migrated.publishComment(task.key, input));
  await assert.rejects(migrated.publishComment(task.key, { ...input, title: "Иное" }));
});

test("комментарии: конкурентные публикации не дедуплицируются и не резервируют requestId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-comments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const tasks = new BoardTasksService(workspace);
  const task = await tasks.create({ board: "product", requestId: "task" }, "worker");
  const reopened = new BoardTasksService(await openWorkspace(root));
  const [first, second] = await Promise.all([
    tasks.publishComment(task.id, message),
    reopened.publishComment(task.id, message),
  ]);
  assert.notEqual(first.commentId, second.commentId);
  assert.equal((await tasks.listComments(task.id)).items.length, 2);
  await tasks.update(
    task.id,
    { title: "Иное", ifRevision: 1, requestId: message.requestId },
    message.actor,
  );
  assert.equal(
    (await reopened.getComment(task.id, first.commentId)).description,
    message.description,
  );
});
