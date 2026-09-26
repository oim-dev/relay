import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { fixture } from "./helpers/server.js";

test("HTTP: потеря ответа после публикации не вызывает повтор; состояние читается отдельно", async (t) => {
  const { app, tasks } = await fixture(t);
  const task = await tasks.create({ board: "product", requestId: "task" }, "agent");
  await app.listen(0, "127.0.0.1");
  const backend = await createHttpBackend(await app.getUrl());
  const fetch = globalThis.fetch;
  let publications = 0;
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    if (args[1]?.method === "POST") {
      publications++;
      assert.equal(response.status, 200);
      await response.text();
      throw new TypeError("Ответ потерян после завершённой записи");
    }
    return response;
  });
  await assert.rejects(
    backend.boardTasks.publishComment(task.id, {
      title: "Отчёт",
      description: "## Проверено\n\nПолный текст\n",
      actor: "worker",
      actorRole: "worker",
      requestId: "correlation",
    }),
    { code: "SERVER_UNAVAILABLE", message: /Запись могла завершиться.*Перечитайте состояние/ },
  );
  assert.equal(publications, 1);
  const comments = await backend.boardTasks.listComments(task.id);
  assert.equal(comments.items.length, 1);
  assert.equal(
    (await backend.boardTasks.getComment(task.id, comments.items[0]!.id)).description,
    "## Проверено\n\nПолный текст\n",
  );
});
