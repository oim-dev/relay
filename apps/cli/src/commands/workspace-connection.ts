import { serverAddress } from "@relay/project-runtime/config";
import { serverUrlSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import type { GlobalOptions, Runtime } from "../context.js";
import { cliConfiguration } from "../configuration.js";
import { PresentedError } from "../output.js";
import { shellCommand } from "../command-kit.js";
import { cardText } from "../presentation/common.js";

/** Каталог не выбирает проект и не требует клиентской копии серверного реестра. */
export async function workspaceConnection(runtime: Runtime, globals: GlobalOptions) {
  invariant(
    !globals.local,
    "WORKSPACE_REQUIRES_SERVER",
    "Каталог проектов доступен через Relay Server; уберите --local",
  );
  const explicitUrl = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL;
  const source = await cliConfiguration(runtime, globals).catch((error: unknown) => {
    if (!(error instanceof AppError) || error.code !== "CONFIG_NOT_FOUND") throw error;
    if (explicitUrl !== undefined) return undefined;
    throw new PresentedError(
      error.code,
      "Не найдено подключение к каталогу проектов. Укажите --server-url, RELAY_SERVER_URL или --config существующего workspace",
      error.exitCode,
      error.details,
      (options) =>
        cardText(
          {
            title: "Не найдено подключение к каталогу проектов",
            fields: [
              [
                "Подключение",
                "Укажите --server-url, RELAY_SERVER_URL или --config существующего workspace. Новую базу создавать не нужно.",
              ],
            ],
            commands: [
              {
                purpose: "recovery",
                label: "Варианты подключения",
                command: "npx @oim-dev/relay-cli workspace project list --help",
              },
            ],
          },
          options,
        ),
    );
  });
  const url =
    explicitUrl ?? (source?.kind === "registry" ? serverAddress(source) : source?.value.server.url);
  invariant(
    url !== undefined,
    "REGISTRY_REQUIRED",
    "Укажите --server-url или workspace-конфиг; справка: npx @oim-dev/relay-cli workspace project list --help",
  );
  const endpoint = new URL(parse(serverUrlSchema, url, "адрес Relay Server")).origin;
  const configPath = source?.path;
  const invocation = [
    "npx",
    "@oim-dev/relay-cli",
    ...(configPath &&
    (source.kind === "registry" ||
      globals.config !== undefined ||
      runtime.env.RELAY_CONFIG !== undefined)
      ? ["--config", configPath]
      : []),
    "--server-url",
    endpoint,
    ...(globals.actor ? ["--actor", globals.actor] : []),
    ...(globals.format ? ["--format", globals.format] : []),
  ];
  return {
    endpoint,
    configPath,
    invocation,
    command: (tokens: string[]) => shellCommand([...invocation, ...tokens]),
  };
}
