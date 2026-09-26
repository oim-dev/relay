import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { observeDevProcess } from "./dev-process.js";

test("Ожидание dev-процесса различает готовность, exit, signal, ошибку запуска и таймаут", async (t) => {
  const start = (source: string, executable = process.execPath) => {
    const child = spawn(executable, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    const monitor = observeDevProcess(child);
    t.after(async () => {
      if (!monitor.closed) child.kill("SIGKILL");
      await monitor.completion;
    });
    return { child, monitor };
  };
  await t.test("успешный typecheck остаётся обязательным", async () => {
    const { monitor } = start('console.log("Found 0 errors."); setInterval(() => {}, 1000)');
    await monitor.waitForTypecheck(5000);
    assert.equal(monitor.closed, false);
  });
  await t.test("HTTP и незавершённый маркер не заменяют успешную компиляцию", async () => {
    const { monitor } = start(
      'console.log("Relay: http://127.0.0.1:4700"); ' +
        'process.stdout.write("Found 0 err"); ' +
        "setInterval(() => {}, 1000)",
    );
    await monitor.waitFor(() => monitor.output.includes("Relay:"), "HTTP", 5000);
    await assert.rejects(monitor.waitForTypecheck(100), /таймаут ожидания/);
    assert.equal(monitor.closed, false);
  });
  await t.test("отложенный typecheck с разбитым выводом подтверждает готовность", async () => {
    const { monitor } = start(
      'console.log("Relay: http://127.0.0.1:4700"); ' +
        'process.stdout.write("Found 0 err"); ' +
        'setTimeout(() => console.log("ors. Watching for file changes."), 200); ' +
        "setInterval(() => {}, 1000)",
    );
    await monitor.waitFor(() => monitor.output.includes("Relay:"), "HTTP", 5000);
    await monitor.waitForTypecheck(5000);
    assert.equal(monitor.closed, false);
  });
  await t.test("живой watch с ошибкой типов не считается готовым", async () => {
    const { monitor } = start(
      'console.log("Found 1 error. Watching for file changes."); setInterval(() => {}, 1000)',
    );
    await monitor.waitFor(() => monitor.output.includes("Found 1 error"), "Запуск", 5000);
    await assert.rejects(
      monitor.waitForTypecheck(5000),
      /компиляция завершилась с ошибками: 1[\s\S]*Found 1 error/,
    );
  });
  await t.test("ранний exit содержит код и вывод", async () => {
    const { monitor } = start('console.error("typecheck failed"); process.exitCode = 7');
    await monitor.completion;
    await assert.rejects(
      monitor.waitFor(() => false, "Typecheck", 5000),
      (error: Error) => {
        assert.match(error.message, /завершился до готовности/);
        assert.match(error.message, /code=7/);
        assert.match(error.message, /\[\d+ мс, stderr\] typecheck failed/);
        return true;
      },
    );
    // Старый маркер успеха не должен скрывать уже завершившийся процесс.
    await assert.rejects(
      monitor.waitFor(() => true, "Готовность"),
      /завершился до готовности/,
    );
  });
  await t.test("таймаут живого процесса содержит бюджет и вывод", async () => {
    const { monitor } = start('console.log("watch started"); setInterval(() => {}, 1000)');
    await monitor.waitFor(() => monitor.output.includes("watch started"), "Запуск", 5000);
    await assert.rejects(
      monitor.waitFor(() => false, "Typecheck", 30),
      (error: Error) => {
        assert.match(error.message, /таймаут ожидания; wait=\d+ мс; budget=30 мс/);
        assert.match(
          error.message,
          /elapsed=\d+ мс; exit=false; close=false; code=null; signal=null/,
        );
        assert.match(error.message, /watch started/);
        return true;
      },
    );
  });
  await t.test("завершение сигналом и намеренная остановка", async () => {
    const { child, monitor } = start('console.log("ready"); setInterval(() => {}, 1000)');
    await monitor.waitFor(() => monitor.output.includes("ready"), "Запуск", 5000);
    child.kill("SIGTERM");
    await monitor.completion;
    await assert.rejects(
      monitor.waitFor(() => false, "Typecheck"),
      /signal=SIGTERM/,
    );
    await monitor.waitFor(() => monitor.closed, "Остановка", 5000, true);
  });
  await t.test("ошибка spawn не выглядит как таймаут", async () => {
    const { monitor } = start("", "/relay-missing-dev-process/node");
    await monitor.completion;
    await assert.rejects(
      monitor.waitFor(() => false, "Запуск"),
      /ошибка запуска.*\n.*ENOENT/,
    );
  });
});
