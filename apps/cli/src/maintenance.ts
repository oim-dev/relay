import type { Command } from "commander";
import { resolve } from "node:path";
import {
  locateMaintenanceTarget,
  requireLocalMaintenance,
} from "@relay/project-runtime/maintenance";
import type { MaintenanceTarget, MaintenanceTransport } from "@relay/project-runtime/maintenance";
import type { GlobalOptions, Runtime } from "./context.js";
import { outputOptions } from "./context.js";
import { shellCommand } from "./command-kit.js";
import { printResult } from "./output.js";
import type { OutputOptions } from "./output.js";
import type { Result } from "./queries/result.js";

/** Контекст обслуживания: без Backend, Workspace и сетевого подключения. */
export interface MaintenanceContext {
  runtime: Runtime;
  globals: GlobalOptions;
  output: OutputOptions;
  target: MaintenanceTarget;
  /** Команда с фактическим выбором базы: `npx @oim-dev/relay-cli --local --config … <args>`. */
  invocation(args: readonly string[]): string;
}

/** Транспорт из флагов и окружения; config server.url проверяет locateMaintenanceTarget. */
export function maintenanceTransport(
  runtime: Runtime,
  globals: GlobalOptions,
): MaintenanceTransport {
  const serverUrl = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL;
  return {
    ...(globals.local ? { local: true } : {}),
    ...(serverUrl !== undefined ? { serverUrl } : {}),
  };
}

/**
 * Обработчик storage status/migrate: сначала отказ HTTP-режима до ввода-вывода, затем поиск
 * базы без текущей схемы проекта, recovery и создания каталогов (A14).
 */
export function maintenanceAction<Options extends object>(
  command: Command,
  runtime: Runtime,
  handler: (context: MaintenanceContext, options: Options) => Promise<Result>,
): void {
  command.action(async () => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    const output = outputOptions(runtime, globals);
    runtime.output = output;
    const transport = maintenanceTransport(runtime, globals);
    requireLocalMaintenance(transport);
    const config = globals.config ?? runtime.env.RELAY_CONFIG;
    const target = await locateMaintenanceTarget({
      cwd: runtime.cwd,
      ...(config !== undefined ? { config } : {}),
      ...(globals.project !== undefined ? { project: globals.project } : {}),
      ...transport,
    });
    runtime.maintenanceCommand = shellCommand([
      "npx",
      "@oim-dev/relay-cli",
      "--local",
      "--config",
      resolve(runtime.cwd, target.configPath),
    ]);
    runtime.output = outputOptions(runtime, globals);
    const context: MaintenanceContext = {
      runtime,
      globals,
      output: runtime.output,
      target,
      invocation: (args) =>
        shellCommand([
          "npx",
          "@oim-dev/relay-cli",
          "--local",
          "--config",
          resolve(runtime.cwd, target.configPath),
          ...args,
        ]),
    };
    const result = await handler(context, command.opts() as Options);
    if (globals.project) result.meta = { ...result.meta, project: globals.project };
    printResult(runtime.stdout, result, runtime.output);
  });
}

/** Единственная реализация Core для CLI и runner; правил миграции в CLI нет. */
export {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "@relay/core/application/storage/maintenance";
