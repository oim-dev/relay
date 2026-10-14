import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { GraphPage } from "@relay/core/domain/entity-graph";
import { AppError } from "@relay/core/shared/errors";
import { shellCommand } from "../src/command-kit.js";
import { printError } from "../src/output.js";
import { helpRuntime } from "./helpers/help.js";
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
import { httpProxy, httpServer } from "./helpers/http.js";

/** Bash исполняет напечатанную строку без пересборки аргументов; заменяется только npx. */
async function follow(cwd: string, command: string) {
  assert.ok(command.startsWith("npx @oim-dev/relay-cli "), command);
  const result = await promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `npx() { shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${command}`,
    ],
    { cwd, env: cliEnv(), timeout: 30_000 },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
const token = (text: string, label: string) => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label}:`));
  assert.ok(index >= 0, text);
  return lines[index]!.slice(label.length + 1).trim() || lines[index + 1]!.trim();
};

for (const transport of ["local", "HTTP", "workspace"] as const) {
  test(`doctor ${transport}: копируемые version/ID/ref на 24/40/100 и GRAPH_CHANGED → Bash-чтение`, async (t) => {
    const app = await fixture(t);
    const id = await app.create(
      "Длинное название задачи Ω 界 е́, которое должно переноситься по ширине",
    );
    await app.create("Вторая задача");
    const config = join(app.root, ".relay", "конфиг с 'кавычкой.json");
    await copyFile(join(app.root, ".relay/config.json"), config);
    let cwd = app.root;
    let globals = ["--local", "--config", config];
    if (transport === "HTTP") {
      const server = await httpServer(t, app.root);
      globals = ["--server-url", server.url, "--config", config];
    } else if (transport === "workspace") {
      cwd = await tempDirectory(t);
      await writeFile(
        join(cwd, "relay.workspace.json"),
        JSON.stringify({ version: 1, projects: { selected: { path: app.root } } }),
      );
      const server = await httpServer(t, cwd);
      globals = ["--server-url", server.url, "--project", "selected"];
    }
    const run = (args: Array<string | number>) => invoke<GraphPage>(cwd, [...globals, ...args]);
    const markdown =
      "## Основание\n\n  отступы\n\n```text\nдлинная строка Markdown без физических переносов внутри сохранённого содержания Ω 界\n```\nХВОСТ\n";
    let staleVersion = "";
    for (const width of [24, 40, 100]) {
      const before = successful(
        await run(["inspect", "graph", "list", "--root", `task:${id}`]),
      ).data;
      const human = await invokeRaw(
        cwd,
        [...globals, "inspect", "graph", "list", "--root", `task:${id}`],
        { env: { COLUMNS: String(width), FORCE_COLOR: "3" } },
      );
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.equal(token(human.stdout, "Версия"), before.version);
      assert.ok(
        human.stdout
          .split("\n")
          .some((line) => line.trim() === `task:${id}` || line.endsWith(` task:${id}`)),
        human.stdout,
      );
      assert.equal(token(human.stdout, "Корень"), `task:${id}`);
      if (width === 24)
        assert.ok(
          !human.stdout.includes(
            "Длинное название задачи Ω 界 е́, которое должно переноситься по ширине",
          ),
        );
      const saved = await invokeRaw(
        cwd,
        [
          ...globals,
          "doctor",
          "graph",
          "link",
          "--from",
          `task:${id}`,
          "--to",
          "PRODUCT-2",
          "--type",
          `diagnostic-${width}`,
          "--description",
          markdown,
          "--if-version",
          token(human.stdout, "Версия"),
        ],
        { env: { COLUMNS: String(width) } },
      );
      assert.equal(saved.code, 0, saved.stdout);
      assert.equal(saved.stderr, "");
      const edge = token(saved.stdout, "ID отношения");
      const version = token(saved.stdout, "Версия");
      assert.match(version, /^[a-f0-9]{64}$/);
      const current = successful(
        await run(["inspect", "graph", "list", "--root", `task:${id}`]),
      ).data;
      assert.equal(current.version, version);
      assert.equal(current.edges.find((item) => item.id === edge)?.description, markdown);
      const list = await invokeRaw(
        cwd,
        [...globals, "inspect", "graph", "list", "--root", `task:${id}`],
        { env: { COLUMNS: String(width) } },
      );
      assert.ok(list.stdout.includes(markdown), list.stdout);
      assert.ok(
        list.stdout.split("\n").some((line) => line.trim() === edge || line.endsWith(` ${edge}`)),
        list.stdout,
      );
      assert.doesNotMatch(list.stdout, /\u001b/);
      // Токены из human без склейки принимаются настоящей следующей записью.
      const update = await follow(
        cwd,
        shellCommand([
          "npx",
          "@oim-dev/relay-cli",
          ...globals,
          "doctor",
          "graph",
          "update",
          edge,
          "--description",
          "",
          "--if-version",
          version,
        ]),
      );
      assert.match(update, /применён/);
      const context = await invokeRaw(
        cwd,
        [...globals, "inspect", "graph", "context", `task:${id}`],
        { env: { COLUMNS: String(width) } },
      );
      assert.equal(context.code, 0, context.stdout);
      assert.equal(token(context.stdout, "Версия"), token(update, "Версия"));
      staleVersion = version;
    }
    const conflict = await invokeRaw(
      cwd,
      [...globals, "doctor", "graph", "unlink", "unused", "--if-version", staleVersion],
      { env: { COLUMNS: "24" } },
    );
    assert.equal(conflict.code, 4, conflict.stdout);
    assert.equal(conflict.stderr, "");
    assert.match(conflict.stdout, /GRAPH_CHANGED/);
    const read = hints(conflict.stdout).find((line) => line.endsWith("inspect graph list"));
    assert.ok(read, conflict.stdout);
    assert.ok(!read.includes("--if-version") && !read.includes("--cursor"));
    if (transport === "workspace")
      assert.ok(read.includes("--project selected") && !read.includes("--local"));
    if (transport !== "local") assert.ok(read.includes("--server-url"));
    assert.match(await follow(cwd, read), /Граф проекта/);
  });
}

test("doctor: index corrupt → явный local reindex; HTTP не выдаёт выдуманную конфигурацию", async (t) => {
  const app = await fixture(t);
  await app.create("Данные сохраняются");
  const server = await httpServer(t, app.root);
  const config = join(app.root, ".relay", "конфиг с 'кавычкой.json");
  await copyFile(join(app.root, ".relay/config.json"), config);
  const directory = join(app.root, ".relay/.indexes/state.json");
  await rm(directory);
  const local = await invokeRaw(app.root, ["--config", config, "doctor", "check"], {
    env: { COLUMNS: "24" },
  });
  assert.equal(local.code, 5, local.stdout);
  assert.match(local.stdout, /STORAGE_INDEX_CORRUPT/);
  const repair = hints(local.stdout).find((line) => line.endsWith("storage reindex"));
  assert.ok(repair?.includes("--local"), local.stdout);
  const remote = await invokeRaw(app.root, ["doctor", "check"], {
    env: { RELAY_SERVER_URL: server.url },
  });
  assert.equal(remote.code, 5, remote.stdout);
  assert.match(remote.stdout, /недоступно через HTTP/);
  assert.ok(
    hints(remote.stdout).every((line) => !line.includes("--local") && !line.includes("--config")),
    remote.stdout,
  );
  assert.ok(hints(remote.stdout).some((line) => line.endsWith("inspect graph list")));
  await follow(app.root, repair!);
  for (const command of hints(remote.stdout)) await follow(app.root, command);
  successful(await app.run(["doctor", "check"]));
  assert.equal(
    successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data.title,
    "Данные сохраняются",
  );
});

test("doctor: адресные validation details, schema-поля и число проверок; JSON без изменений", () => {
  const details = ["first", "second"].map((id) => ({
    code: "INVALID_DATA",
    message: "Запись не соответствует схеме",
    checks: ["catalog", "tasks", "graph", "planning"],
    details: {
      path: `entities/tasks/${id}.json`,
      ref: { kind: "task", id },
      issues: [
        {
          path: ["title"],
          message: "Expected string, received number",
          expected: "string",
          received: "number",
        },
      ],
    },
  }));
  for (const width of [24, 40, 100]) {
    const output = helpRuntime("/unused");
    printError(
      output.io.stdout,
      new AppError("VALIDATION_FAILED", "Нарушения целостности", 5, details),
      { format: "text", text: { width, color: false } },
    );
    const text = output.output();
    assert.match(text, /Причин: 2/);
    assert.equal(text.match(/Проверок: 4/g)?.length, 2);
    for (const id of ["first", "second"]) {
      assert.ok(text.includes(`entities/tasks/${id}.json`), text);
      assert.ok(text.includes(`task:${id}`), text);
    }
    assert.match(text, /Поле:\s+title/);
    assert.doesNotMatch(text, /"checks"|"issues"|Синтаксис и примеры/);
    assert.doesNotMatch(text, /HTTP|на стороне Server/);
  }
  const output = helpRuntime("/unused");
  printError(
    output.io.stdout,
    new AppError("VALIDATION_FAILED", "Нарушения целостности", 5, details),
    {
      format: "json",
      recovery: {
        command: () => {
          throw new Error("JSON не должен вызывать human-навигацию");
        },
      },
    },
  );
  assert.deepEqual(JSON.parse(output.output()).error.details, details);
});

test("doctor local/HTTP: malformed и schema требуют восстановления содержимого, не ремонта через reindex", async (t) => {
  const app = await fixture(t);
  const id = await app.create("Восстановить запись");
  const path = join(app.root, ".relay/entities/tasks", `${id}.json`);
  const original = await readFile(path, "utf8");
  const server = await httpServer(t, app.root);
  for (const damage of ["malformed", "schema"]) {
    const record = JSON.parse(original);
    record.data.title = 17;
    const damaged = damage === "malformed" ? "{invalid-record" : JSON.stringify(record);
    await writeFile(path, damaged);
    let localDetails: unknown;
    for (const globals of [["--local"], ["--server-url", server.url]]) {
      const failure = await invoke(app.root, [...globals, "doctor", "check"]);
      failed(failure, "VALIDATION_FAILED", 5);
      assert.ok(!failure.body.ok);
      if (globals[0] === "--local") localDetails = failure.body.error.details;
      else assert.deepEqual(failure.body.error.details, localDetails);
      const details = failure.body.error.details as Array<{
        code: string;
        details: { path?: string; issues?: unknown[] };
        checks: string[];
      }>;
      const addressed = details.filter(
        (issue) =>
          issue.code === "INVALID_DATA" &&
          issue.details.path?.endsWith(`entities/tasks/${id}.json`),
      );
      assert.equal(addressed.length, 1, failure.stdout);
      assert.ok(addressed[0]!.checks.length >= 1);
      if (damage === "schema") assert.ok(addressed[0]!.details.issues?.length);
      for (const width of [24, 40, 100]) {
        const human = await invokeRaw(app.root, [...globals, "doctor", "check"], {
          env: { COLUMNS: String(width) },
        });
        assert.equal(human.code, 5, human.stdout);
        assert.equal(human.stderr, "");
        assert.ok(human.stdout.includes(`entities/tasks/${id}.json`), human.stdout);
        assert.match(human.stdout, /Проверок: [1-9]/);
        assert.ok(
          human.stdout.replaceAll(/\s+/g, " ").includes("Reindex не исправляет JSON"),
          human.stdout,
        );
        assert.doesNotMatch(human.stdout, /Синтаксис и примеры/);
        if (damage === "schema") assert.match(human.stdout, /Поле:\s+title/);
        if (globals[0] !== "--local")
          assert.ok(
            hints(human.stdout).every(
              (line) => !line.includes("--local") && !line.includes("--config"),
            ),
          );
      }
      assert.equal(await readFile(path, "utf8"), damaged);
    }
    // Подсказка reindex условна: сначала действительно восстанавливаем содержимое.
    const error = await invokeRaw(app.root, ["--local", "doctor", "check"]);
    await writeFile(path, original);
    const repair = hints(error.stdout).find((line) => line.endsWith("storage reindex"));
    assert.ok(repair, error.stdout);
    await follow(app.root, repair);
    successful(await app.run(["doctor", "check"]));
  }
});

test("doctor local/HTTP: managed-защита и потерянная связь ведут к владельцу и отдельному reconcile", async (t) => {
  const app = await fixture(t);
  const parent = await app.create("Родитель");
  const child = await app.create("Ребёнок");
  successful(await app.run(["task", "parent", "set", child, parent, "--if-revision", 1]));
  const before = successful(await app.run<any>(["task", "get", child])).data;
  const server = await httpServer(t, app.root);
  const graph = successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  const edge = graph.edges.find((item) => item.from.id === child && item.to.id === parent)!;
  assert.ok(edge);
  for (const globals of [["--local"], ["--server-url", server.url]]) {
    const denied = await invokeRaw(app.root, [
      ...globals,
      "doctor",
      "graph",
      "unlink",
      edge.id,
      "--if-version",
      graph.version,
    ]);
    assert.equal(denied.code, 4, denied.stdout);
    assert.match(denied.stdout, /RELATION_MANAGED/);
    assert.match(denied.stdout, /предметной командой владельца/);
    assert.match(denied.stdout, /storage reconcile-relations/);
    if (globals[0] === "--local")
      assert.ok(hints(denied.stdout).some((line) => line.endsWith("storage reconcile-relations")));
    else assert.ok(hints(denied.stdout).every((line) => !line.includes("--local")));
  }
  const path = join(app.root, ".relay/relations/tasks", `${child}.json`);
  const owned = JSON.parse(await readFile(path, "utf8"));
  owned.entries = owned.entries.filter(
    (entry: { edge: { id: string } }) => entry.edge.id !== edge.id,
  );
  await writeFile(path, JSON.stringify(owned));
  successful(await app.run(["--local", "storage", "reindex"]));
  let repair: string | undefined;
  for (const globals of [["--local"], ["--server-url", server.url]]) {
    const check = await invoke(app.root, [...globals, "doctor", "check"]);
    failed(check, "VALIDATION_FAILED", 5);
    assert.match(check.stdout, /MANAGED_RELATIONS_MISMATCH/);
    const human = await invokeRaw(app.root, [...globals, "doctor", "check"]);
    assert.equal(human.code, 5, human.stdout);
    assert.ok(human.stdout.includes(`task:${child}`), human.stdout);
    assert.match(human.stdout, /Недостающих:\s+1/);
    const resolve = hints(human.stdout).find((line) =>
      line.endsWith(`inspect resolve task:${child}`),
    );
    assert.ok(resolve, human.stdout);
    assert.match(await follow(app.root, resolve), /PRODUCT-2/);
    if (globals[0] === "--local")
      repair = hints(human.stdout).find((line) => line.endsWith("storage reconcile-relations"));
    else assert.ok(hints(human.stdout).every((line) => !line.includes("--local")));
  }
  assert.ok(repair);
  const withoutActor = await invokeRaw(app.root, ["--local", "doctor", "check"], {
    env: { RELAY_ACTOR: undefined },
  });
  const help = hints(withoutActor.stdout).find((line) =>
    line.endsWith("storage reconcile-relations --help"),
  );
  assert.ok(help, withoutActor.stdout);
  assert.match(await follow(app.root, help), /reconcile-relations/);
  await follow(app.root, repair);
  successful(await app.run(["doctor", "check"]));
  assert.deepEqual(successful(await app.run(["task", "get", child])).data, before);
});

test("doctor HTTP mutation: serverDetails сохраняет schema-адреса, requestId/URL и один POST", async (t) => {
  const app = await fixture(t);
  const id = await app.create("Не менять повреждённую запись");
  await app.create("Цель отношения");
  const graph = successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  const path = join(app.root, ".relay/entities/tasks", `${id}.json`);
  const original = await readFile(path, "utf8");
  const record = JSON.parse(original);
  record.data.title = 17;
  const damaged = JSON.stringify(record);
  await writeFile(path, damaged);
  // Повреждение уже существовало до старта: проверяем schema-отказ мутации,
  // а не отдельный ранний отказ watcher по маркеру внешних изменений.
  const server = await httpServer(t, app.root);
  const posts: Array<{
    request: { requestId: string };
    response: { error: { details: unknown } };
  }> = [];
  const proxy = await httpProxy(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const upstream = await fetch(`${server.url}${request.url}`, {
      method: request.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(body.length ? { body } : {}),
    });
    const text = await upstream.text();
    if (request.method === "POST") {
      posts.push({ request: JSON.parse(body.toString()), response: JSON.parse(text) });
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(text);
  });
  let readHint: string | undefined;
  for (const width of [24, 100]) {
    const requestId = `doctor-schema-request-${width}-no-retry`;
    const command = [
      "--server-url",
      proxy.url,
      "doctor",
      "graph",
      "link",
      "--from",
      `task:${id}`,
      "--to",
      "PRODUCT-2",
      "--type",
      "diagnostic",
      "--if-version",
      graph.version,
      "--request-id",
      requestId,
    ];
    const count = posts.length;
    const json = await invoke(app.root, command, { env: { COLUMNS: String(width) } });
    failed(json, "INVALID_DATA", 5);
    assert.equal(posts.length, count + 1, "Нет автоматического повтора POST после ошибки схемы");
    assert.equal(posts.at(-1)!.request.requestId, requestId);
    assert.ok(!json.body.ok);
    const expected = {
      serverDetails: posts.at(-1)!.response.error.details,
      requestId,
      url: proxy.url,
    };
    assert.deepEqual(json.body.error.details, expected);
    assert.equal(JSON.stringify(json.body.error.details), JSON.stringify(expected));
    assert.equal(
      json.stdout,
      `${JSON.stringify({ ok: false, error: { ...json.body.error, details: expected } })}\n`,
    );
    const human = await invokeRaw(app.root, command, { env: { COLUMNS: String(width) } });
    assert.equal(human.code, 5, human.stdout);
    assert.equal(human.stderr, "");
    assert.equal(posts.length, count + 2, "Второй явный вызов делает ровно один POST");
    assert.ok(human.stdout.includes(`entities/tasks/${id}.json`), human.stdout);
    assert.ok(human.stdout.includes(`task:${id}`), human.stdout);
    assert.match(human.stdout, /Поле:\s+title/);
    assert.equal(token(human.stdout, "ID запроса"), requestId);
    assert.equal(token(human.stdout, "URL сервера"), proxy.url);
    assert.doesNotMatch(human.stdout, /serverDetails|"issues"|Синтаксис и примеры|\u001b/);
    const prose = human.stdout.replaceAll(/\s+/g, " ");
    assert.ok(prose.includes("Reindex не исправляет JSON"), human.stdout);
    assert.ok(prose.includes("Обслуживание недоступно через HTTP"), human.stdout);
    assert.ok(hints(human.stdout).every((line) => !line.includes("--local")));
    readHint = hints(human.stdout).find((line) => line.endsWith("inspect graph list"));
    assert.ok(readHint, human.stdout);
    assert.equal(await readFile(path, "utf8"), damaged);
  }
  await writeFile(path, original);
  successful(await app.run(["--local", "storage", "reindex"]));
  const after = successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  assert.deepEqual(after.edges, graph.edges, "Отказ записи не создал диагностических отношений");
  assert.match(await follow(app.root, readHint!), /Граф проекта/);
  assert.equal(posts.length, 4, "Чтение из подсказки не повторяет мутацию");
});

test("doctor: HTTP-оболочка не скрывает проверки, владельца и schema recovery старого сервера", () => {
  const ref = { kind: "task", id: "Task0001" };
  const schema = {
    path: "entities/tasks/Task0001.json",
    ref,
    issues: [{ path: ["title"], message: "Expected string", expected: "string" }],
  };
  const managed = {
    path: "relations/tasks/Task0001.json",
    ref,
    slot: "task-links",
    missing: [{}],
    extra: [],
    drift: [],
  };
  const invocation = (args: readonly string[]) =>
    shellCommand(["npx", "@oim-dev/relay-cli", "--server-url", "http://localhost:4700", ...args]);
  for (const [code, serverDetails] of [
    ["IO_ERROR", schema],
    ["MANAGED_RELATIONS_MISMATCH", managed],
    [
      "VALIDATION_FAILED",
      [
        {
          code: "INVALID_DATA",
          message: "Ошибка схемы",
          details: schema,
          checks: ["storage.entities", "catalog"],
        },
      ],
    ],
  ] as const) {
    const details = { serverDetails, requestId: "correlation-only", url: "http://localhost:4700" };
    const before = JSON.stringify(details);
    const output = helpRuntime("/unused");
    const error = new AppError(code, "Отказ сервера", 5, details);
    printError(output.io.stdout, error, {
      format: "text",
      text: { width: 100, color: false },
      recovery: { command: invocation },
    });
    const text = output.output();
    assert.ok(text.includes("task:Task0001"), text);
    assert.equal(token(text, "ID запроса"), details.requestId);
    assert.equal(token(text, "URL сервера"), details.url);
    assert.doesNotMatch(text, /serverDetails|Синтаксис и примеры/);
    if (code === "MANAGED_RELATIONS_MISMATCH") {
      assert.ok(hints(text).includes(invocation(["inspect", "resolve", "task:Task0001"])), text);
    } else {
      assert.match(text, /Поле:\s+title/);
      assert.match(text, /Reindex не исправляет JSON/);
    }
    if (code === "VALIDATION_FAILED") assert.match(text, /Проверок: 2/);
    assert.equal(JSON.stringify(details), before, "Human-рендеринг не меняет details");
    const json = helpRuntime("/unused");
    printError(json.io.stdout, error, { format: "json" });
    assert.deepEqual(JSON.parse(json.output()).error.details, details);
  }
});
