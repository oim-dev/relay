import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { API_PREFIX } from "@relay/contracts";
import { serverPortSchema } from "@relay/core/domain/config";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { configurationMode } from "@relay/project-runtime/config";
import { serverConfiguration } from "./modules/workspace/source.js";
import { projectRouting } from "./modules/workspace/routing.js";
import { isErrno } from "@relay/core/shared/errors";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/errors.js";
import { configureHttpPolicy } from "./common/http-policy.js";
import { setupOpenApi } from "./openapi/setup.js";

export interface ServerOptions {
  cwd: string;
  actor: string;
  config?: string;
  /** Переопределяет server.port из конфигурации проекта. */
  port?: number;
  /** Статика подключается явно; undefined или false запускает только API. */
  webRoot?: string | false;
  allowedOrigins?: string[];
}

/**
 * Инициализирует приложение и порт по одному снимку конфигурации проекта.
 */
async function initializeServer(
  options: ServerOptions,
): Promise<{ app: NestFastifyApplication; port: number }> {
  const actor = parse(actorSchema, options.actor, "автор");
  const source = await serverConfiguration(options.cwd, options.config);
  const port = parse(serverPortSchema, options.port ?? source.value.server.port, "порт");
  const candidate = options.webRoot ? resolve(options.webRoot) : undefined;
  let webRoot: string | undefined;
  if (candidate) {
    try {
      if ((await stat(join(candidate, "index.html"))).isFile()) webRoot = candidate;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    logger: false,
    forceCloseConnections: "idle",
    rewriteUrl: projectRouting,
  });
  configureHttpPolicy(adapter.getInstance(), options.allowedOrigins ?? []);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(
      { cwd: options.cwd, configPath: source.path, actor, mode: configurationMode(source) },
      webRoot,
    ),
    adapter,
    { logger: false, abortOnError: false },
  );
  try {
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalFilters(new ApiExceptionFilter());
    setupOpenApi(app);
    await app.init();
    await adapter.getInstance().ready();
    return { app, port };
  } catch (error) {
    await app.close();
    throw error;
  }
}

/**
 * Создаёт сервер без прослушивания порта для встраивания и HTTP-проверок.
 */
export async function createServer(options: ServerOptions): Promise<NestFastifyApplication> {
  return (await initializeServer(options)).app;
}

/**
 * Запускает общий HTTP-сервер на loopback-адресе с настройками проекта.
 */
export async function startServer(options: ServerOptions) {
  const { app, port } = await initializeServer(options);
  try {
    for (let candidate = port; ; candidate += 1) {
      try {
        await app.listen(candidate, "127.0.0.1");
        break;
      } catch (error) {
        if (!isErrno(error, "EADDRINUSE") || candidate === 0 || candidate >= 65535) throw error;
      }
    }
    return { app, url: await app.getUrl(), close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
