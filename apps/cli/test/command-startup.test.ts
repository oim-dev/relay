import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliEnv, fixture, successful, tempDirectory } from "./helpers/cli.js";

// Проверяем границы запуска, а не main.ts под заранее загруженным --import tsx.
const entries = [
  { name: "dist", file: "../dist/cli/main.js", nodeArgs: [] },
  {
    name: "source launcher",
    file: "../scripts/dev.mjs",
    nodeArgs: ["--conditions=tasks-source"],
  },
].map((entry) => ({ ...entry, path: fileURLToPath(new URL(entry.file, import.meta.url)) }));

const colors: NodeJS.ProcessEnv[] = [
  {},
  { NO_COLOR: "1" },
  { FORCE_COLOR: "3" },
  { NO_COLOR: "1", FORCE_COLOR: "3" },
];

function launch(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: cliEnv({ NODE_OPTIONS: undefined, NODE_NO_WARNINGS: undefined, ...env }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b/);
  return result;
}

for (const entry of entries) {
  test(`startup: ${entry.name} — text, JSON, help и ошибки без цвета и штатного stderr`, async (t) => {
    const app = await fixture(t);
    const outside = await tempDirectory(t);
    successful(
      await app.run([
        "project",
        "update",
        "--name",
        "Запуск без цвета 🧪 東京",
        "--if-revision",
        1,
      ]),
    );
    const expected = successful(await app.run(["project", "get"]));
    for (const color of colors) {
      const env = {
        ...color,
        COLUMNS: "40",
        TERM: "xterm-256color",
        RELAY_CONFIG: join(app.root, ".relay/config.json"),
      };
      const text = launch(outside, [...entry.nodeArgs, entry.path, "project", "get"], env);
      assert.equal(text.status, 0, text.stdout + text.stderr);
      assert.equal(text.stderr, "");
      assert.match(text.stdout, /PROJECT — Запуск без цвета 🧪 東京/);
      assert.doesNotMatch(text.stdout, /^npx @oim-dev\/relay-cli /m);
      const json = launch(
        outside,
        [...entry.nodeArgs, entry.path, "project", "get", "--format", "json"],
        env,
      );
      assert.equal(json.status, 0, json.stdout + json.stderr);
      assert.equal(json.stderr, "");
      assert.deepEqual(JSON.parse(json.stdout), expected);
      const help = launch(outside, [...entry.nodeArgs, entry.path, "project", "update", "--help"], {
        ...env,
        RELAY_CONFIG: join(outside, "несуществующий.json"),
      });
      assert.equal(help.status, 0, help.stdout + help.stderr);
      assert.equal(help.stderr, "");
      assert.match(help.stdout, /--if-revision/);
      assert.match(help.stdout, /--slug/);
      const error = launch(
        outside,
        [...entry.nodeArgs, entry.path, "project", "get", "--format", "json"],
        { ...color, RELAY_CONFIG: undefined },
      );
      assert.equal(error.status, 2, error.stdout + error.stderr);
      assert.equal(error.stderr, "");
      assert.equal(JSON.parse(error.stdout).error.code, "CONFIG_NOT_FOUND");
    }
  });

  test(`startup: ${entry.name} сохраняет остальные env и настоящие Node warnings`, async (t) => {
    const outside = await tempDirectory(t);
    const url = pathToFileURL(entry.path).href;
    const probe = `
      const unrelatedEnv = () => JSON.stringify(Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !["NO_COLOR", "FORCE_COLOR"].includes(key))
      ));
      const before = unrelatedEnv();
      process.argv = [process.execPath, ${JSON.stringify(entry.path)}, "project", "update", "--help"];
      await import(${JSON.stringify(url)});
      if (before !== unrelatedEnv()) throw new Error("Изменены посторонние env");
      process.emitWarning("Диагностика Node сохранена", { code: "RELAY_STARTUP_PROBE" });
    `;
    const result = launch(outside, [...entry.nodeArgs, "--input-type=module", "--eval", probe], {
      NO_COLOR: "1",
      FORCE_COLOR: "3",
      RELAY_CONFIG: join(outside, "нет-конфига.json"),
      RELAY_ACTOR: "startup-actor",
      RELAY_SERVER_URL: "http://127.0.0.1:1",
      INIT_CWD: outside,
      COLUMNS: "40",
      TERM: "xterm-256color",
      RELAY_STARTUP_SENTINEL: "Остальные env сохранены 🧪",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /--if-revision/);
    assert.match(result.stderr, /\[RELAY_STARTUP_PROBE\] Warning: Диагностика Node сохранена/);
    assert.doesNotMatch(result.stderr, /NO_COLOR|FORCE_COLOR/);
  });
}

test("startup: source launcher сохраняет INIT_CWD при конфликтующих color env", async (t) => {
  const app = await fixture(t);
  const outside = await tempDirectory(t);
  const entry = entries[1]!;
  const expected = successful(await app.run(["project", "get"]));
  const result = launch(
    outside,
    [...entry.nodeArgs, entry.path, "project", "get", "--format", "json"],
    { INIT_CWD: app.root, NO_COLOR: "1", FORCE_COLOR: "3" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
