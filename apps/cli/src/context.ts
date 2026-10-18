import type { Command } from "commander";
import type { Readable, Writable } from "node:stream";
import type { Result, OutputFormat } from "./queries/result.js";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { connectBackend } from "./backend/connect.js";
import type { ConnectionInfo, ConnectOptions } from "./backend/connect.js";
import type { Backend, WorkspaceInfo } from "./backend/types.js";
import { InputReader } from "./input.js";
import { printResult } from "./output.js";
import type { OutputOptions } from "./output.js";
import { terminalOptions } from "./terminal.js";
import type { ColorMode } from "./terminal.js";
import { commandInvocation } from "./command-kit.js";
import type { RecoveryContext } from "./presentation/recovery.js";
import { synchronizationText, synchronizationWarning } from "./presentation/synchronization.js";

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
  /**
   * Вызов обслуживания с сохранением явного выбора базы и режима:
   * подставляется вместо плейсхолдера `<config>` в подсказках Core только в text-выводе.
   */
  maintenanceCommand?: string;
  recovery?: RecoveryContext;
}
export interface CommandContext {
  writeRequested?: boolean;
  /** Версия, проверяемая Backend при продолжении offset-страницы. */
  offsetVersion?: string;
  /** Подключение, разрешённое один раз до открытия Backend. */
  connection?: ConnectionInfo;
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
    ...(runtime.maintenanceCommand ? { maintenanceCommand: runtime.maintenanceCommand } : {}),
    ...(runtime.recovery ? { recovery: runtime.recovery } : {}),
  };
}

export function action(
  command: Command,
  runtime: Runtime,
  handler: (context: CommandContext) => Promise<Result>,
  options: ConnectOptions = {},
): void {
  command.action(async () => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    const { backend, connection } = await connectBackend(runtime, globals, options);
    const workspace = backend.workspace;
    const output = outputOptions(runtime, globals, workspace.config.output);
    runtime.output = output;
    const context: CommandContext = {
      workspace,
      backend,
      globals,
      output,
      runtime,
      connection,
    };
    if (runtime.recovery) runtime.recovery.command = (args) => commandInvocation(context, args);
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
    const isOverview =
      command.name() === "overview" && !command.opts().metric && command.opts().view !== "map";
    if (backend.synchronization && (context.writeRequested || isOverview)) {
      try {
        const status = await backend.synchronization.status();
        if (status.mode === "git") {
          result.meta = { ...result.meta, synchronization: status };
          if (isOverview) {
            const original = result.text;
            result.text = (options) =>
              [
                typeof original === "function" ? original(options) : (original ?? ""),
                synchronizationText(status, options),
              ].join("\n\n");
          } else {
            const warning = synchronizationWarning(status);
            if (warning) result.warnings = [...(result.warnings ?? []), warning];
          }
        }
      } catch {
        result.warnings = [
          ...(result.warnings ?? []),
          "Результат локальной операции подтверждён, но статус синхронизации получить не удалось.",
        ];
      }
    }
    printResult(runtime.stdout, result, output);
  });
}

export function author(context: CommandContext): string {
  context.writeRequested = true;
  const value = context.globals.actor ?? context.runtime.env.RELAY_ACTOR;
  invariant(value, "ACTOR_REQUIRED", "Для записи укажите --actor или RELAY_ACTOR");
  return parse(actorSchema, value, "автор");
}
