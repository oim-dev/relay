import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "../src/application/storage/service.js";
import { exists } from "../src/storage/files.js";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { fixture } from "./helpers/workspace.js";

test("критерии: готовность к работе, завершение, автор, повтор, конфликт и сброс после изменения", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const command = {
    board: "product",
    column: "ready" as const,
    requestId: "task",
    includeTask: true,
    acceptanceCriteria: [
      {
        title: "Сохранение",
        summary: "Первая строка\nВторая",
        description: "## Проверка\n\n  код  \n",
      },
    ],
  };
  const task = await service.create(command, "orchestrator");
  const first = await service.listCriteria(task.id);
  const criterionId = first.items[0]!.id;
  assert.equal("description" in first.items[0]!, false);
  assert.equal((await service.get(task.id)).ready, true);
  assert.equal((await service.get(task.id)).canComplete, false);
  assert.equal((await service.list({ readiness: "ready" })).total, 1);
  await assert.rejects(
    service.move(task.id, { column: "done", ifRevision: 1, requestId: "blocked" }, "human"),
    { code: "TASK_ACCEPTANCE_INCOMPLETE" },
  );
  const completion = {
    action: "complete" as const,
    criterionId,
    completed: true,
    ifRevision: 1,
    requestId: "complete",
  };
  const saved = await service.changeCriterion(task.id, completion, "human");
  assert.equal(saved.criterionId, criterionId);
  const completed = await service.getCriterion(task.id, criterionId);
  assert.equal(completed.criterion.completedBy, "human");
  assert.ok(completed.criterion.completedAt);
  assert.equal((await service.get(task.id)).canComplete, true);
  assert.equal((await service.get(task.id)).column, "ready");
  assert.deepEqual(await service.changeCriterion(task.id, completion, "human"), saved);
  await assert.rejects(
    service.changeCriterion(task.id, { ...completion, requestId: "stale" }, "human"),
    { code: "REVISION_CONFLICT" },
  );
  await assert.rejects(
    service.changeCriterion(task.id, { ...completion, completed: false }, "human"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await service.changeCriterion(
    task.id,
    { action: "update", criterionId, summary: "Уточнение", ifRevision: 2, requestId: "edit" },
    "human",
  );
  const reset = (await service.getCriterion(task.id, criterionId)).criterion;
  assert.equal(reset.completed, false);
  assert.equal(reset.completedAt, null);
  assert.equal(reset.completedBy, null);
  assert.equal(reset.description, command.acceptanceCriteria[0]!.description);
  await service.changeCriterion(
    task.id,
    { ...completion, ifRevision: 3, requestId: "again" },
    "human",
  );
  await service.move(task.id, { column: "done", ifRevision: 4, requestId: "finish" }, "human");
  await assert.rejects(
    service.changeCriterion(
      task.id,
      { action: "remove", criterionId, ifRevision: 5, requestId: "remove-done" },
      "human",
    ),
    { code: "TASK_ACCEPTANCE_LOCKED" },
  );
  assert.deepEqual(await service.create(command, "orchestrator"), task);
  const path = join(dirname(workspace.configPath), "entities/tasks", `${task.id}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(
    stored.data.acceptanceCriteria[0].description,
    command.acceptanceCriteria[0]!.description.split("\n"),
  );
});

test("критерии: страницы, границы, удаление и атомарная конкуренция", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const task = await service.create(
    {
      board: "product",
      requestId: "task",
      acceptanceCriteria: Array.from({ length: 21 }, (_, index) => ({
        title: `Критерий ${index}`,
      })),
    },
    "agent",
  );
  const first = await service.listCriteria(task.id);
  assert.equal(first.items.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(
    (await service.listCriteria(task.id, { offset: 20, version: first.version })).items.length,
    1,
  );
  const writes = await Promise.allSettled(
    ["a", "b"].map((requestId) =>
      service.changeCriterion(
        task.id,
        { action: "add", title: requestId, ifRevision: 1, requestId },
        "agent",
      ),
    ),
  );
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(service.listCriteria(task.id, { version: first.version }), {
    code: "BOARD_CHANGED",
  });
  await service.changeCriterion(
    task.id,
    { action: "remove", criterionId: first.items[0]!.id, ifRevision: 2, requestId: "remove" },
    "agent",
  );
  assert.equal((await service.listCriteria(task.id)).total, 21);
  await assert.rejects(service.getCriterion(task.id, first.items[0]!.id), { code: "NOT_FOUND" });
  await assert.rejects(
    service.create(
      {
        board: "product",
        column: "done",
        requestId: "invalid",
        acceptanceCriteria: [{ title: "Условие" }],
      },
      "agent",
    ),
    { code: "TASK_ACCEPTANCE_INCOMPLETE" },
  );
  await assert.rejects(
    service.create(
      {
        board: "product",
        requestId: "too-many",
        acceptanceCriteria: Array.from({ length: 101 }, () => ({ title: "Условие" })),
      },
      "agent",
    ),
  );
});

test("критерии: v3 читается без записи, миграция сохраняет квитанции и восстанавливает pending", async (t) => {
  const { workspace } = await fixture(t);
  const service = new BoardTasksService(workspace);
  const command = {
    board: "product",
    requestId: "old",
    description: "\nТекст  \n",
    includeTask: true,
  };
  const task = await service.create(command, "agent");
  await writeLegacyMigrationFixture(workspace);
  const path = join(dirname(workspace.configPath), "boards/product/tasks", `${task.id}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.version = 3;
  delete stored.acceptanceCriteria;
  const original = JSON.stringify(stored);
  await writeFile(path, original);
  assert.equal((await service.listCriteria(task.id)).total, 0);
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(
    join(dirname(workspace.configPath), "kanban-pending.json"),
    JSON.stringify({ version: 1, writes: [{ slug: "product", task: stored }], removes: [] }),
  );
  assert.equal((await new StorageService(workspace).migrate()).migrated, true);
  assert.equal(await exists(join(dirname(workspace.configPath), "kanban-pending.json")), false);
  const added = await service.changeCriterion(
    task.id,
    {
      action: "add",
      title: "Новый",
      description: "\n  текст  \n",
      ifRevision: 1,
      requestId: "add",
    },
    "agent",
  );
  assert.ok(added.criterionId);
  assert.deepEqual(await service.create(command, "agent"), task);
  assert.equal((await service.get(task.id)).description, command.description);
  const current = JSON.parse(await readFile(join(dirname(workspace.configPath), "entities/tasks", `${task.id}.json`), "utf8"));
  assert.equal(current.schemaVersion, 2);
  assert.deepEqual(current.data.acceptanceCriteria[0].description, ["", "  текст  ", ""]);
});
