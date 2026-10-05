import type { Command } from "commander";
import type { Readable, Writable } from "node:stream";
import type { Result, OutputFormat } from "./queries/result.js";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { connectBackend } from "./backend/connect.js";
import type { Backend, WorkspaceInfo } from "./backend/types.js";
import { InputReader } from "./input.js";
import { printResult } from "./output.js";
import type { OutputOptions } from "./output.js";
import { terminalOptions } from "./terminal.js";
import type { ColorMode } from "./terminal.js";
import { cliConfiguration } from "./configuration.js";
import { selectProject, serverAddress } from "@relay/project-runtime/config";

export interface GlobalOptions {
  config?: string;
  project?: string;
  serverUrl?: string;
  local?: boolean;
  actor?: string;
  format?: OutputFormat;
  maxBytes?: number;
  color?: ColorMode;
}
export interface Runtime {
  cwd: string;
  stdout: Writable;
  input: InputReader;
  env: NodeJS.ProcessEnv;
  output: OutputOptions;
  helpCommand?: string;
  /** Код выхода успешно напечатанного результата с частичным отказом; по умолчанию 0. */
  exitCode?: number;
}
export interface CommandContext {
  /** Версия, проверяемая Backend при продолжении offset-страницы. */
  offsetVersion?: string;
  /** Фактически выбранный HTTP origin; не адрес сервера из удалённого конфига. */
  connection?: string;
  workspace: WorkspaceInfo;
  backend: Backend;
  runtime: Runtime;
  output: OutputOptions;
  globals: GlobalOptions;
}

export function runtime(stdin: Readable, stdout: Writable, cwd = process.cwd()): Runtime {
  return {
    cwd,
    stdout,
    input: new InputReader(stdin, cwd),
    env: process.env,
    output: { format: "text", text: terminalOptions(stdout, process.env) },
  };
}

export function outputOptions(
  runtime: Runtime,
  globals: GlobalOptions,
  _defaults = runtime.output,
): OutputOptions {
  const format = globals.format ?? "text";
  return {
    format,
    text: terminalOptions(runtime.stdout, runtime.env),
  };
}

export function action(
  command: Command,
  runtime: Runtime,
  handler: (context: CommandContext) => Promise<Result>,
): void {
  command.action(async () => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    const backend = await connectBackend(runtime, globals, command.name() === "migrate");
    const workspace = backend.workspace;
    const output = outputOptions(runtime, globals, workspace.config.output);
    runtime.output = output;
    const context: CommandContext = {
      workspace,
      backend,
      globals,
      output,
      runtime,
    };
    if (backend.kind === "http") {
      let url = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL;
      if (!url) {
        const source = await cliConfiguration(runtime, globals);
        url =
          source.kind === "registry"
            ? serverAddress(source)
            : selectProject(source, globals.project).serverUrl;
      }
      if (url) context.connection = new URL(url).origin;
    }
    let result: Result;
    try {
      result = await handler(context);
    } catch (error) {
      if (
        context.offsetVersion &&
        error instanceof AppError &&
        /VERSION|SNAPSHOT|STALE|_CHANGED$/.test(error.code) &&
        /CONFLICT|MISMATCH|CHANGED|STALE/.test(error.code)
      ) {
        throw new AppError(
          error.code,
          error.message.includes("историческому снимку")
            ? error.message
            : `${error.message} Курсор устарел: версия проверяет неизменность текущего состояния и не даёт доступа к историческому снимку. Начните чтение заново без --cursor`,
          error.exitCode,
          error.details,
        );
      }
      throw error;
    }
    if (globals.project) result.meta = { ...result.meta, project: globals.project };
    printResult(runtime.stdout, result, output);
    if (result.exitCode) runtime.exitCode = result.exitCode;
  });
}

export function author(context: CommandContext): string {
  const value = context.globals.actor ?? context.runtime.env.RELAY_ACTOR;
  invariant(value, "ACTOR_REQUIRED", "Для записи укажите --actor или RELAY_ACTOR");
  return parse(actorSchema, value, "автор");
}
