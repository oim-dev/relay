import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
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
let client;
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
      { cwd, timeout: 20000 },
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
    await invoke(join(workspace, name), ["init"]);
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
  console.log(
    "Проверены три независимые npm-установки: документация из files, local, workspace A/B, CLI, Web и MCP, остановка общего сервера.",
  );
} finally {
  await client?.close();
  for (const process of processes.reverse()) await process.close();
  await rm(temporary, { recursive: true, force: true });
}
