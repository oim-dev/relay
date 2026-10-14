import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { commandsFor, requiredJobs, runPhase } from "./ci.mjs";
import { runCheck } from "./check.mjs";
import { subprocessEnv } from "./release/test-env.mjs";

test("полный runner последовательно исполняет обязательные PR-фазы без публикации", async () => {
  const actual = [];
  const logs = [];
  const result = await runCheck({
    execute: async (phase) => {
      actual.push(phase);
      await Promise.resolve();
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(actual, Object.keys(requiredJobs));
  assert.deepEqual(actual.slice(0, 2), ["preflight", "build"]);
  assert.equal(result.status, 0);
  assert.match(logs.at(-1), /УСПЕШНО; пройдено 10\/10/);
  assert(commandsFor("tooling").some((command) => command.includes("check:test")));
  for (const phase of actual) {
    const commands = commandsFor(phase);
    assert(commands.length);
    for (const command of commands)
      assert.doesNotMatch(
        command.join(" "),
        /publish|capture|restore|artifact-id|verified-pr|gate/,
      );
  }
});

for (const failure of [{ status: 7 }, { signal: "SIGTERM" }, { error: new Error("ENOENT") }]) {
  test(`fail-fast: ${failure.status ?? failure.signal ?? failure.error.message}`, async () => {
    const actual = [];
    const logs = [];
    const result = await runCheck({
      execute: async (phase) => {
        actual.push(phase);
        return failure;
      },
      log: (line) => logs.push(line),
    });
    assert.deepEqual(actual, ["preflight"]);
    assert.equal(result.status, failure.status);
    assert.equal(result.signal, failure.signal);
    assert.equal(result.error, failure.error);
    assert.match(logs.at(-2), /НЕ УСПЕШНО; пройдено 0\/10/);
    assert.match(logs.at(-1), /Не пройдены: preflight, build, .*package-smoke/);
  });
}

test("исключение и отмена между фазами не превращаются в успех", async () => {
  const thrown = await runCheck({
    execute: () => {
      throw new Error("ошибка запуска");
    },
    log() {},
  });
  assert.match(thrown.error.message, /ошибка запуска/);
  const controller = new AbortController();
  const actual = [];
  const result = await runCheck({
    signal: controller.signal,
    execute: async (phase) => {
      actual.push(phase);
      controller.abort("SIGINT");
      return { status: 0 };
    },
    log() {},
  });
  assert.deepEqual(actual, ["preflight"]);
  assert.equal(result.signal, "SIGINT");
});

test("workflow, gate и локальный runner используют один обязательный набор", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  // Проверяем текущую блочную форму workflow строго: новая форма требует обновления теста,
  // а не молчаливого исключения job из локального набора.
  const blocks = [
    ...workflow
      .split(/^jobs:\n/m)[1]
      .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm),
  ];
  assert.deepEqual(
    blocks.map((match) => match[1]),
    [...Object.keys(requiredJobs), "gate"],
  );
  for (const [, id, body] of blocks) {
    const phases = [...body.matchAll(/run: node scripts\/ci\.mjs ([\w-]+)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      phases.filter((phase) => !["capture", "restore", "artifact-id"].includes(phase)),
      [id],
    );
  }
  const gate = blocks.find((match) => match[1] === "gate")[2];
  const needs = gate.match(/needs:\s*\[([^\]]+)\]/);
  assert(needs, "Нужен явный список gate.needs");
  assert.deepEqual(
    needs[1].split(",").map((id) => id.trim()),
    Object.keys(requiredJobs),
  );
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts.check, "node scripts/check.mjs");
  assert.equal(manifest.scripts["check:test"], "node --test scripts/check.test.mjs");
  assert(!manifest.scripts.precheck && !manifest.scripts.postcheck);
});

test("runPhase сохраняет ненулевой код и не запускает следующую команду", () => {
  for (const status of [1, 9, 42, 255]) {
    let calls = 0;
    assert.throws(
      () =>
        runPhase("preflight", {
          execute: () => {
            calls++;
            return { status };
          },
        }),
      {
        exitCode: status,
        message: `Фаза preflight остановлена: pnpm run release:check (код ${status})`,
      },
    );
    assert.equal(calls, 1);
  }
});

for (const mode of ["failure", "child-signal", "parent-signal", "npm-wrapper", "ci-helper"]) {
  test(
    `реальный процесс: ${mode}, итог и отсутствие следующей фазы`,
    { skip: process.platform === "win32", timeout: 15000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "relay-check-test-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const pnpm = join(directory, "pnpm");
      const body =
        mode === "failure" || mode === "npm-wrapper" || mode === "ci-helper"
          ? "process.exit(9)"
          : mode === "child-signal"
            ? "process.kill(process.pid, 'SIGTERM')"
            : "console.log('ГОТОВ К СИГНАЛУ'); setInterval(() => {}, 1000)";
      await writeFile(pnpm, `#!${process.execPath}\n${body}\n`);
      await chmod(pnpm, 0o755);
      const child = spawn(
        mode === "npm-wrapper" ? "npm" : process.execPath,
        mode === "npm-wrapper"
          ? ["run", "check"]
          : mode === "ci-helper"
            ? [fileURLToPath(new URL("./ci.mjs", import.meta.url)), "preflight"]
            : [fileURLToPath(new URL("./check.mjs", import.meta.url))],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: subprocessEnv({ PATH: directory + delimiter + process.env.PATH }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      });
      let output = "";
      let interrupted = false;
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (mode === "parent-signal" && !interrupted && output.includes("ГОТОВ К СИГНАЛУ")) {
          interrupted = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve({ status, signal }));
      });
      if (["failure", "npm-wrapper", "ci-helper"].includes(mode)) {
        assert.equal(result.status, 9);
        assert.match(output, /Фаза preflight остановлена: pnpm run release:check \(код 9\)/);
      } else assert.equal(result.signal, "SIGTERM");
      if (mode !== "ci-helper") {
        assert.match(output, /НЕ УСПЕШНО; пройдено 0\/10/);
        assert.match(output, /Не пройдены: preflight, build/);
      }
      assert.doesNotMatch(output, /CI: pnpm run format:check/);
      assert.doesNotMatch(output, /\[2\/10\]/);
    },
  );
}
