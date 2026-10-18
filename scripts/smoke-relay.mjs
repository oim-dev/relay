import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { releaseMetadata } from "./release/metadata.mjs";
import { runNpm } from "./release/npm.mjs";
import { assertInstalledContent, readPackageContent } from "./release/package-content.mjs";
import {
  checkServerSurface,
  startServerProcess,
} from "../apps/cli/test/helpers/server-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".artifacts"), { recursive: true });
const temporary = await mkdtemp(join(root, ".artifacts/relay-installed-"));
const exec = promisify(execFile);
const processes = [];
const environment = {
  ...process.env,
  RELAY_CONFIG: undefined,
  RELAY_SERVER_URL: undefined,
  RELAY_HOME: join(temporary, "relay-home"),
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
};
let client;

async function gitDirectory(root) {
  return (
    await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, env: environment })
  ).stdout.trim();
}

/** Detached worker может завершаться после закрытия Server/CLI; его база ещё используется. */
async function waitForManagedWorkers() {
  const exists = async (path) =>
    stat(path)
      .then(() => true)
      .catch((error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
  const alive = async (directory) => {
    const file = join(directory, "relay-worker-pid.json");
    if (!(await exists(file))) return false;
    const { pid } = JSON.parse(await readFile(file, "utf8"));
    assert(Number.isSafeInteger(pid) && pid > 0);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (!status || status.slice(status.lastIndexOf(")") + 2).startsWith("Z ")) return false;
    }
    return true;
  };
  for (const name of ["relay-home", "restored-home"]) {
    const home = join(temporary, name);
    if (!(await exists(home))) continue;
    for (const entry of await readdir(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = join(home, entry.name),
        deadline = Date.now() + 30000;
      const metadata = await gitDirectory(root);
      while (
        (await exists(join(metadata, "relay-worker/write.lock"))) ||
        (await exists(join(metadata, "relay-worker-start.json"))) ||
        (await alive(metadata))
      ) {
        assert(Date.now() < deadline, `Worker не завершился; сохранён тестовый каталог ${root}`);
        await delay(50);
      }
    }
  }
}

try {
  const npmVersion = (await runNpm(["--version"], root)).stdout.trim();
  console.log(`Независимые установки: Node.js ${process.version}, npm ${npmVersion}`);
  const installations = Object.fromEntries(
    await Promise.all(
      ["cli", "server", "mcp"].map(async (component) => {
        const manifest = JSON.parse(
          await readFile(join(root, "apps", component, "package.json"), "utf8"),
        );
        const metadata = releaseMetadata(manifest);
        const content = await readPackageContent(join(root, "apps", component), manifest);
        const directory = join(temporary, component);
        await mkdir(directory);
        await writeFile(join(directory, "package.json"), JSON.stringify({ private: true }));
        await runNpm(
          [
            "install",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--workspaces=false",
            join(root, "apps", component, ".artifacts/npm", metadata.archiveName),
          ],
          directory,
        );
        const installed = join(directory, "node_modules", ...manifest.name.split("/"));
        const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
        for (const field of [
          "name",
          "version",
          "repository",
          "homepage",
          "bugs",
          "bin",
          "publishConfig",
          "files",
        ])
          assert.deepEqual(
            packed[field],
            manifest[field],
            `Метаданные установленного пакета: ${field}`,
          );
        await assertInstalledContent(installed, manifest, content);
        assert.equal(packed.scripts, undefined);
        assert.equal(packed.devDependencies, undefined);
        assert(
          !Object.values(packed.dependencies).some((version) =>
            /^(workspace:|file:|link:)/.test(version),
          ),
        );
        const binary = join(installed, manifest.bin[`relay-${component}`]);
        assert.equal(
          (await exec(process.execPath, [binary, "--version"], { cwd: temporary })).stdout.trim(),
          manifest.version,
        );
        const launched = await runNpm(
          ["exec", "--offline", "--", `relay-${component}`, "--version"],
          directory,
        );
        assert.equal(launched.stdout.trim(), manifest.version);
        return [component, { directory, binary, name: packed.name, version: packed.version }];
      }),
    ),
  );
  const workspace = join(temporary, "workspace");
  const remote = join(temporary, "remote");
  await mkdir(workspace);
  await mkdir(remote);
  const invokeResponse = async (cwd, args) => {
    const result = await exec(
      process.execPath,
      [installations.cli.binary, "--format", "json", ...args],
      { cwd, timeout: 20000, env: environment },
    );
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true, result.stdout);
    return response;
  };
  const invoke = async (cwd, args) => (await invokeResponse(cwd, args)).data;
  const createdTaskId = (receipt) => {
    assert.equal(receipt.ref?.kind, "task", "Создание задачи возвращает EntitySaved.ref");
    assert.equal(typeof receipt.ref.id, "string");
    assert(receipt.ref.id.length > 0, "В квитанции создания нужен непустой ref.id");
    return receipt.ref.id;
  };
  for (const name of ["a", "b"]) {
    await mkdir(join(workspace, name));
    await invoke(join(workspace, name), [
      "init",
      "--config",
      join(workspace, name, ".relay/config.json"),
    ]);
  }
  const localTask = await invoke(join(workspace, "a"), [
    "--local",
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Локальная задача А",
    "--actor",
    "smoke",
  ]);
  const localTaskId = createdTaskId(localTask);
  // Новый CLI-процесс проверяет сохранность без привязки к физическому формату хранилища Core.
  const persisted = await invoke(join(workspace, "a"), ["--local", "task", "get", localTaskId]);
  assert.equal(persisted.id, localTaskId);
  assert.equal(persisted.title, "Локальная задача А");
  const local = await startServerProcess(
    [installations.server.binary, "--port", "0", "--format", "json"],
    join(workspace, "a"),
    environment,
  );
  processes.push(local);
  await checkServerSurface(local.url, { web: true });
  assert.equal(
    (await invoke(remote, ["--server-url", local.url, "task", "get", localTaskId])).title,
    "Локальная задача А",
  );
  assert.deepEqual(await readdir(remote), []);
  assert.equal((await (await fetch(`${local.url}/api/v1/server`)).json()).data.mode, "local");

  await invoke(workspace, ["workspace", "project", "init"]);
  const shared = await startServerProcess(
    [installations.server.binary, "--port", "0", "--format", "json"],
    workspace,
    environment,
  );
  processes.push(shared);
  const configPath = join(workspace, "relay.workspace.json");
  const configuration = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...configuration, server: { port: 0, url: shared.url } }),
  );
  for (const name of ["a", "b"])
    await invoke(workspace, ["workspace", "project", "add", name, name]);
  const remoteTask = await invoke(workspace, [
    "b",
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Задача Б через workspace",
    "--actor",
    "smoke",
  ]);
  const remoteTaskId = createdTaskId(remoteTask);
  const [a, b] = await Promise.all([
    invoke(workspace, ["a", "task", "get", localTaskId]),
    invoke(workspace, ["b", "task", "get", remoteTaskId]),
  ]);
  assert.equal(a.title, "Локальная задача А");
  assert.equal(b.title, "Задача Б через workspace");
  const catalog = await invokeResponse(workspace, ["workspace", "project", "list"]);
  const context = catalog.data;
  assert.equal(context.mode, "workspace");
  assert.equal(context.projects.length, 2);
  assert.notEqual(context.projects[0].id, context.projects[1].id);
  assert.equal(catalog.meta.page.count, 2);
  assert.equal(catalog.meta.page.total, 2);
  assert.equal(catalog.meta.page.nextCursor, null);
  assert.equal(catalog.meta.page.nextCommand, null);

  const mcp = await startServerProcess(
    [installations.mcp.binary, "--server-url", shared.url, "--port", "0", "--format", "json"],
    remote,
    environment,
  );
  processes.push(mcp);
  const require = createRequire(join(installations.mcp.directory, "package.json"));
  const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href
  );
  client = new Client({ name: "relay-package-check", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
  assert.deepEqual(client.getServerVersion(), {
    name: installations.mcp.name,
    version: installations.mcp.version,
  });
  const task = await client.callTool({
    name: "board_task_get",
    arguments: { project: "b", reference: remoteTaskId },
  });
  assert.equal(task.structuredContent.data.title, b.title);
  const missing = await client.callTool({
    name: "board_task_get",
    arguments: { reference: localTaskId },
  });
  assert.equal(missing.structuredContent.error.code, "PROJECT_REQUIRED");
  await shared.close();
  const stopped = await client.callTool({
    name: "board_task_get",
    arguments: { project: "a", reference: localTaskId },
  });
  assert.equal(stopped.structuredContent.error.code, "SERVER_UNAVAILABLE");
  assert.equal((await invoke(join(workspace, "a"), ["task", "get", localTaskId])).title, a.title);
  const gitProject = join(temporary, "git-project"),
    gitOrigin = join(temporary, "origin.git");
  await mkdir(gitProject);
  await exec("git", ["init", "--bare", gitOrigin], { cwd: temporary, env: environment });
  await exec("git", ["init", "--initial-branch", "dev"], { cwd: gitProject, env: environment });
  const managed = await invoke(gitProject, ["init"]);
  const gitRoot = dirname(managed.configPath);
  const gitMetadata = await gitDirectory(gitRoot);
  assert((await readFile(join(gitRoot, ".git"), "utf8")).startsWith("gitdir: "));
  assert.equal((await invoke(gitProject, ["sync", "status"])).origin, null);
  const gitTask = await invoke(gitProject, [
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Самостоятельный worker",
    "--actor",
    "smoke",
  ]);
  await exec("git", ["remote", "add", "origin", gitOrigin], { cwd: gitProject, env: environment });
  await invoke(gitProject, ["task", "get", gitTask.ref.id]);
  const deadline = Date.now() + 20000;
  let synchronized = false;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(join(gitMetadata, "relay-sync.json"), "utf8"));
    if (state.generation > 0 && state.remote && state.firstDirty === null && !state.error) {
      synchronized = true;
      break;
    }
    await delay(50);
  }
  assert(synchronized, "Установленный worker должен отправить запись после выхода CLI");
  const restoredHome = join(temporary, "restored-home");
  const restoredCode = join(temporary, "restored-code");
  await mkdir(restoredCode);
  await exec("git", ["init", "--initial-branch", "dev"], { cwd: restoredCode, env: environment });
  await exec("git", ["remote", "add", "origin", gitOrigin], {
    cwd: restoredCode,
    env: environment,
  });
  const gitServer = await startServerProcess(
    [installations.server.binary, "--port", "0", "--format", "json"],
    restoredCode,
    { ...environment, RELAY_HOME: restoredHome },
  );
  processes.push(gitServer);
  const restored = await (
    await fetch(`${gitServer.url}/api/v1/board-tasks/${gitTask.ref.id}`)
  ).json();
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.data.title, "Самостоятельный worker");
  assert.deepEqual((await readdir(gitProject)).sort(), [".git"]);
  await gitServer.close();
  console.log(
    "Проверены три независимые npm-установки: local, workspace A/B, CLI, Web, MCP, Git-bootstrap и отдельный worker после выхода CLI.",
  );
} finally {
  await client?.close();
  for (const process of processes.reverse()) await process.close();
  await waitForManagedWorkers();
  await rm(temporary, { recursive: true, force: true });
}
