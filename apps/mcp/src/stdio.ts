import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfiguration, serverAddress } from "@relay/project-runtime/config";
import { Projects } from "./projects.js";
import { createTools } from "./tools.js";

/** Клиент владеет процессом; stdout содержит только MCP, данные обслуживает Server. */
export async function startStdio(options: { cwd: string; config?: string; serverUrl?: string }) {
  const source = options.serverUrl
    ? undefined
    : await readConfiguration(options.cwd, options.config);
  const projects = new Projects(options.serverUrl ?? serverAddress(source!));
  const server = createTools(projects);
  const transport = new StdioServerTransport();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      process.stdin.removeListener("end", onEnd);
      try {
        await server.close();
      } finally {
        await projects.close();
        process.stdin.pause();
        finish();
      }
    })());
  const onEnd = () => {
    void close();
  };
  process.stdin.once("end", onEnd);
  try {
    // Discovery работает и до запуска API; отказ Server возвращается вызовом инструмента.
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  return { close, closed };
}
