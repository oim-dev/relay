import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EntityDetail } from "@relay/contracts/entities";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { inspectPending, StorageTransaction } from "@relay/core/storage/entity-store/transaction";
import { failed, invoke, invokeRaw, successful, tempDirectory } from "./helpers/cli.js";
import { httpProxy } from "./helpers/http.js";

/** Все файлы, включая WAL, индексы и runtime; также замечаем появление каталогов. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
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

/** Сбой в реальном publisher: валидный WAL генерирует Core, не ручная копия его схемы. */
function crashAt(t: TestContext, predicate: (stage: string, path?: string) => boolean) {
  const publish = StorageTransaction.prototype.publish;
  return t.mock.method(
    StorageTransaction.prototype,
    "publish",
    function (this: StorageTransaction, ...args: Parameters<StorageTransaction["publish"]>) {
      return publish.apply(
        new StorageTransaction(this.root, (stage, path) => {
          if (predicate(stage, path)) throw new Error("Остановка WAL для проверки init");
        }),
        args,
      );
    },
  );
}

test("init: config-present WAL не восстанавливается при выборе source/HTTP, обычный project get выполняет recovery", async (t) => {
  const requests: string[] = [];
  const server = await httpProxy(t, async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(500).end();
  });
  for (const mode of ["found", "explicit", "env", "registry"])
    for (const urlSource of ["none", "flag", "env", "config"])
      await t.test(`${mode}/${urlSource}`, async (t) => {
        const root = await tempDirectory(t);
        const project = join(root, "Проект с 'кавычкой Ω");
        const foreign = join(root, "workspace");
        await mkdir(foreign);
        const workspace = await initialize(project, "tasks");
        const cwd = mode === "found" ? project : foreign;
        const args: string[] = [];
        const env: NodeJS.ProcessEnv = {};
        if (mode === "explicit") args.push("--config", workspace.configPath);
        if (mode === "env") env.RELAY_CONFIG = workspace.configPath;
        if (mode === "registry") {
          await writeFile(
            join(foreign, "relay.workspace.json"),
            JSON.stringify({
              version: 1,
              projects: { alpha: { config: workspace.configPath } },
              ...(urlSource === "config" ? { server: { url: server.url } } : {}),
            }),
          );
          args.push("--project", "alpha");
        } else if (urlSource === "config") {
          const config = JSON.parse(await readFile(workspace.configPath, "utf8"));
          await writeFile(
            workspace.configPath,
            JSON.stringify({ ...config, server: { url: server.url } }),
          );
        }
        if (urlSource === "flag") args.push("--server-url", server.url);
        if (urlSource === "env") env.RELAY_SERVER_URL = server.url;

        const mocked = crashAt(t, (stage) => stage === "intent");
        try {
          await assert.rejects(
            saveProjectSettings(workspace, {
              name: "Принятое имя из WAL",
              slug: "pending-project",
              ifRevision: 1,
            }),
            /Остановка WAL/,
          );
        } finally {
          mocked.mock.restore();
        }
        assert.equal((await inspectPending(workspace.dataRoot)).kind, "operation");
        const before = await snapshot(root);
        const code = urlSource === "none" ? "ALREADY_INITIALIZED" : "LOCAL_ONLY";
        const exit = urlSource === "none" ? 4 : 2;
        failed(await invoke(cwd, [...args, "init"], { env }), code, exit);
        assert.deepEqual(await snapshot(root), before, "JSON init не исполняет WAL до отказа");
        const human = await invokeRaw(cwd, [...args, "init"], { env });
        assert.equal(human.code, exit, human.stdout);
        assert.equal(human.stderr, "");
        assert.ok(human.stdout.includes(code), human.stdout);
        assert.deepEqual(await snapshot(root), before, "text init не исполняет WAL до отказа");
        failed(await invoke(cwd, [...args, "--local", "init"], { env }), "ALREADY_INITIALIZED", 4);
        assert.deepEqual(await snapshot(root), before, "--local не разрешает recovery через init");
        assert.deepEqual(requests, []);

        const readArgs = ["--local", "--config", workspace.configPath, "project", "get"];
        const read = successful(await invoke<EntityDetail>(project, readArgs)).data;
        assert.equal(read.data.kind, "project");
        if (read.data.kind !== "project") throw new Error("Ожидался проект");
        assert.equal(read.data.name, "Принятое имя из WAL");
        assert.equal(read.data.slug, "pending-project");
        assert.equal(read.revision, 2);
        assert.equal(read.ref.id, workspace.config.projectId);
        assert.equal((await inspectPending(workspace.dataRoot)).kind, "none");
        const recovered = await snapshot(root);
        assert.notDeepEqual(recovered, before);
        assert.deepEqual(successful(await invoke(project, readArgs)).data, read);
        assert.deepEqual(
          await snapshot(root),
          recovered,
          "повторное чтение не пишет после recovery",
        );
      });
});

test("init: валидный initial WAL остаётся неизменным при отказе, исходный проект восстанавливается", async (t) => {
  for (const stage of ["intent", "config", "manifest"])
    for (const mode of ["found", "registry"])
      await t.test(`${stage}/${mode}`, async (t) => {
        const root = await tempDirectory(t);
        const project = join(root, "project");
        await mkdir(project);
        const configPath = join(project, ".relay/config.json");
        const dataRoot = join(project, ".relay");
        const mocked = crashAt(t, (current, path) =>
          stage === "intent"
            ? current === "intent"
            : current === "file" && path === (stage === "config" ? "config.json" : "storage.json"),
        );
        try {
          await assert.rejects(initialize(project, "tasks"), /Остановка WAL/);
        } finally {
          mocked.mock.restore();
        }
        const pending = await inspectPending(dataRoot);
        assert.equal(pending.kind, "operation");
        if (pending.kind !== "operation") throw new Error("Ожидался обычный WAL");
        const config = pending.intent.changes.find((change) => change.path === "config.json")!
          .after as { projectId: string };
        let cwd = project;
        const args: string[] = [];
        if (mode === "registry") {
          cwd = root;
          await writeFile(
            join(root, "relay.workspace.json"),
            JSON.stringify({ version: 1, projects: { alpha: { config: configPath } } }),
          );
          args.push("--project", "alpha");
        }
        const before = await snapshot(root);
        failed(await invoke(cwd, [...args, "init"]), "ALREADY_INITIALIZED", 4);
        assert.deepEqual(await snapshot(root), before);
        const human = await invokeRaw(cwd, [...args, "init"]);
        assert.equal(human.code, 4, human.stdout);
        assert.equal(human.stderr, "");
        assert.deepEqual(await snapshot(root), before);
        // Без опубликованного config обычный CLI ещё не может выбрать проект;
        // Core умеет завершать initial intent. При существующем config recovery проверяет сам CLI.
        if (stage === "intent") await openWorkspace(project, configPath);
        const read = successful(await invoke<EntityDetail>(project, ["project", "get"])).data;
        assert.equal(read.ref.id, config.projectId);
        assert.equal(read.revision, 1);
        assert.equal((await inspectPending(dataRoot)).kind, "none");
        const recovered = await snapshot(root);
        successful(await invoke(project, ["project", "get"]));
        assert.deepEqual(await snapshot(root), recovered);
      });
});
