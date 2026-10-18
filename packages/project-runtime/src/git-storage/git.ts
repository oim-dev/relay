import { spawn } from "node:child_process";
import { AppError, invariant } from "@relay/core/shared/errors";

export interface GitOptions {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  timeout?: number;
  /** Бюджет суммарного stdout/stderr; нижний слой не разрешает превышать 128 МиБ. */
  maxBytes?: number;
}

export const LOCAL_GIT_TIMEOUT = 30_000;
export const TRANSFER_GIT_TIMEOUT = 60 * 60_000;

/** Git работает только с переданным каталогом, без унаследованного перенаправления индекса. */
export async function git(cwd: string, args: string[], options: GitOptions = {}) {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  invariant(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 128 * 1024 * 1024,
    "INVALID_ARGUMENT",
    "Бюджет Git должен быть целым числом от 1 до 128 МиБ",
    2,
  );
  invariant(
    options.timeout === undefined || (Number.isSafeInteger(options.timeout) && options.timeout > 0),
    "INVALID_ARGUMENT",
    "Таймаут Git должен быть положительным целым числом миллисекунд",
    2,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(
        key,
      )
    )
      delete env[key];
  Object.assign(
    env,
    {
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Relay Sync",
      GIT_AUTHOR_EMAIL: "relay@localhost",
      GIT_COMMITTER_NAME: "Relay Sync",
      GIT_COMMITTER_EMAIL: "relay@localhost",
    },
    options.env,
  );
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((accept, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.fsync=all",
        "-c",
        "core.fsyncMethod=fsync",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "credential.interactive=false",
        ...args,
      ],
      {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0;
    let failure: AppError | undefined;
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Группа уже завершилась. */
      }
    };
    const timer = setTimeout(
      () => {
        failure = new AppError(
          "SYNC_NETWORK_UNAVAILABLE",
          "Git не завершился за отведённое время; локальные данные сохранены",
          4,
        );
        terminate();
      },
      options.timeout ??
        (["fetch", "push"].includes(args[0] ?? "") ? TRANSFER_GIT_TIMEOUT : LOCAL_GIT_TIMEOUT),
    );
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new AppError("SYNC_TOO_LARGE", "Ответ Git превышает допустимый бюджет", 4, {
          maxBytes,
        });
        terminate();
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(errors, chunk));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new AppError("SYNC_GIT_UNAVAILABLE", "Для Git-базы требуется доступная команда git", 4),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors).toString("utf8"),
      };
      if (result.code && !options.allowFailure)
        reject(
          new AppError(
            "SYNC_GIT_FAILED",
            "Операция Git не выполнена; проверьте доступ к origin и состояние синхронизации",
            4,
            { operation: args[0], exitCode: result.code },
          ),
        );
      else accept(result);
    });
    child.stdin.end(options.input);
  });
}

export async function gitText(cwd: string, args: string[], options: GitOptions = {}) {
  return (await git(cwd, args, options)).stdout.toString("utf8").trim();
}
