import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import type { OpenAPIObject } from "@nestjs/swagger";
import { WORK_HISTORY_CAPABILITY } from "@relay/contracts/work-history";
import { initialize } from "@relay/core/storage/workspace";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { createServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

const markdown =
  "  # Полное поручение\n\n## Условия\n\n```ts\nconst value = '  ';\n```\n\nПоследняя строка  \n\n";
const operator = { name: "Человек клиента", email: "client@example.test", source: "git" as const };
const git = { branch: "feature/история", commit: "1234567890abcdef" };

for (const mode of ["local", "http"] as const)
  test(`История ${mode}: намерение → fork → attach → результат → явная приёмка родителем`, async (t) => {
    const { app, root } = await fixture(t);
    await app.listen(0, "127.0.0.1");
    const backend =
      mode === "local"
        ? await createLocalBackend(root)
        : await createHttpBackend(await app.getUrl());
    const work = backend.workHistory;
    let parent = await work.start(
      { title: "Родитель", description: markdown, operator, git, requestId: "start" },
      "parent",
    );
    const parentRef = parent.session.key;
    const parentRunId = parent.run!.id;
    assert.equal(parent.session.description, markdown);
    assert.equal(parent.run!.actor, "parent");
    assert.deepEqual(parent.run!.operator, operator);
    assert.deepEqual(parent.run!.git, git);
    parent = await work.openCheckpoint(
      {
        ref: parentRef,
        runId: parentRunId,
        ifRevision: parent.session.revision,
        title: "Намерение",
        body: markdown,
        references: ["PROJECT"],
        requestId: "intent",
      },
      "parent",
    );
    const intent = parent.checkpoint!;
    assert.equal(intent.body, markdown);
    assert.equal(intent.references[0]!.key, "PROJECT");
    const fork = await work.fork(
      {
        ref: intent.key,
        runId: parentRunId,
        ifRevision: parent.session.revision,
        title: "Ребёнок",
        description: markdown,
        requestId: "fork",
      },
      "parent",
    );
    assert.equal(fork.childSession!.status, "pending");
    assert.equal(fork.childSession!.currentRunId, null);
    assert.equal(fork.childSession!.originCheckpointId, intent.id);
    assert.equal(fork.childSession!.parentSessionId, parent.session.id);
    let child = await work.attach(
      {
        ref: fork.childSession!.key,
        ifRevision: fork.childSession!.revision,
        actor: "child",
        client: "test",
        requestId: "attach",
      },
      "ignored",
    );
    assert.equal(child.run!.actor, "child");
    assert.deepEqual(child.run!.operator, { ...operator, source: "inherited" });
    assert.equal(child.run!.git, null);
    assert.equal((await work.openIntents({ ref: parentRef })).total, 1);
    child = await work.openCheckpoint(
      {
        ref: child.session.key,
        ifRevision: child.session.revision,
        runId: child.run!.id,
        title: "Исполнение",
        body: markdown,
        requestId: "child-intent",
      },
      "child",
    );
    const open = await work.openIntents({ ref: parentRef, includeChildren: true, limit: 1 });
    assert.equal(open.total, 2);
    assert.equal(open.items[0]!.body, markdown);
    assert.equal(open.nextOffset, 1);
    const openNext = await work.openIntents({
      ref: parentRef,
      includeChildren: true,
      limit: 1,
      offset: 1,
      version: open.version,
    });
    assert.equal(openNext.items.length, 1);
    assert.notEqual(openNext.items[0]!.id, open.items[0]!.id);
    assert.equal((await work.openIntents({ ref: parentRef, includeChildren: false })).total, 1);
    child = await work.completeCheckpoint(
      {
        ref: child.checkpoint!.key,
        ifRevision: child.session.revision,
        runId: child.run!.id,
        title: "Результат",
        body: markdown,
        checks: markdown,
        requestId: "child-result",
      },
      "child",
    );
    child = await work.complete(
      {
        ref: child.session.key,
        ifRevision: child.session.revision,
        runId: child.run!.id,
        result: markdown,
        requestId: "child-complete",
      },
      "child",
    );
    assert.equal(child.session.result, markdown);
    assert.equal((await work.get({ ref: child.session.key })).acceptance, null);
    await assert.rejects(
      work.openIntents({
        ref: parentRef,
        includeChildren: true,
        limit: 1,
        offset: 1,
        version: open.version,
      }),
      { code: "VERSION_CONFLICT" },
    );
    await assert.rejects(
      work.complete(
        {
          ref: parentRef,
          ifRevision: fork.session.revision,
          runId: parentRunId,
          result: markdown,
          requestId: "not-accepted",
        },
        "parent",
      ),
    );
    parent = await work.saveCheckpoint(
      {
        ref: intent.key,
        ifRevision: fork.session.revision,
        runId: parentRunId,
        title: "Принятие",
        body: markdown,
        acceptedSessionIds: [child.session.id],
        requestId: "accept",
      },
      "parent",
    );
    assert.deepEqual(parent.checkpoint!.acceptedSessionIds, [child.session.id]);
    assert.equal(
      (await work.get({ ref: child.session.key })).acceptance!.checkpointId,
      parent.checkpoint!.id,
    );
    parent = await work.completeCheckpoint(
      {
        ref: intent.key,
        ifRevision: parent.session.revision,
        runId: parentRunId,
        title: "Итог намерения",
        body: markdown,
        requestId: "parent-result",
      },
      "parent",
    );
    parent = await work.complete(
      {
        ref: parentRef,
        ifRevision: parent.session.revision,
        runId: parentRunId,
        result: markdown,
        requestId: "parent-complete",
      },
      "parent",
    );
    assert.equal(parent.session.status, "completed");
    assert.equal((await work.checkpoint({ ref: intent.key })).body, markdown);
    assert.equal((await work.get({ ref: parentRef })).session.result, markdown);
    const roots = await work.list({ parent: null, unfinished: false });
    assert.equal(roots.total, 1);
    assert.equal(roots.projectTotals.sessions, 2);
    assert.equal(roots.projectTotals.unfinished, 0);
    assert.equal(roots.items[0]!.counts.children, 1);
    assert.equal(roots.items[0]!.latestRun!.actor, "parent");
    assert.deepEqual(roots.items[0]!.latestRun!.operator, operator);
    assert.equal((await work.openIntents({ ref: parentRef, includeChildren: true })).total, 0);
    assert.equal(roots.items[0]!.id, parent.session.id);
    assert.equal((await work.list({ unfinished: true })).total, 0);
    assert.equal((await work.list({ actor: "child" })).total, 1);
    const tree = await work.tree({ ref: parentRef, limit: 1 });
    assert.equal(tree.total, 2);
    assert.equal(tree.totals.sessions, 2);
    assert.equal(tree.nextOffset, 1);
    const next = await work.tree({
      ref: parentRef,
      offset: tree.nextOffset!,
      limit: 1,
      version: tree.version,
    });
    assert.equal(next.items[0]!.depth, 1);
    assert.equal(next.items[0]!.parentSessionId, parent.session.id);
    assert.equal(next.items[0]!.session.latestRun!.actor, "child");
    assert(next.items[0]!.session.acceptance);
    const own = await work.history({ ref: parentRef, includeChildren: false, order: "asc" });
    assert(own.items.every((item) => item.sessionId === parent.session.id));
    const all = await work.history({
      ref: parentRef,
      includeChildren: true,
      order: "asc",
      limit: 1,
    });
    assert(all.total > own.total);
    assert.equal(all.nextOffset, 1);
    const context = await work.context({ ref: parentRef, limit: 1 });
    assert.equal(context.session.description, markdown);
    assert.equal(context.session.result, markdown);
    assert.equal(context.history.items.length, 1);
    assert.equal(context.history.total, own.total);
    const projectPage = await work.history({ limit: 1 });
    await work.start({ title: "Новая ветка", requestId: "new" }, "other");
    await assert.rejects(work.history({ offset: 1, limit: 1, version: projectPage.version }), {
      code: "VERSION_CONFLICT",
    });
  });

test("История HTTP: takeover не разрешает старому run запись; pause/resume/cancel сохраняют lifecycle", async (t) => {
  const { app } = await fixture(t);
  await app.listen(0, "127.0.0.1");
  const work = (await createHttpBackend(await app.getUrl())).workHistory;
  let current = await work.start({ title: "Ветка", requestId: "start" }, "old");
  const oldRun = current.run!.id;
  current = await work.takeover(
    {
      ref: current.session.key,
      ifRevision: current.session.revision,
      reason: markdown,
      requestId: "transfer",
    },
    "new",
  );
  assert.equal(current.run!.predecessorRunId, oldRun);
  assert.equal(current.run!.actor, "new");
  await assert.rejects(
    work.openCheckpoint(
      {
        ref: current.session.key,
        ifRevision: current.session.revision,
        runId: oldRun,
        title: "Старый владелец",
        body: markdown,
        requestId: "old",
      },
      "old",
    ),
    { code: "WORK_RUN_NOT_CURRENT", exitCode: 4 },
  );
  const stale = await app.inject({
    method: "POST",
    url: "/api/v1/work-history/checkpoints/open",
    payload: {
      ref: current.session.key,
      ifRevision: current.session.revision,
      runId: oldRun,
      title: "Старый владелец",
      body: markdown,
      requestId: "stale-wire",
      actor: "old",
    },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, "WORK_RUN_NOT_CURRENT");
  assert.equal((await work.get({ ref: current.session.key })).counts.checkpoints, 0);
  current = await work.openCheckpoint(
    {
      ref: current.session.key,
      ifRevision: current.session.revision,
      runId: current.run!.id,
      title: "Намерение",
      requestId: "open",
      body: markdown,
    },
    "new",
  );
  const intent = current.checkpoint!.key;
  current = await work.pause(
    {
      ref: current.session.key,
      ifRevision: current.session.revision,
      runId: current.run!.id,
      reason: markdown,
      requestId: "pause",
    },
    "new",
  );
  assert.equal(current.session.status, "paused");
  assert.equal(current.run!.endSummary, markdown);
  current = await work.resume(
    { ref: current.session.key, ifRevision: current.session.revision, requestId: "resume" },
    "resumed",
  );
  current = await work.cancelCheckpoint(
    {
      ref: intent,
      ifRevision: current.session.revision,
      runId: current.run!.id,
      title: "Отмена",
      body: markdown,
      requestId: "cancel-intent",
    },
    "resumed",
  );
  current = await work.cancel(
    {
      ref: current.session.key,
      ifRevision: current.session.revision,
      runId: current.run!.id,
      result: markdown,
      requestId: "cancel",
    },
    "resumed",
  );
  assert.equal(current.session.status, "cancelled");
});

test("История: реальные local/scoped HTTP, OpenAPI из канона и строгие bool query", async (t) => {
  const { app, workspace } = await fixture(t);
  const document = (await app.inject("/api/openapi.json")).json<OpenAPIObject>();
  const ajv = new Ajv({ strict: false, allErrors: true });
  formats.default(ajv);
  const operations = Object.entries(document.paths).filter(([path]) =>
    path.includes("/work-history/"),
  );
  assert.equal(operations.length, 44);
  for (const [, item] of operations) {
    const operation = item.get ?? item.post!;
    assert(operation.operationId);
    for (const parameter of operation.parameters ?? [])
      if (!("$ref" in parameter))
        assert(parameter.description || (parameter.schema && "description" in parameter.schema));
  }
  for (const prefix of ["/api/v1", `/api/v1/projects/${workspace.config.projectId}`]) {
    const context = (await app.inject(`${prefix}/context`)).json().data;
    assert(context.capabilities.includes(WORK_HISTORY_CAPABILITY));
    const response = await app.inject({
      method: "POST",
      url: `${prefix}/work-history/sessions/start`,
      payload: { title: "Ветка HTTP", description: markdown, requestId: "wire" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const schema = document.components!.schemas!.WorkHistoryMutation!;
    const validate = ajv.compile({ ...schema, components: document.components });
    assert(validate(response.json().data), JSON.stringify(validate.errors));
    assert.equal(response.json().data.run.actor, "web-human");
    assert.equal(response.json().data.run.operator, null);
    assert.equal(response.json().data.run.git, null);
    assert.equal(response.json().data.session.description, markdown);
    assert.equal(
      (await app.inject(`${prefix}/work-history/sessions?unfinished=false`)).json().data.total,
      0,
    );
    for (const query of [
      "unfinished=0",
      "unfinished=TRUE",
      "unfinished=",
      "unfinished=false&unfinished=true",
      "limit=101",
      "offset=-1",
      "unknown=1",
    ])
      assert.equal(
        (await app.inject(`${prefix}/work-history/sessions?${query}`)).statusCode,
        400,
        query,
      );
    assert.equal(
      (await app.inject(`${prefix}/work-history/history?includeChildren=no`)).statusCode,
      400,
    );
    assert.equal((await app.inject(`${prefix}/work-history/history?ref=S-1`)).statusCode, 400);
  }
});

test("История workspace: две базы и параллельные авторы изолированы", async (t) => {
  const { root } = await fixture(t);
  await initialize(join(root, "second"), "tasks");
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "." });
  await registerProject(registry.configPath, "b", { path: "second" });
  const app = await createServer({ cwd: root, actor: "server" });
  try {
    await app.listen(0, "127.0.0.1");
    const [a, b] = await Promise.all([
      createHttpBackend(await app.getUrl(), "a"),
      createHttpBackend(await app.getUrl(), "b"),
    ]);
    const [first, second] = await Promise.all([
      a.workHistory.start({ title: "A", actor: "explicit-a", requestId: "same" }, "ignored"),
      b.workHistory.start({ title: "B", requestId: "same" }, "default-b"),
    ]);
    assert.equal(first.run!.actor, "explicit-a");
    assert.equal(second.run!.actor, "default-b");
    assert.notEqual(first.session.key, second.session.key);
    assert.notEqual(first.session.id, second.session.id);
    assert.equal((await a.workHistory.get({ ref: first.session.key })).session.title, "A");
    assert.equal((await b.workHistory.get({ ref: second.session.key })).session.title, "B");
    await assert.rejects(a.workHistory.get({ ref: second.session.id }));
    assert.equal((await app.inject("/api/v1/work-history/sessions")).statusCode, 400);
  } finally {
    await app.close();
  }
});
