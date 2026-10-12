import { serverUrlSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { selectProject, serverAddress } from "@relay/project-runtime/config";
import { cliConfiguration } from "../configuration.js";
import type { GlobalOptions, Runtime } from "../context.js";
import type { Backend } from "./types.js";
import { resolve } from "node:path";
import { shellCommand } from "../command-kit.js";
import { requireLocalMaintenance } from "@relay/project-runtime/maintenance";

/** Выбор выполняется до openWorkspace: HTTP-команды не создают даже .tasks-runtime. */
export async function connectBackend(
  runtime: Runtime,
  globals: GlobalOptions,
  localOnly = false,
): Promise<Backend> {
  if (localOnly) {
    const serverUrl = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL;
    requireLocalMaintenance({
      ...(globals.local ? { local: true } : {}),
      ...(serverUrl !== undefined ? { serverUrl } : {}),
    });
  }
  const source = await cliConfiguration(runtime, globals).catch((error: unknown) => {
    if (
      error instanceof AppError &&
      error.code === "CONFIG_NOT_FOUND" &&
      !globals.local &&
      (globals.serverUrl ?? runtime.env.RELAY_SERVER_URL)
    )
      return undefined;
    throw error;
  });
  invariant(
    !(source?.kind === "registry" && globals.local),
    "WORKSPACE_REQUIRES_SERVER",
    "В workspace операции с данными выполняются через Relay Server",
  );
  const target =
    source && !(globals.serverUrl && source.kind === "project" && globals.project)
      ? selectProject(source, globals.project)
      : {};
  const configuredUrl =
    globals.serverUrl ??
    runtime.env.RELAY_SERVER_URL ??
    (source?.kind === "registry" ? serverAddress(source) : target.serverUrl);
  if (!globals.local && configuredUrl !== undefined) {
    // Адрес из config/реестра: тот же отказ, что и для флага, без запроса к Server.
    if (localOnly) requireLocalMaintenance({ serverUrl: configuredUrl });
    const url = new URL(parse(serverUrlSchema, configuredUrl, "адрес сервера")).origin;
    const { createHttpBackend } = await import("@relay/project-runtime/backend/http");
    return createHttpBackend(
      url,
      globals.project ?? (source?.kind === "project" ? source.value.projectId : undefined),
    );
  }
  invariant(
    target.configPath,
    "LOCAL_CONFIG_REQUIRED",
    "Для локальной операции нужен path или config проекта",
  );
  // Путь известен до открытия базы: подсказки Core об обслуживании получают его в text.
  runtime.maintenanceCommand = shellCommand([
    "npx",
    "@oim-dev/relay-cli",
    "--local",
    "--config",
    resolve(runtime.cwd, target.configPath),
  ]);
  const { createLocalBackend } = await import("@relay/project-runtime/backend/local");
  return createLocalBackend(runtime.cwd, target.configPath);
}
