import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { initialize } from "@relay/core/storage/workspace";
import { defaultConfig } from "@relay/core/domain/config";
import { startServer } from "@relay/server-runtime";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startMcp } from "../src/server.js";
import { entitySavedSchema, entityDetailSchema } from "@relay/contracts/entities";
import { fullContextSchema } from "@relay/contracts/entities/graph";
import { taskProgressSchema, productProgressSchema } from "@relay/contracts/progress";
import {
  planningSavedSchema,
  stagesPageSchema,
  planningCandidatesPageSchema,
} from "@relay/contracts/planning";
import {
  releaseSummarySchema,
  releaseCompositionSchema,
  releasesPageSchema,
} from "@relay/contracts/releases";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tasks-mcp-"));
  const clients: Client[] = [];
  const servers: { close(): Promise<unknown> }[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(servers.map((server) => server.close()));
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ["a", "b"]) {
    await mkdir(join(root, name));
    await initialize(join(root, name), "tasks");
  }
  const connect = async (url: string) => {
    const client = new Client({ name: "тест-агент", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
    return client;
  };
  const start = async (config?: string) => {
    const api = await startServer({
      cwd: root,
      port: 0,
      actor: "api",
      ...(config ? { config } : {}),
    });
    servers.push(api);
    const server = await startMcp({ cwd: root, port: 0, serverUrl: api.url });
    servers.push(server);
    return { ...server, api };
  };
  return { root, clients, servers, connect, start };
}

test("MCP планирования: discovery, запись состава, повтор, конфликты и выпуск", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  for (const name of [
    "plan_create",
    "plan_stage_create",
    "plan_tasks_include",
    "release_create",
    "release_publish",
  ])
    assert(tools.find((tool) => tool.name === name)?.inputSchema.required?.includes("actor"));
  assert(tools.find((tool) => tool.name === "plan_stage_create")?.inputSchema.properties?.title);
  const transferTool = tools.find((tool) => tool.name === "plan_task_transfer")!;
  assert(transferTool.inputSchema.required?.includes("targetPlan"));
  assert(transferTool.inputSchema.required?.includes("targetStage"));
  assert.match(JSON.stringify(transferTool.inputSchema.properties?.targetStage), /Внутренний ID/);
  assert(
    !JSON.stringify(tools.filter((tool) => /^(plan|release|work_plan)/.test(tool.name))).includes(
      "STG-",
    ),
  );
  const input = {
    title: "План агента",
    goal: "Постоянный результат",
    actor: "agent",
    requestId: "plan",
  };
  const plan = planningSavedSchema.parse((await call(client, "plan_create", input)).data);
  const duplicatePlan = planningSavedSchema.parse((await call(client, "plan_create", input)).data);
  assert.notEqual(duplicatePlan.id, plan.id);
  const stage = planningSavedSchema.parse(
    (
      await call(client, "plan_stage_create", {
        ref: plan.id,
        title: "Этап",
        ifRevision: plan.revision,
        actor: "agent",
        requestId: "stage",
      })
    ).data,
  );
  assert.equal(
    (await call(client, "plan_task_candidates", { stage: stage.stageId })).error?.code,
    "INVALID_ARGUMENT",
  );
  const secondStage = planningSavedSchema.parse(
    (
      await call(client, "plan_stage_create", {
        ref: plan.id,
        title: "Другой этап",
        ifRevision: stage.revision,
        actor: "agent",
        requestId: "stage-2",
      })
    ).data,
  );
  const page = stagesPageSchema.parse(
    (await call(client, "plan_stages_list", { ref: plan.id, limit: 1 })).data,
  );
  assert.equal(page.nextOffset, 1);
  assert.equal("key" in page.items[0]!, false);
  assert.equal("revision" in page.items[0]!, false);
  const nextPage = stagesPageSchema.parse(
    (
      await call(client, "plan_stages_list", {
        ref: plan.id,
        limit: 1,
        offset: 1,
        version: page.version,
      })
    ).data,
  );
  assert.equal(nextPage.items[0]?.id, secondStage.stageId);
  assert.equal(nextPage.nextOffset, null);
  assert.equal(
    (await call(client, "plan_stages_list", { ref: plan.id, limit: 1, offset: 1 })).error?.code,
    "INVALID_ARGUMENT",
  );
  const task = await call(client, "board_task_create", {
    title: "Готовый результат",
    board: "product",
    column: "done",
    actor: "agent",
    requestId: "task",
  });
  let saved = planningSavedSchema.parse(
    (
      await call(client, "plan_tasks_include", {
        ref: plan.id,
        stage: stage.stageId,
        tasks: [task.data?.id],
        ifRevision: secondStage.revision,
        actor: "agent",
        requestId: "include",
      })
    ).data,
  );
  const candidates = planningCandidatesPageSchema.parse(
    (
      await call(client, "plan_task_candidates", {
        plan: plan.id,
        stage: stage.stageId,
        availableOnly: "true",
        limit: 1,
      })
    ).data,
  );
  assert.equal(candidates.items[0]?.id, task.data?.id);
  assert.equal(candidates.items[0]?.assignment?.planId, plan.id);
  assert.equal(
    (
      await call(client, "plan_stages_list", {
        ref: plan.id,
        limit: 1,
        offset: 1,
        version: page.version,
      })
    ).error?.code,
    "PLANNING_CHANGED",
  );
  const transfer = {
    ref: plan.id,
    task: task.data?.id,
    targetPlan: plan.id,
    targetStage: secondStage.stageId,
    ifRevision: saved.revision,
    targetRevision: saved.revision,
    reason: "## Причина\n\nПерестановка работы",
    actor: "agent",
    requestId: "transfer",
  };
  const { targetPlan: _targetPlan, ...withoutPlan } = transfer;
  assert.equal(
    (await call(client, "plan_task_transfer", withoutPlan)).error?.code,
    "VALIDATION_ERROR",
  );
  saved = planningSavedSchema.parse((await call(client, "plan_task_transfer", transfer)).data);
  assert.equal(
    (await call(client, "plan_task_transfer", transfer)).error?.code,
    "REVISION_CONFLICT",
  );
  assert.equal(saved.targetRevision, saved.revision);
  assert.equal(
    (await call(client, "plan_tasks_list", { ref: plan.id, stage: stage.stageId })).data?.total,
    0,
  );
  assert.equal(
    (await call(client, "plan_tasks_list", { ref: plan.id, stage: secondStage.stageId })).data
      ?.total,
    1,
  );
  const stageUpdate = {
    ref: plan.id,
    stage: secondStage.stageId,
    title: "Актуальный этап",
    outcome: "## Результат\n\nПроверенный Markdown\n",
    ifRevision: saved.revision,
    actor: "agent",
    requestId: "stage-update",
  };
  saved = planningSavedSchema.parse((await call(client, "plan_stage_update", stageUpdate)).data);
  assert.equal(
    (await call(client, "plan_stage_update", stageUpdate)).error?.code,
    "REVISION_CONFLICT",
  );
  const currentStages = stagesPageSchema.parse(
    (await call(client, "plan_stages_list", { ref: plan.id })).data,
  );
  assert.equal(currentStages.items[1]?.outcome, stageUpdate.outcome);
  assert.deepEqual(currentStages.items[1]?.taskIds, [task.data?.id]);
  assert.equal(
    (
      await call(client, "plan_update", {
        ref: plan.id,
        title: "Конфликт",
        ifRevision: 1,
        actor: "agent",
        requestId: "stale",
      })
    ).error?.code,
    "REVISION_CONFLICT",
  );
  saved = planningSavedSchema.parse(
    (
      await call(client, "plan_start", {
        ref: plan.id,
        ifRevision: saved.revision,
        actor: "agent",
        requestId: "start",
      })
    ).data,
  );
  saved = planningSavedSchema.parse(
    (
      await call(client, "plan_complete", {
        ref: plan.id,
        ifRevision: saved.revision,
        result: "Проверено",
        actor: "agent",
        requestId: "complete",
      })
    ).data,
  );
  assert.equal((await call(client, "work_plan_progress", { ref: plan.id })).data?.completed, true);
  const release = planningSavedSchema.parse(
    (
      await call(client, "release_create", {
        title: "Релиз",
        version: "1.0",
        planIds: [plan.id],
        actor: "agent",
        requestId: "release",
      })
    ).data,
  );
  const publish = {
    ref: release.id,
    ifRevision: release.revision,
    actor: "agent",
    requestId: "publish",
  };
  const publishedReceipt = await call(client, "release_publish", publish);
  assert.equal(publishedReceipt.ok, true);
  assert.match(publishedReceipt.text, /Выпуск зафиксирован/);
  assert.equal(
    (await call(client, "release_plans_list", { ref: release.id, limit: 1 })).data?.total,
    1,
  );
  const published = releaseSummarySchema.parse(
    (await call(client, "release_get", { ref: release.id })).data,
  );
  assert.equal(published.status, "released");
  assert.equal(published.readiness.ready, 1);
  assert.equal("snapshotId" in published, false);
  assert.equal(
    (
      await call(client, "board_task_move", {
        reference: task.data?.id,
        column: "ready",
        ifRevision: 1,
        actor: "agent",
        requestId: "reopen-task",
      })
    ).ok,
    true,
  );
  const read = await call(client, "release_get", { ref: release.id });
  const current = releaseSummarySchema.parse(read.data);
  assert.equal(current.status, "released");
  assert.equal(current.releasedAt, published.releasedAt);
  assert.equal(current.releasedBy, "agent");
  assert.equal(current.readiness.ready, 0);
  assert.match(read.text, /Состояние: Выпущен/);
  assert.match(read.text, /Текущая готовность: 0\/1 планов/);
  assert(read.text.includes(published.releasedAt!));
  assert.equal((await call(client, "release_publish", publish)).error?.code, "REVISION_CONFLICT");
  const currentComposition = releaseCompositionSchema.parse(
    (await call(client, "release_plans_list", { ref: release.id })).data,
  );
  assert.equal(currentComposition.items[0]?.plan?.counts.completed, 0);
  assert.equal(
    (await call(client, "release_progress", { ref: release.id })).data?.completed,
    false,
  );
  const currentList = releasesPageSchema.parse(
    (await call(client, "releases_list", { status: "released" })).data,
  );
  assert.equal(currentList.items[0]?.readiness.ready, 0);
  const large = planningSavedSchema.parse(
    (
      await call(client, "release_create", {
        title: "Большое описание",
        version: "next",
        planIds: [plan.id],
        description: "Описание ".repeat(500),
        actor: "agent",
        requestId: "large-release",
      })
    ).data,
  );
  assert.equal(
    (await call(client, "release_get", { ref: large.id, maxBytes: 1024 })).error?.code,
    "RESPONSE_TOO_LARGE",
  );
  assert(!(await client.listTools()).tools.some((entry) => entry.name === "release_snapshot"));
  assert.equal((await call(client, "plans_list", { project: "missing" })).ok, false);
});

test("MCP частичного изменения этапа: необязательные поля без defaults, повтор после другой правки и очистка", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  const createTool = tools.find((tool) => tool.name === "plan_stage_create")!;
  const updateTool = tools.find((tool) => tool.name === "plan_stage_update")!;
  assert(createTool.inputSchema.required?.includes("title"));
  assert.match(updateTool.description!, /Изменить только переданные поля/);
  for (const name of ["title", "summary", "outcome", "completionConditions"]) {
    assert(!updateTool.inputSchema.required?.includes(name));
    const field = updateTool.inputSchema.properties?.[name] as Record<string, unknown>;
    assert(field);
    assert.equal("default" in field, false);
  }
  const plan = planningSavedSchema.parse(
    (
      await call(client, "plan_create", {
        title: "Частичные изменения",
        actor: "agent",
        requestId: "plan",
      })
    ).data,
  );
  const fields = {
    title: "Исходный этап",
    summary: "Первое описание",
    outcome: "## Результат\n\n- Сохранить Markdown\n",
    completionConditions: "## Условия\n\nПроверить повтор\n",
  };
  const stage = planningSavedSchema.parse(
    (
      await call(client, "plan_stage_create", {
        ...fields,
        ref: plan.id,
        ifRevision: plan.revision,
        actor: "agent",
        requestId: "stage",
      })
    ).data,
  );
  const titleInput = {
    ref: plan.id,
    stage: stage.stageId,
    title: "Новое название",
    ifRevision: stage.revision,
    actor: "agent",
    requestId: "title",
  };
  const title = planningSavedSchema.parse(
    (await call(client, "plan_stage_update", titleInput)).data,
  );
  const summary = "Отдельная правка\nС переносом строки";
  const changed = planningSavedSchema.parse(
    (
      await call(client, "plan_stage_update", {
        ref: plan.id,
        stage: stage.stageId,
        summary,
        ifRevision: title.revision,
        actor: "another-agent",
        requestId: "summary",
      })
    ).data,
  );
  const replay = await call(client, "plan_stage_update", titleInput);
  assert.equal(replay.error?.code, "REVISION_CONFLICT");
  assert.equal(replay.isError, true);
  assert.equal(replay.data, undefined);
  const read = async () =>
    stagesPageSchema.parse((await call(client, "plan_stages_list", { ref: plan.id })).data);
  const afterReplay = await read();
  assert.equal(afterReplay.planRevision, changed.revision);
  assert.equal(afterReplay.items[0]?.title, titleInput.title);
  assert.equal(afterReplay.items[0]?.summary, summary);
  assert.equal(afterReplay.items[0]?.outcome, fields.outcome);
  assert.equal(afterReplay.items[0]?.completionConditions, fields.completionConditions);
  const clearInput = {
    ref: plan.id,
    stage: stage.stageId,
    summary: "",
    outcome: "",
    completionConditions: "",
    ifRevision: changed.revision,
    actor: "agent",
    requestId: "clear",
  };
  const cleared = planningSavedSchema.parse(
    (await call(client, "plan_stage_update", clearInput)).data,
  );
  assert.equal(
    (await call(client, "plan_stage_update", clearInput)).error?.code,
    "REVISION_CONFLICT",
  );
  const empty = await call(client, "plan_stage_update", {
    ref: plan.id,
    stage: stage.stageId,
    ifRevision: cleared.revision,
    actor: "agent",
    requestId: "empty",
  });
  assert.equal(empty.error?.code, "INVALID_ARGUMENT");
  const afterEmpty = await read();
  assert.equal(afterEmpty.planRevision, cleared.revision);
  assert.equal(afterEmpty.items[0]?.title, titleInput.title);
  assert.equal(afterEmpty.items[0]?.summary, "");
  assert.equal(afterEmpty.items[0]?.outcome, "");
  assert.equal(afterEmpty.items[0]?.completionConditions, "");
});

test("MCP: прогресс задачи и продукта, discovery, продолжение и изоляция", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  for (const kind of ["task", "implementation", "scenario", "feature", "application", "product"]) {
    const tool = tools.find((entry) => entry.name === `${kind}_progress`);
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok(tool.inputSchema.properties?.version);
  }
  const saved = await call(client, "board_task_create", {
    board: "product",
    title: "Проверить",
    requestId: "progress",
    actor: "agent",
    acceptanceCriteria: [{ title: "Первый" }, { title: "Второй" }],
  });
  const task = taskProgressSchema.parse(
    (await call(client, "task_progress", { ref: saved.data?.id, limit: 1 })).data,
  );
  assert.equal(task.completed, false);
  assert.equal(task.reasons.nextOffset, 1);
  const next = taskProgressSchema.parse(
    (
      await call(client, "task_progress", {
        ref: task.entity.id,
        limit: 1,
        offset: 1,
        version: task.version,
      })
    ).data,
  );
  assert.equal(next.reasons.items[0]?.code, "CRITERION_INCOMPLETE");
  assert.equal(
    (await call(client, "task_progress", { ref: task.entity.id, offset: 1 })).error?.code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (await call(client, "task_progress", { ref: task.entity.id, project: "missing" })).ok,
    false,
  );
  assert.equal(
    productProgressSchema.parse((await call(client, "product_progress")).data).completed,
    false,
  );
});

test("MCP: предметные линковки и снятие сразу видны в полном графе", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const feature = entitySavedSchema.parse(
    (
      await call(client, "entity_feature_create", {
        name: "Поиск",
        summary: "",
        description: "## Требования\n\nНайти товар",
        actor: "agent",
        requestId: "f",
      })
    ).data,
  );
  const task = entitySavedSchema.parse(
    (
      await call(client, "entity_task_create", {
        board: "BOARD-PRODUCT",
        title: "Реализовать поиск",
        targets: [feature.key],
        actor: "agent",
        requestId: "t",
      })
    ).data,
  );
  const doc = entitySavedSchema.parse(
    (
      await call(client, "entity_document_create", {
        name: "ТЗ",
        summary: "",
        body: "## Проверка\n\nПроверить поиск",
        documentKind: "specification",
        relations: [{ type: "references", target: task.ref, description: "Прочитать" }],
        actor: "agent",
        requestId: "d",
      })
    ).data,
  );
  const context = fullContextSchema.parse(
    (await call(client, "entity_context", { ref: feature.key })).data,
  );
  assert.ok(context.nodes.some((node) => node.ref.id === doc.ref.id));
  assert.ok(
    context.edges.some(
      (edge) =>
        edge.from.id === task.ref.id && edge.to.id === doc.ref.id && edge.type === "references",
    ),
  );
  const update = {
    ref: task.key,
    targets: [],
    ifRevision: task.revision,
    requestId: "clear",
    actor: "agent",
  };
  const saved = await call(client, "entity_task_update", update);
  assert.equal(saved.ok, true);
  assert.equal((await call(client, "entity_task_update", update)).error?.code, "REVISION_CONFLICT");
  assert.equal(
    (await call(client, "entity_task_update", { ...update, requestId: "stale" })).error?.code,
    "REVISION_CONFLICT",
  );
  const detached = fullContextSchema.parse(
    (await call(client, "entity_context", { ref: feature.key })).data,
  );
  assert.equal(detached.nodes.length, 3);
  assert.equal(detached.edges.length, 2);
  assert.ok(
    !detached.nodes.some((node) => node.ref.id === task.ref.id || node.ref.id === doc.ref.id),
  );
  assert.ok(
    detached.edges.some(
      (edge) =>
        edge.type === "part-of" && edge.from.id === feature.ref.id && edge.to.kind === "product",
    ),
  );
  assert.ok(
    detached.edges.some(
      (edge) =>
        edge.type === "part-of" && edge.from.kind === "product" && edge.to.kind === "project",
    ),
  );
  const documentChange = {
    ref: doc.key,
    relations: [],
    ifRevision: 1,
    requestId: "detach",
    actor: "agent",
  };
  assert.equal((await call(client, "entity_document_update", documentChange)).ok, true);
  assert.equal(
    fullContextSchema.parse((await call(client, "entity_context", { ref: doc.key })).data).edges
      .length,
    0,
  );
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const body = z
    .object({
      ok: z.boolean(),
      data: z.record(z.string(), z.unknown()).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
      error: z.object({ code: z.string() }).passthrough().optional(),
    })
    .parse(result.structuredContent);
  const content = z.object({ text: z.string() }).parse(result.content[0]).text;
  if (
    body.ok &&
    [
      "board_task_create",
      "board_task_update",
      "board_task_move",
      "board_task_link",
      "task_criterion_add",
      "task_criterion_update",
      "task_criterion_complete",
      "task_criterion_remove",
    ].includes(name)
  ) {
    assert.match(content, /Задача .*Ревизия/);
    assert.ok(content.includes(String(body.data?.id)));
  } else if (body.ok && name === "task_comment_publish") {
    assert.match(content, /Сообщение .*Ревизия ленты/);
  } else if (
    body.ok &&
    ["product_application_save", "product_scope_replace", "product_implementation_update"].includes(
      name,
    )
  ) {
    assert.match(content, /Ревизия:/);
    assert.ok(content.includes(String(body.data?.id)));
  } else if (
    body.ok &&
    (/^entity_.*(?:create|update|move|link|rename_key)$/.test(name) || name === "entity_get")
  ) {
    assert.match(content, /Ревизия/);
  } else if (body.ok && /^(plan_|release_)/.test(name) && typeof body.data?.action === "string") {
    assert.match(content, /Ревизия:/);
    assert.match(content, /requestId:/);
    if (body.data?.targetRevision !== undefined)
      assert(content.includes(`Ревизия целевого плана: ${body.data.targetRevision}`));
  } else if (body.ok && (name === "plan_get" || name === "release_get")) {
    assert.match(content, /Состояние:/);
  } else if (body.ok && name.endsWith("_progress")) {
    assert.match(content, /выполнено|не выполнено/);
  } else assert.deepEqual(JSON.parse(content), result.structuredContent);
  return { ...body, isError: result.isError, text: content };
}

test("MCP обсуждений: discovery без аудита, имена агентов, повтор, бюджет и изоляция", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  const publish = tools.find((tool) => tool.name === "task_comment_publish");
  assert.deepEqual(
    tools.filter((tool) => /history|audit/i.test(tool.name)),
    [],
  );
  for (const name of ["task_comment_publish", "task_comments_list", "task_comment_get"])
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
  for (const name of ["entity_history", "task_history_list", "task_history_get"])
    await assert.rejects(client.callTool({ name, arguments: {} }), { code: -32602 });
  assert.ok(publish?.inputSchema.required?.includes("actor"));
  assert.ok(publish?.inputSchema.required?.includes("actorRole"));
  const created = await call(client, "board_task_create", {
    board: "product",
    actor: "operator",
    requestId: "create",
  });
  const reference = created.data?.id;
  const input = {
    reference,
    title: "Отчёт",
    description: "## Проверено\n\nТочное содержание\n",
    actor: "worker-api",
    actorRole: "worker",
    requestId: "message",
  };
  const saved = await call(client, "task_comment_publish", input);
  assert.equal(saved.ok, true);
  const duplicate = await call(client, "task_comment_publish", input);
  assert.equal(duplicate.ok, true);
  assert.notEqual(duplicate.data?.commentId, saved.data?.commentId);
  assert.equal((await call(client, "board_task_get", { reference })).data?.revision, 1);
  const read = await call(client, "task_comment_get", {
    reference,
    entryId: saved.data?.commentId,
  });
  assert.equal(read.data?.description, input.description);
  assert.equal(read.data?.actor, "worker-api");
  assert.equal(
    (
      await call(client, "task_comment_publish", {
        ...input,
        actor: "planner",
        actorRole: "orchestrator",
      })
    ).ok,
    true,
  );
  const page = await call(client, "task_comments_list", { reference, limit: 1 });
  assert.equal(page.ok, true);
  assert.equal((await call(client, "task_comments_list", { reference, after: 0 })).ok, true);
  const otherServer = await app.start(join(app.root, "b/.relay/config.json"));
  const other = await app.connect(otherServer.url);
  assert.equal(
    (await call(other, "task_comment_get", { reference, entryId: saved.data?.commentId })).ok,
    false,
  );
  await call(client, "task_comment_publish", {
    ...input,
    description: "Большой текст ".repeat(1000),
    requestId: "large",
  });
  const latest = await call(client, "task_comments_list", { reference, limit: 1 });
  const entries = latest.data?.items as { id: string }[];
  const tooLarge = await call(client, "task_comment_get", {
    reference,
    entryId: entries[0]?.id,
    maxBytes: 1024,
  });
  assert.equal(tooLarge.ok, false);
});

test("MCP движка: discovery из контрактов, публичные ключи, история адресов и контекст", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  const create = tools.find((tool) => tool.name === "entity_task_create");
  assert.ok(create);
  const properties = create.inputSchema.properties as Record<string, { description?: string }>;
  for (const name of ["board", "title", "targets", "dependencies", "actor", "requestId"])
    assert.match(properties[name]?.description ?? "", /[А-Яа-яЁё]/);
  assert.equal("data" in properties, false);
  assert.equal((await call(client, "entity_types")).data?.total, 11);
  const args = {
    board: "BOARD-PRODUCT",
    title: "Проверить движок",
    actor: "agent",
    requestId: "entity-create",
  };
  const created = entitySavedSchema.parse((await call(client, "entity_task_create", args)).data);
  const duplicate = entitySavedSchema.parse((await call(client, "entity_task_create", args)).data);
  assert.notEqual(duplicate.ref.id, created.ref.id);
  const renamed = entitySavedSchema.parse(
    (
      await call(client, "entity_rename_key", {
        ref: created.key,
        key: "TASK-CHECK-23",
        ifRevision: 1,
        actor: "agent",
        requestId: "entity-rename",
      })
    ).data,
  );
  const byKey = entityDetailSchema.parse(
    (await call(client, "entity_get", { ref: created.key })).data,
  );
  const byId = entityDetailSchema.parse(
    (await call(client, "entity_get", { ref: created.ref.id })).data,
  );
  assert.deepEqual(byKey, byId);
  assert.equal(byKey.key, renamed.key);
  assert.equal(
    (await call(client, "entities_list", { kind: "task", board: "BOARD-PRODUCT" })).data?.total,
    2,
  );
  assert.equal((await call(client, "entity_keys", { ref: renamed.key })).data?.total, 2);
  const contextDefinition = tools.find((tool) => tool.name === "entity_context")!;
  const contextProperties = contextDefinition.inputSchema.properties as Record<string, unknown>;
  assert.equal("depth" in contextProperties, false);
  assert.equal("offset" in contextProperties, false);
  const context = await call(client, "entity_context", { ref: created.key });
  assert.equal(context.ok, true);
  const graph = fullContextSchema.parse(context.data);
  assert.equal(graph.complete, true);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges[0]?.type, "part-of");
  const limited = await call(client, "entity_context", { ref: created.key, maxBytes: 1024 });
  assert.equal(limited.ok, false);
  assert.equal(limited.error?.code, "RESPONSE_TOO_LARGE");
  assert.equal(limited.data, undefined);
});

test("MCP канбана: предметные аргументы, блокеры, повтор и перенос со стабильным ID", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === "board_task_create",
  );
  assert.ok(definition);
  const properties = definition.inputSchema.properties as Record<string, { description?: string }>;
  for (const name of [
    "board",
    "title",
    "description",
    "column",
    "requestId",
    "actor",
    "productLinks",
    "parentId",
  ])
    assert.match(properties[name]?.description ?? "", /[А-Яа-яЁё]/);
  assert.equal("kind" in properties, false);
  const create = {
    board: "product",
    title: "Цель",
    description: "## Цель\nРабота",
    requestId: "create",
    actor: "agent",
  };
  const saved = await call(client, "board_task_create", create);
  assert.equal(saved.ok, true);
  assert.match(String(saved.data?.id), /^[A-Za-z0-9]{8}$/);
  const duplicate = await call(client, "board_task_create", create);
  assert.equal(duplicate.ok, true);
  assert.notEqual(duplicate.data?.id, saved.data?.id);
  const dep = await call(client, "board_task_create", {
    ...create,
    board: "infrastructure",
    requestId: "dep",
  });
  const reference = String(saved.data?.id);
  const linked = await call(client, "board_task_link", {
    reference,
    target: dep.data?.id,
    relation: "depends-on",
    ifRevision: 1,
    requestId: "link",
    actor: "agent",
  });
  assert.equal(linked.ok, true);
  assert.equal((await call(client, "board_tasks_list", { readiness: "blocked" })).data?.total, 1);
  assert.equal(
    (
      await call(client, "board_task_move", {
        reference,
        column: "done",
        ifRevision: 2,
        requestId: "blocked",
        actor: "agent",
      })
    ).error?.code,
    "TASK_BLOCKED",
  );
  const moved = await call(client, "board_task_move", {
    reference,
    board: "infrastructure",
    column: "ready",
    ifRevision: 2,
    requestId: "move",
    actor: "agent",
  });
  assert.equal(moved.data?.id, reference);
  assert.equal(moved.data?.key, "INFRA-2");
});

test("MCP критериев: discovery, атомарное создание, выполнение, повтор и конфликт", async (t) => {
  const app = await setup(t);
  const server = await app.start(join(app.root, "a/.relay/config.json"));
  const client = await app.connect(server.url);
  const tools = (await client.listTools()).tools;
  for (const name of [
    "task_criteria_list",
    "task_criterion_get",
    "task_criterion_add",
    "task_criterion_update",
    "task_criterion_complete",
    "task_criterion_remove",
  ]) {
    const definition = tools.find((tool) => tool.name === name);
    assert.ok(definition);
    for (const property of Object.values(definition.inputSchema.properties ?? {}))
      assert.match((property as { description?: string }).description ?? "", /[А-Яа-яЁё]/);
  }
  const saved = await call(client, "board_task_create", {
    board: "product",
    requestId: "criteria",
    actor: "orchestrator",
    acceptanceCriteria: [{ title: "Условие", description: "## Проверить\n\nРезультат" }],
  });
  assert.equal(saved.ok, true);
  const reference = saved.data?.id;
  const page = await call(client, "task_criteria_list", { reference });
  const criterionId = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(page.data)
    .items[0]!.id;
  assert.equal((await call(client, "task_criterion_get", { reference, criterionId })).ok, true);
  const command = {
    reference,
    criterionId,
    completed: true,
    ifRevision: 1,
    actor: "human",
    requestId: "complete",
  };
  const complete = await call(client, "task_criterion_complete", command);
  assert.equal(complete.ok, true);
  assert.equal(
    (await call(client, "task_criterion_complete", command)).error?.code,
    "REVISION_CONFLICT",
  );
  assert.equal(
    (await call(client, "task_criterion_complete", { ...command, requestId: "stale" })).error?.code,
    "REVISION_CONFLICT",
  );
});

test("продукт доступен агенту через API и изолирован между областями", async (t) => {
  const app = await setup(t);
  const { configPath } = await initializeRegistry(app.root);
  await registerProject(configPath, "a", { path: "a" });
  await registerProject(configPath, "b", { path: "b" });
  const server = await app.start();
  const client = await app.connect(server.url);
  const args = {
    project: "a",
    actor: "agent",
    command: {
      action: "create",
      requestId: "passport",
      fields: {
        kind: "passport",
        name: "Продукт",
        summary: "Назначение",
        description: "## Цель\n\nПрямой Markdown",
      },
    },
  };
  const saved = await call(client, "product_save", args);
  assert.equal(saved.ok, true);
  assert.equal((await call(client, "product_save", args)).ok, false);
  const list = await call(client, "product_list", { project: "a", kind: "passport" });
  assert.equal(list.ok, true);
  assert.equal(list.data?.total, 1);
  assert.equal((await call(client, "product_list", { project: "b" })).data?.total, 0);
  assert.equal((await call(client, "product_context", { project: "a" })).ok, true);
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === "product_feature_save",
  );
  assert.ok(definition);
  const properties = definition.inputSchema.properties as Record<string, { description?: string }>;
  for (const field of ["name", "description", "summary", "action", "requestId", "ifRevision"])
    assert.match(properties[field]!.description ?? "", /[А-Яа-яЁё]/);
  assert.equal(properties.command, undefined);
  const featureArgs = {
    project: "a",
    actor: "agent",
    action: "create",
    requestId: "feature-tool",
    name: "Каталог",
    summary: "Поиск\nВыбор",
    description: "## Цель\n\nНайти вещь.\n\n## Критерии приёмки\n\n- Вещь доступна.",
  };
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "product_feature_save", arguments: featureArgs }),
  );
  assert.match(z.object({ text: z.string() }).parse(result.content[0]).text, /Каталог/);
  const receipt = z
    .object({
      ok: z.literal(true),
      data: z.object({ id: z.string(), revision: z.literal(1), name: z.literal("Каталог") }),
    })
    .parse(result.structuredContent);
  const repeated = CallToolResultSchema.parse(
    await client.callTool({ name: "product_feature_save", arguments: featureArgs }),
  );
  assert.notEqual(repeated.isError, true);
  assert.notEqual(
    z.object({ data: z.object({ id: z.string() }) }).parse(repeated.structuredContent).data.id,
    receipt.data.id,
  );
  const wrongRevision = CallToolResultSchema.parse(
    await client.callTool({
      name: "product_feature_save",
      arguments: {
        ...featureArgs,
        requestId: "bad-update",
        action: "update",
        id: receipt.data.id,
        ifRevision: 99,
      },
    }),
  );
  assert.equal(wrongRevision.isError, true);
  const byKey = await call(client, "product_get", { project: "a", ref: "FEATURE-1" });
  assert.equal(byKey.data?.id, receipt.data.id);
  const compact = await call(client, "product_entities", {
    project: "a",
    q: "FEATURE-1",
    limit: 1,
  });
  assert.equal(compact.data?.total, 1);
  assert.equal((await call(client, "product_get", { project: "b", ref: "FEATURE-1" })).ok, false);
  await call(client, "product_application_save", {
    project: "a",
    actor: "agent",
    action: "create",
    requestId: "app-keys",
    name: "Web",
    summary: "Интерфейс",
    description: "## Назначение\n\nПоказывать каталог.",
    slug: "web",
    prefix: "WEB",
    type: "frontend",
  });
  const overview = await call(client, "product_overview", { project: "a" });
  const scope = await call(client, "product_scope_replace", {
    project: "a",
    actor: "agent",
    applicationId: "WEB",
    ifRevision: 0,
    ifVersion: overview.data?.version,
    requestId: "scope-keys",
    contracts: [
      {
        featureId: "FEATURE-1",
        scenarioId: null,
        title: "Каталог Web",
        description: "## Вклад\n\nОтобразить товары.",
        status: "none",
      },
    ],
  });
  assert.equal(scope.ok, true);
  const implementation = await call(client, "product_get", { project: "a", ref: "WEB-FI-1" });
  const change = {
    project: "a",
    ref: "WEB-FI-1",
    ifRevision: implementation.data?.revision,
    actor: "agent",
    requestId: "impl-keys",
    status: "partial",
  };
  const changed = await call(client, "product_implementation_update", change);
  assert.equal(changed.ok, true);
  assert.equal(changed.data?.id, implementation.data?.id);
  assert.equal(
    (await call(client, "product_implementation_update", change)).error?.code,
    "REVISION_CONFLICT",
  );
  assert.equal((await call(client, "product_lint", { project: "a" })).ok, true);
  assert.equal((await call(client, "product_list", { project: "b" })).data?.total, 0);
});

test("несколько MCP-клиентов, общий Relay Server, горячий реестр и изоляция задач/авторов", async (t) => {
  const app = await setup(t);
  const { configPath } = await initializeRegistry(app.root);
  await registerProject(configPath, "a", { path: "a" });
  const server = await app.start();
  const [first, second] = await Promise.all([app.connect(server.url), app.connect(server.url)]);
  const toolsBefore = await first.listTools();
  const removed = [
    "project_context",
    "project_records",
    "project_record_get",
    "project_record_save",
    "task_briefing",
    "checkpoint_changes",
    "project_overview",
    "project_groups",
    "tasks_list",
    "task_create",
    "task_get",
    "comment_add",
    "log_add",
  ];
  assert.ok(toolsBefore.tools.every((tool) => !removed.includes(tool.name)));
  const documentation = await readFile(new URL("../docs/MCP.md", import.meta.url), "utf8");
  for (const tool of toolsBefore.tools) {
    assert.equal(tool.annotations?.idempotentHint, tool.annotations?.readOnlyHint);
    if (!tool.annotations?.readOnlyHint) {
      assert.match(tool.description ?? "", /не повторяйте запись вслепую/);
    }
    assert(documentation.includes(`\`${tool.name}\``), `Нет справки инструмента ${tool.name}`);
    assert.match(tool.description ?? "", /[А-Яа-яЁё]/);
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.properties && typeof node.properties === "object")
        for (const [name, field] of Object.entries(node.properties)) {
          if (name === "requestId")
            assert.match(
              (field as { description?: string }).description ?? "",
              /не ключ дедупликации/,
            );
          assert.match(
            (field as { description?: string }).description ?? "",
            /[А-Яа-яЁё]/,
            `${tool.name}.${name}`,
          );
        }
      Object.values(node).forEach(inspect);
    };
    inspect(tool.inputSchema);
  }
  assert.equal(
    (
      await call(first, "board_task_create", {
        project: "a",
        board: "product",
        requestId: "first",
        title: "Первая",
        actor: "agent-a",
      })
    ).ok,
    true,
  );
  assert.equal((await call(second, "project_register", { project: "b", path: "b" })).ok, true);
  assert.equal(
    (
      await call(second, "board_task_create", {
        project: "b",
        board: "product",
        requestId: "first",
        title: "Вторая",
        actor: "agent-b",
      })
    ).ok,
    true,
  );
  const [a, b] = await Promise.all([
    call(first, "board_task_get", { project: "a", reference: "PRODUCT-1" }),
    call(second, "board_task_get", { project: "b", reference: "PRODUCT-1" }),
  ]);
  assert.equal(a.data?.title, "Первая");
  assert.equal(b.data?.title, "Вторая");
  assert.equal(a.data?.createdBy, "agent-a");
  assert.equal(b.data?.createdBy, "agent-b");
  assert.equal(a.meta?.project, "a");
  assert.equal((await call(first, "board_tasks_list")).error?.code, "PROJECT_REQUIRED");
  const update = {
    project: "b",
    reference: "PRODUCT-1",
    actor: "agent-b",
    description: "Отчёт",
    ifRevision: 1,
    requestId: "step-1",
  };
  assert.equal((await call(first, "board_task_update", update)).ok, true);
  assert.equal((await call(second, "board_task_update", update)).error?.code, "REVISION_CONFLICT");
  assert.equal(
    (await call(first, "board_task_update", { ...update, description: "Другое" })).error?.code,
    "REVISION_CONFLICT",
  );
  const current = await call(second, "board_task_get", { project: "b", reference: "PRODUCT-1" });
  assert.equal(current.data?.description, update.description);
  assert.equal(
    (
      await call(second, "board_task_update", {
        ...update,
        ifRevision: current.data?.revision,
        description: "Согласованная правка после чтения",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call(first, "board_task_update", {
        project: "b",
        reference: "PRODUCT-1",
        requestId: "conflict",
        actor: "orchestrator",
        ifRevision: 1,
        title: "Конфликт",
      })
    ).error?.code,
    "REVISION_CONFLICT",
  );
  await writeFile(
    join(app.root, "next.json"),
    JSON.stringify({ version: 1, projects: { a: { path: "b" } } }),
  );
  await rename(join(app.root, "next.json"), configPath);
  assert.equal(
    (await call(first, "board_task_get", { project: "a", reference: "PRODUCT-1" })).data?.title,
    "Вторая",
  );
  assert.equal(
    (await call(second, "board_task_get", { project: "b", reference: "PRODUCT-1" })).error?.code,
    "PROJECT_NOT_FOUND",
  );
  assert.deepEqual(await first.listTools(), toolsBefore);
  await writeFile(configPath, "{");
  assert.equal(
    (await call(first, "board_task_get", { project: "a", reference: "PRODUCT-1" })).error?.code,
    "INVALID_DATA",
  );
  await writeFile(configPath, JSON.stringify({ version: 1, projects: { a: { path: "a" } } }));
  assert.equal(
    (await call(first, "board_task_get", { project: "a", reference: "PRODUCT-1" })).data?.title,
    "Первая",
  );
});

test("один проект по прямому конфигу и автоматическому поиску, ошибки HTTP и завершение", async (t) => {
  const app = await setup(t);
  const path = join(app.root, "a/.relay/config.json");
  const server = await app.start(path);
  const client = await app.connect(server.url);
  assert.equal((await call(client, "projects_list")).meta?.mode, "local");
  assert.equal(
    (
      await call(client, "board_task_create", {
        board: "product",
        requestId: "single",
        title: "Одна база",
        actor: "orchestrator",
      })
    ).ok,
    true,
  );
  assert.equal(
    (await call(client, "board_task_get", { reference: "PRODUCT-1" })).data?.title,
    "Одна база",
  );
  assert.equal(
    (await call(client, "board_task_get", { project: "wrong", reference: "PRODUCT-1" })).error
      ?.code,
    "PROJECT_NOT_FOUND",
  );
  assert.equal(
    (
      await call(client, "board_task_create", {
        board: "product",
        requestId: "missing-actor",
        title: "Без автора",
      })
    ).error?.code,
    "VALIDATION_ERROR",
  );
  assert.equal(
    (await fetch(server.url, { headers: { Origin: "https://example.com" } })).status,
    403,
  );
  assert.equal((await fetch(server.url, { headers: { Accept: "text/event-stream" } })).status, 405);
  await client.close();
  await server.close();
  await assert.rejects(fetch(server.url));
  const next = await startMcp({ cwd: join(app.root, "a"), port: 0, serverUrl: server.api.url });
  app.servers.push(next);
  const restored = await app.connect(next.url);
  assert.equal(
    (await call(restored, "board_task_get", { reference: "PRODUCT-1" })).data?.title,
    "Одна база",
  );
});

test("явный REST URL, remote-only, пагинация и курсоры разных проектов", async (t) => {
  const app = await setup(t);
  const { configPath } = await initializeRegistry(app.root);
  await registerProject(configPath, "remote", { path: "a" });
  await registerProject(configPath, "other", { path: "b" });
  const server = await app.start();
  const api = server.api;
  const client = await app.connect(server.url);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await call(client, "board_task_create", {
          project: "remote",
          board: "product",
          requestId: `create-${i}`,
          title: `Задача ${i}`,
          actor: "agent",
        })
      ).ok,
      true,
    );
  const first = await call(client, "board_tasks_list", { project: "remote", limit: 1 });
  assert.equal(first.data?.nextOffset, 1);
  const next = await call(client, "board_tasks_list", {
    project: "remote",
    limit: 1,
    offset: first.data?.nextOffset,
    version: first.data?.version,
  });
  assert.notDeepEqual(first.data, next.data);
  assert.equal(
    (
      await call(client, "board_tasks_list", {
        project: "other",
        limit: 1,
        offset: first.data?.nextOffset,
        version: first.data?.version,
      })
    ).error?.code,
    "BOARD_CHANGED",
  );
  const saved = await call(client, "board_task_get", { project: "remote", reference: "PRODUCT-1" });
  assert.equal(saved.data?.createdBy, "agent");
  await writeFile(
    join(app.root, "b/.relay/config.json"),
    JSON.stringify({ ...defaultConfig, server: { port: 3000, url: api.url } }),
  );
  assert.equal(
    (await call(client, "board_task_get", { project: "other", reference: "PRODUCT-1" })).error
      ?.code,
    "NOT_FOUND",
  );
  await api.close();
  assert.equal(
    (await call(client, "board_task_get", { project: "remote", reference: "PRODUCT-1" })).error
      ?.code,
    "SERVER_UNAVAILABLE",
  );
});

test("параллельный первый доступ, размер ответа и постоянная регистрация после рестарта", async (t) => {
  const app = await setup(t);
  await initializeRegistry(app.root);
  const server = await app.start();
  const [a, b] = await Promise.all([app.connect(server.url), app.connect(server.url)]);
  assert.equal((await call(a, "project_register", { project: "app", path: "a" })).ok, true);
  const created = await Promise.all(
    [a, b].map((client, index) =>
      call(client, "board_task_create", {
        project: "app",
        board: "product",
        requestId: `parallel-${index}`,
        title: `Работа ${index}`,
        actor: `agent-${index}`,
        description: "Контекст".repeat(1000),
      }),
    ),
  );
  for (const result of created) assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(new Set(created.map((item) => item.data?.id)).size, 2);
  assert.equal(
    (await call(a, "board_task_get", { project: "app", reference: "PRODUCT-1", maxBytes: 1024 }))
      .error?.code,
    "RESPONSE_TOO_LARGE",
  );
  assert.equal(
    (await call(a, "board_tasks_list", { project: "app", limit: 1, maxBytes: 4096 })).ok,
    true,
  );
  await Promise.all([a.close(), b.close()]);
  await server.close();
  const restarted = await app.start();
  const next = await app.connect(restarted.url);
  assert.equal(
    (
      await call(next, "board_task_get", {
        project: "app",
        reference: String(created[0]?.data?.id),
        maxBytes: 65536,
      })
    ).data?.id,
    created[0]?.data?.id,
  );
});
