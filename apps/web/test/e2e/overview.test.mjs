import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBrowser } from "./helpers/browser.mjs";
import { CLEAR_FAULT_PATH, startControlProxy } from "./helpers/proxy.mjs";
import { seedProject } from "./helpers/seed.mjs";
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
let alphaApi;
let seeded;

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

before(async () => {
  await assertBuilt();
  await mkdir(screenshots, { recursive: true });
  workspace = await createWorkspace();
  webPort = await freePort();
  serverPort = await freePort();
  server = await startRelayServer({
    config: workspace.config,
    cwd: workspace.root,
    port: serverPort,
    webPort,
  });
  proxy = await startControlProxy(server.url);
  web = await startWeb({ port: webPort, apiUrl: proxy.url });
  const registry = await (await fetch(`${server.url}/api/v1/projects`)).json();
  const byKey = Object.fromEntries(registry.data.projects.map((project) => [project.key, project]));
  alpha = byKey.alpha;
  beta = byKey.beta;
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
  browser = createBrowser(`tasks-web-overview-${process.pid}`);
  await browser.viewport(1440, 1000);
  await browser.media("light");
});

after(async () => {
  await browser?.close().catch(() => undefined);
  await web?.stop();
  await proxy?.close();
  await server?.stop();
  await workspace?.remove();
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
