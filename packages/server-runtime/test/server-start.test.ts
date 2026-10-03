import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { startServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

test("runtime последовательно пропускает занятые порты и возвращает фактический URL", async (t) => {
  const { root } = await fixture(t);
  // Все три listener удерживаются до запуска: последний освобождаем для Relay.
  const listeners: ReturnType<typeof createTcpServer>[] = [];
  let port = 0;
  for (let index = 0; index < 3; index += 1) {
    const listener = createTcpServer();
    t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    listener.listen(index === 0 ? 0 : port + index, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert(address && typeof address === "object");
    if (index === 0) port = address.port;
    listeners.push(listener);
  }
  await new Promise<void>((resolve) => listeners[2]!.close(() => resolve()));
  const server = await startServer({ cwd: root, actor: "human", port });
  t.after(() => server.close());
  assert.equal(server.url, `http://127.0.0.1:${port + 2}`);
  assert.equal(await server.app.getUrl(), server.url);
  assert.equal((await fetch(`${server.url}/api/v1/health`)).status, 200);
  assert.equal((await fetch(`${server.url}/api/v1/context`)).status, 200);
});

for (const [port, code, attempts] of [
  [4700, "EACCES", [4700]],
  [65534, "EADDRINUSE", [65534, 65535]],
  [0, "EADDRINUSE", [0]],
] as const) {
  test(`runtime сохраняет ${code} и завершает попытки от порта ${port}`, async (t) => {
    const { root } = await fixture(t);
    const failure = Object.assign(new Error("Ошибка listen для проверки"), { code });
    const ports: unknown[] = [];
    t.mock.method(FastifyAdapter.prototype, "listen", (candidate: unknown) => {
      ports.push(candidate);
      throw failure;
    });
    const close = t.mock.method(FastifyAdapter.prototype, "close");
    await assert.rejects(
      startServer({ cwd: root, actor: "human", port }),
      (error) => error === failure,
    );
    assert.deepEqual(ports, attempts);
    assert.equal(close.mock.callCount(), 1);
  });
}

test("runtime сохраняет свободный фиксированный порт и поддерживает порт 0", async (t) => {
  const { root } = await fixture(t);
  const first = await startServer({ cwd: root, actor: "human", port: 0 });
  t.after(() => first.close());
  const port = Number(new URL(first.url).port);
  assert(port > 0);
  await first.close();
  const second = await startServer({ cwd: root, actor: "human", port });
  t.after(() => second.close());
  assert.equal(second.url, first.url);
  assert.equal((await fetch(`${second.url}/api/v1/health`)).status, 200);
});
