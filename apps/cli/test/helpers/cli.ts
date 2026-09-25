import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

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
    hasMore?: boolean;
    nextCursor?: string | null;
    truncated?: boolean;
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
interface RunOptions {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
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
      [...(options.nodeArgs ?? []), binary, ...args.map(String)],
      {
        cwd,
        env: { ...process.env, RELAY_ACTOR: "orchestrator", ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
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
  // Core canonicalizes storage paths, including macOS temporary-directory symlinks.
  const root = await realpath(await mkdtemp(join(tmpdir(), "tasks-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  successful(await invoke(root, ["init"]));
  return {
    root,
    run: <T = unknown>(args: Array<string | number>, options?: RunOptions) =>
      invoke<T>(root, args, options),
    async create(title: string, args: Array<string | number> = []): Promise<string> {
      return successful(
        await invoke<{ id: string }>(root, [
          "task",
          "create",
          "--board",
          "product",
          "--title",
          title,
          ...args,
        ]),
      ).data.id;
    },
  };
}
