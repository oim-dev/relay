import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { CliPage } from "../../src/queries/result.js";

export const binary = fileURLToPath(
  new URL(
    process.env.RELAY_CLI_TEST_SOURCE === "1" ? "../../src/main.ts" : "../../dist/cli/main.js",
    import.meta.url,
  ),
);

interface Success<T> {
  ok: true;
  data: T;
  meta?: {
    page?: CliPage;
    project?: string;
  };
}
interface Failure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
export interface Invocation<T> {
  code: number | null;
  stdout: string;
  stderr: string;
  body: Success<T> | Failure;
}
export interface RunOptions {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  timeoutMs?: number;
  /** Проверка границы процесса: main, stdio, сигналы или окружение Node.js. */
  subprocess?: boolean;
}

export type FixtureContext = Pick<TestContext, "after">;
type Cleanup = () => void | Promise<void>;
const fixtureCleanups = new WeakMap<FixtureContext, Cleanup[]>();

/** Ресурсы закрываются до удаления их базы; ошибка не отменяет остальные cleanup. */
export function fixtureCleanup(t: FixtureContext, cleanup: Cleanup): void {
  let cleanups = fixtureCleanups.get(t);
  if (!cleanups) {
    cleanups = [];
    fixtureCleanups.set(t, cleanups);
    const pending = cleanups;
    // Отдельные t.after идут FIFO и прекращаются после ошибки: rm опережал Server.close().
    t.after(async () => {
      const errors: unknown[] = [];
      while (pending.length) {
        try {
          await pending.pop()!();
        } catch (error) {
          errors.push(error);
        }
      }
      fixtureCleanups.delete(t);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Ошибки очистки CLI fixtures");
    });
  }
  cleanups.push(cleanup);
}

/** Не наследуем подключение к рабочей базе и настройки цвета. Явные env теста имеют приоритет. */
export function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["RELAY_CONFIG", "RELAY_SERVER_URL", "INIT_CWD", "FORCE_COLOR", "NO_COLOR"])
    delete env[key];
  return {
    ...env,
    ...(process.env.RELAY_CLI_TEST_SOURCE === "1"
      ? { TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.dev.json", import.meta.url)) }
      : {}),
    RELAY_ACTOR: "test-agent",
    ...overrides,
  };
}

/** Абсолютный loader нужен, поскольку cwd дочернего процесса — изолированная база. */
export const cliNodeArgs =
  process.env.RELAY_CLI_TEST_SOURCE === "1"
    ? ["--conditions=tasks-source", "--import", import.meta.resolve("tsx")]
    : [];

export async function tempDirectory(t: FixtureContext): Promise<string> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "relay-cli-test-"));
  } catch (error) {
    if (
      !["EACCES", "EPERM", "ENOENT", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
    const base = fileURLToPath(new URL("../../../../.artifacts", import.meta.url));
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(join(base, "relay-cli-test-"));
  }
  fixtureCleanup(t, () => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

type EntryPoints = {
  runtime: typeof import("../../src/context.js").runtime;
  runCli: typeof import("../../src/run.js").runCli;
};
let entryPoints: Promise<EntryPoints> | undefined;

/** Настоящий CLI и Backend; у каждого вызова свои потоки, cwd, env и дерево команд. */
export async function invokeRaw(
  cwd: string,
  args: Array<string | number>,
  options: RunOptions = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (
    process.env.RELAY_CLI_TEST_SOURCE === "1" ||
    options.subprocess ||
    options.nodeArgs ||
    options.timeoutMs !== undefined
  )
    return invokeProcess(cwd, args, options);
  entryPoints ??= Promise.all([
    import(new URL("../../dist/cli/context.js", import.meta.url).href),
    import(new URL("../../dist/cli/run.js", import.meta.url).href),
  ]).then(([context, run]) => ({ runtime: context.runtime, runCli: run.runCli }));
  const { runtime, runCli } = await entryPoints;
  let output = "";
  const stdin = Readable.from(options.input === undefined ? [] : [options.input]);
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const io = runtime(stdin, stdout, cwd);
  io.env = cliEnv(options.env);
  try {
    const code = await runCli(args.map(String), io);
    return { code, stdout: output, stderr: "" };
  } finally {
    stdin.destroy();
    stdout.destroy();
  }
}

/** Настоящий main: exit code и stderr проверяются на границе отдельного процесса. */
async function invokeProcess(
  cwd: string,
  args: Array<string | number>,
  options: RunOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...cliNodeArgs, ...(options.nodeArgs ?? []), binary, ...args.map(String)],
      {
        cwd,
        env: cliEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timer = setTimeout(
      () =>
        stop(
          new Error(`CLI превысил timeout ${options.timeoutMs ?? 30_000} мс: ${args.join(" ")}`),
        ),
      options.timeoutMs ?? 30_000,
    );
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

export async function invoke<T = unknown>(
  cwd: string,
  args: Array<string | number>,
  options: RunOptions = {},
): Promise<Invocation<T>> {
  const result = await invokeRaw(cwd, ["--format", "json", ...args], options);
  try {
    return { ...result, body: JSON.parse(result.stdout) as Success<T> | Failure };
  } catch {
    throw new Error(`CLI не вернул JSON: ${result.stdout}\n${result.stderr}`);
  }
}

export function successful<T>(result: Invocation<T>): Success<T> {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.body.ok, result.stdout);
  return result.body;
}

export function failed(result: Invocation<unknown>, code: string, exitCode = 2): void {
  assert.equal(result.code, exitCode, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(!result.body.ok, result.stdout);
  assert.equal(result.body.error.code, code, result.stdout);
}

export async function fixture(t: FixtureContext) {
  const root = await tempDirectory(t);
  successful(await invoke(root, ["init"]));
  return {
    root,
    run: <T = unknown>(args: Array<string | number>, options?: RunOptions) =>
      invoke<T>(root, args, options),
    async create(title: string, args: Array<string | number> = []): Promise<string> {
      return successful(
        await invoke<{ ref: { id: string } }>(root, [
          "task",
          "create",
          "--board",
          "product",
          "--title",
          title,
          ...args,
        ]),
      ).data.ref.id;
    },
  };
}
