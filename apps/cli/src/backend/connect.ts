import { serverUrlSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { selectProject, serverAddress } from "@relay/project-runtime/config";
import { cliConfiguration } from "../configuration.js";
import type { GlobalOptions, Runtime } from "../context.js";
import type { Backend } from "./types.js";
import { localInvocation, shellCommand } from "../command-kit.js";
import { requireLocalMaintenance } from "@relay/project-runtime/maintenance";
import { resolve } from "node:path";

/** Сведения клиента, не поля Config и не пути серверного реестра. */
export interface ConnectionInfo {
  transport: "local" | "http";
  serverUrl?: string;
  serverUrlSource?: "flag" | "env" | "config";
  serverUrlConfigField?: "server.url" | "server.port";
  projectId?: string;
  clientConfig?: {
    path: string;
    mode: "local" | "workspace";
    source: "flag" | "env" | "discovered";
  };
}

export interface ConnectOptions {
  localOnly?: boolean;
  /** Только конфигурационное чтение: без подготовки legacy-каталогов. */
  createLegacyDirectories?: boolean;
}

/** Выбор выполняется до openWorkspace: HTTP-команды не создают даже .tasks-runtime. */
export async function connectBackend(
  runtime: Runtime,
  globals: GlobalOptions,
  options: ConnectOptions = {},
): Promise<{ backend: Backend; connection: ConnectionInfo }> {
  const { localOnly = false } = options;
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
  if (localOnly && globals.local && source?.kind === "registry") {
    const target = selectProject(source, globals.project);
    invariant(
      target.configPath,
      "LOCAL_CONFIG_REQUIRED",
      "Для обслуживания нужен прямой config выбранного проекта",
    );
    const invocation = localInvocation(runtime, globals, target.configPath, true);
    if (globals.actor) invocation.push("--actor", globals.actor);
    if (globals.format) invocation.push("--format", globals.format);
    // helpCommand — путь зарегистрированного листа, не пользовательская shell-строка.
    const command = runtime.helpCommand?.split(" ").slice(2) ?? ["storage", "--help"];
    throw new AppError(
      "LOCAL_CONFIG_REQUIRED",
      "Для обслуживания укажите прямой --local --config выбранного проекта, не реестр workspace. Перед выполнением остановите писателей и сохраните резервную копию.",
      2,
      {
        configPath: target.configPath,
        next: shellCommand([...invocation, ...command]),
      },
    );
  }
  invariant(
    !(source?.kind === "registry" && globals.local),
    "WORKSPACE_REQUIRES_SERVER",
    "В workspace операции с данными выполняются через Relay Server",
  );
  const configuredUrl =
    globals.serverUrl ??
    runtime.env.RELAY_SERVER_URL ??
    (source?.kind === "registry" ? serverAddress(source) : source?.value.server.url);
  // При HTTP клиентский реестр не разрешает key/ID/slug: источник каталога — Server.
  const target =
    source && (globals.local || configuredUrl === undefined)
      ? selectProject(source, globals.project)
      : {};
  const clientConfig: ConnectionInfo["clientConfig"] = source
    ? {
        path: source.path,
        mode: source.kind === "registry" ? "workspace" : "local",
        source:
          globals.config !== undefined
            ? "flag"
            : runtime.env.RELAY_CONFIG !== undefined
              ? "env"
              : "discovered",
      }
    : undefined;
  if (!globals.local && configuredUrl !== undefined) {
    invariant(
      source?.kind !== "registry" || globals.project !== undefined,
      "PROJECT_REQUIRED",
      "В workspace укажите --project: ключ регистрации, ID или slug из каталога Server",
    );
    // Адрес из config/реестра: тот же отказ, что и для флага, без запроса к Server.
    if (localOnly) requireLocalMaintenance({ serverUrl: configuredUrl });
    const url = new URL(parse(serverUrlSchema, configuredUrl, "адрес сервера")).origin;
    const project =
      globals.project ?? (source?.kind === "project" ? source.value.projectId : undefined);
    const config = globals.config ?? runtime.env.RELAY_CONFIG;
    const invocation = [
      "npx",
      "@oim-dev/relay-cli",
      "--server-url",
      url,
      ...(project ? ["--project", project] : []),
      ...(config ? ["--config", resolve(runtime.cwd, config)] : []),
      ...(globals.actor ? ["--actor", globals.actor] : []),
      ...(globals.format ? ["--format", globals.format] : []),
    ];
    runtime.recovery = { command: (args) => shellCommand([...invocation, ...args]) };
    const { createHttpBackend } = await import("@relay/project-runtime/backend/http");
    const backend = await createHttpBackend(url, project);
    return {
      backend,
      connection: {
        transport: "http",
        serverUrl: url,
        serverUrlSource:
          globals.serverUrl !== undefined
            ? "flag"
            : runtime.env.RELAY_SERVER_URL !== undefined
              ? "env"
              : "config",
        ...(globals.serverUrl === undefined && runtime.env.RELAY_SERVER_URL === undefined
          ? {
              serverUrlConfigField: source?.value.server.url
                ? ("server.url" as const)
                : ("server.port" as const),
            }
          : {}),
        ...(backend.workspace.projectId ? { projectId: backend.workspace.projectId } : {}),
        ...(clientConfig ? { clientConfig } : {}),
      },
    };
  }
  invariant(
    target.configPath,
    "LOCAL_CONFIG_REQUIRED",
    "Для локальной операции нужен path или config проекта",
  );
  // Выбор известен до открытия базы; обычному проекту не нужны дополнительные флаги.
  runtime.maintenanceCommand = shellCommand(localInvocation(runtime, globals, target.configPath));
  const invocation = localInvocation(runtime, globals, target.configPath);
  if (globals.project) invocation.push("--project", globals.project);
  if (globals.actor) invocation.push("--actor", globals.actor);
  if (globals.format) invocation.push("--format", globals.format);
  const maintenance = localInvocation(runtime, { ...globals, local: true }, target.configPath);
  if (globals.project) maintenance.push("--project", globals.project);
  if (globals.actor) maintenance.push("--actor", globals.actor);
  if (globals.format) maintenance.push("--format", globals.format);
  runtime.recovery = {
    command: (args) => shellCommand([...invocation, ...args]),
    maintenance: (args) => shellCommand([...maintenance, ...args]),
    actorAvailable: !!(globals.actor ?? runtime.env.RELAY_ACTOR),
  };
  const { createLocalBackend } = await import("@relay/project-runtime/backend/local");
  const backend = await createLocalBackend(runtime.cwd, target.configPath, {
    ...(options.createLegacyDirectories === undefined
      ? {}
      : { createLegacyDirectories: options.createLegacyDirectories }),
  });
  return {
    backend,
    connection: {
      transport: "local",
      ...(backend.workspace.config.projectId
        ? { projectId: backend.workspace.config.projectId }
        : {}),
      ...(clientConfig ? { clientConfig } : {}),
    },
  };
}
