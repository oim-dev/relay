import { createServer, request } from "node:http";
import { once } from "node:events";

/** Проектная часть адреса REST и SSE: `/api/v1/projects/:project/...`. */
const PROJECT_PATH = /^\/api\/v1\/projects\/([^/]+)\/(.*)$/;
/** Управляющий адрес снятия отказа обзора; проходит через прокси Vite вместе с `/api`. */
export const CLEAR_FAULT_PATH = "/api/__e2e/overview-fault/clear";

/**
 * Управляемый прокси между Vite и собственным Relay Server.
 *
 * Считает чтения обзора и открытые SSE-потоки по проектам, удерживает ответы обзора
 * до явного освобождения, подменяет ответы для проверки ошибок, вставляет heartbeat
 * и обрывает потоки. Недоступный upstream отвечает 502, как прокси разработки.
 *
 * @param {string} target Адрес собственного сервера.
 */
export async function startControlProxy(target) {
  let upstream = new URL(target);
  /** @type {Map<string, number>} */
  const overviewReads = new Map();
  /** @type {Map<string, Set<import("node:http").ServerResponse>>} */
  const streams = new Map();
  /** @type {Map<string, number>} */
  const streamsOpened = new Map();
  /** @type {Map<string, {release: () => void}[]>} */
  const held = new Map();
  /** @type {Set<string>} */
  const holding = new Set();
  /** @type {Map<string, {status: number, body: unknown}>} */
  const overviewFaults = new Map();
  /** @type {Map<string, ((value: void) => void)[]>} */
  const readWaiters = new Map();
  /** @type {Map<string, number>} */
  const changedEvents = new Map();
  /** @type {{project: string, at: number, faulted: boolean}[]} */
  const overviewResponses = [];
  /** @type {Map<string, number>} */
  const faultClearedAt = new Map();
  /** @type {{project: string, at: number, event?: string}[]} */
  const readLog = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();

  const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  /** Пересылает запрос на сервер; при отказе upstream отвечает 502. */
  const forward = (incoming, outgoing, onResponse, defer) => {
    const upstreamRequest = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: upstream.host },
      },
      (response) => {
        const deliver = () => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          onResponse?.(response);
          response.pipe(outgoing);
        };
        if (defer === undefined) deliver();
        else defer(deliver);
      },
    );
    upstreamRequest.on("error", () => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({
          ok: false,
          error: { code: "BAD_GATEWAY", message: "Нет связи с сервером" },
        }),
      );
    });
    incoming.pipe(upstreamRequest);
  };

  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://proxy");
    // Управляющий адрес для страницы: снять отказ обзора в том же шаге, что и нажатие кнопки.
    if (incoming.method === "POST" && url.pathname === CLEAR_FAULT_PATH) {
      const target = url.searchParams.get("project") ?? "";
      overviewFaults.delete(target);
      faultClearedAt.set(target, Date.now());
      outgoing.writeHead(204).end();
      return;
    }
    const match = PROJECT_PATH.exec(url.pathname);
    const project = match ? decodeURIComponent(match[1]) : null;
    const rest = match ? match[2] : "";
    if (project !== null && incoming.method === "GET" && rest === "product/overview") {
      increment(overviewReads, project);
      readLog.push({ project, at: Date.now() });
      for (const resolve of readWaiters.get(project) ?? []) resolve();
      readWaiters.delete(project);
      // Исход решается по моменту прихода запроса: снятие отказа позже не меняет его ответ.
      const fault = overviewFaults.get(project);
      overviewResponses.push({ project, at: Date.now(), faulted: fault !== undefined });
      if (fault) {
        outgoing.writeHead(fault.status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(fault.body));
        return;
      }
      if (holding.has(project)) {
        // Сервер читает состояние сразу, удерживается только доставка ответа браузеру.
        forward(incoming, outgoing, undefined, (deliver) => {
          if (!holding.has(project)) {
            deliver();
            return;
          }
          const queue = held.get(project) ?? [];
          queue.push({ release: deliver });
          held.set(project, queue);
        });
        return;
      }
      forward(incoming, outgoing);
      return;
    }
    if (project !== null && incoming.method === "GET" && rest === "events") {
      forward(incoming, outgoing, (response) => {
        if ((response.statusCode ?? 0) !== 200) return;
        increment(streamsOpened, project);
        response.on("data", (chunk) => {
          const matches = String(chunk).match(/^event: changed$/gm);
          if (matches) {
            changedEvents.set(project, (changedEvents.get(project) ?? 0) + matches.length);
            readLog.push({ project, at: Date.now(), event: "changed" });
          }
        });
        const set = streams.get(project) ?? new Set();
        set.add(outgoing);
        streams.set(project, set);
        outgoing.once("close", () => set.delete(outgoing));
      });
      return;
    }
    forward(incoming, outgoing);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Прокси не получил порт");

  return {
    url: `http://127.0.0.1:${address.port}`,
    /** Число GET обзора проекта с запуска прокси. */
    overviewReads: (project) => overviewReads.get(project) ?? 0,
    /** Ожидает следующее чтение обзора проекта. */
    nextOverviewRead: (project) =>
      new Promise((resolve) => {
        const list = readWaiters.get(project) ?? [];
        list.push(resolve);
        readWaiters.set(project, list);
      }),
    /** Журнал чтений обзора и событий changed для отчёта об измерениях. */
    timeline: (project, since) =>
      readLog
        .filter((item) => item.project === project && item.at >= since)
        .map((item) => `${item.event ?? "read"}+${item.at - since}`),
    /** Число событий changed, отправленных сервером в потоки проекта. */
    changedEvents: (project) => changedEvents.get(project) ?? 0,
    /** Открытые сейчас SSE-потоки проекта. */
    openStreams: (project) => streams.get(project)?.size ?? 0,
    /** Все открытые SSE-потоки. */
    totalOpenStreams: () => [...streams.values()].reduce((sum, set) => sum + set.size, 0),
    /** Число успешно открытых SSE-потоков проекта с запуска прокси. */
    streamsOpened: (project) => streamsOpened.get(project) ?? 0,
    /** Удерживает доставку ответов обзора проекта до `release`; сервер читает сразу. */
    hold: (project) => holding.add(project),
    /** Число прочитанных сервером, но ещё не доставленных ответов обзора. */
    heldCount: (project) => held.get(project)?.length ?? 0,
    /** Отпускает удерживаемые запросы в порядке поступления и прекращает удержание. */
    release: (project) => {
      holding.delete(project);
      const queue = held.get(project) ?? [];
      held.delete(project);
      for (const item of queue) item.release();
    },
    /** Отвечает на чтение обзора заданным статусом и телом вместо сервера. */
    failOverview: (project, status, body) => overviewFaults.set(project, { status, body }),
    /** Чтения обзора проекта с указанного момента: время и был ли ответ подменён отказом. */
    overviewResponses: (project, since) =>
      overviewResponses.filter((item) => item.project === project && item.at >= since),
    /** Время последнего снятия отказа управляющим адресом из страницы. */
    faultClearedAt: (project) => faultClearedAt.get(project) ?? null,
    /** Возвращает чтение обзора серверу. */
    restoreOverview: (project) => overviewFaults.delete(project),
    /** Отправляет heartbeat во все открытые потоки проекта. */
    heartbeat: (project) => {
      for (const stream of streams.get(project) ?? [])
        stream.write(`event: heartbeat\ndata: {"timestamp":"${new Date().toISOString()}"}\n\n`);
    },
    /** Отправляет событие во все открытые потоки проекта, например workspace-error. */
    emit: (project, event, data) => {
      for (const stream of streams.get(project) ?? [])
        stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    /** Меняет адрес сервера, например после перезапуска. */
    retarget: (next) => {
      upstream = new URL(next);
    },
    async close() {
      for (const project of held.keys()) holding.delete(project);
      held.clear();
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}
