import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { ProjectSettings } from "@relay/contracts/entities/project-settings";
import type { Config } from "@relay/core/domain/config";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
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
import { shellCommand } from "../src/command-kit.js";

const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli"));
const projectData = (entity: EntityDetail) => {
  assert.equal(entity.data.kind, "project");
  if (entity.data.kind !== "project") throw new Error("Ожидался проект");
  return entity.data;
};

/** Баш исполняет буквальную подсказку; заменяется лишь npx, без сети и выбора npm-версии. */
async function replay(cwd: string, command: string) {
  assert.doesNotMatch(command, /[\r\n]/);
  return promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `launcher=("$@"); npx() { test "$1" = '@oim-dev/relay-cli' || return 90; shift; "\${launcher[@]}" "$@"; };\n${command}`,
      "--",
      process.execPath,
      ...cliNodeArgs,
      binary,
    ],
    { cwd, env: cliEnv(), timeout: 30000 },
  );
}

test("project: local slug/rename, исходная CAS, alias/ID и совместимый JSON имени", async (t) => {
  const app = await fixture(t);
  const before = successful(await app.run<EntityDetail>(["project", "get"])).data;
  const settings = successful(
    await app.run<ProjectSettings>([
      "project",
      "update",
      "--slug",
      "new-local-slug",
      "--if-revision",
      before.revision,
    ]),
  ).data;
  assert.equal(settings.name, projectData(before).name);
  assert.equal(settings.slug, "new-local-slug");
  assert.equal(settings.revision, before.revision + 1);
  assert.equal("requestId" in settings, false);
  const noOp = successful(
    await app.run<ProjectSettings>([
      "project",
      "update",
      "--slug",
      settings.slug,
      "--name",
      settings.name,
      "--if-revision",
      before.revision,
    ]),
  ).data;
  assert.deepEqual(noOp, settings, "совпадающая пара возвращает настройки без новой записи");
  const current = successful(await app.run<EntityDetail>(["project", "get"])).data;
  assert.deepEqual(current.ref, before.ref);
  assert.deepEqual(projectData(current).documentSections, projectData(before).documentSections);
  failed(
    await app.run([
      "project",
      "update",
      "--slug",
      "must-not-save",
      "--if-revision",
      before.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  const config = successful(await app.run<Config>(["config", "get"])).data;
  assert.equal(config.projectSettings?.slug, settings.slug);
  assert.equal(config.projectSettings?.revision, settings.revision);
  assert.equal(config.projectId, before.ref.id);
  const saved = successful(
    await app.run<EntitySaved>([
      "project",
      "rename",
      "PROJECT-LOCAL",
      "--if-revision",
      current.revision,
      "--request-id",
      "rename-local",
    ]),
  ).data;
  assert.equal(saved.action, "rename");
  assert.equal(saved.requestId, "rename-local");
  assert.deepEqual(saved.ref, before.ref);
  assert.equal(saved.key, "PROJECT-LOCAL");
  const renamed = successful(await app.run<EntityDetail>(["project", "get"])).data;
  assert.deepEqual(projectData(renamed), projectData(current));
  assert.equal(renamed.key, saved.key);
  for (const address of ["PROJECT", "PROJECT-LOCAL", `project:${before.ref.id}`]) {
    const resolved = successful(
      await app.run<{ ref: unknown; key: string }>(["inspect", "resolve", address]),
    ).data;
    assert.deepEqual(resolved.ref, before.ref);
    assert.equal(resolved.key, saved.key);
  }
  const keys = successful(await app.run<any>(["inspect", "keys", "PROJECT", "--limit", 1]));
  assert.equal(keys.meta!.page!.total, 2);
  assert.ok(keys.meta!.page!.nextCommand);
  const second = JSON.parse((await replay(app.root, keys.meta!.page!.nextCommand!)).stdout);
  assert.equal(second.meta.page.nextCursor, null);
  failed(
    await app.run(["project", "rename", "PROJECT-STALE", "--if-revision", current.revision]),
    "REVISION_CONFLICT",
    4,
  );
  successful(await app.run(["document", "create", "--name", "Коллизия", "--body", "Текст"]));
  const collision = await app.run([
    "project",
    "rename",
    "DOC-1",
    "--if-revision",
    renamed.revision,
  ]);
  assert.equal(collision.body.ok, false, collision.stdout);
  assert.match(collision.stdout, /KEY|ключ/i);
  assert.deepEqual(successful(await app.run(["project", "get"])).data, renamed);
  const name = successful(
    await app.run<EntitySaved>([
      "project",
      "update",
      "--name",
      "  Принятое имя 🧪 東京  ",
      "--if-revision",
      renamed.revision,
      "--request-id",
      "name-compatible",
    ]),
  ).data;
  assert.equal(name.action, "update");
  assert.equal(name.requestId, "name-compatible");
  assert.equal(name.key, "PROJECT-LOCAL");
  assert.equal(
    projectData(successful(await app.run<EntityDetail>(["project", "get"])).data).slug,
    settings.slug,
  );
});

test("project: нормализованная квитанция inline/file/stdin и ошибки до мутации", async (t) => {
  const app = await fixture(t);
  const nameFile = join(app.root, "имя.txt");
  await writeFile(nameFile, "  Имя Ω\n");
  for (const source of [
    ["--name", "  Имя Ω  "],
    ["--name-file", nameFile],
    ["--name-file", "-"],
  ]) {
    const before = successful(await app.run<EntityDetail>(["project", "get"])).data;
    const result = await invokeRaw(
      app.root,
      ["project", "update", ...source, "--if-revision", before.revision],
      { input: "  Имя Ω\n" },
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n")[0], "✓ Название проекта изменено: PROJECT — Имя Ω");
    assert.equal(
      projectData(successful(await app.run<EntityDetail>(["project", "get"])).data).name,
      "Имя Ω",
    );
    assert.deepEqual(hints(result.stdout), []);
    assert.match(
      (await replay(app.root, "npx @oim-dev/relay-cli project get")).stdout,
      /PROJECT — Имя Ω/,
    );
  }
  const before = successful(await app.run<EntityDetail>(["project", "get"])).data;
  for (const args of [
    ["--slug", "Bad Slug"],
    ["--slug", " good-slug "],
    ["--slug", "x"],
    ["--slug", "good-slug", "--name", "Внутри\nперенос"],
    ["--slug", "good-slug", "--name", "Управление\u001b"],
    ["--slug", "good-slug", "--name-file", "absent.txt"],
    ["--slug", "good-slug", "--name", "x", "--name-file", "-"],
    ["--slug", "good-slug", "--request-id", "cannot-ignore"],
    ["--slug-file", nameFile],
  ]) {
    const invalid = await app.run(
      ["project", "update", ...args, "--if-revision", before.revision],
      { input: "Файл" },
    );
    assert.notEqual(invalid.code, 0, invalid.stdout);
    assert.equal(invalid.stderr, "");
    assert.equal(invalid.body.ok, false);
    assert.deepEqual(successful(await app.run(["project", "get"])).data, before);
  }
  failed(
    await app.run(["project", "update", "--slug", "good-slug", "--if-revision", before.revision], {
      env: { RELAY_ACTOR: undefined },
    }),
    "ACTOR_REQUIRED",
  );
  failed(
    await app.run(
      [
        "project",
        "update",
        "--slug",
        "good-slug",
        "--name-file",
        "-",
        "--if-revision",
        before.revision,
      ],
      { input: Buffer.from([0xff]) },
    ),
    "INVALID_UTF8",
  );
  assert.deepEqual(successful(await app.run(["project", "get"])).data, before);
  const both = await invokeRaw(
    app.root,
    [
      "project",
      "update",
      "--slug",
      "both-slug",
      "--name-file",
      "-",
      "--if-revision",
      before.revision,
    ],
    { input: "  Новое имя 🧪\n" },
  );
  assert.equal(both.code, 0, both.stdout);
  assert.equal(both.stderr, "");
  assert.match(both.stdout, /✓ Настройки проекта сохранены: Новое имя 🧪/);
  assert.match(both.stdout, /Slug:\s+both-slug/);
  const after = successful(await app.run<EntityDetail>(["project", "get"])).data;
  assert.equal(projectData(after).name, "Новое имя 🧪");
  assert.equal(projectData(after).slug, "both-slug");
});

test(
  "project: конкурентная запись до EOF stdin сохраняется, исходная ревизия не подменяется",
  { timeout: 30_000 },
  async (t) => {
    const app = await fixture(t);
    const backend = await createLocalBackend(app.root);
    const before = await backend.projectSettings.get();
    const child = spawn(
      process.execPath,
      [
        ...cliNodeArgs,
        binary,
        "--format",
        "json",
        "project",
        "update",
        "--name-file",
        "-",
        "--slug",
        "stdin-slug",
        "--if-revision",
        String(before.revision),
      ],
      { cwd: app.root, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    child.stdin.write("  Задержанный ввод");
    const concurrent = await backend.projectSettings.save({
      name: "Конкурентное имя",
      slug: before.slug,
      ifRevision: before.revision,
    });
    child.stdin.end("  \n");
    assert.equal(await completed, 4, Buffer.concat(output).toString());
    assert.equal(Buffer.concat(errors).toString(), "");
    assert.match(Buffer.concat(output).toString(), /REVISION_CONFLICT/);
    assert.deepEqual(await backend.projectSettings.get(), concurrent);
  },
);

test("project: 0/5/25/100 разделов, Unicode 24/40/100, JSON полный, Bash-переходы и страницы", async (t) => {
  const app = await fixture(t);
  const backend = await createLocalBackend(app.root);
  const config = join(app.root, ".relay/config.json");
  // Реальный путь с пробелами/апострофом для всех копируемых команд.
  const quoted = join(app.root, "проект с 'кавычкой", ".relay/config.json");
  // Инициализируем независимую базу, не копируем конфиг поверх живой базы.
  successful(await invoke(app.root, ["--config", quoted, "init"]));
  const selected = await createLocalBackend(app.root, quoted);
  const first = await backend.entities.get({ ref: "PROJECT", kind: "project" });
  assert.equal((projectData(first).documentSections ?? defaultDocumentSections).length, 5);
  let stale: string | undefined;
  for (const count of [0, 5, 25, 100]) {
    const sections = Array.from({ length: count }, (_, index) => ({
      id: `sec-${index + 1}`,
      name: `Похожее имя 🧪 東京 — ${index + 1}`,
    }));
    const before = await selected.entities.get({ ref: "PROJECT", kind: "project" });
    await selected.entities.update(
      {
        ref: "PROJECT",
        changes: { kind: "project", name: "Проект Ω 🧪 東京", documentSections: sections },
        ifRevision: before.revision,
        requestId: `sections-${count}`,
      },
      "test-agent",
    );
    const prefix = ["--config", quoted, "--local"];
    const json = successful(
      await invoke<EntityDetail>(app.root, [...prefix, "project", "get"]),
    ).data;
    assert.deepEqual(json, await selected.entities.get({ ref: "PROJECT", kind: "project" }));
    assert.deepEqual(projectData(json).documentSections, sections);
    for (const width of [24, 40, 100]) {
      const human = await invokeRaw(app.root, [...prefix, "project", "get"], {
        env: { COLUMNS: String(width), FORCE_COLOR: "3" },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.doesNotMatch(human.stdout, /\u001b|sec-\d/);
      assert.match(human.stdout, new RegExp(`Разделов документов:\\s+${count}\\b`));
      assert.ok(human.stdout.split("\n").length < 30, human.stdout);
      assert.equal(hints(human.stdout).length, 0);
      if (width === 24) {
        const listed = await invokeRaw(app.root, [...prefix, "document", "section", "list"]);
        assert.equal(listed.stderr, "");
        const docs = await invokeRaw(app.root, [
          ...prefix,
          "document",
          "list",
          "--section",
          sections[0]?.id ?? "none",
        ]);
        assert.equal(docs.stderr, "");
        assert.match(docs.stdout, /Документ|документ/);
      }
    }
    if (stale)
      failed(
        await invoke(app.root, [...prefix, "document", "section", "list", "--cursor", stale]),
        "VERSION_CONFLICT",
      );
    let page = successful(
      await invoke<any>(app.root, [...prefix, "document", "section", "list", "--limit", 7]),
    );
    const actual = [...page.data.items];
    stale = page.meta!.page!.nextCursor ?? undefined;
    while (page.meta!.page!.nextCommand) {
      page = JSON.parse((await replay(app.root, page.meta!.page!.nextCommand)).stdout);
      actual.push(...page.data.items);
    }
    assert.deepEqual(actual, sections);
    assert.equal(page.meta!.page!.total, count);
  }
  // Выбор через env не добавляет меню команд в карточку.
  const env = await invokeRaw(app.root, ["project", "get"], {
    env: { RELAY_CONFIG: quoted, COLUMNS: "24" },
  });
  assert.equal(env.code, 0, env.stdout);
  assert.deepEqual(hints(env.stdout), []);
  const ordinary = await invokeRaw(app.root, ["--config", config, "project", "get"]);
  assert.equal(ordinary.code, 0);
});

test("project: HTTP settings/rename без лишнего get и retry; CAS между чтением и записью", async (t) => {
  const app = await fixture(t);
  const backend = await createLocalBackend(app.root);
  const server = await httpServer(t, app.root);
  const calls: { method: string; path: string; body?: any }[] = [];
  let race = false;
  let lose = false;
  const proxy = await httpProxy(t, async (request, response, signal) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    calls.push({
      method: request.method!,
      path: new URL(request.url!, server.url).pathname,
      ...(body.length ? { body: JSON.parse(body.toString()) } : {}),
    });
    const upstream = await fetch(`${server.url}${request.url}`, {
      signal,
      method: request.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(body.length ? { body } : {}),
    });
    const text = await upstream.text();
    if (race && request.method === "GET" && request.url!.endsWith("/context/settings")) {
      race = false;
      const current = await backend.projectSettings.get();
      await backend.projectSettings.save({
        name: "Конкурент 🧪",
        slug: current.slug,
        ifRevision: current.revision,
      });
    }
    if (lose && ["PUT", "POST"].includes(request.method!)) {
      lose = false;
      assert.equal(upstream.status, 200, text);
      response.destroy();
      return;
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(text);
  });
  const remote = <T = unknown>(args: Array<string | number>) =>
    app.run<T>(["--server-url", proxy.url, ...args]);
  const before = successful(await remote<EntityDetail>(["project", "get"])).data;
  calls.length = 0;
  const settings = successful(
    await remote<ProjectSettings>([
      "project",
      "update",
      "--slug",
      "http-slug",
      "--if-revision",
      before.revision,
    ]),
  ).data;
  assert.equal(settings.name, projectData(before).name);
  assert.deepEqual(
    calls.map(({ method, path }) => [method, path.split("/").slice(-2).join("/")]),
    [
      ["GET", `${before.ref.id}/context`],
      ["GET", "context/settings"],
      ["PUT", "context/settings"],
    ],
  );
  assert.deepEqual(calls.at(-1)!.body, {
    name: settings.name,
    slug: "http-slug",
    ifRevision: before.revision,
  });
  assert.deepEqual(
    projectData(successful(await remote<EntityDetail>(["project", "get"])).data).documentSections,
    projectData(before).documentSections,
  );
  const config = successful(await remote<Config>(["config", "get"])).data;
  assert.equal(config.projectSettings?.slug, settings.slug);
  assert.equal(config.projectSettings?.revision, settings.revision);
  assert.equal(config.projectId, before.ref.id);
  calls.length = 0;
  const both = successful(
    await remote<ProjectSettings>([
      "project",
      "update",
      "--name",
      "  Принято по HTTP  ",
      "--slug",
      "http-both",
      "--if-revision",
      settings.revision,
    ]),
  ).data;
  assert.equal(both.name, "Принято по HTTP");
  assert.equal(calls.length, 2, "context + save, нет get ради имени/квитанции");
  assert.equal(calls[1]!.method, "PUT");
  calls.length = 0;
  const invalid = await remote([
    "project",
    "update",
    "--slug",
    "bad slug",
    "--if-revision",
    both.revision,
  ]);
  assert.equal(invalid.body.ok, false, invalid.stdout);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["GET"],
    "неверный ввод: только подключение, без предметного чтения/записи",
  );
  calls.length = 0;
  const receipt = await invokeRaw(app.root, [
    "--server-url",
    proxy.url,
    "project",
    "update",
    "--name",
    "  Только имя  ",
    "--if-revision",
    both.revision,
  ]);
  assert.equal(receipt.code, 0, receipt.stdout);
  assert.equal(receipt.stderr, "");
  assert.match(receipt.stdout, /PROJECT — Только имя\n/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.changes.name, "Только имя");
  let current = await backend.projectSettings.get();
  calls.length = 0;
  race = true;
  failed(
    await remote(["project", "update", "--slug", "do-not-save", "--if-revision", current.revision]),
    "REVISION_CONFLICT",
    4,
  );
  assert.equal(calls.filter(({ method }) => method === "PUT").length, 1);
  assert.equal(calls.at(-1)!.body.ifRevision, current.revision);
  assert.equal((await backend.projectSettings.get()).name, "Конкурент 🧪");
  assert.equal((await backend.projectSettings.get()).slug, "http-both");
  current = await backend.projectSettings.get();
  calls.length = 0;
  lose = true;
  failed(
    await remote(["project", "update", "--slug", "saved-lost", "--if-revision", current.revision]),
    "SERVER_UNAVAILABLE",
    5,
  );
  assert.equal(calls.filter(({ method }) => method === "PUT").length, 1);
  const afterLost = successful(await remote<EntityDetail>(["project", "get"])).data;
  assert.equal(projectData(afterLost).slug, "saved-lost");
  assert.equal(afterLost.revision, current.revision + 1);
  calls.length = 0;
  lose = true;
  failed(
    await remote(["project", "rename", "PROJECT-HTTP", "--if-revision", afterLost.revision]),
    "SERVER_UNAVAILABLE",
    5,
  );
  assert.equal(calls.length, 2, "context + rename, ни get, ни повторного POST");
  assert.equal(calls[1]!.method, "POST");
  const renamed = successful(await remote<EntityDetail>(["project", "get"])).data;
  assert.equal(renamed.key, "PROJECT-HTTP");
  assert.deepEqual(renamed.ref, before.ref);
  const old = successful(await remote<any>(["inspect", "resolve", "PROJECT"])).data;
  assert.equal(old.key, renamed.key);
  assert.deepEqual(old.ref, renamed.ref);
  successful(await app.run(["document", "create", "--name", "Занятый ключ", "--body", "Текст"]));
  calls.length = 0;
  const collision = await remote(["project", "rename", "DOC-1", "--if-revision", renamed.revision]);
  assert.equal(collision.body.ok, false, collision.stdout);
  assert.match(collision.stdout, /KEY|ключ/i);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  failed(
    await remote(["project", "rename", "PROJECT-STALE", "--if-revision", afterLost.revision]),
    "REVISION_CONFLICT",
    4,
  );
  assert.deepEqual(successful(await remote(["project", "get"])).data, renamed);
});

test("project: workspace slug/rename сохраняют регистрацию, соседний проект и Bash-подсказки", async (t) => {
  const alpha = await fixture(t);
  const beta = await fixture(t);
  const root = await tempDirectory(t);
  successful(await invoke(root, ["workspace", "project", "init"]));
  const server = await httpServer(t, root);
  const configPath = join(root, "relay.workspace.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, server: { port: 0, url: server.url } }));
  for (const [key, app] of [
    ["alpha", alpha],
    ["beta", beta],
  ] as const)
    successful(await invoke(root, ["workspace", "project", "add", key, app.root]));
  const registry = await readFile(configPath, "utf8");
  const bBefore = successful(await beta.run(["project", "get"])).data;
  const before = successful(
    await invoke<EntityDetail>(root, ["--project", "alpha", "project", "get"]),
  ).data;
  const settings = successful(
    await invoke<ProjectSettings>(root, [
      "--project",
      "alpha",
      "project",
      "update",
      "--slug",
      "workspace-slug",
      "--if-revision",
      before.revision,
    ]),
  );
  assert.equal(settings.meta!.project, "alpha");
  assert.equal(settings.data.name, projectData(before).name);
  const renamed = await invokeRaw(
    root,
    ["alpha", "project", "rename", "PROJECT-WORKSPACE", "--if-revision", settings.data.revision],
    { env: { COLUMNS: "24" } },
  );
  assert.equal(renamed.code, 0, renamed.stdout);
  assert.equal(renamed.stderr, "");
  assert.deepEqual(hints(renamed.stdout), []);
  const hint = shellCommand([
    "npx",
    "@oim-dev/relay-cli",
    "--server-url",
    server.url,
    "--project",
    "alpha",
    "project",
    "get",
  ]);
  const followed = await replay(root, hint);
  assert.match(followed.stdout, /PROJECT-WORKSPACE/);
  assert.equal(followed.stderr, "");
  const sectionList = await invokeRaw(root, ["alpha", "document", "section", "list"]);
  assert.equal(sectionList.stderr, "");
  assert.deepEqual(hints(sectionList.stdout), []);
  const firstPage = successful(
    await invoke<any>(root, ["--project", "alpha", "document", "section", "list", "--limit", 2]),
  );
  const nextPage = JSON.parse((await replay(root, firstPage.meta!.page!.nextCommand!)).stdout);
  assert.equal(nextPage.meta.project, "alpha");
  assert.equal(nextPage.meta.page.count, 2);
  assert.equal(nextPage.meta.page.total, 5);
  const current = successful(
    await invoke<EntityDetail>(root, ["--project", "alpha", "project", "get"]),
  ).data;
  assert.deepEqual(current.ref, before.ref);
  assert.equal(projectData(current).slug, "workspace-slug");
  assert.equal(projectData(current).name, projectData(before).name);
  const alias = successful(
    await invoke<any>(root, ["alpha", "inspect", "resolve", "PROJECT"]),
  ).data;
  assert.deepEqual(alias.ref, before.ref);
  assert.equal(alias.key, "PROJECT-WORKSPACE");
  successful(
    await invoke(root, ["alpha", "document", "create", "--name", "Коллизия", "--body", "Текст"]),
  );
  const collision = await invoke(root, [
    "alpha",
    "project",
    "rename",
    "DOC-1",
    "--if-revision",
    current.revision,
  ]);
  assert.equal(collision.body.ok, false, collision.stdout);
  assert.match(collision.stdout, /KEY|ключ/i);
  failed(
    await invoke(root, [
      "alpha",
      "project",
      "update",
      "--slug",
      "no-overwrite",
      "--if-revision",
      before.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  assert.equal(await readFile(configPath, "utf8"), registry);
  assert.deepEqual(successful(await beta.run(["project", "get"])).data, bBefore);
  const remoteOnly = await tempDirectory(t);
  const selectedById = successful(
    await invoke<EntityDetail>(remoteOnly, [
      "--server-url",
      server.url,
      "--project",
      before.ref.id,
      "project",
      "get",
    ]),
  ).data;
  assert.deepEqual(selectedById, current);
  const selectedBySlug = successful(
    await invoke<EntityDetail>(remoteOnly, [
      "--server-url",
      server.url,
      "--project",
      "workspace-slug",
      "project",
      "get",
    ]),
  ).data;
  assert.deepEqual(selectedBySlug, current);
  assert.notEqual(
    (
      await invoke(remoteOnly, [
        "--server-url",
        server.url,
        "--project",
        projectData(before).slug,
        "project",
        "get",
      ])
    ).code,
    0,
    "старый slug не становится алиасом",
  );
  const bySlug = await invokeRaw(
    remoteOnly,
    [
      "--server-url",
      server.url,
      "--project",
      "workspace-slug",
      "project",
      "update",
      "--slug",
      "workspace-next",
      "--name",
      "Новое имя",
      "--if-revision",
      current.revision,
    ],
    { env: { COLUMNS: "24" } },
  );
  assert.equal(bySlug.code, 0, bySlug.stdout);
  assert.equal(bySlug.stderr, "");
  assert.deepEqual(hints(bySlug.stdout), []);
  const stable = shellCommand([
    "npx",
    "@oim-dev/relay-cli",
    "--server-url",
    server.url,
    "--project",
    before.ref.id,
    "project",
    "get",
  ]);
  const readStable = await replay(remoteOnly, stable);
  assert.match(readStable.stdout, /workspace-next/);
  assert.equal(readStable.stderr, "");
  assert.deepEqual(successful(await beta.run(["project", "get"])).data, bBefore);
});

test("project: CONFIG_NOT_FOUND и явный missing config отличаются от адреса записи; help без базы", async (t) => {
  const root = await tempDirectory(t);
  for (const args of [
    ["project"],
    ["project", "get", "--help"],
    ["project", "update", "--help"],
    ["project", "rename", "--help"],
  ]) {
    const help = await invokeRaw(root, args);
    assert.equal(help.code, 0, help.stdout + help.stderr);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /slug/);
  }
  const missing = await invokeRaw(root, ["project", "get"]);
  assert.equal(missing.code, 2, missing.stdout);
  assert.equal(missing.stderr, "");
  assert.match(missing.stdout, /CONFIG_NOT_FOUND/);
  assert.match(missing.stdout, /текущий каталог/);
  assert.match(missing.stdout, /заведомо нового проекта/);
  assert.doesNotMatch(missing.stdout, /Проверьте ключ записи/);
  const path = join(root, "missing config.json");
  for (const options of [
    { args: ["--config", path], env: {} },
    { args: [], env: { RELAY_CONFIG: path } },
  ]) {
    const explicit = await invokeRaw(root, [...options.args, "project", "get"], {
      env: options.env,
    });
    assert.equal(explicit.code, 3, explicit.stdout);
    assert.equal(explicit.stderr, "");
    assert.match(explicit.stdout, /явно выбранный путь/);
    assert.doesNotMatch(explicit.stdout, /Проверьте ключ записи/);
    failed(
      await invoke(root, [...options.args, "project", "get"], { env: options.env }),
      "NOT_FOUND",
      3,
    );
  }
  assert.deepEqual(await readdir(root), []);
  const app = await fixture(t);
  const absent = await invokeRaw(app.root, ["inspect", "resolve", "DOES-NOT-EXIST"]);
  assert.notEqual(absent.code, 0);
  assert.match(absent.stdout, /Проверьте ключ записи/);
});
