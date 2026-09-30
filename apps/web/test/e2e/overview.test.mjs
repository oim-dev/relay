import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBrowser } from "./helpers/browser.mjs";
import { CLEAR_FAULT_PATH, startControlProxy } from "./helpers/proxy.mjs";
import { seedBreadth, seedCatalog, seedProject } from "./helpers/seed.mjs";
import {
  assertBuilt,
  createWorkspace,
  fingerprint,
  freePort,
  relayApi,
  repositoryRoot,
  runLocalCli,
  startRelayServer,
  startWeb,
  stopAllProcesses,
  until,
} from "./helpers/stack.mjs";

/**
 * Браузерные регрессии экрана «Обзор» (O-13…O-20 плана фичи) на реальных Server и Web.
 * Данные, порты, сервер, прокси и сессия браузера принадлежат только этому запуску.
 */

const screenshots = join(repositoryRoot, ".artifacts/web-e2e-screens");
const measurements = {};
let workspace;
let server;
let serverPort;
let webPort;
let proxy;
let web;
let browser;
let alpha;
let beta;
let gamma;
let delta;
let epsilon;
let alphaApi;
let gammaApi;
let seeded;
let breadth;

const q = (value) => JSON.stringify(value);
const overviewUrl = (project) => `${web.url}/projects/${encodeURIComponent(project.slug)}`;

/** Значение плитки сводных показателей. */
const metric = (label) =>
  `(() => { const item = [...document.querySelectorAll('ul[aria-label="Сводные показатели"] li')].find((li) => li.querySelector('span')?.textContent === ${q(label)}); return item ? Number(item.querySelectorAll('span')[1].textContent) : null; })()`;
/** Число задач колонки в распределении. */
const stage = (label) =>
  `(() => { const item = [...document.querySelectorAll('ul[aria-label="Задачи по колонкам"] li')].find((li) => li.querySelector('span')?.textContent === ${q(label)}); return item ? Number(item.children[2].textContent) : null; })()`;
const freshness = `(document.querySelector('[data-freshness]')?.getAttribute('data-freshness') ?? null)`;
const mainText = `(document.querySelector('main')?.innerText ?? '')`;
const planStatuses = `(document.querySelector('ul[aria-label="Планы по статусам"]')?.innerText ?? '')`;
const heading = `(document.querySelector('main h1')?.textContent ?? '')`;

/** Ждёт условие в странице и возвращает время его наступления по часам страницы. */
const probe = async (expression) => {
  await browser.eval(
    `window.__overviewSeen = null; clearInterval(window.__overviewProbe); window.__overviewProbe = setInterval(() => { try { if (${expression}) { window.__overviewSeen = Date.now(); clearInterval(window.__overviewProbe); } } catch {} }, 20); true`,
  );
  return {
    async seenAfter(start, timeout = 20_000) {
      await browser.waitFor("window.__overviewSeen !== null", timeout);
      return (await browser.eval("window.__overviewSeen")) - start;
    },
  };
};

/** Ждёт, пока чтения обзора не прекратятся на заданное окно. */
const settledReads = async (project, quiet = 1_500) => {
  let last = proxy.overviewReads(project.id);
  let stableSince = Date.now();
  await until(
    () => {
      const current = proxy.overviewReads(project.id);
      if (current !== last) {
        last = current;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= quiet;
    },
    { timeout: 30_000, message: "затихание чтений обзора" },
  );
  return last;
};

const taskRevision = async (id) => (await alphaApi.get(`/board-tasks/${id}`)).revision;
const moveTask = async (id, column) =>
  alphaApi.post(`/board-tasks/${id}/move`, { ifRevision: await taskRevision(id), column });
const createTask = (title, column = "inbox") =>
  alphaApi.post("/board-tasks", { board: "product", title, column });

/**
 * Шаг подъёма стенда: сбой сразу печатается в stderr с названием шага и выводом процессов,
 * не дожидаясь итоговой сводки `node --test`.
 */
const setupStep = async (name, action) => {
  try {
    return await action();
  } catch (error) {
    const logs = [
      server?.logs && `Relay Server:\n${server.logs()}`,
      web?.logs && `Vite:\n${web.logs()}`,
    ]
      .filter(Boolean)
      .join("\n");
    console.error(
      `\n[web-e2e] Стенд не поднят на шаге «${name}»:\n${error?.stack ?? error}${logs ? `\n${logs}` : ""}\n`,
    );
    throw error;
  }
};

before(async () => {
  await setupStep("проверка сборок", assertBuilt);
  await mkdir(screenshots, { recursive: true });
  workspace = await setupStep("временный workspace", () =>
    createWorkspace(["alpha", "beta", "gamma", "delta", "epsilon"]),
  );
  webPort = await freePort();
  serverPort = await freePort();
  server = await setupStep("запуск Relay Server", () =>
    startRelayServer({
      config: workspace.config,
      cwd: workspace.root,
      port: serverPort,
      webPort,
    }),
  );
  proxy = await setupStep("управляющий прокси", () => startControlProxy(server.url));
  web = await setupStep("запуск Vite", () => startWeb({ port: webPort, apiUrl: proxy.url }));
  await setupStep("данные проектов", async () => {
    const registry = await (await fetch(`${server.url}/api/v1/projects`)).json();
    const byKey = Object.fromEntries(
      registry.data.projects.map((project) => [project.key, project]),
    );
    alpha = byKey.alpha;
    beta = byKey.beta;
    gamma = byKey.gamma;
    delta = byKey.delta;
    epsilon = byKey.epsilon;
    gammaApi = relayApi(() => server.url, gamma.id);
    breadth = await seedBreadth(gammaApi);
    alphaApi = relayApi(() => server.url, alpha.id);
    seeded = await seedProject(alphaApi, { name: "Альфа", long: true });
    await relayApi(() => server.url, beta.id).post("/product/records", {
      action: "create",
      fields: {
        kind: "passport",
        name: "Бета",
        summary: "",
        description: "Описание беты без краткой summary.",
      },
    });
  });
  browser = createBrowser(`tasks-web-overview-${process.pid}`);
  await setupStep("запуск браузера agent-browser", async () => {
    await browser.viewport(1440, 1000);
    await browser.media("light");
  });
});

after(async () => {
  // Каждый шаг уборки независим: сбой одного не оставляет живыми остальные ресурсы.
  const cleanup = [
    ["сессия agent-browser", () => browser?.close()],
    ["Vite", () => web?.stop()],
    ["прокси", () => proxy?.close()],
    ["Relay Server", () => server?.stop()],
    ["оставшиеся процессы", stopAllProcesses],
    ["временный workspace", () => workspace?.remove()],
  ];
  for (const [name, action] of cleanup) {
    try {
      await action();
    } catch (error) {
      console.error(`[web-e2e] Уборка «${name}» не удалась: ${error?.message ?? error}`);
    }
  }
  console.log(`Измерения: ${JSON.stringify(measurements)}`);
});

test("O-18/O-01: прямой URL показывает полный срез, пустые состояния и Back/Forward", async () => {
  await browser.open(overviewUrl(alpha));
  await browser.waitFor(`${metric("Задачи")} === 7`);
  assert.match(await browser.eval(heading), /^Альфа/);
  assert.equal(await browser.eval(stage("К выполнению")), 2);
  assert.equal(await browser.eval(stage("Отменено")), 1);
  const text = await browser.eval(mainText);
  assert.match(text, /Ждёт: PRODUCT-3 \(зависимость\)/);
  assert.match(text, /Критерии приёмки выполнены\s+0 из 2/);
  assert.match(text, /Первый этап/);
  assert.match(text, /Выпущенных релизов пока нет/);
  await browser.eval(
    `[...document.querySelectorAll('main a')].find((a) => a.textContent.includes('Все планы')).click(); true`,
  );
  await browser.waitFor(`location.pathname.endsWith('/plans')`);
  await browser.back();
  await browser.waitFor(`${metric("Задачи")} === 7`);
  await browser.forward();
  await browser.waitFor(`location.pathname.endsWith('/plans')`);
  await browser.back();
  await browser.reload();
  await browser.waitFor(`${metric("Задачи")} === 7`);

  await browser.open(overviewUrl(beta));
  await browser.waitFor(`${heading} === 'Бета'`);
  const empty = await browser.eval(mainText);
  assert.match(empty, /Краткое описание не заполнено — показано начало описания паспорта/);
  assert.match(empty, /Описание беты без краткой summary/);
  assert.match(empty, /Сейчас нет задач в работе/);
  assert.match(empty, /Активных планов нет/);
  assert.match(empty, /Нет закреплённых действующих документов/);
  assert.equal(await browser.eval(metric("Задачи")), 0);
});

test("O-13: изменения через HTTP и local CLI появляются без перезагрузки", async () => {
  await browser.open(overviewUrl(alpha));
  await browser.waitFor(`${metric("Задачи")} === 7`);
  const durations = {};

  let check = await probe(`${stage("В работе")} === 2`);
  let start = Date.now();
  await moveTask(seeded.tasks.inbox.id, "in-progress");
  durations.taskColumnHttp = await check.seenAfter(start);

  const criteria = await alphaApi.get(`/board-tasks/${seeded.tasks.ready.id}/criteria`);
  check = await probe(`/Критерии приёмки выполнены\\s+1 из 2/.test(${mainText})`);
  start = Date.now();
  await alphaApi.post(`/board-tasks/${seeded.tasks.ready.id}/criteria`, {
    action: "complete",
    criterionId: criteria.items[0].id,
    completed: true,
    ifRevision: await taskRevision(seeded.tasks.ready.id),
  });
  durations.criterionHttp = await check.seenAfter(start);

  const passport = (await alphaApi.get("/product/state")).records.find(
    (record) => record.fields.kind === "passport",
  );
  check = await probe(`${mainText}.includes('Обновлённая summary паспорта')`);
  start = Date.now();
  await alphaApi.post("/product/records", {
    action: "update",
    id: passport.id,
    ifRevision: passport.revision,
    fields: { ...passport.fields, summary: "Обновлённая summary паспорта" },
  });
  durations.passportHttp = await check.seenAfter(start);

  check = await probe(
    `${metric("Документы")} === 3 && ${mainText}.includes('Новый закреплённый документ')`,
  );
  start = Date.now();
  await alphaApi.post("/product/records", {
    action: "create",
    fields: {
      kind: "document",
      name: "Новый закреплённый документ",
      summary: "",
      body: "Текст",
      documentKind: "decision",
      documentStatus: "active",
      pinned: true,
      links: [],
    },
  });
  durations.documentHttp = await check.seenAfter(start);

  check = await probe(`${mainText}.includes('Второй выпуск')`);
  start = Date.now();
  await alphaApi.post("/releases", {
    title: "Второй выпуск",
    version: "2.0.0",
    planIds: [seeded.plan.id],
  });
  durations.releaseHttp = await check.seenAfter(start);

  const planRevision = async (id) => (await alphaApi.get(`/plans/${id}`)).revision;
  check = await probe(`${mainText}.includes('Этапы: 0 из 2')`);
  start = Date.now();
  await alphaApi.post(`/plans/${seeded.plan.id}/stages`, {
    ifRevision: await planRevision(seeded.plan.id),
    action: "create",
    fields: { title: "Второй этап" },
  });
  durations.planStageHttp = await check.seenAfter(start);

  const second = await alphaApi.post("/plans", {
    title: "Второй план",
    summary: "Проверка смены статуса",
    goal: "Статус плана меняется без перезагрузки.",
  });
  await browser.waitFor(`/Запланированы\\s*1/.test(${planStatuses})`);
  const secondStaged = await alphaApi.post(`/plans/${second.id}/stages`, {
    ifRevision: second.revision,
    action: "create",
    fields: { title: "Этап второго плана" },
  });
  const secondStages = await alphaApi.get(`/plans/${second.id}/stages`);
  const secondFilled = await alphaApi.post(`/plans/${second.id}/tasks`, {
    ifRevision: secondStaged.revision,
    stage: secondStages.items[0].id,
    add: [seeded.tasks.review.id],
  });
  check = await probe(
    `${mainText}.includes('Второй план') && /В работе\\s*2/.test(${planStatuses}) && /Запланированы\\s*0/.test(${planStatuses})`,
  );
  start = Date.now();
  await alphaApi.post(`/plans/${second.id}/transition`, {
    ifRevision: secondFilled.revision,
    action: "start",
  });
  durations.planStatusHttp = await check.seenAfter(start);

  check = await probe(`${metric("Задачи")} === 8`);
  start = Date.now();
  await runLocalCli(alpha.configPath, [
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Создана local CLI",
  ]);
  durations.taskLocalCli = await check.seenAfter(start);

  measurements.convergenceMs = durations;
  for (const [name, value] of Object.entries(durations))
    assert(value < 5_000, `${name}: ${value} мс`);
});

test("O-14: heartbeat не читает обзор, burst объединяется, изменение во время чтения дочитывается", async () => {
  await browser.waitFor(`${freshness} === 'live'`);
  const before = await settledReads(alpha);
  for (let index = 0; index < 3; index += 1) proxy.heartbeat(alpha.id);
  await settledReads(alpha, 2_000);
  assert.equal(proxy.overviewReads(alpha.id), before, "heartbeat вызвал GET обзора");

  const total = await browser.eval(metric("Задачи"));
  const burst = 10;
  const burstStart = proxy.overviewReads(alpha.id);
  const eventsStart = proxy.changedEvents(alpha.id);
  const burstAt = Date.now();
  await Promise.all(Array.from({ length: burst }, (_, index) => createTask(`Пачка ${index}`)));
  await browser.waitFor(`${metric("Задачи")} === ${total + burst}`);
  const burstReads = (await settledReads(alpha)) - burstStart;
  measurements.burst = {
    changes: burst,
    changedEvents: proxy.changedEvents(alpha.id) - eventsStart,
    overviewReads: burstReads,
    timeline: proxy.timeline(alpha.id, burstAt),
  };
  // Сервер растягивает запись пачки во времени; чтения ограничены паузой и пределом ожидания,
  // поэтому их должно быть заметно меньше событий, а не по одному на изменение.
  assert(burstReads >= 1, "пачка не перечитана");
  assert(
    burstReads * 2 <= measurements.burst.changedEvents,
    `чтений ${burstReads} на ${measurements.burst.changedEvents} событий changed`,
  );

  proxy.hold(alpha.id);
  const heldBefore = proxy.overviewReads(alpha.id);
  await createTask("Первое изменение");
  await until(() => proxy.heldCount(alpha.id) >= 1, { message: "удержанный ответ" });
  await createTask("Изменение во время чтения");
  proxy.release(alpha.id);
  await browser.waitFor(`${metric("Задачи")} === ${total + burst + 2}`);
  const readsDuringFlight = (await settledReads(alpha)) - heldBefore;
  measurements.changeDuringRead = { overviewReads: readsDuringFlight };
  assert(readsDuringFlight >= 2, "изменение во время чтения не дочитано");
  assert.equal(await browser.eval(freshness), "live");
});

test("O-15: разрыв, пропущенные изменения, reconnect и workspace-error", async () => {
  const total = await browser.eval(metric("Задачи"));
  await server.stop();
  const stoppedAt = Date.now();
  await browser.waitFor(`${freshness} === 'connecting'`, 15_000);
  await browser.waitFor(`${freshness} === 'offline'`, 20_000);
  measurements.offlineAfterMs = Date.now() - stoppedAt;
  assert.match(await browser.eval(mainText), /Нет связи с сервером обновлений/);
  assert.equal(await browser.eval(metric("Задачи")), total, "устаревшие данные скрыты");

  await runLocalCli(alpha.configPath, [
    "task",
    "create",
    "--board",
    "product",
    "--title",
    "Пока сервер остановлен",
  ]);
  const check = await probe(`${freshness} === 'live' && ${metric("Задачи")} === ${total + 1}`);
  server = await startRelayServer({
    config: workspace.config,
    cwd: workspace.root,
    port: serverPort,
    webPort,
  });
  const restartedAt = Date.now();
  measurements.recoveryAfterRestartMs = await check.seenAfter(restartedAt, 30_000);
  measurements.downtimeMs = restartedAt - stoppedAt;
  assert(
    measurements.recoveryAfterRestartMs <= 5_000,
    `восстановление после перезапуска ${measurements.recoveryAfterRestartMs} мс`,
  );
  assert.doesNotMatch(await browser.eval(mainText), /Нет связи с сервером обновлений/);

  await settledReads(alpha);
  proxy.emit(alpha.id, "workspace-error", {
    code: "STORAGE_ERROR",
    message: "Тестовая ошибка хранилища.",
  });
  await browser.waitFor(`${freshness} === 'storage-error'`);
  const failure = await browser.eval(mainText);
  assert.match(failure, /Ошибка хранилища проекта/);
  assert.match(failure, /Тестовая ошибка хранилища/);
  assert.equal(await browser.eval(metric("Задачи")), total + 1, "ошибка хранилища скрыла данные");
  proxy.emit(alpha.id, "changed", { source: "storage" });
  await browser.waitFor(`${freshness} === 'live'`);
});

test("O-16: поздний ответ, A → B → A, освобождение подписки и один SSE на проект", async () => {
  await browser.waitFor(`${freshness} === 'live'`);
  await until(() => proxy.openStreams(alpha.id) === 1, { message: "один поток проекта A" });
  const total = await browser.eval(metric("Задачи"));
  proxy.hold(alpha.id);
  await createTask("Поздний ответ A");
  await until(() => proxy.heldCount(alpha.id) >= 1, { message: "удержанный ответ A" });

  await browser.command("pushstate", `/projects/${encodeURIComponent(beta.slug)}`);
  await browser.waitFor(`${heading} === 'Бета'`);
  proxy.release(alpha.id);
  await until(() => proxy.openStreams(alpha.id) === 0 && proxy.openStreams(beta.id) === 1, {
    message: "поток A освобождён, поток B единственный",
  });
  const betaText = await browser.eval(mainText);
  assert.equal(await browser.eval(heading), "Бета");
  assert.doesNotMatch(betaText, /Альфа|Поздний ответ A/);
  assert.equal(await browser.eval(metric("Задачи")), 0);

  await browser.command("pushstate", `/projects/${encodeURIComponent(alpha.slug)}`);
  await browser.waitFor(`${metric("Задачи")} === ${total + 1}`);
  assert.match(await browser.eval(heading), /^Альфа/);
  await until(() => proxy.openStreams(alpha.id) === 1 && proxy.totalOpenStreams() === 1, {
    message: "после возврата один поток",
  });

  await browser.command("pushstate", `/projects/${encodeURIComponent(alpha.slug)}/plans`);
  await browser.waitFor(
    `location.pathname.endsWith('/plans') && !document.querySelector('ul[aria-label="Сводные показатели"]')`,
  );
  const leftAt = await settledReads(alpha);
  await createTask("Изменение вне обзора");
  await settledReads(alpha, 2_000);
  assert.equal(proxy.overviewReads(alpha.id), leftAt, "подписка обзора не освобождена");
  assert.equal(proxy.openStreams(alpha.id), 1, "общий поток каркаса закрыт или продублирован");
  await browser.back();
  await browser.waitFor(`${metric("Задачи")} === ${total + 2}`);
});

/**
 * Снимает устойчивый отказ обзора и нажимает «Повторить чтение» одним шагом в странице,
 * затем доказывает, что восстановление пришло от GET, отправленного после нажатия.
 */
const retryByButton = async (project) => {
  const clickedAt = await browser.eval(
    `(async () => { const find = () => [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('Повторить чтение')); const deadline = Date.now() + 15000; let button = find(); while (button && (button.disabled || button.hasAttribute('data-loading')) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 20)); button = find(); } if (!button || button.disabled || button.hasAttribute('data-loading')) return null; await fetch(${q(CLEAR_FAULT_PATH)} + '?project=' + encodeURIComponent(${q(project.id)}), { method: 'POST' }); const at = Date.now(); button.click(); return at; })()`,
  );
  assert.notEqual(clickedAt, null, "кнопка «Повторить чтение» не показана");
  const clearedAt = proxy.faultClearedAt(project.id);
  assert.notEqual(clearedAt, null, "отказ не снят из страницы");
  await until(() => proxy.overviewResponses(project.id, clickedAt).some((item) => !item.faulted), {
    message: "GET обзора после нажатия",
  });
  const beforeClick = proxy
    .overviewResponses(project.id, clearedAt)
    .filter((item) => item.at < clickedAt && !item.faulted);
  assert.deepEqual(beforeClick, [], "обзор восстановился до нажатия кнопки");
};

/** Проверяет, что устойчивый отказ повторяется и не заменяется автоматически. */
const assertStableFailure = async (project, expression) => {
  const since = Date.now();
  await until(() => proxy.overviewResponses(project.id, since).length >= 1, {
    timeout: 10_000,
    message: "повторное чтение при устойчивом отказе",
  }).catch(() => undefined);
  assert(
    proxy.overviewResponses(project.id, since).every((item) => item.faulted),
    "отказ снят без явного переключения",
  );
  assert.equal(await browser.eval(`Boolean(${expression})`), true, "состояние ошибки исчезло");
};

test("O-17: ошибки REST и невалидный DTO не показываются нулями, retry восстанавливает", async () => {
  const noMetrics = `!document.querySelector('ul[aria-label="Сводные показатели"]')`;
  proxy.failOverview(alpha.id, 500, {
    ok: false,
    error: { code: "IO_ERROR", message: "Диск недоступен" },
  });
  await browser.reload();
  await browser.waitFor(`${mainText}.includes('Не удалось загрузить обзор')`);
  let text = await browser.eval(mainText);
  assert.match(text, /Диск недоступен/);
  assert.equal(await browser.eval(noMetrics), true, "ошибка показана нулями");

  proxy.failOverview(alpha.id, 200, { ok: true, data: { productId: "x", snapshot: {} } });
  await browser.reload();
  await browser.waitFor(`${mainText}.includes('неожиданном формате')`);
  assert.equal(await browser.eval(noMetrics), true, "невалидный DTO показан нулями");
  await assertStableFailure(alpha, `${mainText}.includes('неожиданном формате') && ${noMetrics}`);
  await retryByButton(alpha);
  await browser.waitFor(`${metric("Задачи")} !== null`);

  const total = await browser.eval(metric("Задачи"));
  proxy.failOverview(alpha.id, 503, {
    ok: false,
    error: { code: "HTTP_503", message: "Сервер перегружен" },
  });
  await createTask("Во время ошибки чтения");
  await browser.waitFor(`${mainText}.includes('Не удалось обновить обзор')`);
  assert.equal(await browser.eval(freshness), "stale", "бейдж не отражает устаревание");
  text = await browser.eval(mainText);
  assert.equal(await browser.eval(metric("Задачи")), total, "прежние данные не сохранены");
  assert.match(text, /Показаны последние успешно прочитанные данные/);
  await assertStableFailure(alpha, `${mainText}.includes('Не удалось обновить обзор')`);
  await retryByButton(alpha);
  await browser.waitFor(
    `${metric("Задачи")} === ${total + 1} && !${mainText}.includes('Не удалось обновить обзор')`,
  );
  assert.equal(await browser.eval(freshness), "live");

  // Отдельно: без нажатия обзор восстанавливается следующим изменением проекта.
  proxy.failOverview(alpha.id, 503, {
    ok: false,
    error: { code: "HTTP_503", message: "Сервер перегружен" },
  });
  await createTask("Ошибка перед автовосстановлением");
  await browser.waitFor(`${mainText}.includes('Не удалось обновить обзор')`);
  const restoredAt = Date.now();
  proxy.restoreOverview(alpha.id);
  await createTask("Изменение после восстановления сервера");
  await browser.waitFor(
    `${metric("Задачи")} === ${total + 3} && !${mainText}.includes('Не удалось обновить обзор')`,
  );
  assert(
    proxy.overviewResponses(alpha.id, restoredAt).some((item) => !item.faulted),
    "автовосстановление без чтения обзора",
  );
});

test("O-18: SSE-обновление сохраняет фокус и прокрутку", async () => {
  await browser.viewport(1024, 700);
  await browser.waitFor(`${freshness} === 'live'`);
  const total = await browser.eval(metric("Задачи"));
  const before = await browser.eval(
    `(() => { const scroller = document.scrollingElement; scroller.scrollTop = scroller.scrollHeight; const link = [...document.querySelectorAll('main a')].find((a) => a.textContent.includes('Библиотека знаний')); link.focus(); return { top: scroller.scrollTop, focused: document.activeElement === link }; })()`,
  );
  assert.equal(before.focused, true);
  await createTask("Фокус и прокрутка");
  await browser.waitFor(`${metric("Задачи")} === ${total + 1}`);
  const afterUpdate = await browser.eval(
    `({ top: document.scrollingElement.scrollTop, focused: document.activeElement?.textContent ?? '' })`,
  );
  assert(
    Math.abs(afterUpdate.top - before.top) <= 2,
    `прокрутка ${before.top} → ${afterUpdate.top}`,
  );
  assert.match(afterUpdate.focused, /Библиотека знаний/);
});

test("O-19: ширины, темы, длинные названия, доступность, touch и reduced motion", async () => {
  const report = [];
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 1100, 1024, 768, 390]) {
      await browser.viewport(width, 900);
      await browser.media(scheme);
      await browser.waitFor(
        `document.documentElement.getAttribute('data-mantine-color-scheme') === ${q(scheme)} && ${metric("Задачи")} !== null`,
      );
      const layout = await browser.eval(
        `(() => { const root = document.documentElement; const small = [...document.querySelectorAll('main a, main button')].filter((el) => !el.closest('p')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height < 24).length; const overflow = [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).length; const containers = [...document.querySelectorAll('main section[aria-labelledby], main header, main [role="alert"], ul[aria-label="Сводные показатели"] a')]; const escaped = []; for (const container of containers) { const box = container.getBoundingClientRect(); for (const child of container.querySelectorAll('*')) { const rect = child.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; if (rect.right > box.right + 1 || rect.left < box.left - 1) escaped.push((container.querySelector('h2, h3, span')?.textContent ?? container.tagName) + ': ' + (child.textContent ?? '').trim().slice(0, 40) + ' +' + Math.round(Math.max(rect.right - box.right, box.left - rect.left)) + 'px'); } } return { scroll: root.scrollWidth, width: innerWidth, small, overflow, escaped: [...new Set(escaped)] }; })()`,
      );
      const audit = await browser.command("a11y", "--selector", "main");
      const violations = audit.violations.map((item) => `${item.id}(${item.nodeCount})`);
      await browser.eval("scrollTo(0, 0); document.scrollingElement.scrollTop = 0; true");
      await browser.screenshot(join(screenshots, `overview-${scheme}-${width}.png`));
      report.push({ scheme, width, ...layout, violations });
      assert(
        layout.scroll <= layout.width,
        `${scheme} ${width}: горизонтальная прокрутка ${layout.scroll}`,
      );
      assert.equal(layout.overflow, 0, `${scheme} ${width}: элементы за пределами экрана`);
      assert.equal(layout.small, 0, `${scheme} ${width}: цели касания меньше 24px`);
      assert.deepEqual(
        layout.escaped,
        [],
        `${scheme} ${width}: содержимое выходит за пределы панели`,
      );
      assert.deepEqual(violations, [], `${scheme} ${width}: нарушения доступности`);
    }
  }
  measurements.layout = report;

  await browser.media("light", "reduced-motion");
  const motion = await browser.eval(
    `getComputedStyle(document.querySelector('ul[aria-label="Сводные показатели"] a')).transitionDuration`,
  );
  assert.match(motion, /^(0s|1e-05s|0\.00001s)/);

  await browser.viewport(1440, 1000);
  const keyboard = await browser.eval(
    `[...document.querySelectorAll('main a, main button')].filter((el) => el.tabIndex < 0 || el.getAttribute('aria-hidden') === 'true').length`,
  );
  assert.equal(keyboard, 0, "интерактивные элементы недоступны с клавиатуры");
  const labels = await browser.eval(
    `[...document.querySelectorAll('main section')].every((section) => section.getAttribute('aria-labelledby') && document.getElementById(section.getAttribute('aria-labelledby'))?.textContent)`,
  );
  assert.equal(labels, true, "область без доступного названия");
});

/** Текст и ссылки группы «Требует внимания» по заголовку. */
const attentionGroup = (title) =>
  `(() => { const section = [...document.querySelectorAll('main section')].find((item) => item.querySelector(':scope > h3')?.firstChild?.textContent === ${q(title)}); if (!section) return null; return { text: section.innerText, links: [...section.querySelectorAll('a')].map((a) => a.getAttribute('href')), expanded: section.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null }; })()`;
/** Ссылки блока «Доски». */
const boardLinks = `[...document.querySelectorAll('#overview-boards a')].map((a) => a.getAttribute('href'))`;
const activeText = `(document.activeElement?.textContent ?? '')`;

test("O-07/F1: каждая группа внимания раскрывается до полного набора проекта со всех досок", async () => {
  await browser.viewport(1440, 1000);
  await browser.media("light");
  await browser.open(overviewUrl(gamma));
  await browser.waitFor(`${metric("Задачи")} === 24 && ${metric("Доски")} === 8`);
  const base = `/projects/${encodeURIComponent(gamma.slug)}`;
  const groups = [
    { title: "В работе", tasks: breadth.groups.progress },
    { title: "На проверке", tasks: breadth.groups.review },
    { title: "Заблокированы", tasks: breadth.groups.blocked },
  ];
  for (const group of groups) {
    const total = group.tasks.length;
    assert(total > 5, `${group.title}: фикстура больше подборки`);
    const hidden = group.tasks.find((task) => task.board === "app1");
    const hiddenHref = `${base}/boards/app1/${hidden.id}`;
    const before = await browser.eval(attentionGroup(group.title));
    assert.equal(before.links.length, 5, `${group.title}: подборка из пяти`);
    assert.match(before.text, new RegExp(`Показано 5 из ${total}`));
    assert.equal(before.expanded, "false");
    assert(!before.links.includes(hiddenHref), `${group.title}: задача app1 уже в подборке`);

    await browser.command(
      "click",
      `main button[aria-label=${q(`Показать все ${total}: ${group.title}`)}]`,
    );
    await browser.waitFor(
      `(() => { const group = ${attentionGroup(group.title)}; return group?.expanded === 'true' && group.links.length === ${total}; })()`,
    );
    const after = await browser.eval(attentionGroup(group.title));
    for (const task of group.tasks)
      assert(
        after.links.includes(`${base}/boards/${task.board}/${task.id}`),
        `${group.title}: нет ${task.key}`,
      );
    assert.match(after.text, new RegExp(`Показано ${total} из ${total}`));
    // Порядок: доски в порядке каталога (продукт, приложения), внутри доски — по рангу.
    const catalogOrder = ["product", "app1", "app2", "app3", "app4", "app5", "app6"];
    const boardSequence = after.links.map((href) =>
      catalogOrder.indexOf(href.split("/boards/")[1].split("/")[0]),
    );
    assert.deepEqual(
      boardSequence,
      [...boardSequence].sort((left, right) => left - right),
      `${group.title}: доски перемешаны`,
    );
    assert.doesNotMatch(after.text, new RegExp(`Показано 5 из ${total}`));
  }

  // Раскрытие блокеров сохраняет адресные причины: у задач подборки — ключ и вид связи.
  const blockedText = (await browser.eval(attentionGroup("Заблокированы"))).text;
  for (const board of ["product", "app6", "app5"])
    assert.match(
      blockedText,
      new RegExp(`Ждёт: ${board.toUpperCase()}-1 \\(зависимость\\)`),
      `нет причины ${board}`,
    );
  assert.doesNotMatch(blockedText, /Ждёт задач:/);
  // Смешанная группа показывает колонку у каждой задачи, включая карточки подборки.
  assert.equal(blockedText.match(/К выполнению/g)?.length, 7, "колонка показана не у всех");

  // Переход к ранее скрытой задаче другой доски открывает её окно на фактической доске.
  const hidden = breadth.groups.progress.find((task) => task.board === "app1");
  await browser.command("click", `main a[href$=${q(`/boards/app1/${hidden.id}`)}]`);
  await browser.waitFor(`location.pathname === ${q(`${base}/boards/app1/${hidden.id}`)}`);
  await browser.waitFor(`document.body.innerText.includes('Гамма: в работе app1')`);
  await browser.back();
  await browser.waitFor(`${metric("Задачи")} === 24`);

  // Раскрытый список остаётся живым: новая задача другой доски появляется без перезагрузки.
  await browser.command("click", `main button[aria-label="Показать все 8: В работе"]`);
  await browser.waitFor(`${attentionGroup("В работе")}?.links.length === 8`);
  const added = await gammaApi.post("/board-tasks", {
    board: "app3",
    title: "Гамма: новая задача в работе",
    column: "in-progress",
  });
  await browser.waitFor(
    `${metric("Задачи")} === 25 && ${attentionGroup("В работе")}?.links.includes(${q(`${base}/boards/app3/${added.id}`)})`,
  );
  assert.equal(await browser.eval(`${attentionGroup("В работе")}.expanded`), "true");
});

test("O-07/F1: полный список читается по действию, продолжается, сворачивается и переживает ошибку", async () => {
  for (let index = 0; index < 36; index += 1)
    await gammaApi.post("/board-tasks", {
      board: `app${(index % 6) + 1}`,
      title: `Гамма: проверка ${index}`,
      column: "review",
    });
  // Раскрытый список прежней страницы дочитывает изменения по SSE: ждём затихания его запросов.
  let lastReads = proxy.taskListReads(gamma.id, 0).length;
  let quietSince = Date.now();
  await until(
    () => {
      const current = proxy.taskListReads(gamma.id, 0).length;
      if (current !== lastReads) {
        lastReads = current;
        quietSince = Date.now();
      }
      return Date.now() - quietSince >= 1_500;
    },
    { timeout: 30_000, message: "затихание чтений списка прежней страницы" },
  );
  await browser.command("network", "requests", "--clear");
  await browser.open(overviewUrl(gamma));
  await browser.waitFor(`${attentionGroup("На проверке")}?.text.includes('Показано 5 из 43')`);
  await settledReads(gamma);
  // Запросы считаются по журналу сети браузера после очистки перед открытием страницы.
  const pageTaskReads = async () => {
    const data = await browser.command("network", "requests", "--filter", "board-tasks");
    return (data.requests ?? data ?? []).filter((item) =>
      String(item.url).includes("/board-tasks?"),
    );
  };
  assert.deepEqual(await pageTaskReads(), [], "список задач прочитан до раскрытия");

  // Ошибка чтения: подборка остаётся видна, текст говорит о чтении, а не о записи.
  proxy.failTaskList(gamma.id, 500, {
    ok: false,
    error: { code: "IO_ERROR", message: "Диск недоступен" },
  });
  const failedAt = Date.now();
  await browser.command("click", `main button[aria-label="Показать все 43: На проверке"]`);
  await browser.waitFor(
    `${attentionGroup("На проверке")}?.text.includes('Не удалось прочитать полный список задач')`,
  );
  // Дожидаемся исчерпания автоматических повторов SWR, чтобы восстановление дало только кнопка.
  await until(() => proxy.taskListReads(gamma.id, failedAt).length >= 3, {
    timeout: 30_000,
    message: "повторы чтения списка",
  });
  await settledReads(gamma);
  const failed = await browser.eval(attentionGroup("На проверке"));
  assert.equal(failed.links.length, 5, "подборка пропала при ошибке");
  assert.equal(failed.expanded, "true");
  assert.doesNotMatch(failed.text, /отправляли изменения/);
  assert(proxy.taskListReads(gamma.id, failedAt).every((item) => item.faulted));
  proxy.restoreTaskList(gamma.id);
  const retryAt = Date.now();
  await browser.command("find", "role", "button", "click", "--name", "Перечитать список");
  await browser.waitFor(
    `${attentionGroup("На проверке")}?.links.length === 40 && ${attentionGroup("На проверке")}.text.includes('Показано 40 из 43')`,
  );
  assert(
    proxy.taskListReads(gamma.id, retryAt).some((item) => !item.faulted),
    "список восстановлен не чтением после нажатия",
  );
  assert.doesNotMatch(
    (await browser.eval(attentionGroup("На проверке"))).text,
    /Не удалось прочитать/,
  );

  assert((await pageTaskReads()).length > 0, "проверка запросов страницы не видит список");

  // Продолжение: вторая страница той же версии, без дублей и пропусков.
  const firstPage = await browser.eval(attentionGroup("На проверке"));
  await browser.command("find", "role", "button", "click", "--name", "Загрузить ещё");
  await browser.waitFor(`${attentionGroup("На проверке")}?.links.length === 43`);
  const full = await browser.eval(attentionGroup("На проверке"));
  assert.equal(new Set(full.links).size, 43, "дубли в полном списке");
  // Уже показанные задачи остаются на местах, новая порция добавлена в конец.
  assert.deepEqual(full.links.slice(0, 40), firstPage.links, "первые 40 задач переместились");
  assert.equal(full.links.slice(40).filter((href) => firstPage.links.includes(href)).length, 0);
  assert.match(full.text, /Показано 43 из 43/);
  assert.doesNotMatch(full.text, /Загрузить ещё/);
  const pages = proxy
    .taskListReads(gamma.id, retryAt)
    .map((item) => new URLSearchParams(item.query));
  assert(pages.some((query) => query.get("offset") === "40" && query.get("version")));

  // Свёртка возвращает подборку обзора.
  await browser.command("click", `main button[aria-label="Свернуть до подборки: На проверке"]`);
  await browser.waitFor(
    `${attentionGroup("На проверке")}?.expanded === 'false' && ${attentionGroup("На проверке")}.links.length === 5`,
  );
  assert.match((await browser.eval(attentionGroup("На проверке"))).text, /Показано 5 из 43/);
});

test("O-07/F2: доски раскрываются до полного каталога, плитки ведут к своим блокам", async () => {
  await browser.open(overviewUrl(gamma));
  await browser.waitFor(`${metric("Доски")} === 8`);
  const base = `/projects/${encodeURIComponent(gamma.slug)}`;
  const tiles = await browser.eval(
    `[...document.querySelectorAll('ul[aria-label="Сводные показатели"] a')].map((a) => ({ label: a.querySelector('span').textContent, href: a.getAttribute('href') }))`,
  );
  assert.deepEqual(
    tiles.map((tile) => [tile.label, tile.href]),
    [
      ["Задачи", "#overview-tasks"],
      ["Доски", "#overview-boards"],
      ["Документы", `${base}/documents`],
      ["Фичи продукта", `${base}/product/features`],
    ],
  );
  const before = await browser.eval(boardLinks);
  assert.equal(before.length, 5);
  assert.match(
    await browser.eval(`document.getElementById('overview-boards').innerText`),
    /Показано 5 из 8/,
  );
  for (const slug of ["app5", "app6", "infrastructure"])
    assert(!before.includes(`${base}/boards/${slug}`), `${slug} уже в подборке`);

  await browser.command("click", `#overview-boards button[aria-expanded="false"]`);
  await browser.waitFor(`${boardLinks}.length === 8`);
  const all = await browser.eval(boardLinks);
  for (const slug of ["product", "app1", "app2", "app3", "app4", "app5", "app6", "infrastructure"])
    assert(all.includes(`${base}/boards/${slug}`), `в каталоге нет ${slug}`);
  const boardsText = await browser.eval(`document.getElementById('overview-boards').innerText`);
  assert.match(boardsText, /инфраструктура/);
  assert.match(boardsText, /Показано 8 из 8/);

  await browser.command("click", `#overview-boards a[href$="/boards/infrastructure"]`);
  await browser.waitFor(`location.pathname === ${q(`${base}/boards/infrastructure`)}`);
  await browser.back();
  await browser.waitFor(`${metric("Доски")} === 8`);

  // Плитка «Доски» не уводит на одну доску, а прокручивает к блоку с полным каталогом.
  await browser.eval("scrollTo(0, 0); true");
  await browser.command("click", `ul[aria-label="Сводные показатели"] a[href="#overview-boards"]`);
  await browser.waitFor(
    `location.hash === '#overview-boards' && location.pathname === ${q(base)} && (() => { const box = document.getElementById('overview-boards').getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; })()`,
  );
  await browser.command("click", `ul[aria-label="Сводные показатели"] a[href="#overview-tasks"]`);
  await browser.waitFor(`location.hash === '#overview-tasks' && location.pathname === ${q(base)}`);
});

test("O-18/F3: SSE сохраняет вторую страницу досок, фокус и прокрутку; новая версия дочитывается", async () => {
  const api = relayApi(() => server.url, epsilon.id);
  await seedCatalog(api, { name: "Эпсилон", count: 51 });
  const base = `/projects/${encodeURIComponent(epsilon.slug)}`;
  const boardsBlock = `document.getElementById('overview-boards')`;
  const navigationBoards = `[...document.querySelectorAll('[role="group"][aria-label="Доски и задачи"] a')].map((a) => a.getAttribute('href'))`;
  const snapshot = `({ links: ${boardLinks}, text: ${boardsBlock}.innerText, focus: document.activeElement?.getAttribute('href') ?? document.activeElement?.tagName, scrollY: Math.round(scrollY), top: Math.round(${boardsBlock}.querySelector('a[href$="/boards/infrastructure"]').getBoundingClientRect().top) })`;
  /**
   * Ждёт, пока после изменения каталог перечитан целиком: начатое позже `since` чтение
   * второй страницы завершено и ни одно чтение досок проекта не выполняется.
   */
  const boardsRereadAfter = (since) =>
    until(
      () => {
        const reads = proxy.boardReads(epsilon.id, since);
        return (
          reads.some((read) => read.query.get("offset") === "50" && read.doneAt !== null) &&
          reads.every((read) => read.doneAt !== null)
        );
      },
      { timeout: 20_000, message: "перечитывание второй страницы досок" },
    );

  await browser.viewport(1440, 1000);
  await browser.open(overviewUrl(epsilon));
  await browser.waitFor(
    `${mainText}.includes('Показать все доски: 53') && ${freshness} === 'live'`,
  );
  await browser.command("click", `#overview-boards button[aria-expanded="false"]`);
  await browser.waitFor(`${boardLinks}.length === 50`);
  await browser.command("find", "role", "button", "click", "--name", "Загрузить ещё доски");
  await browser.waitFor(
    `${boardLinks}.length === 53 && ${boardsBlock}.innerText.includes('Показано 53 из 53')`,
  );
  const target = `#overview-boards a[href$="/boards/infrastructure"]`;
  await browser.eval(
    `(() => { const link = document.querySelector(${q(target)}); link.scrollIntoView({ block: 'center' }); link.focus(); return true; })()`,
  );
  const initial = await browser.eval(snapshot);
  assert.equal(initial.focus, `${base}/boards/infrastructure`);
  assert.equal(new Set(initial.links).size, 53, "дубли в каталоге");
  // Навигация проекта читает тот же кеш и видит обе страницы.
  assert.equal((await browser.eval(navigationBoards)).length, 53);

  /** Состояние раскрытого каталога не изменилось после фонового обновления. */
  const assertPreserved = async (label, expectedLinks) => {
    const current = await browser.eval(snapshot);
    assert.deepEqual(current.links, expectedLinks, `${label}: состав или порядок досок`);
    assert.match(
      current.text,
      new RegExp(`Показано ${expectedLinks.length} из ${expectedLinks.length}`),
    );
    assert.equal(current.focus, initial.focus, `${label}: фокус`);
    assert(
      Math.abs(current.scrollY - initial.scrollY) <= 2,
      `${label}: прокрутка ${initial.scrollY} → ${current.scrollY}`,
    );
    assert(
      Math.abs(current.top - initial.top) <= 2,
      `${label}: положение ссылки ${initial.top} → ${current.top}`,
    );
  };

  // Изменение только паспорта: каталог и его версия прежние, обе страницы перечитаны.
  const passport = (await api.get("/product/state")).records.find(
    (record) => record.fields.kind === "passport",
  );
  const passportAt = Date.now();
  await api.post("/product/records", {
    action: "update",
    id: passport.id,
    ifRevision: passport.revision,
    fields: { ...passport.fields, summary: "Паспорт обновлён во время чтения каталога" },
  });
  await browser.waitFor(`${mainText}.includes('Паспорт обновлён во время чтения каталога')`);
  await boardsRereadAfter(passportAt);
  await assertPreserved("паспорт", initial.links);

  // Изменение задачи на доске второй страницы.
  const taskAt = Date.now();
  await api.post("/board-tasks", {
    board: "catalog51",
    title: "Эпсилон: задача",
    column: "review",
  });
  await browser.waitFor(`${metric("Задачи")} === 1`);
  await boardsRereadAfter(taskAt);
  await assertPreserved("задача", initial.links);

  // Новая версия каталога: страницы перечитываются от первой с новой версией, без дублей и пропусков.
  const catalogAt = Date.now();
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "application",
      name: "Каталог 52",
      slug: "catalog52",
      summary: "",
      description: "Новая доска после раскрытия",
      type: "frontend",
    },
  });
  await browser.waitFor(`${boardLinks}.length === 54`);
  await boardsRereadAfter(catalogAt);
  const reads = proxy.boardReads(epsilon.id, catalogAt);
  assert(
    reads.every((read) => read.status === 200),
    "продолжение прочитано с несовместимой версией",
  );
  const expected = [...initial.links];
  expected.splice(expected.indexOf(`${base}/boards/infrastructure`), 0, `${base}/boards/catalog52`);
  const updated = await browser.eval(snapshot);
  assert.deepEqual(
    [...updated.links].sort(),
    [...expected].sort(),
    "дубли или пропуски после смены версии",
  );
  assert.match(updated.text, /Показано 54 из 54/);
  assert.equal(updated.focus, initial.focus, "фокус после смены версии");
  assert(
    Math.abs(updated.top - initial.top) <= 60,
    `положение ссылки ${initial.top} → ${updated.top}`,
  );
  // Второй потребитель общего кеша видит актуальный каталог.
  await browser.waitFor(`${navigationBoards}.includes(${q(`${base}/boards/catalog52`)})`);
  assert.equal((await browser.eval(navigationBoards)).length, 54);
  assert.deepEqual(await browser.errors().then((data) => data.errors ?? []), []);
});

test("O-05/O-06: архив, закрытые планы, completedNotReady и закрытые релизы видны в Web", async () => {
  await browser.open(overviewUrl(gamma));
  await browser.waitFor(`${metric("Документы")} === 1`);
  const text = await browser.eval(mainText);
  assert.match(text, /в\sархиве\s1/);
  assert.match(text, /действующих\s0/);
  const plans = await browser.eval(planStatuses);
  assert.match(plans, /Завершены\s*2/);
  assert.match(plans, /Отменены\s*1/);
  assert.match(plans, /В работе\s*0/);
  assert.match(text, /Завершены по статусу, но состав фактически не выполнен: 1/);
  assert.match(text, /Активных планов нет/);
  const releases = await browser.eval(
    `document.querySelector('ul[aria-label="Релизы по статусам"]')?.innerText ?? ''`,
  );
  assert.match(releases, /Выпущены\s*1/);
  assert.match(releases, /Отменены\s*1/);
  assert.match(releases, /Запланированы\s*0/);
  assert.match(text, /Гамма: выпущенный релиз/);
  assert.match(text, /Запланированных релизов нет/);
  assert.doesNotMatch(text, /Гамма: отменённый релиз/);
});

test("O-01: проект без паспорта предлагает заполнить паспорт", async () => {
  await browser.open(overviewUrl(delta));
  await browser.waitFor(`${mainText}.includes('Паспорт продукта ещё не заполнен')`);
  assert.equal(await browser.eval(heading), delta.name);
  const text = await browser.eval(mainText);
  assert.match(text, /Сейчас нет задач в работе/);
  assert.equal(await browser.eval(metric("Задачи")), 0);
  assert.equal(await browser.eval(metric("Доски")), 2);
  await browser.command("click", `main header a[href$="/product/passport/edit"]`);
  await browser.waitFor(
    `location.pathname === ${q(`/projects/${encodeURIComponent(delta.slug)}/product/passport/edit`)}`,
  );
  await browser.waitFor(`!!document.querySelector('main form, main textarea, main input')`);
  await browser.back();
  await browser.waitFor(`${mainText}.includes('Паспорт продукта ещё не заполнен')`);
});

test("O-19: клавиатура — Tab/Enter по плитке, раскрытию и ссылке блока", async () => {
  await browser.viewport(1440, 900);
  await browser.open(overviewUrl(gamma));
  await browser.waitFor(`${metric("Доски")} === 8`);
  const base = `/projects/${encodeURIComponent(gamma.slug)}`;
  const press = (key) => browser.command("press", key);
  /** Нажимает Tab, пока фокус не удовлетворит условию; возвращает число нажатий. */
  const tabUntil = async (expression, limit = 80) => {
    for (let count = 1; count <= limit; count += 1) {
      await press("Tab");
      if (await browser.eval(`Boolean(${expression})`)) return count;
    }
    throw new Error(`Tab не довёл фокус до: ${expression}`);
  };
  await browser.eval("document.activeElement?.blur(); scrollTo(0, 0); true");
  await tabUntil(`document.activeElement?.getAttribute('href') === '#overview-boards'`);
  const outline = await browser.eval(`getComputedStyle(document.activeElement).outlineStyle`);
  assert.notEqual(outline, "none", "фокус плитки не виден");
  await press("Enter");
  await browser.waitFor(`location.hash === '#overview-boards'`);
  // Следующий Tab продолжает с блока досок, а не с начала страницы.
  await press("Tab");
  assert.equal(
    await browser.eval(`Boolean(document.activeElement?.closest('#overview-boards'))`),
    true,
    "фокус после перехода плитки не в блоке досок",
  );
  await tabUntil(
    `document.activeElement?.getAttribute('aria-expanded') === 'false' && document.activeElement.closest('#overview-boards')`,
  );
  await press("Enter");
  await browser.waitFor(`${boardLinks}.length === 8`);
  assert.equal(await browser.eval(`document.activeElement?.getAttribute('aria-expanded')`), "true");
  await press("Shift+Tab");
  assert.match(
    await browser.eval(`document.activeElement?.getAttribute('href') ?? ''`),
    /\/boards\/infrastructure$/,
  );
  await press("Enter");
  await browser.waitFor(`location.pathname === ${q(`${base}/boards/infrastructure`)}`);
  await browser.back();
  await browser.waitFor(`${metric("Доски")} === 8`);

  // Старт с последнего элемента блока внимания: следующий Tab ведёт к ссылке блока планов.
  await browser.command("focus", `main button[aria-label$=": Заблокированы"]`);
  await tabUntil(
    `document.activeElement?.tagName === 'A' && ${activeText}.includes('Все планы')`,
    3,
  );
  await press("Enter");
  await browser.waitFor(`location.pathname === ${q(`${base}/plans`)}`);
  await browser.back();
  await browser.waitFor(`${metric("Доски")} === 8`);
});

test("O-19: раскрытые подборки без переполнения в обеих темах на 1440 и 390", async () => {
  const report = [];
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      await browser.viewport(width, 900);
      await browser.media(scheme);
      await browser.open(overviewUrl(gamma));
      await browser.waitFor(
        `document.documentElement.getAttribute('data-mantine-color-scheme') === ${q(scheme)} && ${metric("Доски")} === 8`,
      );
      await browser.command(
        "click",
        `main button[aria-label^="Показать все"][aria-label$=": Заблокированы"]`,
      );
      // Каждое раскрытие дожидается своего результата: сдвиг вёрстки не уводит следующий клик.
      await browser.waitFor(`${attentionGroup("Заблокированы")}?.links.length === 7`);
      await browser.command("click", `#overview-boards button[aria-expanded="false"]`);
      await browser.waitFor(
        `${boardLinks}.length === 8 && location.pathname === ${q(`/projects/${encodeURIComponent(gamma.slug)}`)}`,
      );
      const layout = await browser.eval(
        `(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, overflow: [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).length }))()`,
      );
      const audit = await browser.command("a11y", "--selector", "main");
      const violations = audit.violations.map((item) => `${item.id}(${item.nodeCount})`);
      await browser.eval("scrollTo(0, 0); true");
      await browser.screenshot(join(screenshots, `overview-breadth-${scheme}-${width}.png`));
      report.push({ scheme, width, ...layout, violations });
      assert(layout.scroll <= layout.width, `${scheme} ${width}: горизонтальная прокрутка`);
      assert.equal(layout.overflow, 0, `${scheme} ${width}: элементы за пределами экрана`);
      assert.deepEqual(violations, [], `${scheme} ${width}: нарушения доступности`);
    }
  }
  measurements.breadthLayout = report;
  await browser.viewport(1440, 1000);
  await browser.media("light");
  await browser.open(overviewUrl(alpha));
  await browser.waitFor(`${metric("Задачи")} !== null`);
});

test("O-20: чтение обзора не пишет в базу, потоки освобождаются после закрытия", async () => {
  const before = await fingerprint(join(workspace.projects.alpha.directory, ".relay"));
  await browser.reload();
  await browser.waitFor(`${metric("Задачи")} !== null`);
  await browser.command("pushstate", `/projects/${encodeURIComponent(beta.slug)}`);
  await browser.waitFor(`${heading} === 'Бета'`);
  await browser.back();
  await browser.waitFor(`${metric("Задачи")} !== null`);
  await settledReads(alpha);
  assert.equal(await fingerprint(join(workspace.projects.alpha.directory, ".relay")), before);
  assert.deepEqual(await browser.errors().then((data) => data.errors ?? []), []);
  await browser.close();
  browser = undefined;
  await until(() => proxy.totalOpenStreams() === 0, {
    message: "потоки закрыты вместе с браузером",
  });
});
