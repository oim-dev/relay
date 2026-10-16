import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import type { OpenAPIObject } from "@nestjs/swagger";
import { WORK_HISTORY_CAPABILITY } from "@relay/contracts/work-history";
import {
  WORK_HISTORY_GRAPH_CAPABILITY,
  workHistoryGraphPageSchema,
  workHistoryGraphPointDetailSchema,
} from "@relay/contracts/work-history-graph";
import type { WorkHistoryGraphPage } from "@relay/contracts/work-history-graph";
import { WorkHistoryService } from "@relay/core/application/work-history/service";
import { WorkHistoryGraphService } from "@relay/core/application/work-history/graph";
import { initialize } from "@relay/core/storage/workspace";
import type { Workspace } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { HttpClient } from "@relay/rest-sdk/http-client";
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { operationsTree } from "@relay/rest-sdk/operations-tree";
import { createServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

const markdown =
  "  # Только полная карточка\n\n```ts\nconst spaces = '  ';\n```\n\n" +
  "Материал с пробелами  \n".repeat(250);
const firstOperator = {
  name: "Первый человек",
  email: "first@example.test",
  source: "explicit" as const,
};
const firstGit = { branch: "work/first", commit: "1111111111111111111111111111111111111111" };

async function historyFixture(workspace: Workspace) {
  const service = new WorkHistoryService(workspace);
  let parent = await service.start(
    {
      title: "Корневая работа",
      description: markdown,
      reason: markdown,
      operator: firstOperator,
      git: firstGit,
      requestId: "root",
    },
    "first-agent",
  );
  const firstRun = parent.run!;
  const unfinished = await service.start(
    { title: "Давно открытая работа", description: markdown, requestId: "unfinished" },
    "waiting-agent",
  );
  let cancelled = await service.start(
    { title: "Отменённая работа", requestId: "cancelled-root" },
    "cancel-agent",
  );
  cancelled = await service.cancel(
    {
      ref: cancelled.session.key,
      ifRevision: cancelled.session.revision,
      runId: cancelled.run!.id,
      result: markdown,
      requestId: "cancel-root",
    },
    "cancel-agent",
  );
  parent = await service.openCheckpoint(
    {
      ref: parent.session.key,
      runId: firstRun.id,
      ifRevision: parent.session.revision,
      title: "Исходное намерение",
      summary: "Короткая подпись",
      body: markdown,
      done: markdown,
      checks: markdown,
      references: ["PROJECT"],
      requestId: "intent",
    },
    "first-agent",
  );
  const intent = parent.checkpoint!;
  const fork = await service.fork(
    {
      ref: intent.key,
      runId: firstRun.id,
      ifRevision: parent.session.revision,
      title: "Поручение ребёнку",
      description: markdown,
      requestId: "fork",
    },
    "first-agent",
  );
  let child = await service.attach(
    { ref: fork.childSession!.key, ifRevision: fork.childSession!.revision, requestId: "attach" },
    "child-agent",
  );
  child = await service.complete(
    {
      ref: child.session.key,
      runId: child.run!.id,
      ifRevision: child.session.revision,
      result: markdown,
      requestId: "child-result",
    },
    "child-agent",
  );
  parent = await service.takeover(
    {
      ref: parent.session.key,
      ifRevision: fork.session.revision,
      reason: markdown,
      operator: { name: "Второй человек", email: "second@example.test", source: "environment" },
      git: { branch: "work/second", commit: "2222222222222222222222222222222222222222" },
      requestId: "takeover",
    },
    "second-agent",
  );
  const secondRun = parent.run!;
  parent = await service.completeCheckpoint(
    {
      ref: intent.key,
      runId: secondRun.id,
      ifRevision: parent.session.revision,
      title: "Явная приёмка",
      body: markdown,
      acceptedSessionIds: [child.session.id],
      requestId: "accept",
    },
    "second-agent",
  );
  const acceptance = parent.checkpoint!;
  parent = await service.complete(
    {
      ref: parent.session.key,
      runId: secondRun.id,
      ifRevision: parent.session.revision,
      result: markdown,
      requestId: "complete",
    },
    "second-agent",
  );
  return {
    service,
    parent: parent.session,
    child: child.session,
    intent,
    acceptance,
    firstRun,
    secondRun,
    unfinished,
    cancelled: cancelled.session,
  };
}

function checkCompact(value: unknown): void {
  const forbidden = new Set([
    "description",
    "body",
    "result",
    "done",
    "remaining",
    "nextStep",
    "checks",
    "references",
    "reason",
    "endSummary",
  ]);
  if (Array.isArray(value)) for (const item of value) checkCompact(item);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      assert(!forbidden.has(key), `Полный материал ${key} не должен попасть в graph`);
      checkCompact(item);
    }
}

for (const scoped of [false, true])
  test(`Граф истории ${scoped ? "scoped" : "unscoped"}: компактные страницы, явные границы и историческое авторство Modal`, async (t) => {
    const { app, workspace } = await fixture(t);
    const data = await historyFixture(workspace);
    const prefix = scoped ? `/api/v1/projects/${workspace.config.projectId}` : "/api/v1";
    const base = `${prefix}/work-history/graph`;
    const context = (await app.inject(`${prefix}/context`)).json().data;
    assert.equal(WORK_HISTORY_GRAPH_CAPABILITY, "relay-work-history-graph-v2");
    assert(context.capabilities.includes(WORK_HISTORY_CAPABILITY));
    assert(context.capabilities.includes(WORK_HISTORY_GRAPH_CAPABILITY));
    assert.equal(context.capabilities.includes("relay-work-history-graph-v1"), false);
    const countBefore = (await data.service.history({})).total;
    const raw = await app.inject(base);
    assert.equal(raw.statusCode, 200, raw.body);
    const graph = workHistoryGraphPageSchema.parse(raw.json().data);
    assert.match(graph.version, /^work-graph-v2:/);
    const oldVersion = await app.inject(
      `${base}?version=${encodeURIComponent(graph.version.replace("work-graph-v2:", "work-graph-v1:"))}`,
    );
    assert.equal(oldVersion.statusCode, 409, oldVersion.body);
    assert.equal(oldVersion.json().error.code, "VERSION_CONFLICT");
    assert.equal(graph.scopeRootId, null);
    checkCompact(graph);
    assert(!raw.body.includes("Только полная карточка"));
    assert.deepEqual(
      graph.edges.find((edge) => edge.kind === "fork" && edge.to === `${data.child.id}:created`),
      {
        kind: "fork",
        fromSessionId: data.parent.id,
        to: `${data.child.id}:created`,
      },
    );
    assert.deepEqual(
      graph.edges.find(
        (edge) => edge.kind === "branch-end" && edge.from === `${data.child.id}:closed`,
      ),
      {
        kind: "branch-end",
        from: `${data.child.id}:closed`,
        toSessionId: data.parent.id,
      },
    );
    assert.equal(new Set<string>(graph.edges.map((edge) => edge.kind)).has("acceptance"), false);
    assert(graph.edges.some((edge) => edge.kind === "root-start"));
    assert(graph.edges.some((edge) => edge.kind === "root-end"));
    assert(graph.items.some((point) => point.id === `${data.cancelled.id}:closed`));
    assert.equal(
      graph.edges.some(
        (edge) => edge.kind === "root-end" && edge.from === `${data.cancelled.id}:closed`,
      ),
      true,
    );
    assert.deepEqual(
      (await app.inject(`${base}?order=desc&includeChildren=true&offset=0&limit=50`)).json().data,
      graph,
    );
    const reverse = workHistoryGraphPageSchema.parse(
      (await app.inject(`${base}?order=asc`)).json().data,
    );
    assert.deepEqual(
      reverse.items.map((item) => item.id),
      graph.items.map((item) => item.id).reverse(),
    );
    const original = graph.items.find((item) => item.id === `${data.intent.id}:checkpoint`)!;
    assert.equal(original.runId, data.firstRun.id);
    assert.equal(original.intentState, "completed");
    assert.deepEqual(graph.runs.find((run) => run.id === original.runId)!.operator, firstOperator);

    const firstPage = workHistoryGraphPageSchema.parse(
      (await app.inject(`${base}?limit=1`)).json().data,
    );
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.total, graph.total);
    assert.equal(firstPage.openEnds.length, 1);
    const openEnd = firstPage.openEnds[0]!;
    assert.equal(openEnd.sessionId, data.unfinished.session.id);
    assert.equal(openEnd.runId, data.unfinished.run!.id);
    assert.equal(
      firstPage.items.some((point) => point.id === openEnd.id),
      false,
    );
    assert(firstPage.branches.some((branch) => branch.id === openEnd.sessionId));
    assert(firstPage.runs.some((run) => run.id === openEnd.runId));
    assert(graph.items.some((point) => point.id === openEnd.id && point.at === openEnd.at));
    const seen: string[] = [];
    let forkLane = false;
    let endedLane = false;
    let crossingWindow = false;
    for (let offset = 0; offset < firstPage.total; offset++) {
      const response = await app.inject(
        `${base}?limit=1&offset=${offset}&version=${encodeURIComponent(firstPage.version)}`,
      );
      assert.equal(response.statusCode, 200, response.body);
      const page = workHistoryGraphPageSchema.parse(response.json().data);
      checkCompact(page);
      seen.push(page.items[0]!.id);
      for (const edge of page.edges) {
        if (edge.kind === "sequence") {
          const from = page.boundaryNodes.find((node) => node.id === edge.from);
          const to = page.boundaryNodes.find((node) => node.id === edge.to);
          if (
            from &&
            to &&
            from.side !== to.side &&
            from.side !== "outside-scope" &&
            to.side !== "outside-scope"
          )
            crossingWindow = true;
        }
        if (edge.kind === "fork") {
          assert.equal(edge.fromSessionId, data.parent.id);
          assert.equal(edge.to, page.items[0]!.id);
          assert(
            page.branches.some((branch) => branch.id === edge.fromSessionId && branch.contextOnly),
          );
          forkLane = true;
        }
        if (edge.kind === "branch-end") {
          assert.equal(edge.toSessionId, data.parent.id);
          assert.equal(edge.from, page.items[0]!.id);
          assert(
            page.branches.some((branch) => branch.id === edge.toSessionId && branch.contextOnly),
          );
          endedLane = true;
        }
      }
    }
    assert.deepEqual(
      seen,
      graph.items.map((item) => item.id),
    );
    assert(forkLane);
    assert(endedLane);
    assert(crossingWindow);
    const childScope = workHistoryGraphPageSchema.parse(
      (await app.inject(`${base}?ref=${data.child.key}&includeChildren=false`)).json().data,
    );
    assert(childScope.items.every((point) => point.sessionId === data.child.id));
    assert.deepEqual(childScope.openEnds, []);
    assert.equal(
      childScope.boundaryNodes.some((point) => point.id === original.id),
      false,
    );
    assert.equal(
      childScope.branches.find((branch) => branch.id === data.child.id)!.originCheckpointId,
      data.intent.id,
    );
    assert.equal(
      childScope.edges.some((edge) => edge.kind === "root-start"),
      false,
    );
    assert.equal(
      childScope.branches.find((branch) => branch.id === data.parent.id)!.contextOnly,
      true,
    );

    for (const ref of [
      original.id,
      data.intent.key,
      data.intent.id,
      `work-checkpoint:${data.intent.id}`,
    ]) {
      const response = await app.inject(`${base}/points/${encodeURIComponent(ref)}`);
      assert.equal(response.statusCode, 200, response.body);
      const detail = workHistoryGraphPointDetailSchema.parse(response.json().data);
      assert.equal(detail.checkpoint!.body, markdown);
      assert.equal(detail.checkpoint!.done, markdown);
      assert.equal(detail.checkpoint!.checks, markdown);
      assert.equal(detail.checkpoint!.references[0]!.key, "PROJECT");
      assert.equal(detail.session.description, markdown);
      assert.equal(detail.run!.id, data.firstRun.id);
      assert.equal(detail.run!.actor, "first-agent");
      assert.deepEqual(detail.run!.operator, firstOperator);
      assert.deepEqual(detail.run!.git, firstGit);
      assert.equal(detail.run!.reason, markdown);
      assert.equal(detail.previousRun, null);
    }
    for (const session of [data.parent, data.child]) {
      const detail = workHistoryGraphPointDetailSchema.parse(
        (await app.inject(`${base}/points/${encodeURIComponent(`${session.id}:created`)}`)).json()
          .data,
      );
      assert.equal(detail.checkpoint, null);
      assert.equal(detail.run!.id, data.firstRun.id);
    }
    const accepted = workHistoryGraphPointDetailSchema.parse(
      (
        await app.inject(`${base}/points/${encodeURIComponent(`${data.acceptance.id}:checkpoint`)}`)
      ).json().data,
    );
    assert.equal(accepted.run!.id, data.secondRun.id);
    assert.equal(accepted.previousRun!.id, data.firstRun.id);
    assert.equal((await data.service.history({})).total, countBefore);
    await data.service.start({ title: "Изменение среза", requestId: "new" }, "agent");
    const stale = await app.inject(
      `${base}?limit=1&offset=1&version=${encodeURIComponent(firstPage.version)}`,
    );
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "VERSION_CONFLICT");
  });

test("Граф истории: строгие query, OpenAPI и настоящий generated SDK", async (t) => {
  const { app, workspace } = await fixture(t, true);
  const data = await historyFixture(workspace);
  const document = (await app.inject("/api/openapi.json")).json<OpenAPIObject>();
  const ajv = new Ajv({ strict: false, allErrors: true });
  formats.default(ajv);
  for (const prefix of ["/api/v1", `/api/v1/projects/${workspace.config.projectId}`]) {
    for (const query of [
      "includeChildren=0",
      "includeChildren=TRUE",
      "includeChildren=",
      "includeChildren=false&includeChildren=true",
      "limit=101",
      "limit=0",
      "offset=-1",
      "order=random",
      "version=",
      "status=open",
      "q=foo",
    ]) {
      const response = await app.inject(`${prefix}/work-history/graph?${query}`);
      assert.equal(response.statusCode, 400, response.body);
    }
    for (const ref of ["bad:bogus", "bad:created:created", "bad/created"]) {
      const response = await app.inject(
        `${prefix}/work-history/graph/points/${encodeURIComponent(ref)}`,
      );
      assert(response.statusCode >= 400 && response.statusCode < 500, response.body);
      assert.equal(response.json().ok, false);
    }
    const absent = await app.inject(`${prefix}/work-history/graph/points/absent:checkpoint`);
    assert.equal(absent.statusCode, 404, absent.body);
    assert.equal(
      (
        await app.inject(
          `${prefix}/work-history/graph/points/${data.intent.key}?ref=${data.acceptance.key}`,
        )
      ).statusCode,
      400,
    );
  }
  await app.listen(0, "127.0.0.1");
  const api = createApiClient(
    new HttpClient({ baseUrl: await app.getUrl() }),
    operationsTree,
  ).workHistory;
  const unscoped = await api.getWorkHistoryGraph({ limit: 1, includeChildren: false });
  const scoped = await api.getWorkHistoryGraphForProject({
    project: workspace.config.projectId!,
    limit: 1,
    includeChildren: false,
  });
  assert.deepEqual(scoped, unscoped);
  const ref = encodeURIComponent(`${data.intent.id}:checkpoint`);
  const point = await api.getWorkHistoryGraphPoint({ ref });
  assert.deepEqual(
    await api.getWorkHistoryGraphPointForProject({ project: workspace.config.projectId!, ref }),
    point,
  );
  for (const [path, value, operationId] of [
    ["/api/v1/work-history/graph", unscoped, "getWorkHistoryGraph"],
    ["/api/v1/work-history/graph/points/{ref}", point, "getWorkHistoryGraphPoint"],
    ["/api/v1/projects/{project}/work-history/graph", scoped, "getWorkHistoryGraphForProject"],
    [
      "/api/v1/projects/{project}/work-history/graph/points/{ref}",
      point,
      "getWorkHistoryGraphPointForProject",
    ],
  ] as const) {
    const operation = document.paths[path]!.get!;
    assert.equal(operation.operationId, operationId);
    const response = operation.responses[200]!;
    assert(!("$ref" in response));
    const validate = ajv.compile({
      ...response.content!["application/json"]!.schema,
      components: document.components,
    });
    assert(validate(value), JSON.stringify(validate.errors));
  }
  const schema = document.components!.schemas!.WorkHistoryGraphQuery!;
  assert(!("$ref" in schema));
  assert(!schema.required?.includes("includeChildren"));
  assert(!schema.required?.includes("order"));
  const html = await app.inject("/");
  assert.equal(html.statusCode, 200);
  // Runtime не устанавливает CSP: внешние изображения не блокируются серверным img-src.
  assert.equal(html.headers["content-security-policy"], undefined);
});

test("Граф SDK: completed/cancelled ребёнок замыкается в parent lane до приёмки, чтение ничего не записывает", async (t) => {
  const { app, workspace } = await fixture(t);
  const service = new WorkHistoryService(workspace);
  let parent = await service.start({ title: "Родитель", requestId: "root" }, "parent");
  const parentRunId = parent.run!.id;
  parent = await service.openCheckpoint(
    {
      ref: parent.session.key,
      runId: parentRunId,
      ifRevision: parent.session.revision,
      title: "Прежнее намерение",
      body: markdown,
      requestId: "intent",
    },
    "parent",
  );
  const intent = parent.checkpoint!;
  const children = [];
  for (const status of ["completed", "cancelled"] as const) {
    parent = await service.fork(
      {
        ref: intent.key,
        runId: parentRunId,
        ifRevision: parent.session.revision,
        title: status,
        requestId: `fork-${status}`,
      },
      "parent",
    );
    const pending = parent.childSession!;
    if (status === "completed") {
      const attached = await service.attach(
        { ref: pending.key, ifRevision: pending.revision, requestId: "attach" },
        "child",
      );
      const completed = await service.complete(
        {
          ref: attached.session.key,
          runId: attached.run!.id,
          ifRevision: attached.session.revision,
          result: markdown,
          requestId: "complete",
        },
        "child",
      );
      children.push(completed.session);
    } else {
      const cancelled = await service.cancel(
        { ref: pending.key, ifRevision: pending.revision, result: markdown, requestId: "cancel" },
        "parent",
      );
      children.push(cancelled.session);
    }
  }
  const before = (await service.history({})).total;
  await app.listen(0, "127.0.0.1");
  const api = createApiClient(
    new HttpClient({ baseUrl: await app.getUrl() }),
    operationsTree,
  ).workHistory;
  const graph = workHistoryGraphPageSchema.parse((await api.getWorkHistoryGraph({})).data);
  assert.deepEqual(
    (await api.getWorkHistoryGraphForProject({ project: workspace.config.projectId! })).data,
    graph,
  );
  checkCompact(graph);
  const laneEdges = graph.edges.filter(
    (edge) => edge.kind === "fork" || edge.kind === "branch-end",
  );
  assert.equal(laneEdges.length, 4);
  for (const child of children) {
    assert.equal((await service.get({ ref: child.id })).acceptance, null);
    assert.deepEqual(
      laneEdges.find((edge) => edge.kind === "fork" && edge.to === `${child.id}:created`),
      {
        kind: "fork",
        fromSessionId: parent.session.id,
        to: `${child.id}:created`,
      },
    );
    assert.deepEqual(
      laneEdges.find((edge) => edge.kind === "branch-end" && edge.from === `${child.id}:closed`),
      {
        kind: "branch-end",
        from: `${child.id}:closed`,
        toSessionId: parent.session.id,
      },
    );
    assert.equal(
      graph.branches.find((branch) => branch.id === child.id)!.originCheckpointId,
      intent.id,
    );
  }
  assert.equal(new Set<string>(graph.edges.map((edge) => edge.kind)).has("acceptance"), false);
  assert.equal((await service.history({})).total, before);
  const accepted = await service.saveCheckpoint(
    {
      ref: intent.key,
      runId: parentRunId,
      ifRevision: parent.session.revision,
      title: "Явное принятие",
      body: markdown,
      acceptedSessionIds: [children[0]!.id],
      requestId: "accept",
    },
    "parent",
  );
  assert.equal(
    (await service.get({ ref: children[0]!.id })).acceptance!.checkpointId,
    accepted.checkpoint!.id,
  );
  const after = workHistoryGraphPageSchema.parse((await api.getWorkHistoryGraph({})).data);
  assert.deepEqual(
    after.edges.filter((edge) => edge.kind === "fork" || edge.kind === "branch-end"),
    laneEdges,
  );
  assert(after.items.some((point) => point.id === `${accepted.checkpoint!.id}:checkpoint`));
  assert.equal(new Set<string>(after.edges.map((edge) => edge.kind)).has("acceptance"), false);
  const detail = await api.getWorkHistoryGraphPoint({
    ref: encodeURIComponent(`${accepted.checkpoint!.id}:checkpoint`),
  });
  assert.deepEqual(detail.data.checkpoint!.acceptedSessionIds, [children[0]!.id]);
});

test("Граф истории: неверные таблицы/концы и подмена авторского run не проходят выходную схему", async (t) => {
  const { app, workspace } = await fixture(t);
  const data = await historyFixture(workspace);
  const service = new WorkHistoryGraphService(workspace);
  const valid = await service.graph({ limit: 1 });
  const full = await service.graph({});
  const graphMock = t.mock.method(
    WorkHistoryGraphService.prototype,
    "graph",
    async () =>
      ({
        ...valid,
        edges: [{ kind: "sequence", from: valid.items[0]!.id, to: "missing:created" }],
      }) as WorkHistoryGraphPage,
  );
  let response = await app.inject("/api/v1/work-history/graph");
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().error.code, "INVALID_DATA");
  for (const malformed of [
    { ...valid, branches: [] },
    { ...valid, runs: [] },
    { ...valid, openEnds: [...valid.openEnds, ...valid.openEnds] },
    {
      ...full,
      edges: [{ kind: "fork", fromSessionId: "missing-lane", to: `${data.child.id}:created` }],
    } as WorkHistoryGraphPage,
    {
      ...full,
      edges: [{ kind: "fork", fromSessionId: data.cancelled.id, to: `${data.child.id}:created` }],
    } as WorkHistoryGraphPage,
    {
      ...full,
      edges: [{ kind: "branch-end", from: `${data.child.id}:closed`, toSessionId: "missing-lane" }],
    } as WorkHistoryGraphPage,
    {
      ...full,
      edges: [
        {
          kind: "acceptance",
          from: `${data.child.id}:closed`,
          to: `${data.acceptance.id}:checkpoint`,
        },
      ],
    } as unknown as WorkHistoryGraphPage,
  ]) {
    graphMock.mock.mockImplementation(async () => malformed);
    response = await app.inject("/api/v1/work-history/graph");
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error.code, "INVALID_DATA");
  }
  graphMock.mock.restore();
  const detail = await service.point({ ref: data.intent.key });
  t.mock.method(WorkHistoryGraphService.prototype, "point", async () => ({
    ...detail,
    run: data.secondRun,
  }));
  response = await app.inject(`/api/v1/work-history/graph/points/${data.intent.key}`);
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().error.code, "INVALID_DATA");
});

test("Граф истории workspace: чужие derived ID, CP и scope не разрешаются в соседней базе", async (t) => {
  const { root, workspace } = await fixture(t);
  const a = await historyFixture(workspace);
  const second = await initialize(join(root, "second"), "tasks");
  const b = await new WorkHistoryService(second).start(
    { title: "Другая база", requestId: "start" },
    "other-agent",
  );
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "." });
  await registerProject(registry.configPath, "b", { path: "second" });
  const app = await createServer({ cwd: root, actor: "server-actor" });
  try {
    for (const project of ["a", "b"]) {
      const context = (await app.inject(`/api/v1/projects/${project}/context`)).json().data;
      assert(context.capabilities.includes(WORK_HISTORY_GRAPH_CAPABILITY));
      assert.equal(context.capabilities.includes("relay-work-history-graph-v1"), false);
    }
    for (const ref of [`${a.intent.id}:checkpoint`, a.intent.key, a.intent.id]) {
      const response = await app.inject(
        `/api/v1/projects/b/work-history/graph/points/${encodeURIComponent(ref)}`,
      );
      assert.equal(response.statusCode, 404, response.body);
    }
    assert.equal(
      (await app.inject(`/api/v1/projects/b/work-history/graph?ref=${a.parent.key}`)).statusCode,
      404,
    );
    const graph = workHistoryGraphPageSchema.parse(
      (await app.inject("/api/v1/projects/b/work-history/graph")).json().data,
    );
    assert(graph.items.every((point) => point.sessionId === b.session.id));
    assert(
      graph.runs.every(
        (run) => run.actor === "other-agent" && run.operator === null && run.git === null,
      ),
    );
    assert.equal((await app.inject("/api/v1/work-history/graph")).statusCode, 400);
  } finally {
    await app.close();
  }
});
