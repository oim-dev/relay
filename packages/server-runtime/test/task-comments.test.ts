import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { fixture } from "./helpers/server.js";

test("HTTP: комментарии, авторство, повтор и отсутствие общего history API", async (t) => {
  const { app, tasks, workspace } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "Оператор");
  const base = `/api/v1/projects/${workspace.config.projectId}/board-tasks/${task.id}`;
  const payload = {
    title: "Отчёт",
    description: "## Полный текст\n\n- Проверено\n",
    actor: "worker-api",
    actorRole: "worker",
    requestId: "message",
  };
  const created = await app.inject({ method: "POST", url: `${base}/comments`, payload });
  assert.equal(created.statusCode, 200, created.body);
  const saved = created.json().data;
  const repeated = await app.inject({ method: "POST", url: `${base}/comments`, payload });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.notEqual(repeated.json().data.commentId, saved.commentId);
  assert.equal((await tasks.get(task.id)).revision, 1);
  const page = await app.inject(`${base}/comments?limit=1`);
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().data.items[0].actor, "worker-api");
  assert.equal("description" in page.json().data.items[0], false);
  const full = await app.inject(`${base}/comments/${saved.commentId}`);
  assert.equal(full.json().data.description, payload.description);
  assert.equal(full.json().data.action, "comment-publish");
  assert.deepEqual(full.json().data.fields, []);
  assert.deepEqual(full.json().data.changes, []);
  assert.equal((await app.inject(`${base}/comments/999999`)).statusCode, 404);
  assert.equal((await app.inject(`${base}/comments?cursor=bad`)).statusCode, 400);
  const invalid = await app.inject({
    method: "POST",
    url: `${base}/comments`,
    payload: { ...payload, actor: "", requestId: "bad" },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const another = await app.inject({
    method: "POST",
    url: `${base}/comments`,
    payload: { ...payload, title: "Иное" },
  });
  assert.equal(another.statusCode, 200, another.body);
  const schema = (await app.inject("/api/openapi.json")).json();
  for (const prefix of ["/api/v1", `/api/v1/projects/${workspace.config.projectId}`]) {
    for (const path of [
      "entities/history",
      "graph/history",
      `board-tasks/${task.id}/history`,
      `board-tasks/${task.id}/history/${saved.commentId}`,
    ]) {
      const response = await app.inject(`${prefix}/${path}`);
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().ok, false);
    }
  }
  assert.equal(
    Object.keys(schema.paths).some((path) => path.includes("/history")),
    false,
  );
  for (const name of [
    "EntityHistory",
    "GraphHistory",
    "GraphHistoryQuery",
    "TaskHistoryEvent",
    "TaskActivityQuery",
    "TaskActivityPage",
  ]) {
    assert.equal(name in schema.components.schemas, false, name);
  }
  assert.ok(schema.paths["/api/v1/projects/{project}/board-tasks/{reference}/comments"].get);
  assert.ok(schema.components.schemas.PublishTaskComment.required.includes("actor"));
  await tasks.update(
    task.id,
    { description: "## Новое описание", ifRevision: 1, requestId: "edit-text" },
    "agent",
  );
  const comments = (await app.inject(`${base}/comments?limit=1&actor=worker-api`)).json().data;
  assert.equal(comments.items.length, 1);
  assert.equal(comments.items[0].id, another.json().data.commentId);
  assert.deepEqual(comments.items[0].fields, []);
  assert.equal((await app.inject(`${base}/comments?actor=other`)).json().data.items.length, 0);
  assert.equal(
    (await app.inject(`${base}/comments/${saved.commentId}`)).json().data.description,
    payload.description,
  );
});

test("Backend local/HTTP: комментарии сохраняют Markdown и курсор; повтор публикует новое сообщение", async (t) => {
  const { app, tasks, root } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "human");
  await app.listen(0, "127.0.0.1");
  const local = await createLocalBackend(root);
  const http = await createHttpBackend(await app.getUrl());
  assert.deepEqual((await http.boardTasks.listComments(task.id)).items, []);
  const command = {
    title: "Полный отчёт",
    description: "## Проверка\n\n" + "Строка Markdown.\n".repeat(1000),
    actor: "worker",
    actorRole: "worker" as const,
    requestId: "first",
  };
  const first = await http.boardTasks.publishComment(task.id, command);
  await local.boardTasks.publishComment(task.id, {
    ...command,
    title: "Второй",
    requestId: "second",
  });
  const repeated = await http.boardTasks.publishComment(task.id, command);
  assert.notEqual(repeated.commentId, first.commentId);
  const page = await http.boardTasks.listComments(task.id, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = await http.boardTasks.listComments(task.id, { limit: 1, cursor: page.nextCursor! });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, page.items[0]!.id);
  assert.deepEqual(
    await http.boardTasks.getComment(task.id, first.commentId),
    await local.boardTasks.getComment(task.id, first.commentId),
  );
  assert.equal(
    (await http.boardTasks.getComment(task.id, first.commentId)).description,
    command.description,
  );
  assert.deepEqual(
    await http.boardTasks.listComments(task.id, { after: first.commentId }),
    await local.boardTasks.listComments(task.id, { after: first.commentId }),
  );
});
