import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import type { ServerContextResponse } from "@relay/contracts";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { createServerApi } from "@relay/project-runtime/backend/server";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  invoke,
  invokeRaw,
  successful,
} from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

type Wire = { method: string; path: string; bytes: number; data: any };

async function setup(t: TestContext, count = 23) {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-pages-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRoot = join(root, "server");
  const cwd = join(root, "remote");
  await mkdir(cwd);
  const a = await initialize(join(serverRoot, "a"), "tasks");
  const b = await initialize(join(serverRoot, "b"), "tasks");
  const registry = await initializeRegistry(serverRoot);
  for (let n = 0; n < count; n++)
    await registerProject(registry.configPath, `p-${n}`, { path: n % 2 ? "b" : "a" });
  const server = await httpServer(t, serverRoot);
  const wire: Wire[] = [];
  const control: {
    old?: boolean;
    noCapability?: boolean;
    fault?: "drop" | "malformed";
    faultMethod?: string;
    override?: unknown;
  } = {};
  const proxy = await httpProxy(t, async (request, reply) => {
    const path = request.url!;
    const method = request.method!;
    if (path === "/api/v1/server/capabilities" && (control.old || control.noCapability)) {
      reply.statusCode = control.old ? 404 : 200;
      const data = control.old
        ? { ok: false, error: { code: "NOT_FOUND", message: "Прежний сервер" } }
        : { ok: true, data: { capabilities: [] } };
      wire.push({ method, path, bytes: Buffer.byteLength(JSON.stringify(data)), data });
      reply.end(JSON.stringify(data));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const upstream = await fetch(`${server.url}${path}`, {
      method,
      ...(body.length ? { body, headers: { "Content-Type": "application/json" } } : {}),
    });
    const text = await upstream.text();
    const data = JSON.parse(text);
    wire.push({ method, path, bytes: Buffer.byteLength(text), data });
    if (control.fault && method === control.faultMethod) {
      if (control.fault === "drop") reply.destroy();
      else reply.end(JSON.stringify(control.override));
      return;
    }
    if (control.override !== undefined && path.startsWith("/api/v1/projects/page")) {
      reply.end(JSON.stringify(control.override));
      return;
    }
    reply.statusCode = upstream.status;
    reply.end(text);
  });
  const args = ["--server-url", proxy.url];
  return { root, serverRoot, cwd, a, b, registry, server, proxy, wire, control, args };
}

async function runHint(cwd: string, hint: string) {
  const launcher = `function npx() { shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
  const result = await promisify(execFile)("bash", ["-c", launcher + hint], {
    cwd,
    env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
  });
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("WSP-08 HTTP CLI: limit=1/20 ограничивает wire, полный проход сохраняет data/context и cursor", async (t) => {
  const f = await setup(t);
  const full = (await createServerApi(f.server.url).projects.getProjects()).data;
  for (const limit of [1, 20]) {
    f.wire.length = 0;
    let page = successful(
      await invoke<ServerContextResponse>(f.cwd, [
        "workspace",
        "project",
        "list",
        "--limit",
        limit,
        ...f.args,
      ]),
    );
    assert.deepEqual(page.data, { ...full, projects: full.projects.slice(0, limit) });
    assert.equal((page.meta as any).paginationSource, "server-catalog-fingerprint");
    assert.equal((page.meta as any).configPath, undefined);
    const keys = page.data.projects.map((item) => item.key);
    const firstVersion = f.wire.find((item) => item.path.includes("/page?"))!.data.data.version;
    while (page.meta?.page?.nextCursor) {
      const nextCommand = page.meta.page.nextCommand!;
      page = await runHint(f.cwd, nextCommand);
      assert.equal(page.data.mode, "workspace");
      assert.equal(page.data.configPath, f.registry.configPath);
      assert.equal(page.data.defaultProject, null);
      keys.push(...page.data.projects.map((item) => item.key));
    }
    assert.deepEqual(
      keys,
      full.projects.map((item) => item.key),
    );
    assert.equal(new Set(keys).size, 23);
    const pages = f.wire.filter((item) => item.path.startsWith("/api/v1/projects/page"));
    assert.equal(pages.length, Math.ceil(23 / limit));
    assert.ok(pages.every((item) => item.data.data.catalog.projects.length <= limit));
    assert.ok(pages.every((item) => item.data.data.version === firstVersion));
    assert.ok(
      pages
        .slice(1)
        .every(
          (item) => new URL(item.path, f.proxy.url).searchParams.get("version") === firstVersion,
        ),
    );
    assert.equal(
      f.wire.filter((item) => item.path === "/api/v1/server/capabilities").length,
      pages.length,
    );
    assert.ok(
      !f.wire.some((item) => item.path === "/api/v1/projects" || item.path === "/api/v1/server"),
    );
    t.diagnostic(
      `limit=${limit}; pages=${pages.length}; first page wire=${pages[0]!.bytes} bytes; full=${Buffer.byteLength(JSON.stringify({ ok: true, data: full }))} bytes`,
    );
  }
  const first = successful(
    await invoke<ServerContextResponse>(f.cwd, [
      "workspace",
      "project",
      "list",
      "--limit",
      1,
      ...f.args,
    ]),
  );
  failed(
    await invoke(f.cwd, [
      "workspace",
      "project",
      "list",
      "--limit",
      20,
      "--cursor",
      first.meta!.page!.nextCursor!,
      ...f.args,
    ]),
    "INVALID_CURSOR",
  );
  failed(
    await invoke(f.cwd, [
      "workspace",
      "project",
      "list",
      "--cursor",
      first.meta!.page!.nextCursor!,
      "--server-url",
      f.server.url,
    ]),
    "INVALID_CURSOR",
  );
  failed(
    await invoke(f.cwd, ["workspace", "project", "list", "--q", "not-supported", ...f.args]),
    "INVALID_ARGUMENT",
  );
  const token = JSON.parse(
    Buffer.from(first.meta!.page!.nextCursor!, "base64url").toString("utf8"),
  );
  token.filters = { q: "несуществующий фильтр" };
  failed(
    await invoke(f.cwd, [
      "workspace",
      "project",
      "list",
      "--cursor",
      Buffer.from(JSON.stringify(token)).toString("base64url"),
      ...f.args,
    ]),
    "INVALID_CURSOR",
  );
});

test("WSP-08 HTTP CLI: guard фиксирует смену регистрации, доступности и идентичности; local default сохранён", async (t) => {
  const f = await setup(t, 3);
  const start = async () =>
    successful(
      await invoke<ServerContextResponse>(f.cwd, [
        "workspace",
        "project",
        "list",
        "--limit",
        1,
        ...f.args,
      ]),
    ).meta!.page!.nextCursor!;
  const conflict = async (cursor: string) =>
    failed(
      await invoke(f.cwd, ["workspace", "project", "list", "--cursor", cursor, ...f.args]),
      "VERSION_CONFLICT",
      4,
    );
  let cursor = await start();
  await registerProject(f.registry.configPath, "added", { path: "a" });
  await conflict(cursor);
  cursor = await start();
  const config = await readFile(f.a.configPath, "utf8");
  await rm(f.a.configPath);
  await conflict(cursor);
  await writeFile(f.a.configPath, config);
  cursor = await start();
  await registerProject(f.registry.configPath, "p-0", { path: "b" }, true);
  await conflict(cursor);
  const local = await httpServer(t, join(f.serverRoot, "b"));
  const result = successful(
    await invoke<ServerContextResponse>(f.cwd, [
      "workspace",
      "project",
      "list",
      "--server-url",
      local.url,
      "--limit",
      1,
    ]),
  );
  assert.equal(result.data.mode, "local");
  assert.equal(result.data.configPath, f.b.configPath);
  assert.equal(result.data.defaultProject, f.b.config.projectId);
  assert.equal(result.data.projects.length, 1);
});

test("WSP-08 HTTP CLI: compact JSON opt-in, human compact и прежний default JSON без union", async (t) => {
  const f = await setup(t);
  const added = successful(
    await invoke<any>(f.cwd, [
      "workspace",
      "project",
      "add",
      "компакт",
      "a",
      "--projection",
      "compact",
      ...f.args,
    ]),
  );
  assert.deepEqual(added.data, {
    action: "register",
    key: "компакт",
    configPath: f.registry.configPath,
    entry: { path: "a" },
  });
  assert.equal(
    f.wire.at(-1)!.path,
    "/api/v1/projects/%D0%BA%D0%BE%D0%BC%D0%BF%D0%B0%D0%BA%D1%82/registration",
  );
  assert.ok(f.wire.at(-1)!.bytes < 500);
  const legacy = successful(
    await invoke<ServerContextResponse>(f.cwd, [
      "workspace",
      "project",
      "add",
      "legacy",
      "b",
      ...f.args,
    ]),
  );
  assert.equal(legacy.data.projects.length, 25);
  assert.equal(f.wire.at(-1)!.path, "/api/v1/projects/legacy");
  const human = await invokeRaw(f.cwd, ["workspace", "project", "add", "human", "a", ...f.args]);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Регистрация проекта сохранена/);
  assert.equal(f.wire.at(-1)!.path, "/api/v1/projects/human/registration");
  assert.ok(f.wire.at(-1)!.bytes < 500);
  for (const removed of [true, false]) {
    const result = successful(
      await invoke<any>(f.cwd, [
        "workspace",
        "project",
        "remove",
        "компакт",
        "--projection",
        "compact",
        ...f.args,
      ]),
    );
    assert.equal(result.data.removed, removed);
    assert.equal(result.data.projects, undefined);
    assert.ok(f.wire.at(-1)!.bytes < 500);
  }
  const legacyRemoval = successful(
    await invoke<ServerContextResponse>(f.cwd, [
      "workspace",
      "project",
      "remove",
      "legacy",
      ...f.args,
    ]),
  );
  assert.equal(legacyRemoval.data.projects.length, 24);
  assert.equal(f.wire.at(-1)!.path, "/api/v1/projects/legacy");
  assert.ok(await readFile(f.a.configPath));
  for (const key of ["page", "registration"]) {
    const saved = successful(
      await invoke<ServerContextResponse>(f.cwd, [
        "workspace",
        "project",
        "add",
        key,
        "a",
        ...f.args,
      ]),
    );
    assert.equal(
      saved.data.projects.length,
      25,
      "Служебное имя маршрута не меняет DTO прежней мутации",
    );
    const removed = successful(
      await invoke<ServerContextResponse>(f.cwd, [
        "workspace",
        "project",
        "remove",
        key,
        ...f.args,
      ]),
    );
    assert.equal(removed.data.projects.length, 24);
  }
});

test("WSP-08 HTTP CLI: old Server даёт понятный capability-отказ до страницы/записи без fallback", async (t) => {
  const f = await setup(t, 1);
  for (const old of [true, false]) {
    f.control.old = old;
    f.control.noCapability = !old;
    for (const args of [
      ["list"],
      ["add", "new", "a", "--projection", "compact"],
      ["remove", "p-0", "--projection", "compact"],
    ]) {
      f.wire.length = 0;
      const result = await invoke(f.cwd, ["workspace", "project", ...args, ...f.args]);
      failed(result, "SERVER_INCOMPATIBLE", 5);
      assert.match(result.stdout, /relay-project-catalog-v1/);
      assert.deepEqual(
        f.wire.map((item) => item.path),
        ["/api/v1/server/capabilities"],
      );
    }
  }
  f.wire.length = 0;
  successful(await invoke(f.cwd, ["workspace", "project", "add", "legacy", "a", ...f.args]));
  assert.deepEqual(
    f.wire.map((item) => item.path),
    ["/api/v1/projects/legacy"],
    "Прежний default JSON не требует новой capability",
  );
  const human = await invokeRaw(f.cwd, [
    "workspace",
    "project",
    "remove",
    "legacy",
    "--projection",
    "full",
    ...f.args,
  ]);
  assert.equal(human.code, 0, human.stdout);
  const api = createServerApi(f.proxy.url);
  await assert.rejects(api.projects.getProjectCatalogPage(), { code: "SERVER_INCOMPATIBLE" });
  delete f.control.old;
  delete f.control.noCapability;
  f.wire.length = 0;
  await api.projects.getProjectCatalogPage();
  await api.projects.getProjectCatalogPage();
  assert.equal(
    f.wire.filter((item) => item.path === "/api/v1/server/capabilities").length,
    1,
    "Новый явный вызов восстанавливается; успешная capability кешируется в экземпляре",
  );
});

test("WSP-02/08 HTTP CLI: malformed page/receipts отвергаются, потеря compact ответа не повторяет мутацию", async (t) => {
  const f = await setup(t, 2);
  const valid = (await createServerApi(f.server.url).projects.getProjectCatalogPage({ limit: 1 }))
    .data;
  for (const override of [
    { ok: false, error: { code: "BROKEN", message: "не успех" } },
    { ok: true, data: { ...valid, total: "2" } },
    { ok: true, data: { ...valid, catalog: { ...valid.catalog, configPath: undefined } } },
    {
      ok: true,
      data: {
        ...valid,
        catalog: {
          ...valid.catalog,
          projects: [{ ...valid.catalog.projects[0], available: "false" }],
        },
      },
    },
    { ok: true, data: { ...valid, nextOffset: 0 } },
  ]) {
    f.control.override = override;
    failed(
      await invoke(f.cwd, ["workspace", "project", "list", "--limit", 1, ...f.args]),
      "INVALID_SERVER_RESPONSE",
      5,
    );
  }
  delete f.control.override;
  for (const operation of ["add", "remove"] as const) {
    for (const fault of ["malformed", "drop"] as const) {
      if (operation === "remove")
        await registerProject(f.registry.configPath, "target", { path: "a" });
      const method = operation === "add" ? "PUT" : "DELETE";
      f.control.fault = fault;
      f.control.faultMethod = method;
      f.control.override = {
        ok: true,
        data:
          operation === "add"
            ? { action: "register", key: "target", configPath: f.registry.configPath, entry: {} }
            : {
                action: "unregister",
                key: "target",
                configPath: f.registry.configPath,
                removed: "false",
              },
      };
      f.wire.length = 0;
      const result = await invoke(f.cwd, [
        "workspace",
        "project",
        operation,
        "target",
        ...(operation === "add" ? ["a"] : []),
        "--projection",
        "compact",
        ...f.args,
      ]);
      failed(result, fault === "drop" ? "SERVER_UNAVAILABLE" : "INVALID_SERVER_RESPONSE", 5);
      assert.match(result.stdout, /Запись могла завершиться/);
      assert.equal(f.wire.filter((item) => item.method === method).length, 1);
      delete f.control.fault;
      delete f.control.override;
      const read = successful(
        await invoke<ServerContextResponse>(f.cwd, ["workspace", "project", "list", ...f.args]),
      );
      assert.equal(
        read.data.projects.some((item) => item.key === "target"),
        operation === "add",
      );
    }
  }
});
