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
