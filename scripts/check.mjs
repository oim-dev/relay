import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredJobs } from "./ci.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)} с`;

// Отдельная группа позволяет передать сигнал всей текущей фазе, включая pnpm и тесты.
export function executePhase(phase, { signal } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["scripts/ci.mjs", phase], {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const interrupt = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal.reason);
        else process.kill(-child.pid, signal.reason);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    let error;
    child.on("error", (value) => {
      error = value;
    });
    child.on("close", (status, childSignal) => {
      signal?.removeEventListener("abort", interrupt);
      resolveResult({ status, signal: childSignal, error });
    });
  });
}

export async function runCheck({ execute = executePhase, log = console.log, signal } = {}) {
  const phases = Object.keys(requiredJobs);
  const started = performance.now();
  const passed = [];
  log("Полная локальная проверка PR: без публикации, последовательно, в текущей рабочей копии.");
  log(
    "Нужны Node.js 24, pnpm 11.18.0, установленные зависимости, Chrome for Testing и его системные библиотеки; для package-smoke — npm 11.16.0 и доступ к npm registry. Автоустановки нет.",
  );
  log("Это не чистые изолированные jobs Actions и не свидетельство verified-pr.");
  let failure;
  for (const [index, phase] of phases.entries()) {
    const phaseStarted = performance.now();
    if (signal?.aborted) {
      failure = { signal: signal.reason };
      break;
    }
    log(`[${index + 1}/${phases.length}] ${requiredJobs[phase]} (${phase}): начало`);
    try {
      const result = await execute(phase, { signal });
      if (signal?.aborted || result.error || result.signal || result.status !== 0) {
        failure = { ...result, signal: signal?.aborted ? signal.reason : result.signal };
        log(
          `${phase}: НЕ ПРОЙДЕНА (${seconds(performance.now() - phaseStarted)}); ${failure.error?.message ?? failure.signal ?? `код ${failure.status}`}`,
        );
        break;
      }
      passed.push(phase);
      log(`${phase}: успешно (${seconds(performance.now() - phaseStarted)})`);
    } catch (error) {
      failure = { error };
      log(`${phase}: НЕ ПРОЙДЕНА: ${error.stack ?? error}`);
      break;
    }
  }
  log(
    `Итог: ${failure ? "НЕ УСПЕШНО" : "УСПЕШНО"}; пройдено ${passed.length}/${phases.length}; ${seconds(performance.now() - started)}.`,
  );
  if (failure)
    log(
      `Не пройдены: ${phases.filter((phase) => !passed.includes(phase)).join(", ")}. Последующие стадии не запускались.`,
    );
  return failure ?? { status: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Команда check не принимает аргументы");
  const controller = new AbortController();
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => controller.abort(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await runCheck({ signal: controller.signal });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  if (result.signal) process.kill(process.pid, result.signal);
  else
    process.exitCode =
      result.status === 0 && !result.error ? 0 : result.status > 0 ? result.status : 1;
}
