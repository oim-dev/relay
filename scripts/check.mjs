import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { jobDependencies, requiredJobs } from "./ci.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)} с`;
export const DEFAULT_JOBS = 2;

export function checkOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { jobs: { type: "string", short: "j" } } }));
  } catch {
    throw new Error("Параметры проверки: --jobs <положительное целое число> (или -j)");
  }
  const jobs = values.jobs === undefined ? DEFAULT_JOBS : Number(values.jobs);
  if (
    (values.jobs !== undefined && !/^[1-9]\d*$/.test(values.jobs)) ||
    !Number.isSafeInteger(jobs) ||
    jobs < 1
  )
    throw new Error("Для --jobs укажите положительное целое число");
  return { jobs };
}

/** Каждая строка сохраняет владельца, даже когда фазы печатают одновременно. */
function phaseOutput(stream, target, phase) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) target.write(`[${phase}] ${line}\n`);
  });
  return () => {
    if (pending) target.write(`[${phase}] ${pending}\n`);
    pending = "";
  };
}

// Отдельная группа позволяет передать сигнал всей текущей фазе, включая pnpm и тесты.
export function executePhase(phase, { signal } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["scripts/ci.mjs", phase], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const flushOutput = phaseOutput(child.stdout, process.stdout, phase);
    const flushError = phaseOutput(child.stderr, process.stderr, phase);
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
      flushOutput();
      flushError();
      signal?.removeEventListener("abort", interrupt);
      resolveResult({ status, signal: childSignal, error });
    });
  });
}

export async function runCheck({
  execute = executePhase,
  log = console.log,
  signal,
  jobs = DEFAULT_JOBS,
} = {}) {
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new Error("jobs должен быть положительным целым числом");
  const phases = Object.keys(requiredJobs);
  const started = performance.now();
  const passed = [];
  const pending = new Set(phases);
  const running = new Map();
  log(
    `Полная локальная проверка PR: preflight → build, затем до ${Math.min(jobs, phases.length - 2)} независимых фаз одновременно; текущая рабочая копия.`,
  );
  log(
    "Нужны Node.js 24, pnpm 11.18.0, установленные зависимости, Chrome for Testing и его системные библиотеки; для package-smoke — npm 11.16.0 и доступ к npm registry. Автоустановки нет.",
  );
  log("Это не чистые изолированные jobs Actions и не свидетельство verified-pr.");
  let failure;
  const perform = async (phase) => {
    if (signal?.aborted) {
      failure ??= { signal: signal.reason };
      return;
    }
    const phaseStarted = performance.now();
    const index = phases.indexOf(phase);
    log(`[${index + 1}/${phases.length}] ${requiredJobs[phase]} (${phase}): начало`);
    try {
      const result = await execute(phase, { signal });
      if (signal?.aborted || result.error || result.signal || result.status !== 0) {
        const problem = { ...result, signal: signal?.aborted ? signal.reason : result.signal };
        failure ??= problem;
        log(
          `${phase}: НЕ ПРОЙДЕНА (${seconds(performance.now() - phaseStarted)}); ${problem.error?.message ?? problem.signal ?? `код ${problem.status}`}`,
        );
        return;
      }
      passed.push(phase);
      log(`${phase}: успешно (${seconds(performance.now() - phaseStarted)})`);
    } catch (error) {
      failure ??= { error };
      log(`${phase}: НЕ ПРОЙДЕНА: ${error.stack ?? error}`);
    }
  };
  while (pending.size || running.size) {
    if (signal?.aborted) failure ??= { signal: signal.reason };
    if (!failure) {
      for (const phase of pending) {
        if (running.size >= jobs) break;
        if (!jobDependencies[phase].every((dependency) => passed.includes(dependency))) continue;
        pending.delete(phase);
        const task = Promise.resolve()
          .then(() => perform(phase))
          .finally(() => running.delete(phase));
        running.set(phase, task);
      }
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  if (signal?.aborted) failure = { ...failure, signal: signal.reason };
  if (!failure && passed.length !== phases.length)
    failure = { error: new Error("Невозможно запустить оставшиеся фазы: проверьте зависимости") };
  log(
    `Итог: ${failure ? "НЕ УСПЕШНО" : "УСПЕШНО"}; пройдено ${passed.length}/${phases.length}; ${seconds(performance.now() - started)}.`,
  );
  if (failure)
    log(
      `Не пройдены: ${phases.filter((phase) => !passed.includes(phase)).join(", ")}. После ошибки новые фазы не запускались; уже запущенные завершены.`,
    );
  return failure ?? { status: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = checkOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const controller = new AbortController();
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => controller.abort(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await runCheck({ ...options, signal: controller.signal });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  if (result.signal) process.kill(process.pid, result.signal);
  else
    process.exitCode =
      result.status === 0 && !result.error ? 0 : result.status > 0 ? result.status : 1;
}
