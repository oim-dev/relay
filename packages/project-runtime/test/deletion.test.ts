import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { createLocalBackend } from "../src/backend/local.js";
import type { Backend } from "../src/backend/types.js";
import { assertDeletion, deletionFixture, persistentFiles } from "./helpers/deletion.js";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-deletion-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root, "tasks");
  const backend = await createLocalBackend(root);
  return { root, backend, fixture: await deletionFixture(backend) };
}

for (const kind of [
  "feature",
  "scenario",
  "application",
  "implementation",
  "task",
  "document",
] as const)
  test(`deletion local: ${kind}, полный каскад, ссылки и квитанция`, async (t) => {
    const { backend, fixture } = await setup(t);
    const before = await persistentFiles(backend.workspace.root);
    await backend.deletion.preview({ kind, ref: fixture[kind].key });
    assert.deepEqual(await persistentFiles(backend.workspace.root), before);
    await assertDeletion(backend, fixture, kind, "local-author", kind === "application");
  });

test("deletion local: stale, изменение содержания и комментарий требуют нового preview без записи", async (t) => {
  const { backend, fixture } = await setup(t);
  const query = { kind: "application" as const, ref: fixture.application.key };
  const initial = await backend.deletion.preview(query);
  const checkConflict = async (version: string) => {
    const before = await persistentFiles(backend.workspace.root);
    await assert.rejects(
      backend.deletion.delete({ ...query, ifVersion: version, requestId: "stale" }, "author"),
      { code: "REVISION_CONFLICT", exitCode: 4 },
    );
    assert.deepEqual(await persistentFiles(backend.workspace.root), before);
  };
  await checkConflict("stale");
  await backend.entities.update(
    {
      ref: fixture.application.key,
      ifRevision: fixture.application.revision,
      changes: { kind: "application", name: "Новое имя" },
      requestId: "change",
    },
    "other",
  );
  await checkConflict(initial.version);
  const current = await backend.deletion.preview(query);
  const task = await backend.boardTasks.get(fixture.task.key);
  await backend.boardTasks.publishComment(fixture.task.key, {
    title: "Комментарий",
    description: "Markdown  \n\nКонец\n",
    actor: "comment-author",
    actorRole: "worker",
    requestId: "comment",
  });
  assert.equal((await backend.boardTasks.get(fixture.task.key)).revision, task.revision);
  await checkConflict(current.version);
  await assertDeletion(backend, fixture, "application");
});

for (const reference of ["scope", "stage"] as const)
  test(`deletion local: ссылка ${reference} закрытого плана блокирует preview/delete без записи`, async (t) => {
    const { backend, fixture } = await setup(t);
    const query = { kind: "application" as const, ref: fixture.application.key };
    const preview = await backend.deletion.preview(query);
    let plan = await backend.plans.create(
      {
        title: "План",
        requestId: "plan",
        ...(reference === "scope"
          ? { scope: [{ kind: "application" as const, id: fixture.application.ref.id }] }
          : {}),
      },
      "planner",
    );
    if (reference === "stage") {
      const stage = await backend.plans.changeStage(
        plan.key,
        {
          action: "create",
          ifRevision: plan.revision,
          fields: { title: "Этап" },
          requestId: "stage",
        },
        "planner",
      );
      plan = await backend.plans.changeTasks(
        plan.key,
        {
          stage: stage.stageId,
          add: [fixture.task.key],
          ifRevision: stage.revision,
          requestId: "include",
        },
        "planner",
      );
    }
    await backend.plans.transition(
      plan.key,
      { action: "cancel", result: "Не выполнять", ifRevision: plan.revision, requestId: "cancel" },
      "planner",
    );
    const before = await persistentFiles(backend.workspace.root);
    await assert.rejects(backend.deletion.preview(query), {
      code: "PLANNING_REFERENCE_IN_USE",
      exitCode: 4,
    });
    await assert.rejects(
      backend.deletion.delete(
        { ...query, ifVersion: preview.version, requestId: "blocked" },
        "author",
      ),
      { code: "PLANNING_REFERENCE_IN_USE", exitCode: 4 },
    );
    assert.deepEqual(await persistentFiles(backend.workspace.root), before);
  });

test("deletion local: доска не является самостоятельной целью", async (t) => {
  const { backend } = await setup(t);
  const before = await persistentFiles(backend.workspace.root);
  const query = { kind: "board", ref: "BOARD-WEB" } as unknown as Parameters<
    Backend["deletion"]["preview"]
  >[0];
  await assert.rejects(backend.deletion.preview(query), { code: "VALIDATION_ERROR" });
  await assert.rejects(
    backend.deletion.delete({ ...query, ifVersion: "unchanged", requestId: "board" }, "author"),
    { code: "VALIDATION_ERROR" },
  );
  assert.deepEqual(await persistentFiles(backend.workspace.root), before);
});
