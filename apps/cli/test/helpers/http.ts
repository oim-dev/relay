import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startServer } from "@relay/server-runtime";
import { fixtureCleanup, type FixtureContext } from "./cli.js";

/** Настоящий runtime; порт выбирает ОС, завершение регистрируется до проверок. */
export async function httpServer(t: FixtureContext, cwd: string) {
  const server = await startServer({ cwd, actor: "server-fixture", port: 0 });
  fixtureCleanup(t, () => server.close());
  return server;
}

/** Передайте signal в upstream fetch: teardown отменит его и дождётся обработчика. */
export async function httpProxy(
  t: FixtureContext,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const errors: unknown[] = [];
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task = handler(request, response, controller.signal)
      .catch((error: unknown) => {
        // Только собственная отмена teardown ожидаема; остальные ошибки сохраняются.
        if (!controller.signal.aborted || error !== controller.signal.reason) errors.push(error);
        response.destroy();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  fixtureCleanup(t, async () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    controller.abort();
    server.closeAllConnections();
    // Не закрываем upstream Server, пока обработчики прокси ещё используют его.
    await Promise.all([closed, ...pending]);
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
