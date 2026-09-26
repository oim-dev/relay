import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/server.js";

test("HTTP: критерии, повтор, конфликт, изоляция и условия завершения", async (t) => {
  const { app, workspace } = await fixture(t);
  const base = `/api/v1/projects/${workspace.config.projectId}/board-tasks`;
  const created = await app.inject({
    method: "POST",
    url: base,
    payload: {
      board: "product",
      column: "ready",
      requestId: "create",
      acceptanceCriteria: [
        { title: "Проверка", summary: "Строка\nСтрока", description: "## Описание\n\nТекст  \n" },
      ],
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.id;
  const list = await app.inject(`${base}/${id}/criteria?limit=1`);
  assert.equal(list.statusCode, 200, list.body);
  const criterionId = list.json().data.items[0].id;
  assert.equal(list.json().data.items[0].description, undefined);
  assert.equal(
    (await app.inject(`${base}/${id}/criteria/${criterionId}`)).json().data.criterion.description,
    "## Описание\n\nТекст  \n",
  );
  const blocked = await app.inject({
    method: "POST",
    url: `${base}/${id}/move`,
    payload: { column: "done", ifRevision: 1, requestId: "blocked" },
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, "TASK_ACCEPTANCE_INCOMPLETE");
  const payload = {
    action: "complete",
    completed: true,
    criterionId,
    ifRevision: 1,
    requestId: "complete",
  };
  const completed = await app.inject({ method: "POST", url: `${base}/${id}/criteria`, payload });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(
    (await app.inject({ method: "POST", url: `${base}/${id}/criteria`, payload })).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${base}/${id}/criteria`,
        payload: { ...payload, requestId: "stale" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject(`/api/v1/projects/missing/board-tasks/${id}/criteria`)).statusCode,
    404,
  );
  const done = await app.inject({
    method: "POST",
    url: `${base}/${id}/move`,
    payload: { column: "done", ifRevision: 2, requestId: "done" },
  });
  assert.equal(done.statusCode, 200, done.body);
  const locked = await app.inject({
    method: "POST",
    url: `${base}/${id}/criteria`,
    payload: { ...payload, completed: false, ifRevision: 3, requestId: "locked" },
  });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().error.code, "TASK_ACCEPTANCE_LOCKED");
});
