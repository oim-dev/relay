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
