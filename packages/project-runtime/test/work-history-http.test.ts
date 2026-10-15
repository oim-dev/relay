import assert from "node:assert/strict";
import { test } from "node:test";
import { workHistoryOperations, WORK_HISTORY_CAPABILITY } from "@relay/contracts/work-history";
import { defaultConfig } from "@relay/core/domain/config";
import { createHttpBackend } from "../src/backend/http.js";

const context = {
  ok: true,
  data: {
    capabilities: ["relay-projects-v1", WORK_HISTORY_CAPABILITY],
    projectId: "fixed-project",
    config: defaultConfig,
    configPath: "/project/.relay/config.json",
    storagePath: "/project/.relay",
  },
};
const markdown = "  # Материал\n\n```ts\nconst x = '  ';\n```\n\nКонец  \n\n";
const session = {
  id: "session",
  key: "S-1",
  title: "Ветка",
  description: markdown,
  parentSessionId: null,
  originCheckpointId: null,
  createdByRunId: null,
  parentSequence: null,
  status: "open",
  currentRunId: "run",
  sequence: 2,
  result: "",
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  closedAt: null,
  revision: 1,
};
const run = {
  operator: null,
  git: null,
  id: "run",
  key: "RUN-1",
  sessionId: "session",
  actor: "body-author",
  client: null,
  sourceSessionId: null,
  startedAt: "2026-10-15T12:00:00.000Z",
  endedAt: null,
  startedSequence: 2,
  endedSequence: null,
  endReason: null,
  predecessorRunId: null,
  reason: "",
  endSummary: null,
};
const mutation = { session, run, checkpoint: null, childSession: null };
const page = { items: [], total: 0, nextOffset: null, version: "current" };
const sessionsPage = {
  ...page,
  projectTotals: { sessions: 0, unfinished: 0, runs: 0, checkpoints: 0, openIntents: 0 },
};
const owner = { ref: "S-1", runId: "run", ifRevision: 7, requestId: "correlation" };
const branch = { ref: "S-1", ifRevision: 7, requestId: "correlation" };
const checkpoint = { ...owner, ref: "CP-1", title: "Материал", body: markdown };
const commands = {
  start: { title: "Ветка", description: markdown, requestId: "correlation" },
  fork: { ...owner, ref: "CP-1", title: "Поручение" },
  attach: branch,
  pause: { ...owner, reason: markdown },
  resume: branch,
  takeover: { ...branch, reason: markdown },
  complete: { ...owner, result: markdown },
  cancel: { ...owner, result: markdown },
  openCheckpoint: { ...owner, title: "Намерение", body: markdown },
  saveCheckpoint: checkpoint,
  completeCheckpoint: checkpoint,
  cancelCheckpoint: checkpoint,
};
const mutationNames = Object.keys(commands) as (keyof typeof commands)[];

test("История HTTP: все 19 методов дают UNSUPPORTED до запроса, без fallback", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      ...context,
      data: { ...context.data, capabilities: ["relay-projects-v1"] },
    });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  for (const name of Object.keys(workHistoryOperations) as (keyof typeof workHistoryOperations)[])
    await assert.rejects(backend.workHistory[name]({} as never, "author"), {
      code: "UNSUPPORTED",
      exitCode: 5,
    });
  assert.equal(calls, 1);
});

test("История HTTP: pinned проект, wire bool/null, query версии и выбор общей/веточной истории", async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(new URL(url));
    return Response.json(
      url.endsWith("/context")
        ? context
        : { ok: true, data: new URL(url).pathname.endsWith("/sessions") ? sessionsPage : page },
    );
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700", "alias");
  await backend.workHistory.list({
    unfinished: false,
    parent: null,
    actor: "agent",
    limit: 1,
    offset: 2,
    version: "v:1",
  });
  assert.equal(urls[1]!.pathname, "/api/v1/projects/fixed-project/work-history/sessions");
  assert.deepEqual(Object.fromEntries(urls[1]!.searchParams), {
    unfinished: "false",
    parent: "null",
    actor: "agent",
    limit: "1",
    offset: "2",
    version: "v:1",
  });
  await backend.workHistory.history({ ref: "S-1", includeChildren: false });
  assert.equal(
    urls[2]!.pathname,
    "/api/v1/projects/fixed-project/work-history/sessions/S-1/history",
  );
  assert.equal(urls[2]!.searchParams.get("includeChildren"), "false");
  assert.equal(urls[2]!.searchParams.has("ref"), false);
  await backend.workHistory.history({ includeChildren: true });
  assert.equal(urls[3]!.pathname, "/api/v1/projects/fixed-project/work-history/history");
  assert.equal(urls[3]!.searchParams.get("includeChildren"), "true");
  await backend.workHistory.openIntents({
    ref: "S-1",
    includeChildren: false,
    offset: 1,
    limit: 2,
    version: "v:2",
  });
  assert.equal(
    urls[4]!.pathname,
    "/api/v1/projects/fixed-project/work-history/sessions/S-1/intents",
  );
  assert.deepEqual(Object.fromEntries(urls[4]!.searchParams), {
    includeChildren: "false",
    offset: "1",
    limit: "2",
    version: "v:2",
  });
});

test("История HTTP: Markdown и автор тела имеют приоритет; defaultActor не общий mutable state", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/context")) return Response.json(context);
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, data: mutation });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  const result = await backend.workHistory.start(
    { ...commands.start, actor: "body-author" },
    "ignored",
  );
  assert.equal(result.session.description, markdown);
  await backend.workHistory.start(commands.start, "fallback");
  assert.equal(bodies[0]!.actor, "body-author");
  assert.equal(bodies[1]!.actor, "fallback");
  assert.equal(bodies[0]!.description, markdown);
  assert.equal(bodies[1]!.description, markdown);
});

for (const name of mutationNames)
  for (const failure of ["network", "500", "409", "envelope", "data"] as const)
    test(`История HTTP ${name}: ${failure} не повторяет мутацию`, async (t) => {
      let writes = 0;
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        if (url.endsWith("/context")) return Response.json(context);
        assert.equal(init.method, "POST");
        const body = JSON.parse(String(init.body));
        assert.equal(body.requestId, "correlation");
        assert.equal(body.actor, "author");
        if (name !== "start") assert.equal(body.ifRevision, 7);
        writes++;
        if (failure === "network") throw new TypeError("Ответ потерян");
        if (failure === "envelope") return Response.json({ ok: true });
        if (failure === "data")
          return Response.json({
            ok: true,
            data: { ...mutation, session: { ...session, revision: "1" } },
          });
        return Response.json(
          { ok: false, error: { code: "REFUSAL", message: "Отказ", exitCode: 4 } },
          { status: Number(failure) },
        );
      });
      const work = (await createHttpBackend("http://127.0.0.1:4700")).workHistory;
      await assert.rejects(work[name](commands[name] as never, "author"), {
        code:
          failure === "network"
            ? "SERVER_UNAVAILABLE"
            : ["envelope", "data"].includes(failure)
              ? "INVALID_SERVER_RESPONSE"
              : "REFUSAL",
      });
      assert.equal(writes, 1);
    });

test("История HTTP: невалидные output/defaults не маскируются, конфликт страницы не повторяется", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/context")) return Response.json(context);
    reads++;
    if (reads === 1)
      return Response.json(
        { ok: false, error: { code: "VERSION_CONFLICT", message: "Изменено", exitCode: 4 } },
        { status: 409 },
      );
    if (reads === 2) return Response.json({ ok: true, data: { ...sessionsPage, total: "0" } });
    return Response.json({ ok: true, data: { ...sessionsPage, extra: true } });
  });
  const work = (await createHttpBackend("http://127.0.0.1:4700")).workHistory;
  await assert.rejects(work.list({ version: "old" }), { code: "VERSION_CONFLICT" });
  assert.equal(reads, 1);
  await assert.rejects(work.list({}), { code: "INVALID_SERVER_RESPONSE" });
  await assert.rejects(work.list({}), { code: "INVALID_SERVER_RESPONSE" });
  assert.equal(reads, 3);
});
