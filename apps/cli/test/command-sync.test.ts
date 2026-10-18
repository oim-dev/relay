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
import { withWorkspaceMaintenance } from "@relay/core/storage/access";
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

test("Git CLI: блокировка, полный просмотр и адресное решение из файла без потери соседних изменений", async (t) => {
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
    engine = new EntityEngine(await openWorkspace(root, config));
  const options = { subprocess: true, env: { RELAY_HOME: home } };
  fixtureCleanup(t, () =>
    until(
      async () =>
        !(await exists(join(root, ".git/relay-worker/write.lock"))) &&
        !(await exists(join(root, ".git/relay-worker-start.json"))),
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
  const peerConfig = await managedConfiguration(code, { home: join(directory, "peer") });
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
  failed(await invoke(code, ["task", "list"], options), "SYNC_CONFLICT", 4);
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
      for (const action of [
        ["task", "list"],
        ["sync", "now"],
      ]) {
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
  fixtureCleanup(t, async () => {
    await until(
      async () =>
        !(await exists(join(root, ".git/relay-worker/write.lock"))) &&
        !(await exists(join(root, ".git/relay-worker-start.json"))),
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
  const pid = JSON.parse(await readFile(join(root, ".git/relay-worker-pid.json"), "utf8")) as {
    pid: number;
  };
  assert(pid.pid > 0);
  const output = await invokeRaw(code, ["sync", "status"], options);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  assert.match(output.stdout, /нет ожидающей отправки/);
  for (let i = 0; i < 2; i++) successful(await invoke(code, ["project", "get"], options));
  await until(
    async () =>
      !(await exists(join(root, ".git/relay-worker/write.lock"))) &&
      !(await exists(join(root, ".git/relay-worker-start.json"))),
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
