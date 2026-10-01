import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, invoke, invokeRaw, successful, failed, tempDirectory } from "./helpers/cli.js";
import { httpServer, httpProxy } from "./helpers/http.js";

test("workspace remove отсутствующего имени: нейтральная квитанция, каталог и файлы сохранены без pre-read", async (t) => {
  const app = await fixture(t);
  await app.create("Данные зарегистрированного проекта");
  const root = await tempDirectory(t);
  successful(await invoke(root, ["workspace", "project", "init"]));
  const server = await httpServer(t, root);
  const configPath = join(root, "relay.workspace.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, server: { port: 0, url: server.url } }));
  successful(await invoke(root, ["workspace", "project", "add", "existing", app.root]));
  const catalog = successful(await invoke(root, ["workspace", "project", "list"])).data;
  const registry = JSON.parse(await readFile(configPath, "utf8"));
  const snapshot = async () => {
    const result: Record<string, string> = {};
    const walk = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${name}/`);
        else result[name] = (await readFile(join(directory, entry.name))).toString("base64");
      }
    };
    await walk(join(app.root, ".relay"), "");
    return result;
  };
  const files = await snapshot();
  const requests: string[] = [];
  const proxy = await httpProxy(t, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const upstream = await fetch(`${server.url}${request.url}`, {
      method: request.method ?? "GET",
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(body);
  });
  const human = await invokeRaw(
    root,
    ["--server-url", proxy.url, "workspace", "project", "remove", "never-registered"],
    {
      env: { FORCE_COLOR: "1", NO_COLOR: undefined },
    },
  );
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.equal(human.stderr, "");
  assert.deepEqual(
    requests,
    ["DELETE /api/v1/projects/never-registered"],
    "нейтральная квитанция не требует дополнительного чтения перед DELETE",
  );
  assert.deepEqual(successful(await invoke(root, ["workspace", "project", "list"])).data, catalog);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), registry);
  assert.deepEqual(await snapshot(), files);
  assert.match(human.stdout, /never-registered/);
  assert.doesNotMatch(human.stdout, /\u001b/);
  assert.doesNotMatch(
    human.stdout,
    /регистраци[яю]\s+(?:(?:проекта|только)\s+)?удалена|удалена\s+(?:только\s+)?регистрация/i,
    "успешный DELETE не доказывает, что запись существовала и была удалена",
  );
  assert.match(
    human.stdout,
    /отсутствует|не зарегистрирован|запрос[^\n]*выполнен|снят[оа]|обработан/i,
    "квитанция сообщает постусловие либо обработку запроса, не выдуманное изменение",
  );
});

test("HTTP/local golden: проект, конфиг, задача, граф, doctor, автор и requestId", async (t) => {
  const app = await fixture(t);
  await app.create("Задача HTTP", ["--description", "## Цель\n\n  отступы  \n"]);
  const server = await httpServer(t, app.root);
  const empty = await tempDirectory(t);
  const remote = <T = any>(args: Array<string | number>) =>
    invoke<T>(empty, ["--server-url", server.url, ...args]);
  for (const args of [
    ["project", "get"],
    ["config", "get"],
    ["task", "get", "PRODUCT-1"],
    ["inspect", "graph", "context", "PRODUCT-1"],
    ["doctor", "check"],
  ]) {
    const local = successful(await app.run(args));
    const http = successful(await remote(args));
    assert.deepEqual(http.data, local.data, args.join(" "));
  }
  const before = successful(await remote(["project", "get"])).data;
  const receipt = successful(
    await remote([
      "project",
      "update",
      "--name",
      "HTTP проект",
      "--if-revision",
      before.revision,
      "--request-id",
      "http-project",
      "--actor",
      "Автор HTTP",
    ]),
  ).data;
  assert.equal(receipt.requestId, "http-project");
  const after = successful(await app.run<any>(["project", "get"])).data;
  assert.equal(after.data.name, "HTTP проект");
  assert.equal(after.revision, before.revision + 1);
  failed(
    await remote(["project", "update", "--name", "Устарело", "--if-revision", before.revision]),
    "REVISION_CONFLICT",
    4,
  );
  successful(
    await remote([
      "task",
      "update",
      "PRODUCT-1",
      "--title",
      "Из HTTP",
      "--if-revision",
      1,
      "--actor",
      "Автор HTTP",
      "--request-id",
      "http-task",
    ]),
  );
  const task = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data;
  assert.equal(task.updatedBy, "Автор HTTP");
  assert.equal(task.revision, 2);
  assert.equal(task.description, "## Цель\n\n  отступы  \n");
  const graph = successful(await remote(["inspect", "graph", "list"])).data;
  const linked = successful(
    await remote([
      "doctor",
      "graph",
      "link",
      "--from",
      "PROJECT",
      "--to",
      "PRODUCT-1",
      "--type",
      "http-example",
      "--if-version",
      graph.version,
      "--request-id",
      "http-edge",
    ]),
  ).data;
  assert.equal(linked.requestId, "http-edge");
  const context = successful(await remote(["inspect", "graph", "context", "PRODUCT-1"])).data;
  assert.equal(context.complete, true);
  assert.ok(context.edges.some((edge: any) => edge.id === linked.ids[0] && edge.to.id === task.id));
  for (const operation of ["migrate", "reindex", "reconcile-relations"]) {
    const rejected = await remote(["storage", operation]);
    assert.equal(rejected.code, 2);
    assert.equal(rejected.stderr, "");
    assert.ok(
      !rejected.body.ok && ["LOCAL_REQUIRED", "LOCAL_ONLY"].includes(rejected.body.error.code),
      rejected.stdout,
    );
  }
  for (const args of [
    ["project", "get"],
    ["config", "get"],
    ["doctor", "check"],
    ["inspect", "graph", "context", "PRODUCT-1"],
  ]) {
    const human = await invokeRaw(empty, ["--server-url", server.url, ...args], {
      env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "24" },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    assert.doesNotMatch(human.stdout, /\u001b|"ok":true/);
    assert.ok(human.stdout.trim().length > 0);
    const hint = human.stdout.split("\n").find((line) => line.startsWith("npx @oim-dev/relay-cli"));
    assert.ok(hint?.includes("--server-url") && hint.includes(server.url), human.stdout);
    if (args[0] === "project" || args[0] === "config") {
      assert.match(human.stdout, /HTTP проект/);
      assert.match(
        human.stdout,
        new RegExp(`Ревизия(?: проекта)?:\\s+${after.revision}(?:\\s|$)`, "i"),
      );
      assert.match(human.stdout, /PROJECT/);
    } else if (args[0] === "doctor") {
      assert.match(human.stdout.replace(/\s+/g, " "), /Проверка целостности пройдена/);
      assert.match(human.stdout, /Задач:\s+1/);
      assert.match(hint!, /inspect graph list/);
    } else {
      assert.match(human.stdout, /PRODUCT-1/);
      assert.match(human.stdout, /Из HTTP/);
      assert.match(human.stdout, /http-example/);
      assert.match(human.stdout, /ревизия:\s*2/i);
      assert.match(hint!, /inspect graph list/);
    }
  }
  assert.deepEqual(await readdir(empty), [], "remote-only не создаёт локальные данные");
});

test("workspace project init/list/add/remove: изоляция, cursor fingerprint, endpoint/config и сохранность регистрации", async (t) => {
  const root = await tempDirectory(t);
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(root, name));
    successful(await invoke(join(root, name), ["init"]));
  }
  successful(await invoke(root, ["workspace", "project", "init"]));
  const server = await httpServer(t, root);
  const configPath = join(root, "relay.workspace.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, server: { port: 0, url: server.url } }));
  const run = <T = any>(args: Array<string | number>) => invoke<T>(root, args);
  for (const name of ["a", "b"])
    successful(
      await run([
        "workspace",
        "project",
        "add",
        name,
        name,
        "--project-config",
        ".relay/config.json",
      ]),
    );
  const first = successful(await run(["workspace", "project", "list", "--limit", 1]));
  assert.equal((first.meta as any).paginationSource, "client-catalog-fingerprint");
  assert.equal(first.meta?.page?.consistency, "snapshot");
  assert.equal(first.meta?.page?.total, 2);
  const cursor = first.meta!.page!.nextCursor!;
  assert.ok(cursor);
  const humanPage = await invokeRaw(root, ["workspace", "project", "list", "--limit", 1], {
    env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "24" },
  });
  assert.equal(humanPage.code, 0, humanPage.stdout);
  assert.equal(humanPage.stderr, "");
  assert.doesNotMatch(humanPage.stdout, /\u001b/);
  const hint = humanPage.stdout.split("\n").find((line) => line.includes("--cursor"));
  assert.ok(
    hint?.includes("npx @oim-dev/relay-cli") &&
      hint.includes(configPath) &&
      hint.includes(server.url) &&
      hint.includes("workspace project list"),
    humanPage.stdout,
  );
  const second = successful(await run(["workspace", "project", "list", "--cursor", cursor]));
  assert.equal(second.data.projects.length, 1);
  assert.notEqual(second.data.projects[0].key, first.data.projects[0].key);
  assert.equal(second.meta?.page?.nextCursor, null);
  const otherConfig = join(root, "other.workspace.json");
  await copyFile(configPath, otherConfig);
  failed(
    await run(["--config", otherConfig, "workspace", "project", "list", "--cursor", cursor]),
    "INVALID_CURSOR",
  );
  const otherServer = await httpServer(t, root);
  failed(
    await run([
      "--server-url",
      otherServer.url,
      "workspace",
      "project",
      "list",
      "--cursor",
      cursor,
    ]),
    "INVALID_CURSOR",
  );
  failed(await run(["--project", "a", "workspace", "project", "list"]), "INVALID_ARGUMENT");
  failed(await run(["--local", "workspace", "project", "list"]), "WORKSPACE_REQUIRES_SERVER");
  failed(await run(["project", "get"]), "PROJECT_REQUIRED");
  successful(await run(["workspace", "project", "add", "c", "c"]));
  failed(await run(["workspace", "project", "list", "--cursor", cursor]), "VERSION_CONFLICT");
  const created = successful(
    await run(["a", "task", "create", "--board", "product", "--title", "Только A"]),
  );
  assert.equal(created.meta?.project, "a");
  const task = successful(await run(["a", "task", "get", "PRODUCT-1"])).data;
  const isolated = await run(["b", "task", "get", task.id]);
  assert.equal(isolated.code, 3);
  assert.ok(!isolated.body.ok);
  const path = join(root, "a/.relay/entities/tasks", `${task.id}.json`);
  const bytes = await readFile(path, "utf8");
  const duplicate = await run(["workspace", "project", "add", "a", "b"]);
  assert.notEqual(duplicate.code, 0, "замена регистрации требует --replace");
  assert.equal(successful(await run(["a", "task", "get", task.id])).data.title, "Только A");
  const human = await invokeRaw(root, ["workspace", "project", "remove", "a"], {
    env: { FORCE_COLOR: "1", NO_COLOR: undefined },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /a/);
  assert.doesNotMatch(human.stdout, /\u001b/);
  assert.equal(await readFile(path, "utf8"), bytes);
  failed(await run(["a", "task", "get", task.id]), "PROJECT_NOT_FOUND", 3);
  successful(await run(["workspace", "project", "add", "a", "a"]));
  assert.equal(successful(await run(["a", "task", "get", task.id])).data.title, "Только A");
  const registry = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(registry.projects.b, { path: "b", config: ".relay/config.json" });
  successful(await run(["workspace", "project", "add", "task", "a"]));
  const commandNamed = successful(
    await invoke<any>(root, ["--config", configPath, "--project", "task", "task", "get", task.id], {
      env: { RELAY_CONFIG: join(root, "b/.relay/config.json") },
    }),
  );
  assert.equal(commandNamed.data.title, "Только A");
  assert.equal(commandNamed.meta?.project, "task");
  const empty = await tempDirectory(t);
  const remoteOnly = successful(
    await invoke<any>(empty, [
      "--server-url",
      server.url,
      "--project",
      "task",
      "task",
      "get",
      task.id,
    ]),
  );
  assert.equal(remoteOnly.data.id, task.id);
  assert.equal(remoteOnly.data.title, "Только A");
  assert.equal(remoteOnly.meta?.project, "task");
  assert.deepEqual(await readdir(empty), []);
});

test("HTTP выбор через env-only и server.url клиентского конфига не создаёт местную базу", async (t) => {
  const app = await fixture(t);
  await app.create("Удалённая карточка подключения", [
    "--description",
    "## Сохранённый текст\n\nБез локального fallback",
  ]);
  const expected = successful(await app.run(["task", "get", "PRODUCT-1"])).data;
  const server = await httpServer(t, app.root);
  const empty = await tempDirectory(t);
  const envOnly = successful(
    await invoke(empty, ["task", "get", "PRODUCT-1"], { env: { RELAY_SERVER_URL: server.url } }),
  );
  assert.deepEqual(envOnly.data, expected);
  assert.deepEqual(await readdir(empty), []);
  const client = await tempDirectory(t);
  await mkdir(join(client, ".relay"));
  const config = JSON.parse(await readFile(join(app.root, ".relay/config.json"), "utf8"));
  const path = join(client, ".relay/config.json");
  const bytes = JSON.stringify({ ...config, server: { port: 0, url: server.url } });
  await writeFile(path, bytes);
  const configured = successful(await invoke(client, ["task", "get", "PRODUCT-1"]));
  assert.deepEqual(configured.data, expected);
  assert.deepEqual(await readdir(client), [".relay"]);
  assert.deepEqual(await readdir(join(client, ".relay")), ["config.json"]);
  assert.equal(await readFile(path, "utf8"), bytes);
});

test("HTTP повтор одинакового комментария: два POST, два полных сообщения, ревизия задачи неизменна", async (t) => {
  const app = await fixture(t);
  await app.create("Обсуждаемая задача");
  const before = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data;
  const server = await httpServer(t, app.root);
  const writes: Array<{ path: string; body: unknown }> = [];
  const proxy = await httpProxy(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.method === "POST")
      writes.push({ path: request.url!, body: JSON.parse(body.toString()) });
    const upstream = await fetch(`${server.url}${request.url}`, {
      method: request.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(body.length ? { body } : {}),
    });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(await upstream.text());
  });
  const markdown = "## Результат\n\n  Тот же полный текст  \n";
  const command = [
    "--server-url",
    proxy.url,
    "task",
    "comment",
    "add",
    "PRODUCT-1",
    "--role",
    "worker",
    "--title",
    "Одинаковый комментарий",
    "--description",
    markdown,
    "--request-id",
    "same-comment",
    "--actor",
    "Автор обсуждения",
  ];
  const first = successful(await app.run<any>(command)).data;
  assert.equal(writes.length, 1);
  assert.equal((writes[0]!.body as { requestId: string }).requestId, "same-comment");
  assert.equal(
    successful(await app.run<any>(["--server-url", proxy.url, "task", "get", "PRODUCT-1"])).data
      .revision,
    before.revision,
  );
  const second = successful(await app.run<any>(command)).data;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0], "повторено то же тело на том же endpoint");
  assert.match(writes[0]!.path, /comments$/);
  assert.notEqual(second.commentId, first.commentId);
  for (const id of [first.commentId, second.commentId]) {
    assert.ok(id);
    const comment = successful(
      await app.run<any>(["--server-url", proxy.url, "task", "comment", "get", "PRODUCT-1", id]),
    ).data;
    assert.equal(comment.title, "Одинаковый комментарий");
    assert.equal(comment.description, markdown);
    assert.equal(comment.actor, "Автор обсуждения");
  }
  const page = successful(
    await app.run<any>(["--server-url", proxy.url, "task", "comment", "list", "PRODUCT-1"]),
  ).data;
  assert.equal(page.items.length, 2);
  assert.equal(new Set(page.items.map((entry: any) => entry.id)).size, 2);
  const after = successful(
    await app.run<any>(["--server-url", proxy.url, "task", "get", "PRODUCT-1"]),
  ).data;
  assert.equal(after.revision, before.revision);
  assert.equal(after.title, before.title);
  assert.equal(writes.length, 2, "чтения не повторяют публикацию");
});

test("HTTP cursor восстанавливает фильтры, не переносится на local; отказ сервера не открывает местную базу", async (t) => {
  const app = await fixture(t);
  await app.create("Отбор один");
  await app.create("Посторонний");
  await app.create("Отбор два");
  const server = await httpServer(t, app.root);
  const first = successful(
    await app.run<any>(["--server-url", server.url, "task", "list", "--q", "Отбор", "--limit", 1]),
  );
  const cursor = first.meta!.page!.nextCursor!;
  assert.ok(cursor);
  const next = successful(
    await app.run<any>(["--server-url", server.url, "task", "list", "--cursor", cursor]),
  );
  assert.equal(next.data.items.length, 1);
  assert.match(next.data.items[0].title, /Отбор/);
  assert.notEqual(next.data.items[0].id, first.data.items[0].id);
  failed(await app.run(["--local", "task", "list", "--cursor", cursor]), "INVALID_CURSOR");
  const denied = await httpProxy(t, async (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        error: { code: "STORAGE_READ_FAILED", message: "Тестовый отказ чтения", exitCode: 5 },
      }),
    );
  });
  const result = await app.run(["--server-url", denied.url, "task", "list"]);
  assert.equal(result.code, 5);
  assert.equal(result.stderr, "");
  assert.ok(!result.body.ok);
  assert.doesNotMatch(result.stdout, /Отбор один/);
  successful(await app.run(["--local", "task", "list"], { env: { RELAY_SERVER_URL: denied.url } }));
  const selected = successful(
    await invoke<any>(app.root, ["--server-url", server.url, "project", "get"], {
      env: { RELAY_SERVER_URL: denied.url },
    }),
  );
  assert.equal(selected.data.key, "PROJECT");
});

test("HTTP product overview: cursor по snapshotVersion, отказ сервера не выдаётся нулями", async (t) => {
  const app = await fixture(t);
  for (const name of ["Одна", "Две", "Три"])
    successful(await app.run(["feature", "create", "--name", name, "--description", "Текст"]));
  const plan = successful(
    await app.run<{ key: string }>(["plan", "create", "--title", "План", "--goal", "Цель"]),
  ).data.key;
  const server = await httpServer(t, app.root);
  const first = successful(
    await app.run<any>(["--server-url", server.url, "product", "overview", "--limit", 1]),
  );
  assert.match(first.data.snapshotVersion, /^[a-f0-9]{64}$/);
  assert.equal(first.data.snapshot.plans.byStatus.draft, 1);
  assert.match(first.data.commands.plans, new RegExp(`--server-url ${server.url} .*plan list$`));
  const cursor = first.meta!.page!.nextCursor!;
  assert.equal(
    successful(
      await app.run<any>(["--server-url", server.url, "product", "overview", "--cursor", cursor]),
    ).data.items.length,
    1,
  );
  const revision = successful(await app.run<any>(["plan", "get", plan])).data.revision;
  successful(
    await app.run([
      "--server-url",
      server.url,
      "plan",
      "update",
      plan,
      "--title",
      "Другой план",
      "--if-revision",
      revision,
    ]),
  );
  const after = successful(
    await app.run<any>(["--server-url", server.url, "product", "overview", "--limit", 1]),
  );
  assert.equal(after.data.version, first.data.version);
  assert.notEqual(after.data.snapshotVersion, first.data.snapshotVersion);
  failed(
    await app.run(["--server-url", server.url, "product", "overview", "--cursor", cursor]),
    "VERSION_CONFLICT",
  );
  const denied = await httpProxy(t, async (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        error: { code: "STORAGE_READ_FAILED", message: "Тестовый отказ чтения", exitCode: 5 },
      }),
    );
  });
  const human = await invokeRaw(app.root, ["--server-url", denied.url, "product", "overview"]);
  assert.equal(human.code, 5, human.stdout);
  assert.doesNotMatch(human.stdout, /Задач всего|Сводка|: 0/);
});

test("HTTP product overview --metric: продолжение, VERSION_CONFLICT и прежний сервер без capability", async (t) => {
  const app = await fixture(t);
  const blocker = successful(
    await app.run<{ key: string }>(["task", "create", "--board", "product", "--title", "Блокер"]),
  ).data.key;
  for (const title of ["Первая", "Вторая", "Третья"])
    successful(
      await app.run([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        title,
        "--column",
        "in-progress",
        "--dependencies",
        blocker,
      ]),
    );
  const server = await httpServer(t, app.root);
  const remote = (...args: Array<string | number>) =>
    app.run<any>(["--server-url", server.url, "product", "overview", ...args]);
  const overview = successful(await remote()).data;
  assert.equal(overview.snapshot.operator.unplannedWork.total, 3);
  const [impact] = overview.snapshot.operator.blockerImpact.items;
  assert.deepEqual([impact.key, impact.affected.total], [blocker, 3]);
  const first = successful(
    await remote("--metric", "blocker-affected", "--blocker", blocker, "--limit", 2),
  );
  assert.deepEqual([first.data.total, first.data.items.length], [3, 2]);
  assert.equal(first.data.snapshotVersion, overview.snapshotVersion);
  assert.match(
    first.meta!.page!.nextCommand!,
    new RegExp(
      `^npx @oim-dev/relay-cli --server-url ${server.url} .*--metric blocker-affected --blocker ${blocker} --cursor `,
    ),
  );
  const cursor = first.meta!.page!.nextCursor!;
  const second = successful(await remote("--cursor", cursor));
  assert.equal(second.data.items.length, 1);
  assert.equal(second.meta!.page!.nextCursor, null);
  const keys = [...first.data.items, ...second.data.items].map((item: any) => item.key);
  assert.equal(new Set(keys).size, 3);
  // Изменение задачи между страницами: продолжение не смешивает разные срезы.
  const revision = successful(await app.run<any>(["task", "get", blocker])).data.revision;
  successful(
    await app.run([
      "--server-url",
      server.url,
      "task",
      "update",
      blocker,
      "--title",
      "Блокер изменён",
      "--if-revision",
      revision,
    ]),
  );
  failed(await remote("--cursor", cursor), "VERSION_CONFLICT", 4);

  // Прежний сервер без relay-overview-metrics-v1: детализация диагностируется до запроса.
  const requests: string[] = [];
  const legacy = await httpProxy(t, async (request, response) => {
    requests.push(request.url!);
    const upstream = await fetch(`${server.url}${request.url}`, {
      method: request.method ?? "GET",
    });
    const body = await upstream.text();
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed?.data?.capabilities))
      parsed.data.capabilities = parsed.data.capabilities.filter(
        (name: string) => name !== "relay-overview-metrics-v1",
      );
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(JSON.stringify(parsed));
  });
  successful(await app.run(["--server-url", legacy.url, "product", "overview"]));
  requests.length = 0;
  failed(
    await app.run(["--server-url", legacy.url, "product", "overview", "--metric", "board-work"]),
    "SERVER_INCOMPATIBLE",
    5,
  );
  assert.ok(
    requests.every((path) => !path.includes("/metrics/")),
    requests.join("\n"),
  );
  const human = await invokeRaw(app.root, [
    "--server-url",
    legacy.url,
    "product",
    "overview",
    "--metric",
    "board-work",
  ]);
  assert.equal(human.code, 5, human.stdout);
  assert.match(human.stdout.replace(/\s+/g, " "), /relay-overview-metrics-v1/);
  assert.doesNotMatch(human.stdout, /незавершено|Всего: 0/);
});
