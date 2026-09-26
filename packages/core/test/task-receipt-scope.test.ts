import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { StorageService } from "../src/application/storage/service.js";
import { openWorkspace } from "../src/storage/workspace.js";

test("requestId не резервируется задачей или комментарием; свежая ревизия определяет допустимость", async (t) => {
  const { root, workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const input = { board: "product", title: "Задача", requestId: "same" };
  const a = await tasks.create(input, "agent");
  const b = await tasks.create(input, "agent");
  assert.notEqual(a.id, b.id);
  const comment = {
    title: "Ответ",
    description: "Текст\r\n",
    actor: "agent",
    actorRole: "worker" as const,
    requestId: "same",
  };
  const first = await tasks.publishComment(a.id, comment);
  const second = await tasks.publishComment(a.id, comment);
  assert.notEqual(first.commentId, second.commentId);
  const update = { title: "Правка", ifRevision: 1, requestId: "same" };
  await tasks.update(a.id, update, "agent");
  await new StorageService(workspace).reindex();
  const reopened = new BoardTasksService(await openWorkspace(root));
  await assert.rejects(reopened.update(a.id, update, "agent"), { code: "REVISION_CONFLICT" });
  assert.equal((await reopened.listComments(a.id)).items.length, 2);
});

test("после удаления нет сохранённого результата создания или публикации", async (t) => {
  const { root, workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const input = { board: "product", requestId: "same" };
  const task = await tasks.create(input, "agent");
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.id, kind: "task" });
  await deletion.delete(
    { ref: task.id, kind: "task", ifVersion: preview.version, requestId: "same" },
    "agent",
  );
  await new StorageService(workspace).reindex();
  const next = new BoardTasksService(await openWorkspace(root));
  assert.notEqual((await next.create(input, "agent")).id, task.id);
  await assert.rejects(
    next.publishComment(task.key, {
      title: "Ответ",
      description: "",
      actor: "agent",
      actorRole: "worker",
      requestId: "same",
    }),
  );
});
