import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type {
  ProductOverviewView,
  ProductOverviewMetricView,
} from "../src/presentation/product.js";
import type { ProductOverviewMapPage } from "@relay/contracts/product-query";
import type { WorkHistoryMutation, WorkSessionsPage } from "@relay/contracts/work-history";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixture,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
import { httpServer, httpProxy } from "./helpers/http.js";

test("overview workspace: флаг и префикс, изоляция проектов, продолжения карты и метрик", async (t) => {
  const frontend = await fixture(t);
  const backend = await fixture(t);
  const namedOverview = await fixture(t);
  await frontend.create("Задача frontend");
  const frontendSession = successful(
    await frontend.run<WorkHistoryMutation>([
      "session",
      "start",
      "--title",
      "Работа только frontend",
    ]),
  ).data.session;
  await backend.create("Задача backend 1");
  await backend.create("Задача backend 2");
  for (const name of ["Первая", "Вторая", "Третья"])
    successful(
      await frontend.run(["feature", "create", "--name", name, "--description", "Полный материал"]),
    );
  const root = await tempDirectory(t);
  successful(await invoke(root, ["workspace", "project", "init"]));
  const server = await httpServer(t, root);
  const configPath = join(root, "relay.workspace.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, server: { port: 0, url: server.url } }));
  for (const [key, app] of [
    ["frontend", frontend],
    ["backend", backend],
    ["overview", namedOverview],
  ] as const)
    successful(await invoke(root, ["workspace", "project", "add", key, app.root]));

  failed(await invoke(root, ["overview"]), "PROJECT_REQUIRED");
  failed(await invoke(root, ["frontend", "overview", "--project", "backend"]), "INVALID_ARGUMENT");
  const explicit = successful(
    await invoke<ProductOverviewView>(root, ["overview", "--project", "frontend"]),
  );
  const prefixed = successful(await invoke<ProductOverviewView>(root, ["frontend", "overview"]));
  assert.deepEqual(explicit.data.snapshot, prefixed.data.snapshot);
  assert.equal(explicit.data.snapshotVersion, prefixed.data.snapshotVersion);
  assert.equal(explicit.data.snapshot.tasks.total, 1);
  assert.equal(explicit.data.snapshot.sessions.latest?.id, frontendSession.id);
  assert.equal(explicit.data.snapshot.sessions.unfinished.total, 1);
  assert.equal(
    successful(await invoke<ProductOverviewView>(root, ["backend", "overview"])).data.snapshot
      .sessions.total,
    0,
  );
  assert.equal(
    explicit.data.snapshot.passport.state,
    "missing",
    "Паспорт продукта не требуется для обзора проекта",
  );
  assert.equal(
    successful(await invoke<ProductOverviewView>(root, ["backend", "overview"])).data.snapshot.tasks
      .total,
    2,
  );
  assert.equal(
    successful(await invoke<ProductOverviewView>(root, ["overview", "--project", "overview"])).data
      .snapshot.tasks.total,
    0,
  );

  for (const args of [
    ["overview", "--project", "frontend"],
    ["frontend", "overview"],
  ]) {
    const output = await invokeRaw(root, args, { env: { COLUMNS: "40", FORCE_COLOR: "3" } });
    assert.equal(output.code, 0, output.stdout + output.stderr);
    assert.equal(output.stderr, "");
    assert.match(output.stdout, /^Проект · /);
    assert.match(output.stdout, /Задач всего: 1/);
    assert.doesNotMatch(output.stdout, /\x1b/);
  }

  const client = await tempDirectory(t);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const follow = async (command: string) => {
    assert.doesNotMatch(command, /product overview/);
    assert.ok(command.includes("--project"), command);
    assert.ok(command.includes(server.url), command);
    const result = await promisify(execFile)(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `npx() { shift; ${[process.execPath, ...cliNodeArgs, binary].map(quote).join(" ")} "$@"; };\n${command}`,
      ],
      { cwd: client, env: cliEnv(), timeout: 30_000 },
    );
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true, result.stdout);
    return body;
  };
  for (const selection of [
    ["frontend", "overview"],
    ["overview", "--project", "frontend"],
  ]) {
    const map = successful(
      await invoke<ProductOverviewMapPage>(root, [...selection, "--view", "map", "--limit", 1]),
    );
    assert.ok(map.meta!.page!.nextCursor);
    const next = await follow(map.meta!.page!.nextCommand!);
    assert.equal(next.data.total, 3);
    assert.equal(next.data.snapshotVersion, map.data.snapshotVersion);
    assert.notEqual(next.data.items[0].id, map.data.items[0]!.id);
    failed(
      await invoke(root, ["backend", "overview", "--cursor", map.meta!.page!.nextCursor!]),
      "INVALID_CURSOR",
    );

    const metric = successful(
      await invoke<ProductOverviewMetricView>(root, [
        ...selection,
        "--metric",
        "board-work",
        "--limit",
        1,
      ]),
    );
    assert.ok(metric.meta!.page!.nextCursor);
    const nextMetric = await follow(metric.meta!.page!.nextCommand!);
    assert.equal(nextMetric.data.metric, "board-work");
    assert.equal(nextMetric.data.snapshotVersion, metric.data.snapshotVersion);
    assert.notEqual(nextMetric.data.items[0].id, metric.data.items[0]!.id);
    failed(
      await invoke(root, ["backend", "overview", "--cursor", metric.meta!.page!.nextCursor!]),
      "INVALID_CURSOR",
    );
  }
  const fromHint = await follow(explicit.data.commands.metrics["board-work"]);
  assert.equal(fromHint.data.metric, "board-work");
  const guardedMap = successful(
    await invoke<ProductOverviewMapPage>(root, [
      "frontend",
      "overview",
      "--view",
      "map",
      "--limit",
      1,
    ]),
  );
  const guardedMetric = successful(
    await invoke<ProductOverviewMetricView>(root, [
      "frontend",
      "overview",
      "--metric",
      "board-work",
      "--limit",
      1,
    ]),
  );
  successful(
    await frontend.run([
      "session",
      "pause",
      frontendSession.key,
      "--run",
      frontendSession.currentRunId!,
      "--if-revision",
      frontendSession.revision,
      "--reason",
      "Перерыв",
    ]),
  );
  for (const page of [guardedMap, guardedMetric])
    failed(
      await invoke(root, ["frontend", "overview", "--cursor", page.meta!.page!.nextCursor!]),
      "VERSION_CONFLICT",
      4,
    );
});

for (const transport of ["local", "HTTP"] as const) {
  test(`overview ${transport}: последняя сессия и все незавершённые, compact/full и продолжение`, async (t) => {
    const { root } = await fixture(t);
    const server = transport === "HTTP" ? await httpServer(t, root) : undefined;
    const prefix = server ? ["--server-url", server.url] : ["--local"];
    const run = <T>(args: Array<string | number>) => invoke<T>(root, [...prefix, ...args]);
    const save = async (args: Array<string | number>) =>
      successful(await run<WorkHistoryMutation>(args)).data;
    const text = async (args: Array<string | number>, width = 100) => {
      const result = await invokeRaw(root, [...prefix, ...args], {
        env: { COLUMNS: String(width), FORCE_COLOR: "3" },
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      assert.doesNotMatch(result.stdout, /\x1b/);
      return result.stdout;
    };
    assert.match(await text(["overview"]), /Сессии: записей пока нет/);
    let cancelled = await save(["session", "start", "--title", "Отменённое поручение"]);
    cancelled = await save([
      "session",
      "cancel",
      cancelled.session.key,
      "--run",
      cancelled.run!.id,
      "--if-revision",
      cancelled.session.revision,
      "--result",
      "Отмена",
    ]);
    const onlyClosed = await text(["overview"]);
    assert.match(onlyClosed, /Последняя сессия/);
    assert.match(onlyClosed, /Отменена/);
    assert.doesNotMatch(onlyClosed, /Незавершённые сессии/);
    let old = await save([
      "session",
      "start",
      "--title",
      "Проверить старую работу 世界",
      "--description",
      "ПОЛНОЕ ПОРУЧЕНИЕ",
    ]);
    const alone = await text(["overview"]);
    assert.match(alone, /Незавершённые сессии: 1/);
    assert.match(alone, /последняя/);
    assert.doesNotMatch(alone, /Последняя сессия\n/);
    assert.equal(alone.split(old.session.key).length - 1, 1);
    old = await save([
      "checkpoint",
      "open",
      old.session.key,
      "--run",
      old.run!.id,
      "--if-revision",
      old.session.revision,
      "--title",
      "Делегировать",
      "--body",
      "ПОЛНЫЙ МАТЕРИАЛ",
    ]);
    const fork = await save([
      "session",
      "fork",
      old.checkpoint!.key,
      "--run",
      old.run!.id,
      "--if-revision",
      old.session.revision,
      "--title",
      "Ожидающий ребёнок",
    ]);
    const pending = await text(["overview"]);
    assert.ok(pending.includes(fork.childSession!.key));
    assert.ok(pending.includes(`родитель ${old.session.key}`));
    let paused = await save(["session", "start", "--title", "Приостановленная работа"]);
    paused = await save([
      "session",
      "pause",
      paused.session.key,
      "--run",
      paused.run!.id,
      "--if-revision",
      paused.session.revision,
      "--reason",
      "Пауза",
    ]);
    for (let index = 0; index < 4; index++) {
      await save(["session", "start", "--title", `Незавершённая работа ${index}`]);
      if (index === 0) {
        // Четыре записи целиком помещаются в DTO, но compact всё равно требует продолжение.
        const compact = await text(["overview"]);
        const full = await text(["overview", "--view", "full"]);
        assert.match(compact, /показано 3 из 4/);
        assert.match(compact, /session list --unfinished/);
        assert.match(full, /Незавершённые сессии: 4/);
        assert.doesNotMatch(full, /session list --unfinished/);
      }
    }
    let closed = await save(["session", "start", "--title", "Последняя завершённая работа"]);
    closed = await save([
      "session",
      "complete",
      closed.session.key,
      "--run",
      closed.run!.id,
      "--if-revision",
      closed.session.revision,
      "--result",
      "ПОЛНЫЙ ИТОГ",
    ]);
    const json = successful(await run<ProductOverviewView>(["overview", "--limit", 1]));
    assert.equal(json.data.snapshot.sessions.latest?.id, closed.session.id);
    assert.equal(json.data.snapshot.sessions.unfinished.total, 7);
    assert.equal(json.data.snapshot.sessions.unfinished.items.length, 5);
    const fullJson = successful(await run<ProductOverviewView>(["overview", "--view", "full"]));
    assert.deepEqual(fullJson.data.snapshot.sessions, json.data.snapshot.sessions);
    for (const width of [24, 40, 100, 160]) {
      for (const [view, shown] of [
        ["compact", 3],
        ["full", 5],
      ] as const) {
        const output = await text(["overview", "--view", view, "--limit", 1], width);
        const normalized = output.replace(/\s+/g, " ");
        assert.match(normalized, /Последняя сессия/);
        assert.ok(output.includes(closed.session.key));
        assert.ok(normalized.includes(`Незавершённые сессии: 7 · показано ${shown} из 7`));
        for (const session of json.data.snapshot.sessions.unfinished.items.slice(0, shown))
          assert.ok(output.includes(session.key), session.key);
        assert.doesNotMatch(output, /ПОЛНОЕ ПОРУЧЕНИЕ|ПОЛНЫЙ МАТЕРИАЛ|ПОЛНЫЙ ИТОГ/);
        const continuation = output
          .split("\n")
          .filter(
            (line) => line.startsWith("npx @oim-dev/relay-cli") && line.includes("session list"),
          );
        assert.equal(continuation.length, 1);
        assert.ok(continuation[0]!.includes("--unfinished"));
        if (server) assert.ok(continuation[0]!.includes(server.url));
      }
    }
    const all = successful(
      await run<WorkSessionsPage>(["session", "list", "--unfinished", "--limit", 100]),
    );
    assert.equal(all.data.total, 7);
    assert.ok(all.data.items.some((session) => session.id === old.session.id));
    const command = json.data.commands.unfinishedSessions;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const followed = await promisify(execFile)(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `npx() { shift; ${[process.execPath, ...cliNodeArgs, binary].map(quote).join(" ")} "$@"; };\n${command}`,
      ],
      { cwd: root, env: cliEnv(), timeout: 30_000 },
    );
    assert.equal(followed.stderr, "");
    assert.equal(JSON.parse(followed.stdout).data.total, 7);
  });
}

test("overview HTTP: отсутствие сводки сессий не выдаётся за пустую историю", async (t) => {
  const { root } = await fixture(t);
  const server = await httpServer(t, root);
  for (const missing of [true, false]) {
    const proxy = await httpProxy(t, async (request, response, signal) => {
      const upstream = await fetch(`${server.url}${request.url}`, { signal });
      const body = await upstream.json();
      if (request.url?.endsWith("/product/overview")) {
        if (missing) delete body.data.snapshot.sessions;
        else body.data.snapshot.sessions = null;
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    failed(
      await invoke(root, ["--server-url", proxy.url, "overview"]),
      missing ? "SERVER_INCOMPATIBLE" : "INVALID_SERVER_RESPONSE",
      5,
    );
  }
});
