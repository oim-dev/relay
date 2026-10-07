import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import { digest, jsonValue } from "@relay/core/storage/entity-store/format";
import { fixture, invoke, successful, failed, tempDirectory, cliEnv } from "./helpers/cli.js";
import { httpServer, httpProxy } from "./helpers/http.js";

test("прерывание перед rename сохраняет карточку; следующая CLI-запись работает", async (t) => {
  const app = await fixture(t);
  await app.create("До сбоя");
  const task = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data;
  const target = join(app.root, ".relay/entities/tasks", `${task.id}.json`);
  const before = await readFile(target, "utf8");
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `
    import { atomicJson } from ${JSON.stringify(import.meta.resolve("@relay/core/storage/files"))};
    import { readFile } from 'node:fs/promises';
    const record = JSON.parse(await readFile(process.env.TARGET, 'utf8'));
    await atomicJson(process.env.TARGET, {...record, data: {...record.data, title: 'Не публиковать'}}, process.env.STAGING, false,
      () => { process.stdout.write('перед rename'); process.kill(process.pid, 'SIGKILL'); });
  `,
    ],
    {
      cwd: app.root,
      env: cliEnv({ TARGET: target, STAGING: join(app.root, ".relay/runtime") }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let checkpoint = "";
  child.stdout.on("data", (chunk: Buffer) => {
    checkpoint += chunk.toString();
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    assert.equal(checkpoint, "перед rename", "убийство произошло именно после fsync до публикации");
  } finally {
    clearTimeout(timer);
  }
  assert.equal(await readFile(target, "utf8"), before);
  successful(
    await app.run([
      "task",
      "update",
      "PRODUCT-1",
      "--description",
      "Работа продолжается",
      "--if-revision",
      1,
    ]),
  );
  const after = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data;
  assert.equal(after.title, "До сбоя");
  assert.equal(after.description, "Работа продолжается");
  successful(await app.run(["doctor", "check"]));
});

test("блокировка погибшего процесса: явное старение fixture, затем успешная CLI-запись", async (t) => {
  const app = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `
    import { withStorageLock } from ${JSON.stringify(import.meta.resolve("@relay/core/storage/lock"))};
    await withStorageLock(process.env.STORAGE, async () => {
      process.stdout.write('готово');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `,
    ],
    {
      cwd: app.root,
      env: cliEnv({ STORAGE: join(app.root, ".relay/tasks") }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    child.kill("SIGKILL");
  });
  const exit = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const ready = await Promise.race([
      once(child.stdout, "data"),
      exit.then(() => {
        throw new Error("Процесс блокировки завершился до готовности");
      }),
    ]);
    assert.equal(String(ready[0]), "готово");
    child.kill("SIGKILL");
    await exit;
  } finally {
    clearTimeout(timer);
  }
  const stale = new Date(Date.now() - 30_000);
  await utimes(join(app.root, ".relay/runtime/write.lock"), stale, stale);
  await app.create("После восстановления");
  assert.equal(
    successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data.title,
    "После восстановления",
  );
  successful(await app.run(["doctor", "check"]));
});

test("потерянный ответ записи: ровно один POST, requestId только корреляция, перечитывание результата", async (t) => {
  const app = await fixture(t);
  const server = await httpServer(t, app.root);
  const writes: any[] = [];
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
      assert.equal(upstream.status, 200, text);
      writes.push(JSON.parse(body.toString()));
      if (writes.length === 1) {
        response.destroy();
        return;
      }
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(text);
  });
  const command = [
    "--server-url",
    proxy.url,
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Ответ потерян",
    "--request-id",
    "same-correlation",
    "--actor",
    "Автор потери",
  ];
  const lost = await app.run(command);
  failed(lost, "SERVER_UNAVAILABLE", 5);
  assert.match(lost.stdout, /Перечитайте состояние/);
  assert.equal(writes.length, 1, "скрытый повтор мутации запрещён");
  assert.equal(writes[0].requestId, "same-correlation");
  const saved = successful(
    await app.run<any>(["--server-url", proxy.url, "task", "get", "PRODUCT-1"]),
  ).data;
  assert.equal(saved.title, "Ответ потерян");
  assert.equal(saved.createdBy, "Автор потери");
  assert.equal(saved.revision, 1);
  assert.equal(writes.length, 1);
  successful(await app.run(command));
  assert.equal(writes.length, 2);
  const list = successful(await app.run<any>(["task", "list"])).data;
  assert.equal(list.total, 2, "явный повтор requestId — новая попытка, не replay квитанции");
  assert.equal(new Set(list.items.map((item: any) => item.id)).size, 2);
});

test("missing/corrupt config и повреждение хранения: не пустой успех, данные не исправляются скрытно", async (t) => {
  const empty = await tempDirectory(t);
  failed(await invoke(empty, ["project", "get"]), "CONFIG_NOT_FOUND");
  assert.deepEqual(await readdir(empty), []);
  const app = await fixture(t);
  await app.create("Сохранить несмотря на ошибку");
  const task = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data;
  const taskPath = join(app.root, ".relay/entities/tasks", `${task.id}.json`);
  const original = await readFile(taskPath, "utf8");
  const configPath = join(app.root, ".relay/config.json");
  const config = await readFile(configPath, "utf8");
  const server = await httpServer(t, app.root);
  await writeFile(configPath, "{invalid-config");
  const corruptConfig = await app.run(["--server-url", server.url, "project", "get"]);
  assert.notEqual(corruptConfig.code, 0);
  assert.equal(corruptConfig.stderr, "");
  assert.ok(!corruptConfig.body.ok);
  assert.equal(await readFile(configPath, "utf8"), "{invalid-config");
  assert.equal(await readFile(taskPath, "utf8"), original);
  await writeFile(configPath, config);
  const markerPath = join(app.root, ".relay/storage.json");
  const marker = await readFile(markerPath, "utf8");
  await rm(markerPath);
  const missing = await app.run(["doctor", "check"]);
  assert.notEqual(missing.code, 0);
  assert.ok(!missing.body.ok);
  assert.equal(await readFile(taskPath, "utf8"), original);
  await writeFile(markerPath, marker);
  await writeFile(taskPath, "{invalid-record");
  const corrupt = await app.run(["doctor", "check"]);
  failed(corrupt, "STORAGE_INDEX_STALE", 4);
  assert.equal(corrupt.stderr, "");
  assert.equal(await readFile(taskPath, "utf8"), "{invalid-record");
  const rebuild = await app.run(["--local", "storage", "reindex"]);
  assert.notEqual(rebuild.code, 0);
  assert.equal(await readFile(taskPath, "utf8"), "{invalid-record");
  await writeFile(taskPath, original);
  successful(await app.run(["--local", "storage", "reindex"]));
  successful(await app.run(["doctor", "check"]));
  assert.deepEqual(successful(await app.run(["task", "get", "PRODUCT-1"])).data, task);
});

test("storage migrate: поддерживаемые legacy-задачи сохраняют ID, алиасы, ревизии, текст и отношения", async (t) => {
  const root = await tempDirectory(t);
  const at = "2026-09-26T00:00:00.000Z";
  await mkdir(join(root, ".relay/boards/product/tasks"), { recursive: true });
  await writeFile(
    join(root, ".relay/config.json"),
    JSON.stringify({
      ...structuredClone(defaultConfig),
      projectId: "Legacy01",
      storageDir: "tasks",
      projectSettings: { version: 1, name: "Legacy", slug: "legacy", revision: 1 },
    }),
  );
  await writeFile(
    join(root, ".relay/boards/product/board.json"),
    JSON.stringify({
      version: 1,
      id: "board_product",
      slug: "product",
      prefix: "PRODUCT",
      kind: "product",
      applicationId: null,
      revision: 1,
      createdAt: at,
      createdBy: "relay",
    }),
  );
  const description = "Текст\r\n\n  пробелы  \n";
  for (const n of [1, 2]) {
    await writeFile(
      join(root, `.relay/boards/product/tasks/LegacyT${n}.json`),
      JSON.stringify({
        version: 4,
        id: `LegacyT${n}`,
        key: `PRODUCT-${n}`,
        keys: [`PRODUCT-${n}`, `OLD-${n}`],
        boardId: "board_product",
        title: `Сохранить ${n}`,
        description: description.split("\n"),
        productLinks: [],
        column: "inbox",
        rank: n,
        revision: 7,
        dependencies: [],
        related: [],
        parentId: n === 2 ? "LegacyT1" : null,
        acceptanceCriteria: [],
        requests: {},
        events: [],
        createdAt: at,
        updatedAt: at,
        createdBy: "agent",
        updatedBy: "agent",
      }),
    );
  }
  const originalPath = join(root, ".relay/boards/product/tasks/LegacyT2.json");
  const original = await readFile(originalPath, "utf8");
  failed(
    await invoke(root, [
      "task",
      "update",
      "LegacyT2",
      "--title",
      "Не записать",
      "--if-revision",
      7,
    ]),
    "STORAGE_MIGRATION_REQUIRED",
    4,
  );
  assert.equal(await readFile(originalPath, "utf8"), original);
  const notes = join(root, ".relay/user-notes.txt");
  await writeFile(notes, "Собственные данные пользователя");
  const backups = await tempDirectory(t);
  const migrated = successful(
    await invoke<any>(root, [
      "--local",
      "storage",
      "migrate",
      "--backup-dir",
      join(backups, "legacy"),
    ]),
  ).data;
  assert.equal(migrated.migrated, true);
  // Core создаёт отдельный каталог копии внутри --backup-dir.
  assert.ok(migrated.backup?.path.startsWith(`${join(backups, "legacy")}/`), migrated.backup?.path);
  const task = successful(await invoke<any>(root, ["task", "get", "OLD-2"])).data;
  assert.equal(task.id, "LegacyT2");
  assert.equal(task.revision, 7);
  assert.equal(task.description, description);
  assert.equal(task.parentId, "LegacyT1");
  const graph = successful(await invoke<any>(root, ["inspect", "graph", "context", "OLD-2"])).data;
  assert.equal(graph.complete, true);
  assert.ok(
    graph.edges.some((edge: any) => edge.from.id === "LegacyT2" && edge.to.id === "LegacyT1"),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, ".relay/storage.json"), "utf8")).schemaVersion,
    4,
  );
  assert.equal(await readFile(notes, "utf8"), "Собственные данные пользователя");
  const bytes = await readFile(join(root, ".relay/entities/tasks/LegacyT2.json"), "utf8");
  assert.equal(
    successful(await invoke<any>(root, ["--local", "storage", "migrate"])).data.migrated,
    false,
  );
  assert.equal(await readFile(join(root, ".relay/entities/tasks/LegacyT2.json"), "utf8"), bytes);
  successful(await invoke(root, ["doctor", "check"]));
});

test("storage migrate: неподдерживаемая предметная версия плана отклоняется без сброса содержания", async (t) => {
  const app = await fixture(t);
  successful(
    await app.run([
      "plan",
      "create",
      "--title",
      "План пользователя",
      "--goal",
      "## Цель\n\nНе терять",
    ]),
  );
  const directory = join(app.root, ".relay/entities/work-plans");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const path = join(directory, files[0]!);
  const plan = JSON.parse(await readFile(path, "utf8"));
  plan.dataVersion = 1;
  plan.schemaVersion = 2;
  const original = JSON.stringify(plan);
  await writeFile(path, original);
  const markerPath = join(app.root, ".relay/storage.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.schemaVersion = 3;
  const oldMarker = JSON.stringify(marker);
  await writeFile(markerPath, oldMarker);
  await rm(join(app.root, ".relay/.indexes"), { recursive: true });
  // Физический v3 требует согласованного file-hashes; история операций не создаётся.
  const leaf = jsonValue({
    schemaVersion: 1,
    type: "leaf",
    entries: [[`entities/work-plans/${files[0]}`, digest(jsonValue(plan))]],
  });
  const hash = digest(leaf);
  const segment = join(app.root, ".relay/.indexes/segments", hash.slice(0, 2));
  await mkdir(segment, { recursive: true });
  await writeFile(join(segment, `${hash}.json`), JSON.stringify(leaf));
  await writeFile(
    join(app.root, ".relay/.indexes/state.json"),
    JSON.stringify({ schemaVersion: 1, version: "legacy-plan", roots: { "file-hashes": hash } }),
  );
  const result = await app.run(["--local", "storage", "migrate"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(!result.body.ok);
  assert.ok(!result.body.ok && /^STORAGE_/.test(result.body.error.code), result.stdout);
  assert.ok((result.body.error.details as { next?: string } | undefined)?.next, result.stdout);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(markerPath, "utf8"), oldMarker);
});
