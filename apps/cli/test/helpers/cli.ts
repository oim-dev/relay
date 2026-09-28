import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

/** Не наследуем подключение к рабочей базе. Явные env теста имеют приоритет. */
export function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["RELAY_CONFIG", "RELAY_SERVER_URL", "INIT_CWD"]) delete env[key];
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

export async function tempDirectory(t: TestContext): Promise<string> {
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
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

/** Сквозные проверки запускают CLI отдельно; RELAY_CLI_TEST_SOURCE=1 выбирает исходники с tsx. */
export async function invokeRaw(
  cwd: string,
  args: Array<string | number>,
  options: RunOptions = {},
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

export async function fixture(t: TestContext) {
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
