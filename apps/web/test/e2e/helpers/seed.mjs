/**
 * Наполняет проект данными всех блоков обзора через REST собственного сервера.
 * @param {ReturnType<import("./stack.mjs").relayApi>} api
 * @param {{name: string, long?: boolean}} options
 */
export async function seedProject(api, { name, long = false }) {
  const suffix = long ? " — Сверхдлинноеназваниебезпробеловдляпроверкипереноса" : "";
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "passport",
      name: `${name}${suffix}`,
      summary: `${name}: общий контекст продукта для людей и агентов.`,
      description: "## Назначение\n\nПроверочный продукт браузерных регрессий обзора.",
    },
  });
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "feature",
      name: "Обзор проекта",
      summary: "Срез состояния",
      description: "Описание",
    },
  });
  const create = (title, column, extra = {}) =>
    api.post("/board-tasks", { board: "product", title: `${title}${suffix}`, column, ...extra });
  const tasks = {};
  tasks.inbox = await create("Входящая задача", "inbox");
  tasks.ready = await create("Готова к началу", "ready", {
    acceptanceCriteria: [{ title: "Первый критерий" }, { title: "Второй критерий" }],
  });
  tasks.progress = await create("Задача в работе", "in-progress");
  tasks.review = await create("Задача на проверке", "review");
  tasks.done = await create("Выполненная задача", "done");
  tasks.cancelled = await create("Отменённая задача", "cancelled");
  tasks.blocked = await create("Ждёт задачу в работе", "ready", {
    dependencies: [tasks.progress.id],
  });
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "document",
      name: `Закреплённое руководство${suffix}`,
      summary: "Как читать обзор",
      body: "# Руководство",
      documentKind: "instruction",
      documentStatus: "active",
      pinned: true,
      links: [],
    },
  });
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "document",
      name: "Черновик заметки",
      summary: "",
      body: "Черновик",
      documentKind: "research",
      documentStatus: "draft",
      links: [],
    },
  });
  const plan = await api.post("/plans", {
    title: `План запуска${suffix}`,
    summary: "Довести обзор до приёмки",
    goal: "Обзор помогает сориентироваться в проекте.",
  });
  const staged = await api.post(`/plans/${plan.id}/stages`, {
    ifRevision: plan.revision,
    action: "create",
    fields: { title: "Первый этап" },
  });
  const stages = await api.get(`/plans/${plan.id}/stages`);
  const filled = await api.post(`/plans/${plan.id}/tasks`, {
    ifRevision: staged.revision,
    stage: stages.items[0].id,
    add: [tasks.progress.id, tasks.done.id],
  });
  const started = await api.post(`/plans/${plan.id}/transition`, {
    ifRevision: filled.revision,
    action: "start",
  });
  await api.post("/releases", {
    title: `Первый выпуск${suffix}`,
    version: "1.0.0",
    planIds: [plan.id],
    plannedFor: "2026-12-01",
  });
  return { tasks, plan: { id: plan.id, revision: started.revision, stage: stages.items[0].id } };
}

/** Создаёт план с одним этапом и задачами, запускает его и возвращает актуальную ревизию. */
async function startedPlan(api, title, taskIds) {
  const plan = await api.post("/plans", { title, summary: "", goal: `Цель: ${title}` });
  const staged = await api.post(`/plans/${plan.id}/stages`, {
    ifRevision: plan.revision,
    action: "create",
    fields: { title: "Единственный этап" },
  });
  const stages = await api.get(`/plans/${plan.id}/stages`);
  const filled = await api.post(`/plans/${plan.id}/tasks`, {
    ifRevision: staged.revision,
    stage: stages.items[0].id,
    add: taskIds,
  });
  const started = await api.post(`/plans/${plan.id}/transition`, {
    ifRevision: filled.revision,
    action: "start",
  });
  return { id: plan.id, revision: started.revision };
}

/**
 * Наполняет проект объёмом больше подборок обзора и закрытыми состояниями:
 * шесть приложений (всего восемь досок, инфраструктурная пустая), по семь задач в каждой
 * группе внимания на разных досках, завершённые/отменённые планы, выпущенный/отменённый
 * релиз и архивный документ.
 * @param {ReturnType<import("./stack.mjs").relayApi>} api
 */
export async function seedBreadth(api) {
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "passport",
      name: "Гамма",
      summary: "Проект с полными каталогами больше подборки обзора.",
      description: "Описание",
    },
  });
  const create = (board, title, column, extra = {}) =>
    api.post("/board-tasks", { board, title, column, ...extra });
  const groups = { progress: [], review: [], blocked: [] };
  // Приложения создаются раньше продуктовых задач: старейшие задачи первых досок не попадут
  // в подборку «сначала недавние», а сами доски app5, app6 и infrastructure — в подборку досок.
  for (const board of ["app1", "app2", "app3", "app4", "app5", "app6", "product"]) {
    if (board !== "product")
      await api.post("/product/records", {
        action: "create",
        fields: {
          kind: "application",
          name: `Приложение ${board}`,
          slug: board,
          summary: "",
          description: "Проверка полного каталога досок",
          type: "frontend",
        },
      });
    const progress = await create(board, `Гамма: в работе ${board}`, "in-progress");
    groups.progress.push({ ...progress, board });
    groups.review.push({
      ...(await create(board, `Гамма: на проверке ${board}`, "review")),
      board,
    });
    groups.blocked.push({
      ...(await create(board, `Гамма: ждёт ${board}`, "ready", { dependencies: [progress.id] })),
      board,
    });
  }

  const finished = await create("product", "Гамма: выполненная задача", "done");
  const completedPlan = await startedPlan(api, "Гамма: завершённый план", [finished.id]);
  await api.post(`/plans/${completedPlan.id}/transition`, {
    ifRevision: completedPlan.revision,
    action: "complete",
    result: "Состав выполнен",
  });
  const cancelledTask = await create("product", "Гамма: задача отменённого плана", "inbox");
  const cancelledPlan = await startedPlan(api, "Гамма: отменённый план", [cancelledTask.id]);
  await api.post(`/plans/${cancelledPlan.id}/transition`, {
    ifRevision: cancelledPlan.revision,
    action: "cancel",
    result: "Приоритет изменился",
  });
  // Задача завершённого плана открывается повторно: статус плана остаётся «завершён»,
  // а фактическая готовность состава теряется (completedNotReady).
  const reopened = await create("product", "Гамма: переоткрытая задача", "done");
  const reopenedPlan = await startedPlan(api, "Гамма: переоткрытый план", [reopened.id]);
  await api.post(`/plans/${reopenedPlan.id}/transition`, {
    ifRevision: reopenedPlan.revision,
    action: "complete",
    result: "Состав выполнен до переоткрытия",
  });
  const reopenedTask = await api.get(`/board-tasks/${reopened.id}`);
  await api.post(`/board-tasks/${reopened.id}/move`, {
    ifRevision: reopenedTask.revision,
    column: "in-progress",
  });
  groups.progress.push({ ...reopened, board: "product" });

  await api.post("/releases", {
    title: "Гамма: выпущенный релиз",
    version: "1.0.0",
    planIds: [completedPlan.id],
    status: "released",
  });
  await api.post("/releases", {
    title: "Гамма: отменённый релиз",
    version: "0.9.0",
    planIds: [completedPlan.id],
    status: "cancelled",
  });
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "document",
      name: "Гамма: архивное решение",
      summary: "",
      body: "Устаревшее решение",
      documentKind: "decision",
      documentStatus: "archived",
      links: [],
    },
  });
  return { groups };
}

/**
 * Паспорт и каталог досок больше одной страницы (50): продуктовая, `count` приложений
 * `catalog1…` и инфраструктурная доски.
 */
export async function seedCatalog(api, { name, count }) {
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "passport",
      name,
      summary: "Каталог из нескольких страниц.",
      description: "Описание каталога.",
    },
  });
  for (let index = 1; index <= count; index += 1)
    await api.post("/product/records", {
      action: "create",
      fields: {
        kind: "application",
        name: `Каталог ${index}`,
        slug: `catalog${index}`,
        summary: "",
        description: "Проверка второй страницы каталога досок",
        type: "frontend",
      },
    });
}

/** Ревизия задачи для оптимистичной записи. */
const revisionOf = async (api, id) => (await api.get(`/board-tasks/${id}`)).revision;

/** План с этапами из явных списков задач; при необходимости запускается, завершается или отменяется. */
async function stagedPlan(api, title, stages, finalState = "draft") {
  const plan = await api.post("/plans", { title, summary: "", goal: `Цель: ${title}` });
  let revision = plan.revision;
  for (const taskIds of stages) {
    const stage = await api.post(`/plans/${plan.id}/stages`, {
      ifRevision: revision,
      action: "create",
      fields: { title: "Этап" },
    });
    revision = stage.revision;
    if (taskIds.length > 0)
      revision = (
        await api.post(`/plans/${plan.id}/tasks`, {
          ifRevision: revision,
          stage: stage.stageId,
          add: taskIds,
        })
      ).revision;
  }
  if (finalState === "active")
    await api.post(`/plans/${plan.id}/transition`, { ifRevision: revision, action: "start" });
  if (finalState === "completed" || finalState === "cancelled")
    await api.post(`/plans/${plan.id}/transition`, {
      ifRevision: revision,
      action: finalState === "completed" ? "complete" : "cancel",
      result: "Итог",
    });
  return plan.id;
}

/**
 * Малая fixture показателей оператора: та же раскладка, что в тесте Core
 * `packages/core/test/product-overview-operator.test.ts`, но через REST собственного сервера.
 * Ожидаемые числа выписаны в браузерной регрессии вручную, а не вычисляются.
 * Доски: product, web, infrastructure и пустая empty.
 * @param {ReturnType<import("./stack.mjs").relayApi>} api
 */
export async function seedOperator(api) {
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "passport",
      name: "Дзета",
      summary: "Показатели оператора на малой fixture.",
      description: "Описание",
    },
  });
  for (const slug of ["web", "empty"])
    await api.post("/product/records", {
      action: "create",
      fields: {
        kind: "application",
        slug,
        name: slug,
        summary: "",
        description: `Приложение ${slug}`,
        type: "frontend",
      },
    });
  const task = async (board, column, title, extra = {}) =>
    (await api.post("/board-tasks", { board, column, title, ...extra })).id;
  const move = async (id, column, board) =>
    api.post(`/board-tasks/${id}/move`, {
      column,
      ...(board ? { board } : {}),
      ifRevision: await revisionOf(api, id),
    });
  const completeCriterion = async (id, index) => {
    const criteria = await api.get(`/board-tasks/${id}/criteria`);
    await api.post(`/board-tasks/${id}/criteria`, {
      action: "complete",
      criterionId: criteria.items[index].id,
      completed: true,
      ifRevision: await revisionOf(api, id),
    });
  };
  const link = async (id, target, relation) =>
    api.post(`/board-tasks/${id}/links`, {
      target,
      relation,
      ifRevision: await revisionOf(api, id),
    });
  const release = async (title, planIds, plannedFor = "", action) => {
    const created = await api.post("/releases", { title, version: title, planIds, plannedFor });
    if (action)
      await api.post(`/releases/${created.id}/transition`, {
        action,
        ifRevision: created.revision,
      });
    return created.id;
  };

  const T14 = await task("web", "done", "Дзета: отменённый блокер T14");
  const T15 = await task("web", "done", "Дзета: ждёт отменённую T15", { dependencies: [T14] });
  const T17 = await task("infrastructure", "done", "Дзета: инфраструктура T17");
  const done = [];
  for (const index of [19, 20, 21, 22, 23, 24])
    done.push(await task("infrastructure", "done", `Дзета: выполнена T${index}`));
  const [T19, T20, T21, T22, T23, T24] = done;
  const T18 = await task("web", "done", "Дзета: вернулась в работу T18");
  const T6 = await task("web", "in-progress", "Дзета: общий блокер T6");
  const T3 = await task("web", "review", "Дзета: ждёт T6 на проверке T3", { dependencies: [T6] });
  const T4 = await task("web", "review", "Дзета: родитель на проверке T4");
  const T7 = await task("web", "ready", "Дзета: подзадача T7", { parentId: T4 });
  const T1 = await task("product", "review", "Дзета: критерий выполнен T1", {
    acceptanceCriteria: [{ title: "Проверено" }],
  });
  await completeCriterion(T1, 0);
  const T2 = await task("product", "review", "Дзета: критерий не выполнен T2", {
    acceptanceCriteria: [{ title: "Первый" }, { title: "Второй" }],
  });
  await completeCriterion(T2, 0);
  const T5 = await task("web", "review", "Дзета: без критериев T5");
  const T9 = await task("web", "in-progress", "Дзета: подзадача и зависимость T9");
  const T8 = await task("product", "inbox", "Дзета: ждёт T6 и T9 T8", { dependencies: [T6, T9] });
  await link(T9, T8, "parent");
  const T12 = await task("product", "ready", "Дзета: конец цепочки T12");
  const T11 = await task("product", "ready", "Дзета: середина цепочки T11", {
    dependencies: [T12],
  });
  const T10 = await task("product", "inbox", "Дзета: начало цепочки T10", { dependencies: [T11] });
  const T13 = await task("product", "ready", "Дзета: related T13", { related: [T6] });
  const T16 = await task("web", "inbox", "Дзета: отменённый потребитель T16", {
    dependencies: [T6],
  });
  await move(T16, "cancelled");
  await move(T14, "cancelled");

  const PL3 = await stagedPlan(api, "Дзета PL3", [[T18, T17]], "completed");
  await move(T18, "in-progress");
  const PL1 = await stagedPlan(api, "Дзета PL1", [[T6, T8], []], "active");
  await stagedPlan(api, "Дзета PL2", [[T1]]);
  await stagedPlan(api, "Дзета PL4", [[T2]], "cancelled");
  const PL5 = await stagedPlan(api, "Дзета PL5", [[T19]], "active");
  await stagedPlan(api, "Дзета PL6", []);
  const PL7 = await stagedPlan(api, "Дзета PL7", [[T20], []]);
  const PL8 = await stagedPlan(api, "Дзета PL8", [[T21]], "completed");
  const PL9 = await stagedPlan(api, "Дзета PL9", [[T22]], "completed");
  const PL10 = await stagedPlan(api, "Дзета PL10", [[T23]], "completed");
  const PL11 = await stagedPlan(api, "Дзета PL11", [[T24]], "completed");

  const R1 = await release("R1", [PL8], "2026-10-10");
  await release("R2", [PL9], "", "release");
  const R3 = await release("R3", [PL9]);
  await release("R4", [PL10], "", "cancel");
  await release("R5", [PL3]);
  await release("R6", [PL1]);
  return {
    tasks: { T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T18, T21 },
    plans: { PL5, PL7, PL10, PL11 },
    releases: { R1, R3 },
  };
}

/**
 * Большая fixture: каждая выборка показателей оператора длиннее подборки (5) и страницы
 * полного списка (20) — по `count` записей в каждой группе.
 * @param {ReturnType<import("./stack.mjs").relayApi>} api
 * @param {{count: number}} options
 */
export async function seedOperatorBreadth(api, { count }) {
  await api.post("/product/records", {
    action: "create",
    fields: {
      kind: "passport",
      name: "Эта",
      summary: "Полные списки показателей оператора.",
      description: "Описание",
    },
  });
  const boards = [];
  for (let index = 1; index <= count; index += 1) {
    const slug = `work${index}`;
    await api.post("/product/records", {
      action: "create",
      fields: {
        kind: "application",
        slug,
        name: `Работа ${index}`,
        summary: "",
        description: "Доска большой fixture",
        type: "frontend",
      },
    });
    boards.push(slug);
  }
  const task = async (board, column, title, extra = {}) =>
    (await api.post("/board-tasks", { board, column, title, ...extra })).id;
  const hub = await task("product", "in-progress", "Эта: общий блокер проверки");
  const groups = { met: [], open: [], blockers: [] };
  for (let index = 0; index < count; index += 1) {
    const board = boards[index];
    groups.met.push(await task(board, "review", `Эта: обязательства выполнены ${index}`));
    groups.open.push(
      await task(board, "review", `Эта: ждёт общий блокер ${index}`, { dependencies: [hub] }),
    );
    const blocker = await task(board, "ready", `Эта: блокер ${index}`);
    groups.blockers.push(blocker);
    await task(board, "inbox", `Эта: ждёт блокер ${index}`, { dependencies: [blocker] });
  }
  const plans = { open: [], outside: [], released: [] };
  for (let index = 0; index < count; index += 1) {
    const finished = await task("infrastructure", "done", `Эта: выполнена для плана ${index}`);
    plans.open.push(await stagedPlan(api, `Эта: открытый выполненный ${index}`, [[finished]]));
    const outside = await task("infrastructure", "done", `Эта: вне релизов ${index}`);
    plans.outside.push(
      await stagedPlan(api, `Эта: завершённый вне релизов ${index}`, [[outside]], "completed"),
    );
    const shipped = await task("infrastructure", "done", `Эта: в релизе ${index}`);
    const plan = await stagedPlan(api, `Эта: в релизе ${index}`, [[shipped]], "completed");
    plans.released.push(plan);
    await api.post("/releases", {
      title: `Эта: релиз ${index}`,
      version: `0.${index}.0`,
      planIds: [plan],
      plannedFor: "",
    });
  }
  return { hub, groups, plans, boards };
}
