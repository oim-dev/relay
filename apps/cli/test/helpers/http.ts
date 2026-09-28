import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import { startServer } from "@relay/server-runtime";

/** Настоящий runtime; порт выбирает ОС, завершение регистрируется до проверок. */
export async function httpServer(t: TestContext, cwd: string) {
  const server = await startServer({ cwd, actor: "server-fixture", port: 0 });
  t.after(() => server.close());
  return server;
}

export async function httpProxy(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(errors, [], "Ошибки самого HTTP fixture");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}` };
}
