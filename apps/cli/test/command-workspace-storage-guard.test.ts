import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { binary, cliEnv, cliNodeArgs, failed, invoke, invokeRaw } from "./helpers/cli.js";
import { httpProxy } from "./helpers/http.js";

async function snapshot(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else
        files[name] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
    }
  }
  await walk(path);
  return files;
}

async function runHint(cwd: string, command: string) {
  const launcher = `function npx() { shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
  return promisify(execFile)("bash", ["-c", launcher + command], {
    cwd,
    env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
  });
}

test("STR-03: workspace maintenance предлагает исполнимый direct-config лист без сети и переключения базы", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-workspace-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = {
    alpha: await initialize(join(root, "альфа 'кавычки'"), "tasks"),
    beta: await initialize(join(root, "бета $&"), "tasks"),
  };
  const registry = await initializeRegistry(root);
  for (const [key, project] of Object.entries(projects))
    await registerProject(registry.configPath, key, { config: project.configPath });
  let requests = 0;
  const server = await httpProxy(t, async (_request, reply) => {
    requests++;
    reply.statusCode = 503;
    reply.end("{}");
  });
  const raw = JSON.parse(await readFile(registry.configPath, "utf8"));
  await writeFile(registry.configPath, JSON.stringify({ ...raw, server: { url: server.url } }));
  const registryBefore = await readFile(registry.configPath, "utf8");

  for (const selected of ["alpha", "beta"] as const) {
    const neighbor = selected === "alpha" ? "beta" : "alpha";
    for (const leaf of ["reindex", "reconcile-relations"]) {
      const before = await snapshot(root);
      const result = await invoke(root, [
        "storage",
        leaf,
        "--local",
        "--project",
        selected,
        "--actor",
        "storage 'агент'",
        "--server-url",
        server.url,
      ]);
      failed(result, "LOCAL_CONFIG_REQUIRED");
      assert.deepEqual(
        await snapshot(root),
        before,
        "Guard не открывает Backend и не изменяет даже выбранную базу",
      );
      assert.ok(!result.body.ok);
      const details = result.body.error.details as { configPath: string; next: string };
      assert.equal(details.configPath, projects[selected].configPath);
      assert.match(details.next, /--local --config /);
      assert.match(details.next, /--actor /);
      assert.match(details.next, /--format json/);
      assert.ok(details.next.endsWith(`storage ${leaf}`));
      assert.doesNotMatch(details.next, /--project|--server-url|relay\.workspace\.json/);
      const otherBefore = await snapshot(projects[neighbor].dataRoot);
      const executed = await runHint(root, details.next);
      assert.equal(executed.stderr, "");
      assert.equal(JSON.parse(executed.stdout).ok, true, executed.stdout);
      assert.deepEqual(
        await snapshot(projects[neighbor].dataRoot),
        otherBefore,
        "Соседняя база не изменена после исполнения hint",
      );
      assert.equal(await readFile(registry.configPath, "utf8"), registryBefore);
    }
  }
  const human = await invokeRaw(
    root,
    ["storage", "reindex", "--local", "--project", "alpha", "--format", "text"],
    { env: { COLUMNS: "40" } },
  );
  assert.equal(human.code, 2);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /LOCAL_CONFIG_REQUIRED/);
  const hint = human.stdout.split("\n").find((line) => line.startsWith("npx @oim-dev/relay-cli"));
  assert.ok(hint);
  assert.ok(hint.endsWith("storage reindex"));
  assert.match(hint, /--format text/);

  for (const leaf of ["reindex", "reconcile-relations"]) {
    failed(await invoke(root, ["storage", leaf, "--project", "alpha"]), "LOCAL_REQUIRED");
    failed(await invoke(root, ["storage", leaf, "--local"]), "PROJECT_REQUIRED");
    failed(
      await invoke(root, ["storage", leaf, "--local", "--project", "unknown"]),
      "PROJECT_NOT_FOUND",
      3,
    );
  }
  const single = await initializeRegistry(join(root, "single"));
  await registerProject(single.configPath, "alpha", { config: projects.alpha.configPath });
  failed(
    await invoke(root, ["storage", "reindex", "--local", "--config", single.configPath]),
    "PROJECT_REQUIRED",
  );
  failed(
    await invoke(root, [
      "storage",
      "reindex",
      "--local",
      "--config",
      join(root, "absent"),
      "--project",
      "alpha",
    ]),
    "NOT_FOUND",
    3,
  );
  await writeFile(registry.configPath, "{");
  failed(
    await invoke(root, ["storage", "reindex", "--local", "--project", "alpha"]),
    "INVALID_DATA",
    5,
  );
  assert.equal(requests, 0, "Ни guard, ни direct-config hints не обращались к Server");
});
