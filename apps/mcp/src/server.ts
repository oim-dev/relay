import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readConfiguration, serverAddress } from "@relay/project-runtime/config";
import { DEFAULT_MCP_PORT, serverPortSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { Projects } from "./projects.js";
import { createTools } from "./tools.js";

export async function startMcp(options: {
  cwd: string;
  config?: string;
  port?: number;
  serverUrl?: string;
}) {
  const source = options.serverUrl
    ? undefined
    : await readConfiguration(options.cwd, options.config, false, { managed: false });
  const port = parse(
    serverPortSchema,
    options.port ?? source?.value.mcp?.port ?? DEFAULT_MCP_PORT,
    "порт MCP",
  );
  const projects = new Projects(options.serverUrl ?? serverAddress(source!));
  await projects.source();
  const active = new Set<Promise<void>>();
  const http = createServer((request, reply) => {
    if (request.url !== "/mcp") {
      reply.writeHead(404).end();
      return;
    }
    const host = request.headers.host;
    const actual = http.address();
    const actualPort = actual && typeof actual !== "string" ? actual.port : port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (
      !host ||
      !allowedHosts.includes(host) ||
      (request.headers.origin &&
        !allowedHosts.map((value) => `http://${value}`).includes(request.headers.origin))
    ) {
      reply.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      reply.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Отдельный transport на запрос: состояние клиента и автора не разделяется между агентами.
    const server = createTools(projects);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const operation = (async () => {
      try {
        // SDK объявляет необязательные callbacks в Transport и явный undefined в реализации.
        await server.connect(transport as Transport);
        await transport.handleRequest(request, reply);
      } catch {
        if (!reply.headersSent) reply.writeHead(500).end();
        else reply.end();
      } finally {
        await server.close();
      }
    })();
    active.add(operation);
    void operation.finally(() => active.delete(operation)).catch(() => {});
  });
  http.requestTimeout = 30000;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        http.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await projects.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Не удалось определить порт MCP");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    configPath: source?.path ?? null,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.all(active);
        await projects.close();
      })();
      return closing;
    },
  };
}
