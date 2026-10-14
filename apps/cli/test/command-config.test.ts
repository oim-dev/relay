import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
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

const configPath = (root: string) => join(root, ".relay/config.json");
const connection = (result: ReturnType<typeof successful<any>>) => (result.meta as any).connection;

async function changeServer(root: string, server: { url?: string; port: number }) {
  const path = configPath(root);
  const data = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...data, server }));
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      result[name] = entry.isDirectory()
        ? "directory"
        : (await readFile(join(path, entry.name))).toString("base64");
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
    }
  }
  await walk(root, "");
  return result;
}

async function runHint(root: string, hint: string) {
  const launcher = `
    const {spawnSync} = await import('node:child_process');
    const args = process.argv.slice(1);
    if (args.shift() !== '@oim-dev/relay-cli') throw new Error('Неожиданный пакет');
    const result = spawnSync(process.execPath, [...JSON.parse(process.env.TEST_ARGS), process.env.TEST_BINARY, ...args], {env: process.env, encoding: 'utf8', timeout: 20000});
    if (result.error) throw result.error;
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
  `;
  return promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `npx() { "$TEST_NODE" --input-type=module -e "$TEST_LAUNCHER" -- "$@"; };\n${hint}`,
    ],
    {
      cwd: root,
      env: cliEnv({
        TEST_NODE: process.execPath,
        TEST_LAUNCHER: launcher,
        TEST_ARGS: JSON.stringify(cliNodeArgs),
        TEST_BINARY: binary,
      }),
      timeout: 25000,
    },
  );
}

test("config: ранний конфликт префикса сохраняет формат и грамматику значений/-- без базы", async (t) => {
  const root = await tempDirectory(t);
  for (const format of [["--format", "json"], ["--format=json"]]) {
    for (const args of [
      [...format, "alpha", "config", "get", "--project", "beta"],
      ["alpha", ...format, "config", "get", "--project=beta"],
      ["alpha", "config", ...format, "get", "--project", "beta"],
      ["alpha", "config", "get", "--project", "beta", ...format],
      ["alpha", "config", "get", "--actor", "--format=text", "--project", "beta", ...format],
      ["alpha", "project", "update", "--name", "--format=text", "--project", "beta", ...format],
    ]) {
      const result = await invokeRaw(root, args);
      assert.equal(result.code, 2, result.stdout);
      assert.equal(result.stderr, "");
      const body = JSON.parse(result.stdout);
      assert.equal(body.error.code, "INVALID_ARGUMENT");
      assert.match(body.error.message, /Укажите проект один раз/);
      assert.match(
        body.error.details.hint,
        /npx @oim-dev\/relay-cli (config get|project update) --help$/,
      );
    }
  }
  for (const args of [
    ["alpha", "config", "get", "--project", "beta", "--", "--format=json"],
    ["alpha", "config", "get", "--actor", "--format=json", "--project", "beta"],
    ["alpha", "project", "update", "--name", "--format=json", "--project", "beta"],
  ]) {
    const result = await invokeRaw(root, args);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Ошибка: INVALID_ARGUMENT/);
    assert.match(result.stdout, /Укажите проект один раз/);
  }
  for (const args of [
    ["alpha", "config", "get", "--actor", "--project=beta", "--format=json"],
    ["alpha", "config", "get", "--format=json", "--", "--project=beta"],
    ["--format=json", "--", "alpha", "config", "get", "--project=beta"],
  ]) {
    const result = await invokeRaw(root, args);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /Укажите проект один раз/);
    assert.ok(JSON.parse(result.stdout).error);
  }
  for (const args of [
    ["config"],
    ["config", "--help"],
    ["config", "get", "--help"],
    ["alpha", "config", "get", "--help"],
  ]) {
    const result = await invokeRaw(root, args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /config/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("config: немутирующее local/legacy чтение, происхождение config и безопасная recovery", async (t) => {
  const app = await fixture(t);
  const before = await snapshot(app.root);
  const full = successful(await app.run<any>(["config", "get"]));
  assert.deepEqual(connection(full), {
    transport: "local",
    projectId: full.data.projectId,
    clientConfig: { path: configPath(app.root), mode: "local", source: "discovered" },
  });
  assert.deepEqual(await snapshot(app.root), before);
  const empty = await tempDirectory(t);
  for (const [args, env, source] of [
    [["--config", configPath(app.root)], {}, "flag"],
    [[], { RELAY_CONFIG: configPath(app.root) }, "env"],
  ] as const) {
    const result = successful(await invoke<any>(empty, [...args, "config", "get"], { env }));
    assert.deepEqual(result.data, full.data);
    assert.equal(connection(result).clientConfig.source, source);
    assert.equal(connection(result).clientConfig.path, configPath(app.root));
  }
  const legacy = await tempDirectory(t);
  await mkdir(join(legacy, ".relay"));
  await writeFile(configPath(legacy), JSON.stringify(full.data));
  const bare = await snapshot(legacy);
  await chmod(configPath(legacy), 0o444);
  await chmod(join(legacy, ".relay"), 0o555);
  try {
    const result = successful(await invoke<any>(legacy, ["config", "get"]));
    assert.deepEqual(result.data, full.data);
    assert.equal((result.meta as any).storagePath, join(legacy, ".relay", full.data.storageDir));
    assert.deepEqual(
      await snapshot(legacy),
      bare,
      "legacy чтение не создаёт runtime/tasks/.gitignore",
    );
  } finally {
    await chmod(join(legacy, ".relay"), 0o755);
    await chmod(configPath(legacy), 0o644);
  }
  const absent = await invokeRaw(empty, ["config", "get"], { env: { COLUMNS: "40" } });
  assert.equal(absent.code, 2);
  assert.equal(absent.stderr, "");
  assert.match(absent.stdout, /CONFIG_NOT_FOUND/);
  assert.doesNotMatch(absent.stdout, /найдите запись/);
  const hint = absent.stdout.split("\n").find((line) => line.startsWith("npx "))!;
  assert.equal(hint, "npx @oim-dev/relay-cli init --help");
  const help = await runHint(empty, hint);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /init/);
  const explicit = await invokeRaw(empty, ["--config", "missing.json", "config", "get"]);
  assert.match(explicit.stdout.replace(/\s+/g, " "), /Проверьте явно выбранный путь/);
  assert.doesNotMatch(explicit.stdout, /npx .*init|найдите запись/);
  const entity = await invokeRaw(app.root, ["task", "get", "PRODUCT-999"]);
  assert.notEqual(entity.code, 0);
  assert.equal(entity.stderr, "");
  assert.match(entity.stdout, /Ошибка: NOT_FOUND/);
  assert.match(entity.stdout.replace(/\s+/g, " "), /Проверьте адрес и выбранный проект/);
  assert.doesNotMatch(entity.stdout, /\binit\b|CONFIG_NOT_FOUND/);
  const recovery = entity.stdout
    .split("\n")
    .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
  assert.deepEqual(recovery, ["npx @oim-dev/relay-cli task list"]);
  const records = await runHint(app.root, recovery[0]!);
  assert.equal(records.stderr, "");
  assert.match(records.stdout, /Задачи/);
  assert.match(records.stdout, /Показано: 0 из 0 подходящих записей/);
  assert.deepEqual(await readdir(empty), []);
});

test("config: HTTP URL flag/env/config выбирает один удалённый проект из другого local cwd", async (t) => {
  const app = await fixture(t);
  const other = await fixture(t);
  const server = await httpServer(t, app.root);
  const expected = successful(await app.run<any>(["config", "get"]));
  const projectId = expected.data.projectId;
  const requests: string[] = [];
  const proxy = await httpProxy(t, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const upstream = await fetch(`${server.url}${request.url}`);
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(await upstream.text());
  });
  await changeServer(other.root, { port: 0, url: proxy.url });
  for (const [args, env, source] of [
    [["--server-url", proxy.url], { RELAY_SERVER_URL: "http://127.0.0.1:1" }, "flag"],
    [[], { RELAY_SERVER_URL: proxy.url }, "env"],
    [[], {}, "config"],
  ] as const) {
    const start = requests.length;
    const result = successful(
      await invoke<any>(other.root, [...args, "--project", projectId, "config", "get"], { env }),
    );
    assert.deepEqual(result.data, expected.data);
    assert.deepEqual(connection(result), {
      transport: "http",
      serverUrl: proxy.url,
      serverUrlSource: source,
      projectId,
      ...(source === "config" ? { serverUrlConfigField: "server.url" } : {}),
      clientConfig: { path: configPath(other.root), mode: "local", source: "discovered" },
    });
    assert.deepEqual(requests.slice(start), [`GET /api/v1/projects/${projectId}/context`]);
  }
  const human = await invokeRaw(other.root, [projectId, "config", "get"], {
    env: { COLUMNS: "40" },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Конфиг клиента/);
  assert.match(human.stdout, /Конфиг проекта на сервере/);
  assert.ok(human.stdout.includes(configPath(other.root)));
  assert.ok(human.stdout.includes(configPath(app.root)));
  const hint = human.stdout.split("\n").find((line) => line.startsWith("npx "))!;
  assert.match(hint, /--server-url .* --project .* project get$/);
  const start = requests.length;
  const read = await runHint(other.root, hint);
  assert.equal(read.stderr, "");
  assert.match(read.stdout, /PROJECT/);
  assert.equal(requests.length - start, 2, "подсказка project get: bootstrap + адресное чтение");
  const empty = await tempDirectory(t);
  const remote = successful(
    await invoke<any>(empty, ["config", "get"], {
      env: { RELAY_SERVER_URL: proxy.url, PRIVATE_TOKEN: "not-for-output" },
    }),
  );
  assert.equal(connection(remote).clientConfig, undefined);
  assert.equal(connection(remote).projectId, projectId);
  assert.equal(connection(remote).serverUrlSource, "env");
  assert.ok(!JSON.stringify(remote).includes("not-for-output"));
  assert.deepEqual(remote.data, expected.data);
  failed(
    await invoke(other.root, ["--local", "--project", projectId, "config", "get"]),
    "REGISTRY_REQUIRED",
  );
  const local = successful(await invoke<any>(other.root, ["--local", "config", "get"]));
  assert.equal(connection(local).transport, "local");
  assert.notEqual(connection(local).projectId, projectId);
  await writeFile(configPath(other.root), "{");
  const count = requests.length;
  failed(await invoke(other.root, ["--server-url", proxy.url, "config", "get"]), "INVALID_DATA", 5);
  assert.equal(requests.length, count, "повреждённый ближайший config останавливает до HTTP");
  failed(
    await invoke(empty, ["--server-url", proxy.url, "--config", "missing.json", "config", "get"]),
    "NOT_FOUND",
    3,
  );
});

test("config: workspace из URL/порта сохраняет клиентский реестр и серверные пути", async (t) => {
  const app = await fixture(t);
  const root = await tempDirectory(t);
  const registryPath = join(root, "relay.workspace.json");
  const registry = { version: 1, projects: { alpha: { path: app.root } }, server: { port: 0 } };
  await writeFile(registryPath, JSON.stringify(registry));
  const server = await httpServer(t, root);
  const port = Number(new URL(server.url).port);
  const expected = successful(await app.run<any>(["config", "get"])).data;
  for (const serverConfig of [{ port }, { port: 0, url: server.url }]) {
    await writeFile(registryPath, JSON.stringify({ ...registry, server: serverConfig }));
    for (const [args, env, source] of [
      [["--server-url", server.url], {}, "flag"],
      [[], { RELAY_SERVER_URL: server.url }, "env"],
      [[], {}, "config"],
    ] as const) {
      const result = successful(
        await invoke<any>(root, [...args, "alpha", "config", "get"], { env }),
      );
      assert.deepEqual(result.data, expected);
      assert.equal(result.data.mode, "local");
      assert.equal(result.meta?.project, "alpha");
      assert.deepEqual(connection(result), {
        transport: "http",
        serverUrl: server.url,
        serverUrlSource: source,
        projectId: expected.projectId,
        ...(source === "config"
          ? { serverUrlConfigField: "url" in serverConfig ? "server.url" : "server.port" }
          : {}),
        clientConfig: { path: registryPath, mode: "workspace", source: "discovered" },
      });
    }
  }
  const other = await fixture(t);
  await changeServer(other.root, { port: 0, url: server.url });
  for (const [args, env] of [
    [["--server-url", server.url], {}],
    [[], { RELAY_SERVER_URL: server.url }],
    [[], {}],
  ] as const) {
    const result = successful(
      await invoke<any>(other.root, [...args, "--project", "alpha", "config", "get"], { env }),
    );
    assert.deepEqual(
      result.data,
      expected,
      "регистрация удалённого workspace не выбирается из local cwd",
    );
    assert.equal(connection(result).clientConfig.mode, "local");
  }
  failed(await invoke(root, ["config", "get"]), "PROJECT_REQUIRED");
  failed(await invoke(root, ["--local", "alpha", "config", "get"]), "WORKSPACE_REQUIRES_SERVER");
  const empty = await tempDirectory(t);
  const human = await invokeRaw(empty, ["alpha", "config", "get"], {
    env: { RELAY_CONFIG: registryPath, COLUMNS: "40" },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /Реестр клиента/);
  assert.match(human.stdout, /RELAY_CONFIG/);
  assert.ok(human.stdout.includes(registryPath));
  const hint = human.stdout.split("\n").find((line) => line.startsWith("npx "))!;
  assert.ok(hint.includes(registryPath));
  assert.equal((await runHint(empty, hint)).stderr, "");
  await writeFile(registryPath, JSON.stringify(registry));
  failed(await invoke(root, ["alpha", "config", "get"]), "SERVER_URL_REQUIRED");
});

test("config: источник разрешается один раз, смена файла после bootstrap не меняет URL/hint", async (t) => {
  const app = await fixture(t);
  const client = await fixture(t);
  const server = await httpServer(t, app.root);
  const projectId = successful(await app.run<any>(["config", "get"])).data.projectId;
  const requests: string[] = [];
  const proxy = await httpProxy(t, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const upstream = await fetch(`${server.url}${request.url}`);
    const body = await upstream.text();
    await changeServer(client.root, { port: 0, url: "http://127.0.0.1:1" });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(body);
  });
  const probeRoot = await tempDirectory(t);
  const probe = join(probeRoot, "probe.mjs");
  const log = join(probeRoot, "reads.json");
  await writeFile(
    probe,
    `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const read = fs.promises.readFile;
    let count = 0;
    fs.promises.readFile = function(path, ...args) {
      if (String(path) === process.env.PROBE_CONFIG) count++;
      return read.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    process.on('exit', () => fs.writeFileSync(process.env.PROBE_LOG, JSON.stringify({count})));
  `,
  );
  const options = {
    nodeArgs: ["--import", probe],
    env: { PROBE_CONFIG: configPath(client.root), PROBE_LOG: log },
  };
  successful(await invoke(client.root, ["--local", "config", "get"], options));
  assert.equal(
    JSON.parse(await readFile(log, "utf8")).count,
    3,
    "local: source classification + Core projection + Backend; гарантии не кешируем",
  );
  for (const source of ["config", "env"] as const) {
    await changeServer(client.root, { port: 0, url: proxy.url });
    const result = successful(
      await invoke<any>(client.root, ["--project", projectId, "config", "get"], {
        ...options,
        env: { ...options.env, ...(source === "env" ? { RELAY_SERVER_URL: proxy.url } : {}) },
      }),
    );
    assert.equal(connection(result).serverUrl, proxy.url);
    assert.equal(connection(result).serverUrlSource, source);
    assert.equal(
      JSON.parse(await readFile(log, "utf8")).count,
      2,
      "HTTP: только source classification + Core projection, без повторного чтения ради текста",
    );
  }
  await changeServer(client.root, { port: 0, url: proxy.url });
  const human = await invokeRaw(client.root, ["--project", projectId, "config", "get"], options);
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  const hint = human.stdout.split("\n").find((line) => line.startsWith("npx "))!;
  assert.ok(hint.includes(proxy.url));
  assert.ok(!hint.includes("http://127.0.0.1:1 "));
  assert.equal(JSON.parse(await readFile(log, "utf8")).count, 2);
  assert.equal(requests.length, 3, "один HTTP bootstrap на config get");
  const read = await runHint(client.root, hint);
  assert.equal(read.stderr, "");
  t.diagnostic(
    "readFile config: local=3; HTTP config=2 (baseline 4), env=2; HTTP config get=1, project hint=2",
  );
});

test("config: HTTP legacy без Config.projectId сообщает подтверждённый bootstrap ID без mkdir", async (t) => {
  const app = await fixture(t);
  const full = successful(await app.run<any>(["config", "get"])).data;
  delete full.projectId;
  const legacy = await tempDirectory(t);
  await mkdir(join(legacy, ".relay"));
  await writeFile(configPath(legacy), JSON.stringify(full));
  const server = await httpServer(t, legacy);
  const before = await snapshot(legacy);
  const empty = await tempDirectory(t);
  const result = successful(
    await invoke<any>(empty, ["--server-url", server.url, "config", "get"]),
  );
  assert.deepEqual(result.data, full, "data не дополняется транспортным fallback ID");
  assert.equal(typeof connection(result).projectId, "string");
  assert.ok(connection(result).projectId.length);
  assert.deepEqual(
    await snapshot(legacy),
    before,
    "HTTP context не подготавливает legacy-каталоги",
  );
  assert.deepEqual(await readdir(empty), []);
});

test("config: 503 не переключает HTTP на local; полные 45 статусов на 40/100 колонках", async (t) => {
  const app = await fixture(t);
  let requests = 0;
  const unavailable = await httpProxy(t, async (_request, response) => {
    requests++;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        error: { code: "SERVER_UNAVAILABLE", message: "Проверка отказа" },
      }),
    );
  });
  failed(
    await invoke(app.root, ["--server-url", unavailable.url, "config", "get"]),
    "SERVER_UNAVAILABLE",
    5,
  );
  assert.equal(requests, 3, "разрешённые повторы чтения; нет local fallback");
  const path = configPath(app.root);
  const raw = JSON.parse(await readFile(path, "utf8"));
  const names = Array.from({ length: 45 }, (_, i) => `status-${String(i + 1).padStart(2, "0")}`);
  const statuses = Object.fromEntries(
    names.map((name) => [name, { terminal: false, satisfiesDependencies: false }]),
  );
  await writeFile(
    path,
    JSON.stringify({ ...raw, statuses, defaultStatus: names[0], readyStatuses: [names[44]] }),
  );
  const full = successful(await app.run<any>(["config", "get"]));
  assert.deepEqual(full.data.statuses, statuses);
  for (const width of [40, 100]) {
    const result = await invokeRaw(app.root, ["config", "get"], {
      env: { COLUMNS: String(width), FORCE_COLOR: "1", NO_COLOR: undefined },
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    for (const name of names) assert.ok(result.stdout.includes(name), name);
    assert.equal((result.stdout.match(/terminal=false/g) ?? []).length, 45);
    assert.equal((result.stdout.match(/satisfiesDependencies=false/g) ?? []).length, 45);
    assert.doesNotMatch(result.stdout, /\u001b/);
    assert.ok(result.stdout.includes(configPath(app.root)));
    assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("npx ")).length, 1);
    t.diagnostic(
      `45 статусов, pipe ${width}: ${Buffer.byteLength(result.stdout)} UTF-8 байт, ${result.stdout.split("\n").length - 1} строк`,
    );
  }
});
