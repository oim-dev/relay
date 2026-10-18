#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import { startServer } from "@relay/server-runtime";
import { DEFAULT_SERVER_PORT } from "@relay/core/domain/config";
import { asAppError } from "@relay/core/shared/errors";
import manifest from "#manifest" with { type: "json" };

const command = new Command("relay-server")
  .description("Relay Server: один проект или workspace, REST API и веб-интерфейс")
  .version(manifest.version)
  .option(
    "--config <path>",
    ".relay/config.json или relay.workspace.json; по умолчанию поиск вверх",
  )
  .option("--port <number>", `Порт HTTP; RELAY_PORT, server.port или ${DEFAULT_SERVER_PORT}`)
  .option("--actor <id>", "Автор изменений из веб-интерфейса; по умолчанию human")
  .option("--open", "Открыть браузер после запуска")
  .option("--format <format>", "Формат адреса запуска: text или json", "text")
  .exitOverride();

try {
  command.parse();
  const options = command.opts<{
    config?: string;
    port?: string;
    actor?: string;
    open?: boolean;
    format: string;
  }>();
  const config = options.config ?? process.env.RELAY_CONFIG;
  const port = options.port ?? process.env.RELAY_PORT;
  const webPort = process.env.RELAY_WEB_PORT ?? "5173";
  const server = await startServer({
    cwd: process.cwd(),
    ...(process.env.RELAY_HOME === undefined ? {} : { relayHome: process.env.RELAY_HOME }),
    ...(config === undefined ? {} : { config }),
    ...(port === undefined ? {} : { port: /^\d+$/.test(port) ? Number(port) : NaN }),
    actor: options.actor ?? process.env.RELAY_ACTOR ?? "human",
    webRoot: fileURLToPath(new URL("./dist/web/", import.meta.resolve("#manifest"))),
    allowedOrigins: [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`],
  });
  console.log(
    options.format === "json"
      ? JSON.stringify({ ok: true, data: { url: server.url, pid: process.pid } })
      : `Relay: ${server.url}\nSwagger: ${server.url}/api/docs`,
  );
  if (options.open) {
    const binary =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const child = spawn(
      binary,
      process.platform === "win32" ? ["url.dll,FileProtocolHandler", server.url] : [server.url],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => console.log(`Откройте в браузере: ${server.url}`));
    child.unref();
  }
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      void server.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    const failure = asAppError(error);
    console.error(`${failure.code}: ${failure.message}`);
    process.exitCode = failure.exitCode;
  }
}
