import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { EntityDetail } from "@relay/contracts/entities";
import type { ProjectSettings } from "@relay/contracts/entities/project-settings";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli"));

/** Фиксируем и каталоги: отказ не должен оставлять даже служебные .gitignore. */
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        await visit(path, `${relative}/`);
      } else {
        result[relative] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  }
  await visit(root, "");
  return result;
}

/** Исполняем буквальную Bash-подсказку; npx не скачивает другую версию CLI. */
async function replayRaw(cwd: string, command: string, env: NodeJS.ProcessEnv = {}) {
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
    { cwd, env: cliEnv(env), timeout: 30000 },
  ).then(
    (result) => ({ ...result, code: 0 }),
    (error: unknown) => {
      const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (
        typeof result.code !== "number" ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string"
      )
        throw error;
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  );
}

async function replay(cwd: string, command: string, env: NodeJS.ProcessEnv = {}) {
  const result = await replayRaw(cwd, command, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("init: HTTP intent flag/env/config — отказ без файлов и сети, local только по выбранному адресу", async (t) => {
  const requests: string[] = [];
  const server = await httpProxy(t, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(500).end();
  });
  for (const mode of [
    "new",
    "local-existing",
    "local-child",
    "workspace-root",
    "workspace-child",
    "registration",
    "explicit-registration",
    "env-registration",
  ]) {
    for (const source of ["flag", "env", "config"]) {
      if (mode === "new" && source === "config") continue;
      await t.test(`${mode}/${source}`, async (t) => {
        const root = await tempDirectory(t);
        const args: string[] = [];
        const env: NodeJS.ProcessEnv = {};
        let cwd = root;
        let target = join(root, ".relay/config.json");
        if (mode.startsWith("local-")) {
          successful(await invoke(root, ["init"]));
          if (source === "config") {
            const config = JSON.parse(await readFile(target, "utf8"));
            await writeFile(target, JSON.stringify({ ...config, server: { url: server.url } }));
          }
          if (mode === "local-child") {
            cwd = join(root, "новый дочерний проект");
            await mkdir(cwd);
            target = join(cwd, ".relay/config.json");
          }
        } else if (mode !== "new") {
          const registry = join(root, "relay.workspace.json");
          await writeFile(
            registry,
            JSON.stringify({
              version: 1,
              projects: { alpha: { path: "отдельный проект" } },
              server: source === "config" ? { url: server.url } : { port: 4700 },
            }),
          );
          if (mode === "workspace-child") {
            cwd = join(root, "новый подкаталог");
            await mkdir(cwd);
            target = join(cwd, ".relay/config.json");
          }
          if (mode.includes("registration")) {
            target = join(root, "отдельный проект/.relay/config.json");
            args.push("--project", "alpha");
            if (mode !== "registration") {
              cwd = await tempDirectory(t);
              if (mode === "explicit-registration") args.push("--config", registry);
              else env.RELAY_CONFIG = registry;
            }
          }
        }
        if (source === "flag") args.push("--server-url", server.url);
        if (source === "env") env.RELAY_SERVER_URL = server.url;
        const before = await tree(root);
        const cwdBefore = await tree(cwd);
        failed(await invoke(cwd, [...args, "init"], { env }), "LOCAL_ONLY");
        const human = await invokeRaw(cwd, [...args, "init"], { env });
        assert.equal(human.code, 2, human.stdout);
        assert.equal(human.stderr, "");
        assert.match(human.stdout, /LOCAL_ONLY/);
        assert.match(human.stdout, /--local/);
        assert.deepEqual(await tree(root), before);
        assert.deepEqual(await tree(cwd), cwdBefore);
        assert.deepEqual(requests, []);

        const local = await invoke<{ configPath: string }>(cwd, [...args, "--local", "init"], {
          env,
        });
        if (mode === "local-existing") {
          failed(local, "ALREADY_INITIALIZED", 4);
          assert.deepEqual(await tree(root), before);
        } else {
          assert.equal(successful(local).data.configPath, target);
          const after = await tree(root);
          for (const [path, hash] of Object.entries(before)) assert.equal(after[path], hash, path);
          const read = successful(
            await invoke(cwd, ["--local", "--config", target, "config", "get"], { env }),
          );
          assert.equal((read.meta as { configPath: string }).configPath, target);
          if (mode === "explicit-registration" || mode === "env-registration")
            assert.deepEqual(await tree(cwd), cwdBefore);
        }
        assert.deepEqual(requests, []);
      });
    }
  }
});

test("init: две буквальные подсказки, Unicode-каталог и long quoted config при 24/40/100", async (t) => {
  for (const mode of ["normal", "quoted", "env", "workspace", "workspace-selected"])
    for (const width of [24, 40, 100]) {
      await t.test(`${mode}/${width}`, async (t) => {
        const root = await tempDirectory(t);
        const env: NodeJS.ProcessEnv = { COLUMNS: String(width), FORCE_COLOR: "3" };
        const args: string[] = [];
        let configPath = join(root, ".relay/config.json");
        if (mode === "quoted" || mode === "env") {
          configPath = join(
            root,
            "Длинный проект с 'кавычкой и пробелами",
            "вложенный каталог общего хранилища и Unicode Ω",
            "ещё один каталог для проверки полной копируемой команды",
            "custom.json",
          );
          if (mode === "quoted") args.push("--config", configPath);
          else env.RELAY_CONFIG = configPath;
        }
        if (mode.startsWith("workspace")) {
          await writeFile(
            join(root, "relay.workspace.json"),
            JSON.stringify({ version: 1, projects: { alpha: { path: "альфа" } } }),
          );
          if (mode === "workspace-selected") {
            args.push("alpha");
            configPath = join(root, "альфа/.relay/config.json");
          }
        }
        const result = await invokeRaw(root, [...args, "init"], { env });
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(result.stderr, "");
        assert.doesNotMatch(result.stdout, /\u001b|\[object Object\]/);
        const commands = hints(result.stdout);
        assert.equal(commands.length, 2, result.stdout);
        assert.match(commands[0]!, /config get$/);
        assert.match(commands[1]!, /product create --help$/);
        if (mode === "normal") {
          assert.equal(commands[0], "npx @oim-dev/relay-cli config get");
          assert.equal(commands[1], "npx @oim-dev/relay-cli product create --help");
        }
        if (mode.startsWith("workspace")) assert.match(commands[0]!, /--local --config/);
        const read = JSON.parse(await replay(root, `${commands[0]} --format json`, env));
        assert.equal(read.ok, true);
        assert.equal(read.meta.configPath, configPath);
        assert.match(await replay(root, commands[1]!, env), /product create/);
        const verification = result.stdout.slice(
          result.stdout.indexOf("Проверить созданный"),
          result.stdout.indexOf("Следующий шаг"),
        );
        t.diagnostic(
          JSON.stringify({
            mode,
            width,
            lines: result.stdout.split("\n").length - 1,
            bytes: Buffer.byteLength(result.stdout),
            commandBytes: Buffer.byteLength(commands.join("\n")),
            verificationBytes: Buffer.byteLength(verification),
            verificationLines: verification.split("\n").length - 1,
          }),
        );
      });
    }
});

test("init → slug: shared fix da5e951, local/HTTP, ID/секции/регистрация и исходная CAS", async (t) => {
  const root = await tempDirectory(t);
  successful(await invoke(root, ["init"]));
  const initial = successful(await invoke<EntityDetail>(root, ["project", "get"])).data;
  successful(
    await invoke(root, [
      "document",
      "section",
      "create",
      "init-section",
      "--name",
      "Раздел init",
      "--if-revision",
      initial.revision,
    ]),
  );
  const before = successful(await invoke<EntityDetail>(root, ["project", "get"])).data;
  const local = successful(
    await invoke<ProjectSettings>(root, [
      "project",
      "update",
      "--slug",
      "init-local",
      "--if-revision",
      before.revision,
    ]),
  ).data;
  const afterLocal = successful(await invoke<EntityDetail>(root, ["project", "get"])).data;
  assert.equal(afterLocal.revision, before.revision + 1);
  assert.deepEqual(afterLocal.ref, initial.ref);
  assert.equal(before.data.kind, "project");
  assert.equal(afterLocal.data.kind, "project");
  if (before.data.kind !== "project" || afterLocal.data.kind !== "project") return;
  assert.equal(afterLocal.data.slug, local.slug);
  assert.equal(afterLocal.data.name, before.data.name);
  assert.deepEqual(afterLocal.data.documentSections, before.data.documentSections);
  failed(
    await invoke(root, [
      "project",
      "update",
      "--slug",
      "stale-local",
      "--if-revision",
      before.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );

  const workspace = await tempDirectory(t);
  successful(await invoke(workspace, ["workspace", "project", "init"]));
  const server = await httpServer(t, workspace);
  const remote = ["--server-url", server.url, "--project", "alpha"];
  successful(
    await invoke(workspace, [
      "--server-url",
      server.url,
      "workspace",
      "project",
      "add",
      "alpha",
      root,
    ]),
  );
  const registryPath = join(workspace, "relay.workspace.json");
  const registryBefore = await readFile(registryPath, "utf8");
  assert.deepEqual(
    successful(await invoke(workspace, [...remote, "project", "get"])).data,
    afterLocal,
  );
  const saved = await invokeRaw(workspace, [
    ...remote,
    "project",
    "update",
    "--slug",
    "init-http",
    "--if-revision",
    afterLocal.revision,
  ]);
  assert.equal(saved.code, 0, saved.stdout);
  assert.equal(saved.stderr, "");
  const afterHttp = successful(
    await invoke<EntityDetail>(workspace, [...remote, "project", "get"]),
  ).data;
  assert.equal(afterHttp.revision, afterLocal.revision + 1);
  assert.deepEqual(afterHttp.ref, initial.ref);
  assert.equal(afterHttp.data.kind, "project");
  if (afterHttp.data.kind !== "project") return;
  assert.equal(afterHttp.data.slug, "init-http");
  assert.equal(afterHttp.data.name, before.data.name);
  assert.deepEqual(afterHttp.data.documentSections, before.data.documentSections);
  assert.equal(await readFile(registryPath, "utf8"), registryBefore);
  assert.deepEqual(successful(await invoke(root, ["project", "get"])).data, afterHttp);
  assert.match(await replay(workspace, hints(saved.stdout)[0]!), /init-http/);
  const bytes = await tree(root);
  failed(
    await invoke(workspace, [
      ...remote,
      "project",
      "update",
      "--slug",
      "stale-http",
      "--if-revision",
      afterLocal.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  assert.deepEqual(await tree(root), bytes);
  assert.equal(await readFile(registryPath, "utf8"), registryBefore);
});

test("init: ALREADY_INITIALIZED после паспорта сохраняет все байты и ведёт к своей базе", async (t) => {
  for (const mode of ["normal", "quoted", "env", "local-http", "workspace", "workspace-selected"])
    await t.test(mode, async (t) => {
      const root = await tempDirectory(t);
      const args: string[] = [];
      const env: NodeJS.ProcessEnv = { COLUMNS: "24", FORCE_COLOR: "3" };
      let configPath = join(root, ".relay/config.json");
      if (mode === "quoted" || mode === "env") {
        configPath = join(root, "Проект с 'кавычкой и пробелами", "custom.json");
        if (mode === "quoted") args.push("--config", configPath);
        else env.RELAY_CONFIG = configPath;
      }
      if (mode === "local-http") {
        args.push("--local");
        env.RELAY_SERVER_URL = "http://127.0.0.1:1";
      }
      if (mode.startsWith("workspace")) {
        await writeFile(
          join(root, "relay.workspace.json"),
          JSON.stringify({ version: 1, projects: { alpha: { path: "альфа" } } }),
        );
        if (mode === "workspace-selected") {
          args.push("--project", "alpha");
          configPath = join(root, "альфа/.relay/config.json");
        }
      }
      successful(await invoke(root, [...args, "init"], { env }));
      const description = "## Паспорт Ω\n\nТочное содержание.\n\n- Проверка\n  - Вложенный пункт\n";
      successful(
        await invoke(root, [
          "--local",
          "--config",
          configPath,
          "product",
          "create",
          "--name",
          "Паспорт init",
          "--description",
          description,
        ]),
      );
      const before = await tree(root);
      const human = await invokeRaw(root, [...args, "init", "--storage", "other"], { env });
      assert.equal(human.code, 4, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /ALREADY_INITIALIZED/);
      assert.doesNotMatch(human.stdout, /повтор может выполнить|\u001b|"paths"|\[object Object\]/);
      const commands = hints(human.stdout);
      assert.equal(commands.length, 1, human.stdout);
      assert.match(commands[0]!, /config get$/);
      const json = await invoke(root, [...args, "init"], { env });
      failed(json, "ALREADY_INITIALIZED", 4);
      assert.equal(json.body.ok, false);
      if (json.body.ok) return;
      const details = json.body.error.details as { configPath: string; dataRoot: string };
      assert.equal(details.configPath, configPath);
      assert.equal(typeof details.dataRoot, "string");
      assert.equal(
        (await invoke(root, [...args, "init"], { env: { ...env, COLUMNS: "100" } })).stdout,
        json.stdout,
      );
      assert.deepEqual(await tree(root), before);
      const read = JSON.parse(await replay(root, `${commands[0]} --format json`, env));
      assert.equal(read.ok, true);
      assert.equal(read.meta.configPath, configPath);
      const passport = successful(
        await invoke<EntityDetail>(root, ["--local", "--config", configPath, "product", "get"]),
      ).data;
      assert.equal(passport.data.kind, "product");
      if (passport.data.kind === "product") assert.equal(passport.data.description, description);
      assert.deepEqual(await tree(root), before);
    });
});

test("init: basename preflight даёт INVALID_ARGUMENT без следов, Unicode-каталог читается", async (t) => {
  for (const basename of [
    "нестандартный.json",
    "my config.json",
    "relay.workspace.json",
    "storage.json",
  ])
    await t.test(basename, async (t) => {
      const root = await tempDirectory(t);
      const configPath = join(root, "Каталог с пробелами Ω", basename);
      const before = await tree(root);
      failed(await invoke(root, ["init", "--config", configPath]), "INVALID_ARGUMENT");
      const human = await invokeRaw(root, ["init", "--config", configPath], {
        env: { COLUMNS: "24" },
      });
      assert.equal(human.code, 2, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /INVALID_ARGUMENT/);
      assert.doesNotMatch(human.stdout, /IO_ERROR|ZodError|\[object Object\]/);
      assert.deepEqual(await tree(root), before);
    });
});

test("init: имя без расширения открывается; существующий Unicode-конфиг по-прежнему читается", async (t) => {
  const root = await tempDirectory(t);
  const config = join(root, "Каталог ' с пробелами Ω", "settings");
  successful(await invoke(root, ["init", "--config", config]));
  const project = successful(await invoke(root, ["--config", config, "project", "get"])).data;
  const unicode = join(root, "Каталог ' с пробелами Ω", "конфиг с пробелом.json");
  await rename(config, unicode);
  assert.deepEqual(
    successful(await invoke(root, ["--config", unicode, "project", "get"])).data,
    project,
  );
});

test("init: новый cwd внутри local-проекта без HTTP остаётся самостоятельной базой", async (t) => {
  const root = await tempDirectory(t);
  successful(await invoke(root, ["init"]));
  const child = join(root, "Новый проект Ω");
  await mkdir(child);
  const before = await tree(root);
  const receipt = await invokeRaw(child, ["init"]);
  assert.equal(receipt.code, 0, receipt.stdout);
  assert.equal(receipt.stderr, "");
  const read = JSON.parse(await replay(child, `${hints(receipt.stdout)[0]} --format json`));
  assert.equal(read.meta.configPath, join(child, ".relay/config.json"));
  const after = await tree(root);
  for (const [path, hash] of Object.entries(before)) assert.equal(after[path], hash, path);
});

test("init: storage/pending/incomplete — точная причина, адресная диагностика, без recovery или записи", async (t) => {
  for (const reason of ["storage", "pending", "incomplete"])
    await t.test(reason, async (t) => {
      const root = await tempDirectory(t);
      const configPath = join(root, "База с 'кавычкой Ω", "config.json");
      const dataRoot = join(root, "База с 'кавычкой Ω");
      successful(await invoke(root, ["init", "--config", configPath]));
      await rm(configPath);
      if (reason !== "storage") await rm(join(dataRoot, "storage.json"));
      if (reason === "pending") {
        // Повреждённый WAL не должен даже разбираться или восстанавливаться через init.
        await writeFile(join(dataRoot, "transactions/pending.json"), "неполная запись WAL");
      }
      const before = await tree(root);
      const json = await invoke(root, ["init", "--config", configPath]);
      failed(json, "ALREADY_INITIALIZED", 4);
      if (json.body.ok) return;
      const details = json.body.error.details as {
        configPath: string;
        dataRoot: string;
        reason: string;
        paths: string[];
      };
      assert.equal(details.configPath, configPath);
      assert.equal(details.dataRoot, dataRoot);
      assert.equal(details.reason, reason);
      assert.ok(details.paths.length);
      const human = await invokeRaw(root, ["init", "--config", configPath], {
        env: { COLUMNS: "24" },
      });
      assert.equal(human.code, 4, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /ALREADY_INITIALIZED/);
      assert.doesNotMatch(
        human.stdout,
        /STORAGE_MIGRATION_CONFLICT|повтор может выполнить|storage migrate|"paths"|\u001b/,
      );
      for (const path of details.paths) assert.ok(human.stdout.includes(`- ${path}`), human.stdout);
      const commands = hints(human.stdout);
      assert.equal(commands.length, 1, human.stdout);
      assert.match(commands[0]!, /--local --config.*storage status$/);
      assert.deepEqual(await tree(root), before);
      const diagnostic = await replayRaw(root, `${commands[0]} --format json`);
      assert.equal(diagnostic.stderr, "");
      assert.notEqual(diagnostic.code, 0, diagnostic.stdout);
      const result = JSON.parse(diagnostic.stdout);
      assert.equal(result.ok, false);
      assert.notEqual(result.error.code, "INVALID_ARGUMENT", diagnostic.stdout);
      assert.deepEqual(await tree(root), before);
      t.diagnostic(`${reason}: storage status → ${result.error.code}, exit ${diagnostic.code}`);
    });
});
