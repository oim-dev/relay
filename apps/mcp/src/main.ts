#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import manifest from "#manifest" with { type: "json" };
import { startMcp } from "./server.js";
import { startStdio } from "./stdio.js";
import { DEFAULT_MCP_PORT } from "@relay/core/domain/config";
import { asAppError } from "@relay/core/shared/errors";

const command = new Command("relay-mcp")
  .description("MCP-сервер Relay через HTTP или stdio для одного проекта или реестра")
  .version(manifest.version, "-V, --version", "Показать версию MCP")
  .helpOption("-h, --help", "Показать справку")
  .addOption(
    new Option("--transport <transport>", "Транспорт MCP: HTTP или процесс клиента")
      .choices(["http", "stdio"])
      .default("http"),
  )
  .option("--server-url <url>", "Адрес Relay Server; приоритет над RELAY_SERVER_URL")
  .option("--format <format>", "Формат сообщения запуска: text или json", "text")
  .option(
    "--config <path>",
    "Проектный конфиг или workspace; по умолчанию RELAY_CONFIG или поиск вверх",
  )
  .option(
    "--port <number>",
    `Порт MCP: RELAY_MCP_PORT, mcp.port или ${DEFAULT_MCP_PORT}; 0 выбирает свободный`,
  )
  .exitOverride();
try {
  command.parse();
  const options = command.opts<{
    config?: string;
    port?: string;
    serverUrl?: string;
    format: string;
    transport: "http" | "stdio";
  }>();
  const config = options.config ?? process.env.RELAY_CONFIG;
  const port = options.port ?? process.env.RELAY_MCP_PORT;
  const serverUrl = options.serverUrl ?? process.env.RELAY_SERVER_URL;
  const connection = {
    cwd: process.cwd(),
    ...(config ? { config } : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
  const server =
    options.transport === "stdio"
      ? await startStdio(connection)
      : await startMcp({
          ...connection,
          ...(port === undefined ? {} : { port: /^\d+$/.test(port) ? Number(port) : NaN }),
        });
  if ("url" in server && options.format === "json")
    console.log(JSON.stringify({ ok: true, data: { url: server.url, pid: process.pid } }));
  else if ("url" in server)
    process.stderr.write(
      `Relay MCP: ${server.url}\nRelay Server: ${serverUrl ?? "из конфигурации"}\n`,
    );
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      void server.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if ("closed" in server) void server.closed.then(stop, reject);
  });
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    const failure = asAppError(error);
    process.stderr.write(`${failure.code}: ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}
