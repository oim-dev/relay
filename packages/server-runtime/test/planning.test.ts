import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import {
  planSummarySchema,
  plansPageSchema,
  planningSavedSchema,
  stagesPageSchema,
} from "@relay/contracts/planning";
import { releaseSummarySchema } from "@relay/contracts/releases";
import { fixture } from "./helpers/server.js";

test("REST планирования: local/scoped, SDK, ревизии, повтор и актуальная готовность после выпуска", async (t) => {
  const { app, workspace, tasks } = await fixture(t);
  const prefix = `/api/v1/projects/${workspace.config.projectId}`;
  const command = {
    title: "Серверный план",
    goal: "## Результат\n\nПостоянные данные",
    requestId: "plan",
  };
  const response = await app.inject({ method: "POST", url: `${prefix}/plans`, payload: command });
  assert.equal(response.statusCode, 200, response.body);
  const created = planningSavedSchema.parse(response.json().data);
  const repeated = await app.inject({ method: "POST", url: `${prefix}/plans`, payload: command });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.notEqual(repeated.json().data.id, created.id);
  for (const base of ["/api/v1", prefix]) {
    const page = await app.inject(`${base}/plans?limit=1`);
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(plansPageSchema.parse(page.json().data).total, 2);
    assert.equal(
      planSummarySchema.parse((await app.inject(`${base}/plans/${created.key}`)).json().data).goal,
      command.goal,
    );
  }
  assert.equal((await app.inject("/api/v1/projects/missing/plans")).statusCode, 404);
  assert.equal((await app.inject(`${prefix}/plans?offset=1`)).statusCode, 400);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const backend = await createHttpBackend(await app.getUrl(), workspace.config.projectId);
  const stage = await backend.plans.changeStage(
    created.id,
    {
      action: "create",
      fields: { title: "Этап" },
      ifRevision: created.revision,
      requestId: "stage",
    },
    "agent",
  );
  const task = await tasks.create(
    { board: "product", title: "Результат", column: "done", requestId: "task" },
    "agent",
  );
  let saved = await backend.plans.changeTasks(
    created.id,
    { stage: stage.stageId, add: [task.id], ifRevision: stage.revision, requestId: "include" },
    "agent",
  );
  assert.equal(
    stagesPageSchema.parse(await backend.plans.stages(created.id)).items[0]?.counts.completed,
    1,
  );
  assert.equal((await backend.plans.tasks(created.id, stage.stageId)).total, 1);
  saved = await backend.plans.transition(
    created.id,
    { action: "start", ifRevision: saved.revision, requestId: "start" },
    "agent",
  );
  saved = await backend.plans.transition(
    created.id,
    { action: "complete", ifRevision: saved.revision, result: "Проверено", requestId: "complete" },
    "agent",
  );
  assert.equal((await backend.progress.workPlan({ ref: created.id })).completed, true);
  const conflict = await app.inject({
    method: "POST",
    url: `${prefix}/plans/${created.id}/update`,
    payload: { title: "Старый ввод", ifRevision: 1, requestId: "stale" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const release = await backend.releases.create(
    {
      title: "Релиз",
      version: "1.0",
      planIds: [created.id],
      status: "released",
      requestId: "release",
    },
    "agent",
  );
  const published = releaseSummarySchema.parse(await backend.releases.get(release.id));
  assert.equal(published.status, "released");
  assert.equal(published.releasedBy, "agent");
  assert(published.releasedAt);
  assert.equal("snapshotId" in published, false);
  assert.equal((await backend.releases.composition(release.id)).items[0]?.id, created.id);
  assert.equal((await backend.progress.release({ ref: release.id })).completed, true);
  const composition = await backend.releases.composition(release.id);
  const reopened = await backend.boardTasks.move(
    task.id,
    { column: "ready", ifRevision: 1, requestId: "reopen-task" },
    "agent",
  );
  await backend.boardTasks.update(
    task.id,
    { title: "Изменённый результат", ifRevision: reopened.revision, requestId: "rename-task" },
    "agent",
  );
  const current = await backend.releases.get(release.id);
  assert.equal(current.status, "released");
  assert.equal(current.readiness.ready, 0);
  assert.equal(current.readiness.canRelease, false);
  assert.equal(current.releasedAt, published.releasedAt);
  assert.equal(current.releasedBy, published.releasedBy);
  assert.equal(current.revision, published.revision);
  assert.equal(
    (await backend.releases.composition(release.id)).items[0]?.plan?.counts.completed,
    0,
  );
  assert.equal((await backend.releases.list({ status: "released" })).items[0]?.readiness.ready, 0);
  assert.equal((await backend.progress.release({ ref: release.id })).completed, false);
  assert.equal(
    (await backend.plans.tasks(created.id, stage.stageId)).items[0]?.title,
    "Изменённый результат",
  );
  await assert.rejects(backend.releases.composition(release.id, { version: composition.version }), {
    code: "PLANNING_CHANGED",
  });
  assert.equal("key" in (await backend.plans.stages(created.id)).items[0]!, false);
  for (const base of ["/api/v1", prefix])
    assert.equal((await app.inject(`${base}/releases/${release.id}/snapshot`)).statusCode, 404);
  const spec = (await app.inject("/api/openapi.json")).json();
  assert(spec.paths[`${"/api/v1/projects/{project}"}/plans`]);
  assert.equal(spec.paths["/api/v1/projects/{project}/releases/{reference}/snapshot"], undefined);
  assert(!Object.keys(spec.components.schemas).some((name) => name.startsWith("ReleaseSnapshot")));
  assert(spec.components.schemas.CreatePlan.properties.goal.description.includes("Markdown"));
});

test("REST вложенных этапов: перенос указывает оба плана, выбор требует владельца и продолжение сохраняет версию", async (t) => {
  const { app, workspace, tasks } = await fixture(t);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const backend = await createHttpBackend(await app.getUrl(), workspace.config.projectId);
  const source = await backend.plans.create({ title: "Исходный", requestId: "source" }, "agent");
  const target = await backend.plans.create({ title: "Целевой", requestId: "target" }, "agent");
  const from = await backend.plans.changeStage(
    source.id,
    {
      action: "create",
      fields: { title: "Первый" },
      ifRevision: source.revision,
      requestId: "from",
    },
    "agent",
  );
  const to = await backend.plans.changeStage(
    target.id,
    {
      action: "create",
      fields: { title: "Второй" },
      ifRevision: target.revision,
      requestId: "to",
    },
    "agent",
  );
  const task = await tasks.create(
    { board: "product", title: "Переносимая", requestId: "task" },
    "agent",
  );
  const included = await backend.plans.changeTasks(
    source.id,
    {
      stage: from.stageId,
      add: [task.id],
      ifRevision: from.revision,
      requestId: "include",
    },
    "agent",
  );
  const prefix = `/api/v1/projects/${workspace.config.projectId}`;
  const missingPlan = await app.inject(`${prefix}/plans/task-candidates?stage=${from.stageId}`);
  assert.equal(missingPlan.statusCode, 400, missingPlan.body);
  assert.equal((await backend.plans.candidates()).total, 0);
  assert.equal(
    (await backend.plans.candidates({ plan: source.key, stage: from.stageId })).total,
    1,
  );
  const transfer = {
    task: task.key,
    targetStage: to.stageId,
    ifRevision: included.revision,
    targetRevision: to.revision,
    reason: "## Причина\n\nУточнён план",
    requestId: "transfer",
  };
  const missingTarget = await app.inject({
    method: "POST",
    url: `${prefix}/plans/${source.id}/transfer`,
    payload: transfer,
  });
  assert.equal(missingTarget.statusCode, 400, missingTarget.body);
  assert.equal((await backend.plans.tasks(source.id, from.stageId)).total, 1);
  await assert.rejects(
    backend.plans.transfer(
      source.id,
      { ...transfer, targetPlan: target.key, targetRevision: 1 },
      "agent",
    ),
    {
      code: "REVISION_CONFLICT",
    },
  );
  const command = { ...transfer, targetPlan: target.key };
  const moved = await backend.plans.transfer(source.id, command, "agent");
  await assert.rejects(backend.plans.transfer(source.id, command, "agent"), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(moved.revision, included.revision + 1);
  assert.equal(moved.targetRevision, to.revision + 1);
  assert.equal((await backend.plans.tasks(source.id, from.stageId)).total, 0);
  assert.equal((await backend.plans.tasks(target.id, to.stageId)).items[0]?.id, task.id);
  const memberships = await backend.plans.memberships(task.id);
  assert.equal(memberships.items[0]?.planId, target.id);
  assert.equal("stageKey" in memberships.items[0]!, false);
  const context = await backend.graph.context({ root: task.id });
  assert(
    context.edges.some(
      (edge) => edge.from.id === task.id && edge.to.id === target.id && edge.type === "part-of",
    ),
  );
  assert(!context.edges.some((edge) => edge.from.id === task.id && edge.to.id === source.id));
  assert(!context.nodes.some((node) => String(node.ref.kind) === "plan-stage"));
  const extra = await backend.plans.changeStage(
    target.id,
    {
      action: "create",
      fields: { title: "Третий" },
      ifRevision: moved.targetRevision,
      requestId: "extra",
    },
    "agent",
  );
  const page = await backend.plans.stages(target.id, { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.planRevision, extra.revision);
  assert.equal("key" in page.items[0]!, false);
  assert.equal("revision" in page.items[0]!, false);
  const next = await backend.plans.stages(target.id, {
    limit: 1,
    offset: 1,
    version: page.version,
  });
  assert.equal(next.items[0]?.id, extra.stageId);
  assert.equal(next.nextOffset, null);
  const catalog = await backend.plans.list({ limit: 1 });
  assert.equal("stages" in catalog.items[0]!, false);
  await backend.plans.changeStage(
    target.id,
    {
      action: "update",
      stage: extra.stageId,
      fields: { title: "Обновлённый" },
      ifRevision: extra.revision,
      requestId: "update",
    },
    "agent",
  );
  await assert.rejects(
    backend.plans.stages(target.id, { limit: 1, offset: 1, version: page.version }),
    {
      code: "PLANNING_CHANGED",
    },
  );
});

test("REST частичного изменения этапа: конфликт устаревшего повтора, очистка и пустой набор полей", async (t) => {
  const { app, workspace } = await fixture(t);
  const spec = (await app.inject("/api/openapi.json")).json();
  const changes = spec.components.schemas.ChangePlanStage.properties.fields;
  for (const name of ["title", "summary", "outcome", "completionConditions"]) {
    assert(!changes.required?.includes(name));
    assert.equal("default" in changes.properties[name], false);
  }
  for (const [mode, prefix] of [
    ["local", "/api/v1"],
    ["scoped", `/api/v1/projects/${workspace.config.projectId}`],
  ]) {
    const created = await app.inject({
      method: "POST",
      url: `${prefix}/plans`,
      payload: {
        title: `Частичные изменения ${mode}`,
        requestId: `plan-${mode}`,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const plan = planningSavedSchema.parse(created.json().data);
    const fields = {
      title: "Исходный этап",
      summary: "Первое описание",
      outcome: "## Результат\n\nПроверить сохранность\n",
      completionConditions: "## Условия\n\nПовтор не меняет данные\n",
    };
    const url = `${prefix}/plans/${plan.id}/stages`;
    const stageResponse = await app.inject({
      method: "POST",
      url,
      payload: {
        action: "create",
        fields,
        ifRevision: plan.revision,
        requestId: `stage-${mode}`,
      },
    });
    assert.equal(stageResponse.statusCode, 200, stageResponse.body);
    const stage = planningSavedSchema.parse(stageResponse.json().data);
    const titleInput = {
      action: "update",
      stage: stage.stageId,
      fields: { title: "Новое название" },
      ifRevision: stage.revision,
      requestId: `title-${mode}`,
    };
    const titleResponse = await app.inject({ method: "POST", url, payload: titleInput });
    assert.equal(titleResponse.statusCode, 200, titleResponse.body);
    const title = planningSavedSchema.parse(titleResponse.json().data);
    const summary = "Отдельная правка\nОбычный многострочный текст";
    const summaryResponse = await app.inject({
      method: "POST",
      url,
      payload: {
        action: "update",
        stage: stage.stageId,
        fields: { summary },
        ifRevision: title.revision,
        actor: "another-agent",
        requestId: `summary-${mode}`,
      },
    });
    assert.equal(summaryResponse.statusCode, 200, summaryResponse.body);
    const changed = planningSavedSchema.parse(summaryResponse.json().data);
    const repeated = await app.inject({ method: "POST", url, payload: titleInput });
    assert.equal(repeated.statusCode, 409, repeated.body);
    const afterReplay = stagesPageSchema.parse((await app.inject(url)).json().data);
    assert.equal(afterReplay.planRevision, changed.revision);
    assert.equal(afterReplay.items[0]?.title, titleInput.fields.title);
    assert.equal(afterReplay.items[0]?.summary, summary);
    assert.equal(afterReplay.items[0]?.outcome, fields.outcome);
    assert.equal(afterReplay.items[0]?.completionConditions, fields.completionConditions);
    const clearResponse = await app.inject({
      method: "POST",
      url,
      payload: {
        action: "update",
        stage: stage.stageId,
        fields: { summary: "", outcome: "", completionConditions: "" },
        ifRevision: changed.revision,
        requestId: `clear-${mode}`,
      },
    });
    assert.equal(clearResponse.statusCode, 200, clearResponse.body);
    const cleared = planningSavedSchema.parse(clearResponse.json().data);
    for (const emptyFields of [undefined, {}]) {
      const emptyResponse = await app.inject({
        method: "POST",
        url,
        payload: {
          action: "update",
          stage: stage.stageId,
          ...(emptyFields === undefined ? {} : { fields: emptyFields }),
          ifRevision: cleared.revision,
          requestId: `empty-${mode}-${String(emptyFields === undefined)}`,
        },
      });
      assert.equal(emptyResponse.statusCode, 400, emptyResponse.body);
      assert.equal(emptyResponse.json().error.code, "INVALID_ARGUMENT");
    }
    const afterEmpty = stagesPageSchema.parse((await app.inject(url)).json().data);
    assert.equal(afterEmpty.planRevision, cleared.revision);
    assert.equal(afterEmpty.items[0]?.title, titleInput.fields.title);
    assert.equal(afterEmpty.items[0]?.summary, "");
    assert.equal(afterEmpty.items[0]?.outcome, "");
    assert.equal(afterEmpty.items[0]?.completionConditions, "");
  }
});
