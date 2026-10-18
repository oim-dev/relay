import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { join, dirname } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { git, gitText } from "@relay/project-runtime/git-storage/git";
import { readState } from "@relay/project-runtime/git-storage/state";
import { synchronize, conflicts } from "@relay/project-runtime/git-storage/service";
import { managedConfiguration } from "@relay/project-runtime/git-storage/bootstrap";
import { withWorkspaceMaintenance, gitMetadataDirectory } from "@relay/core/storage/access";
import { openWorkspace } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { exists } from "@relay/core/storage/files";
import {
  invoke,
  invokeRaw,
  successful,
  failed,
  tempDirectory,
  fixtureCleanup,
  binary,
  cliNodeArgs,
  cliEnv,
} from "./helpers/cli.js";

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

test("Git CLI: локальная работа при конфликте, просмотр и адресное решение без потери соседних изменений", async (t) => {
  const directory = await tempDirectory(t),
    code = join(directory, "code"),
    origin = join(directory, "origin.git");
  await mkdir(code);
  await git(directory, ["init", "--bare", origin]);
  await git(code, ["init"]);
  await git(code, ["remote", "add", "origin", origin]);
  const home = join(directory, "home with 'quote");
  const config = await managedConfiguration(code, { home, create: true });
  assert(config);
  const root = dirname(config),
    gitDir = await gitMetadataDirectory(root),
    engine = new EntityEngine(await openWorkspace(root, config));
  const options = { subprocess: true, env: { RELAY_HOME: home } };
  fixtureCleanup(t, () =>
    until(
      async () =>
        !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
        !(await exists(join(gitDir, "relay-worker-start.json"))),
      "Worker не завершился",
    ),
  );
  const doc = await withWorkspaceMaintenance(() =>
    engine.create(
      {
        requestId: "doc",
        data: {
          kind: "document",
          name: "Документ",
          summary: "",
          documentKind: "rules",
          body: "Основа",
        },
      },
      "agent",
    ),
  );
  await synchronize(root);
  const peerCode = join(directory, "peer-code");
  await mkdir(peerCode);
  await git(peerCode, ["init"]);
  await git(peerCode, ["remote", "add", "origin", origin]);
  const peerConfig = await managedConfiguration(peerCode, { home: join(directory, "peer") });
  assert(peerConfig);
  const peer = new EntityEngine(await openWorkspace(dirname(peerConfig), peerConfig));
  for (const [target, body] of [
    [engine, "Локальный текст"],
    [peer, "Удалённый текст"],
  ] as const)
    await withWorkspaceMaintenance(() =>
      target.update(
        { ref: doc.key, ifRevision: 1, requestId: "change", changes: { kind: "document", body } },
        "agent",
      ),
    );
  await synchronize(dirname(peerConfig));
  await assert.rejects(synchronize(root), { code: "SYNC_CONFLICT" });
  successful(await invoke(code, ["task", "list"], options));
  const executable = [process.execPath, ...cliNodeArgs, binary]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  for (const selection of [
    { name: "текущий проект", cwd: code, args: [], env: {}, local: false, config: false },
    {
      name: "явный config",
      cwd: directory,
      args: ["--config", config],
      env: {},
      local: false,
      config: true,
    },
    {
      name: "config из окружения",
      cwd: directory,
      args: [],
      env: { RELAY_CONFIG: config },
      local: false,
      config: true,
    },
    {
      name: "явный local при HTTP",
      cwd: code,
      args: ["--local"],
      env: { RELAY_SERVER_URL: "http://127.0.0.1:1" },
      local: true,
      config: false,
    },
  ]) {
    await t.test(`подсказка конфликта: ${selection.name}`, async () => {
      const env = { ...options.env, ...selection.env };
      for (const action of [["sync", "now"]]) {
        const blocked = await invokeRaw(selection.cwd, [...selection.args, ...action], {
          ...options,
          env,
        });
        assert.equal(blocked.code, 4, blocked.stdout);
        const command = blocked.stdout
          .split("\n")
          .find((line) => line.startsWith("npx ") && line.includes("sync conflicts"));
        assert(command, blocked.stdout);
        assert.equal(command.includes("--config"), selection.config, command);
        assert.equal(command.includes("--local"), selection.local, command);
        if (!selection.local && !selection.config)
          assert.equal(command, "npx @oim-dev/relay-cli sync conflicts");
        const copied = await promisify(execFile)(
          "bash",
          ["-c", command.replace(/^npx @oim-dev\/relay-cli/, executable)],
          { cwd: selection.cwd, env: cliEnv(env) },
        );
        assert.match(copied.stdout, /Локальный текст/);
        assert.match(copied.stdout, /Удалённый текст/);
      }
    });
  }
  successful(
    await invoke(code, ["--local", "sync", "status"], {
      ...options,
      env: { ...options.env, RELAY_SERVER_URL: "http://127.0.0.1:1" },
    }),
  );
  const view = await invokeRaw(code, ["sync", "conflicts"], options);
  assert.equal(view.code, 0, view.stdout);
  assert.match(view.stdout, /Локальный текст/);
  assert.match(view.stdout, /Удалённый текст/);
  const conflict = (await conflicts(root))!;
  const file = join(directory, "decisions.json");
  await writeFile(file, "{broken");
  failed(
    await invoke(
      code,
      ["sync", "resolve", "--if-conflict", conflict.id, "--decisions-file", file],
      options,
    ),
    "INVALID_JSON",
  );
  await writeFile(file, JSON.stringify({ [conflict.paths[0]!]: { take: "remote" } }));
  successful(
    await invoke(
      code,
      ["sync", "resolve", "--if-conflict", conflict.id, "--decisions-file", file],
      options,
    ),
  );
  const result = successful(
    await invoke<{ data: { body: string } }>(code, ["document", "get", doc.key], options),
  );
  assert.equal(result.data.data.body, "Удалённый текст");
});

test("Git CLI: init вне кода, один пакет после серии записей и worker после выхода CLI", async (t) => {
  const directory = await tempDirectory(t),
    code = join(directory, "code"),
    origin = join(directory, "origin.git");
  await mkdir(code);
  await git(directory, ["init", "--bare", origin]);
  await git(code, ["init", "--initial-branch", "dev"]);
  await git(code, ["remote", "add", "origin", origin]);
  const options = { subprocess: true, env: { RELAY_HOME: join(directory, "home") } };
  const initial = successful(await invoke<{ configPath: string }>(code, ["init"], options));
  const root = dirname(initial.data.configPath);
  const gitDir = await gitMetadataDirectory(root);
  fixtureCleanup(t, async () => {
    await until(
      async () =>
        !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
        !(await exists(join(gitDir, "relay-worker-start.json"))),
      "Фоновый процесс не завершился",
    );
  });
  assert.equal(await gitText(code, ["status", "--porcelain"]), "");
  assert.equal(await exists(join(code, ".relay")), false);
  const start = Number(await gitText(origin, ["rev-list", "--count", "relay-data"]));
  for (let i = 0; i < 3; i++)
    successful(
      await invoke(
        code,
        ["task", "create", "--board", "product", "--title", `Задача ${i}`],
        options,
      ),
    );
  await until(
    async () =>
      (await readState(root)).firstDirty === null && (await readState(root)).generation === 3,
    "Пакет не опубликован после выхода CLI",
  );
  assert.equal(Number(await gitText(origin, ["rev-list", "--count", "relay-data"])), start + 1);
  const pid = JSON.parse(await readFile(join(gitDir, "relay-worker-pid.json"), "utf8")) as {
    pid: number;
  };
  assert(pid.pid > 0);
  const output = await invokeRaw(code, ["sync", "status"], options);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  assert.match(output.stdout, /Синхронизировано/);
  for (let i = 0; i < 2; i++) successful(await invoke(code, ["project", "get"], options));
  await until(
    async () =>
      !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
      !(await exists(join(gitDir, "relay-worker-start.json"))),
    "Читающий worker не завершился",
  );
  assert.equal(Number(await gitText(origin, ["rev-list", "--count", "relay-data"])), start + 1);
  await rm(root, { recursive: true });
  successful(
    await invoke(
      directory,
      ["--local", "--config", initial.data.configPath, "sync", "status"],
      options,
    ),
  );
  const restored = successful(await invoke<{ items: unknown[] }>(code, ["task", "list"], options));
  assert.equal(restored.data.items.length, 3);
  assert.equal(await gitText(code, ["symbolic-ref", "--short", "HEAD"]), "dev");
});

test("Git CLI: отсутствующая ветка предлагает init, help не подключается к origin", async (t) => {
  const directory = await tempDirectory(t),
    code = join(directory, "code"),
    origin = join(directory, "empty.git");
  await mkdir(code);
  await git(directory, ["init", "--bare", origin]);
  await git(code, ["init"]);
  await git(code, ["remote", "add", "origin", origin]);
  const options = { subprocess: true, env: { RELAY_HOME: join(directory, "home") } };
  failed(await invoke(code, ["project", "get"], options), "RELAY_NOT_INITIALIZED", 4);
  await git(code, ["remote", "set-url", "origin", join(directory, "missing.git")]);
  const help = await invokeRaw(code, ["sync", "--help"], options);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /conflicts/);
  failed(await invoke(code, ["project", "get"], options), "SYNC_NETWORK_UNAVAILABLE", 4);
});

test("Git CLI: отказ объясняет только нужный параметр подключения до поиска базы", async (t) => {
  const directory = await tempDirectory(t);
  for (const connection of [
    { args: ["--server-url", "http://127.0.0.1:1"], env: {} },
    { args: [], env: { RELAY_SERVER_URL: "http://127.0.0.1:1" } },
  ]) {
    const result = await invokeRaw(directory, [...connection.args, "sync", "status"], {
      env: connection.env,
    });
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /LOCAL_REQUIRED/);
    assert.match(result.stdout, /укажите --local/);
    assert.doesNotMatch(result.stdout, /--config|--project/);
  }
  const selected = await invokeRaw(directory, ["--project", "demo", "sync", "status"]);
  assert.equal(selected.code, 2, selected.stdout);
  assert.match(selected.stdout, /sync не принимает --project/);
  assert.match(selected.stdout, /из каталога нужного Git-проекта/);
  assert.doesNotMatch(selected.stdout, /--local/);
});

test("Git CLI: init без origin, добавление и смена origin продолжают ту же базу без флагов подключения", async (t) => {
  const directory = await tempDirectory(t),
    code = join(directory, "code");
  await mkdir(code);
  await git(code, ["init", "--initial-branch", "dev"]);
  const options = { subprocess: true, env: { RELAY_HOME: join(directory, "home") } };
  const initial = successful(await invoke<{ configPath: string }>(code, ["init"], options)).data;
  const root = dirname(initial.configPath),
    gitDir = await gitMetadataDirectory(root);
  fixtureCleanup(t, () =>
    until(
      async () =>
        !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
        !(await exists(join(gitDir, "relay-worker-start.json"))),
      "Worker не завершился",
    ),
  );
  const status = await invokeRaw(code, ["sync", "status"], options);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, /origin не настроен/);
  const task = successful(
    await invoke<{ ref: { id: string } }>(
      code,
      ["task", "create", "--board", "product", "--title", "До origin"],
      options,
    ),
  ).data;
  await until(
    async () => (await readState(root)).firstDirty === null,
    "Локальный коммит не завершён",
  );
  for (const [i, name] of ["origin-a.git", "origin-b.git"].entries()) {
    const remote = join(directory, name);
    await git(directory, ["init", "--bare", remote]);
    await git(code, ["remote", i ? "set-url" : "add", "origin", remote]);
    successful(await invoke(code, ["task", "get", task.ref.id], options));
    await until(
      async () =>
        (await git(remote, ["rev-parse", "--verify", "relay-data"], { allowFailure: true }))
          .code === 0,
      "Worker не подключил новый origin",
    );
    const config = successful(await invoke<{ configPath: string }>(code, ["init"], options)).data;
    assert.equal(config.configPath, initial.configPath);
    assert.match(
      await gitText(remote, ["show", `relay-data:entities/tasks/${task.ref.id}.json`]),
      /До origin/,
    );
  }
  assert.equal(await exists(join(code, ".relay")), false);
});

test("Git CLI: sync migrate переносит файловую базу, обычные команды продолжают работу без config", async (t) => {
  const directory = await tempDirectory(t),
    code = join(directory, "code");
  await mkdir(code);
  await git(code, ["init", "--initial-branch", "dev"]);
  const options = { subprocess: true, env: { RELAY_HOME: join(directory, "home") } };
  const oldConfig = join(code, ".relay/config.json");
  successful(await invoke(code, ["init", "--config", oldConfig], options));
  const task = successful(
    await invoke<{ ref: { id: string } }>(
      code,
      ["task", "create", "--board", "product", "--title", "Существующая задача"],
      options,
    ),
  ).data;
  const before = await readFile(
    join(dirname(oldConfig), "entities/tasks", `${task.ref.id}.json`),
    "utf8",
  );
  const migrated = successful(
    await invoke<{ configPath: string }>(
      code,
      ["sync", "migrate", "--from-config", ".relay/config.json"],
      options,
    ),
  ).data;
  assert.notEqual(migrated.configPath, oldConfig);
  const gitDir = await gitMetadataDirectory(dirname(migrated.configPath));
  fixtureCleanup(t, () =>
    until(
      async () =>
        !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
        !(await exists(join(gitDir, "relay-worker-start.json"))),
      "Worker не завершился",
    ),
  );
  assert.equal(
    await readFile(join(dirname(oldConfig), "entities/tasks", `${task.ref.id}.json`), "utf8"),
    before,
  );
  const read = await invokeRaw(code, ["task", "get", task.ref.id], options);
  assert.equal(read.code, 0, read.stdout);
  assert.match(read.stdout, /Существующая задача/);
  const status = successful(await invoke<{ root: string }>(code, ["sync", "status"], options)).data;
  assert.equal(status.root, dirname(migrated.configPath));
  const configured = JSON.parse(await readFile(migrated.configPath, "utf8"));
  configured.server.url = "http://127.0.0.1:1";
  await writeFile(migrated.configPath, JSON.stringify(configured));
  for (const selectors of [[], ["--config", migrated.configPath]]) {
    const blocked = await invokeRaw(code, [...selectors, "sync", "status"], options);
    assert.equal(blocked.code, 2, blocked.stdout);
    assert.match(blocked.stdout, /укажите --local/);
    successful(await invoke(code, ["--local", ...selectors, "sync", "status"], options));
  }
});
