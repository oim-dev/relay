import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import type { ServerContextResponse } from "@relay/contracts";
import { initialize } from "@relay/core/storage/workspace";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { createServerApi } from "@relay/project-runtime/backend/server";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixtureCleanup,
  invoke,
  invokeRaw,
  successful,
} from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-audit-"));
  fixtureCleanup(t, () => rm(root, { recursive: true, force: true }));
  const serverRoot = join(root, "сервер 'каталог'");
  const clientRoot = join(root, "клиент 'каталог'");
  const remoteRoot = join(root, "без конфига");
  await mkdir(remoteRoot);
  const registry = await initializeRegistry(serverRoot);
  const client = await initializeRegistry(clientRoot);
  const a = await initialize(join(serverRoot, "a"), "tasks");
  const b = await initialize(join(serverRoot, "b"), "tasks");
  await saveProjectSettings(a, { name: "Платформа 漢字 🚀", slug: "alpha-web", ifRevision: 1 });
  await saveProjectSettings(b, { name: "Второй проект", slug: "beta-web", ifRevision: 1 });
  const server = await httpServer(t, serverRoot);
  return { root, serverRoot, clientRoot, remoteRoot, registry, client, a, b, server };
}

async function runHint(cwd: string, command: string) {
  const launcher = `function npx() { shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
  return promisify(execFile)("bash", ["-c", launcher + command], {
    cwd,
    env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
  });
}

function hints(text: string) {
  return text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli"));
}

test("WSP-04/05/06: remote-only каталог без меню, регистрация/удаление и исполнимое продолжение", async (t) => {
  const f = await setup(t);
  const url = ["--server-url", f.server.url];
  const empty = await invokeRaw(f.remoteRoot, ["workspace", "project", "list", ...url]);
  assert.equal(empty.code, 0, empty.stdout);
  assert.equal(empty.stderr, "");
  assert.match(empty.stdout, /Режим Server:\s+workspace/);
  assert.match(empty.stdout, /Реестр на сервере:/);
  assert.equal(hints(empty.stdout).length, 0);
  assert.match(
    (await invokeRaw(f.remoteRoot, ["workspace", "project", "add", "--help"])).stdout,
    /--project-config/,
  );
  const added = successful(
    await invoke<ServerContextResponse>(f.remoteRoot, [
      "workspace",
      "project",
      "add",
      "альфа",
      "a",
      ...url,
    ]),
  );
  assert.equal(added.data.configPath, f.registry.configPath);
  assert.equal(added.data.projects[0]!.id, f.a.config.projectId);
  assert.equal((added.meta as any)?.configPath, undefined, "Не выдумываем клиентский реестр");
  const second = successful(
    await invoke<ServerContextResponse>(
      f.remoteRoot,
      ["workspace", "project", "add", "beta", "--project-config", "b/.relay/config.json"],
      { env: { RELAY_SERVER_URL: f.server.url } },
    ),
  );
  assert.equal(second.data.projects.length, 2, "Прежняя JSON-квитанция сохраняет полный каталог");
  const page = successful(
    await invoke<ServerContextResponse>(
      f.remoteRoot,
      ["workspace", "project", "list", "--limit", 1],
      { env: { RELAY_SERVER_URL: f.server.url } },
    ),
  );
  assert.equal(page.data.projects.length, 1);
  assert.ok(page.meta?.page?.nextCommand);
  const continued = JSON.parse((await runHint(f.remoteRoot, page.meta.page.nextCommand)).stdout);
  assert.equal(continued.data.projects[0].key, "beta");
  assert.equal(continued.meta.page.nextCursor, null);
  for (const envConfig of [false, true]) {
    const text = await invokeRaw(
      f.remoteRoot,
      [
        "workspace",
        "project",
        "list",
        ...url,
        ...(envConfig ? [] : ["--config", f.client.configPath]),
      ],
      {
        env: envConfig ? { RELAY_CONFIG: f.client.configPath, COLUMNS: "40" } : { COLUMNS: "100" },
      },
    );
    assert.equal(text.code, 0, text.stdout);
    assert.ok(text.stdout.includes(f.registry.configPath));
    assert.ok(text.stdout.includes(f.client.configPath));
    assert.match(text.stdout, /Конфиг клиента:/);
    assert.ok(
      !text.stdout.includes(f.a.configPath),
      "Пути доступных баз раскрываются через config get",
    );
    assert.deepEqual(hints(text.stdout), []);
    const result = await invokeRaw(f.remoteRoot, [...url, "--project", "альфа", "config", "get"]);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.includes(f.a.configPath));
    assert.ok(!text.stdout.includes("\u001b"));
  }
  const removed = successful(
    await invoke<ServerContextResponse>(f.remoteRoot, ["workspace", "project", "remove", "альфа"], {
      env: { RELAY_SERVER_URL: f.server.url },
    }),
  );
  assert.deepEqual(
    removed.data.projects.map((item) => item.key),
    ["beta"],
  );
  assert.ok(await readFile(f.a.configPath));
  failed(
    await invoke(f.remoteRoot, [
      "workspace",
      "project",
      "list",
      ...url,
      "--cursor",
      page.meta.page.nextCursor!,
    ]),
    "VERSION_CONFLICT",
    4,
  );
  failed(
    await invoke(f.remoteRoot, ["workspace", "project", "list", ...url, "--local"]),
    "WORKSPACE_REQUIRES_SERVER",
  );
});

test("WSP-01/03: сервер разрешает key/ID/slug из пустого клиентского workspace; ранняя ошибка JSON", async (t) => {
  const f = await setup(t);
  await registerProject(f.registry.configPath, "alpha", { path: "a" });
  const client = JSON.parse(await readFile(f.client.configPath, "utf8"));
  await writeFile(
    f.client.configPath,
    JSON.stringify({ ...client, server: { url: f.server.url } }),
  );
  for (const selector of ["alpha", f.a.config.projectId!, "alpha-web"]) {
    for (const source of ["flag", "env", "config"]) {
      const args = [
        "project",
        "get",
        "--project",
        selector,
        ...(source === "flag" ? ["--server-url", f.server.url] : []),
      ];
      const result = successful(
        await invoke<any>(f.clientRoot, args, {
          env: source === "env" ? { RELAY_SERVER_URL: f.server.url } : {},
        }),
      );
      assert.equal(result.data.ref.id, f.a.config.projectId);
    }
  }
  const localClient = successful(
    await invoke<any>(join(f.serverRoot, "b"), ["project", "get", "--project", "alpha-web"], {
      env: { RELAY_SERVER_URL: f.server.url },
    }),
  );
  assert.equal(
    localClient.data.ref.id,
    f.a.config.projectId,
    "Local-конфиг клиента не ограничивает удалённый selector из env",
  );
  failed(await invoke(f.clientRoot, ["project", "get"]), "PROJECT_REQUIRED");
  failed(
    await invoke(f.clientRoot, ["project", "get", "--project", "unknown"]),
    "PROJECT_NOT_FOUND",
    3,
  );
  for (const args of [
    ["--format", "json", "--project", "alpha", "beta", "project", "get"],
    ["beta", "project", "get", "--project", "alpha", "--format=json"],
  ]) {
    const result = await invokeRaw(f.remoteRoot, args);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
  }
});

test("WSP-04/05: local Server доступен для discovery, не выдаётся за workspace; неверный config не игнорируется", async (t) => {
  const f = await setup(t);
  const local = await httpServer(t, join(f.serverRoot, "a"));
  const args = ["workspace", "project", "list", "--server-url", local.url];
  const listed = successful(await invoke<ServerContextResponse>(f.remoteRoot, args));
  assert.equal(listed.data.mode, "local");
  assert.equal(listed.data.defaultProject, f.a.config.projectId);
  const fromProject = successful(
    await invoke<ServerContextResponse>(join(f.serverRoot, "b"), args),
  );
  assert.equal(
    fromProject.data.configPath,
    f.a.configPath,
    "Каталог URL доступен из обычного local-конфига",
  );
  const text = await invokeRaw(f.clientRoot, args);
  assert.equal(text.code, 0, JSON.stringify(text));
  assert.equal(text.stderr, "");
  assert.match(text.stdout, /Проект local-сервера/);
  assert.match(text.stdout, /Режим Server:\s+local/);
  assert.ok(text.stdout.includes(f.a.configPath));
  assert.deepEqual(hints(text.stdout), []);
  failed(
    await invoke(f.remoteRoot, [
      "workspace",
      "project",
      "remove",
      "local",
      "--server-url",
      local.url,
    ]),
    "WORKSPACE_REQUIRED",
  );
  failed(await invoke(f.remoteRoot, [...args, "--config", join(f.root, "absent")]), "NOT_FOUND", 3);
  await writeFile(join(f.remoteRoot, "relay.workspace.json"), "{");
  failed(await invoke(f.remoteRoot, args), "INVALID_DATA", 5);
  await rm(join(f.remoteRoot, "relay.workspace.json"));
  const missing = await invokeRaw(f.remoteRoot, ["workspace", "project", "list"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /workspace project list --help/);
  assert.doesNotMatch(missing.stdout, /relay-cli init/);
});

test("WSP-02: runtime schema отвергает неверные успешные конверты/DTO и не повторяет записи", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-wire-"));
  fixtureCleanup(t, () => rm(root, { recursive: true, force: true }));
  let response: unknown;
  let invalidJson = false;
  let count = 0;
  const server = await httpProxy(t, async (_request, reply) => {
    count++;
    reply.setHeader("Content-Type", "application/json");
    reply.end(invalidJson ? "не JSON" : JSON.stringify(response));
  });
  const valid = {
    mode: "workspace",
    configPath: "/server/registry.json",
    defaultProject: null,
    projects: [{ key: "a", id: "id-a", name: "А", configPath: "/server/a.json", available: true }],
  };
  const api = createServerApi(server.url);
  for (response of [
    { ok: true, data: { mode: "workspace", projects: [] } },
    { ok: true, data: { ...valid, projects: [{ ...valid.projects[0], available: "false" }] } },
    { ok: false, error: { code: "BOOM", message: "не успех" } },
    { data: valid },
    { ok: true, data: { ...valid, defaultProject: 10 } },
    { ok: true, data: { ...valid, projects: [{ ...valid.projects[0], error: 17 }] } },
  ]) {
    await assert.rejects(api.projects.getProjects(), { code: "INVALID_SERVER_RESPONSE" });
    await assert.rejects(api.server.getServerContext(), { code: "INVALID_SERVER_RESPONSE" });
  }
  for (const operation of ["add", "remove"]) {
    count = 0;
    response = { ok: true, data: { mode: "workspace", projects: [] } };
    const result = await invoke(root, [
      "workspace",
      "project",
      operation,
      "a",
      ...(operation === "add" ? ["/server/a"] : []),
      "--server-url",
      server.url,
    ]);
    failed(result, "INVALID_SERVER_RESPONSE", 5);
    assert.match(result.stdout, /Запись могла завершиться/);
    assert.equal(count, 1);
  }
  response = { ok: true, data: valid };
  assert.deepEqual((await api.projects.getProjects()).data, valid);
  invalidJson = true;
  count = 0;
  await assert.rejects(
    api.projects.registerProject({ project: "a" }, { path: "/a" }),
    (error: any) =>
      error.code === "INVALID_SERVER_RESPONSE" && /Запись могла завершиться/.test(error.message),
  );
  assert.equal(count, 1);
});

test("WSP-06/08: недоступные базы сохраняют пути/причины, не получают ложный get; курсор проверяет доступность/origin", async (t) => {
  const f = await setup(t);
  await registerProject(f.registry.configPath, "alpha", { path: "a" });
  await registerProject(f.registry.configPath, "beta", { path: "b" });
  const args = ["workspace", "project", "list", "--server-url", f.server.url];
  const first = successful(
    await invoke<ServerContextResponse>(f.remoteRoot, [...args, "--limit", 1]),
  );
  await rm(f.a.configPath);
  await rm(f.b.configPath);
  failed(
    await invoke(f.remoteRoot, [...args, "--cursor", first.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
  const unavailable = await invokeRaw(f.remoteRoot, args, { env: { COLUMNS: "40" } });
  assert.equal(unavailable.code, 0, unavailable.stdout);
  assert.match(unavailable.stdout, /Причина:/);
  assert.match(unavailable.stdout, /база не подтверждена/);
  assert.equal(hints(unavailable.stdout).length, 0);
  const other = await httpServer(t, f.clientRoot);
  failed(
    await invoke(f.remoteRoot, [
      "workspace",
      "project",
      "list",
      "--server-url",
      other.url,
      "--cursor",
      first.meta!.page!.nextCursor!,
    ]),
    "INVALID_CURSOR",
  );
});

test("WSP-07: исправление коллизии slug через CLI сохраняет ID/регистрации и исходную ревизию", async (t) => {
  const f = await setup(t);
  await registerProject(f.registry.configPath, "alpha", { path: "a" });
  await registerProject(f.registry.configPath, "beta", { path: "b" });
  await saveProjectSettings(f.b, { name: "Второй проект", slug: "alpha-web", ifRevision: 2 });
  const common = ["--server-url", f.server.url];
  failed(
    await invoke(f.remoteRoot, ["project", "get", "--project", "alpha-web", ...common]),
    "PROJECT_SLUG_TAKEN",
    4,
  );
  const read = successful(
    await invoke<any>(f.remoteRoot, [
      "project",
      "get",
      "--project",
      f.b.config.projectId!,
      ...common,
    ]),
  );
  failed(
    await invoke(f.remoteRoot, [
      "project",
      "update",
      "--project",
      "beta",
      "--slug",
      "beta-fixed",
      "--if-revision",
      read.data.revision - 1,
      ...common,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  successful(
    await invoke(f.remoteRoot, [
      "project",
      "update",
      "--project",
      "beta",
      "--slug",
      "beta-fixed",
      "--if-revision",
      read.data.revision,
      ...common,
    ]),
  );
  const fixed = successful(
    await invoke<any>(f.remoteRoot, ["project", "get", "--project", "beta-fixed", ...common]),
  );
  assert.equal(fixed.data.ref.id, f.b.config.projectId);
  assert.equal(fixed.data.data.name, "Второй проект");
  const list = successful(
    await invoke<ServerContextResponse>(f.remoteRoot, ["workspace", "project", "list", ...common]),
  );
  assert.deepEqual(
    list.data.projects.map((item) => item.key),
    ["alpha", "beta"],
  );
  assert.equal(list.data.projects.find((item) => item.key === "beta")!.slug, "beta-fixed");
});

test("WSP-02: потеря ответа регистрации не повторяет PUT; отдельное чтение видит запись", async (t) => {
  const f = await setup(t);
  let writes = 0;
  const proxy = await httpProxy(t, async (request, reply, signal) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const response = await fetch(`${f.server.url}${request.url}`, {
      signal,
      method: request.method!,
      ...(body.length ? { body, headers: { "Content-Type": "application/json" } } : {}),
    });
    if (request.method === "PUT") {
      writes++;
      assert.equal(response.status, 200);
      await response.text();
      reply.destroy();
    } else {
      reply.statusCode = response.status;
      reply.end(await response.text());
    }
  });
  const result = await invoke(f.remoteRoot, [
    "workspace",
    "project",
    "add",
    "alpha",
    "a",
    "--server-url",
    proxy.url,
  ]);
  failed(result, "SERVER_UNAVAILABLE", 5);
  assert.equal(writes, 1);
  assert.match(result.stdout, /Запись могла завершиться/);
  const read = successful(
    await invoke<ServerContextResponse>(f.remoteRoot, [
      "workspace",
      "project",
      "list",
      "--server-url",
      proxy.url,
    ]),
  );
  assert.equal(read.data.projects[0]!.key, "alpha");
});
