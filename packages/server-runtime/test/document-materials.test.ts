import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { EntityEngine } from "@relay/core/application/entities/service";
import { GraphService } from "@relay/core/application/graph/service";
import {
  documentBulkResultSchema,
  documentFacetsSchema,
  entityDocumentsPageSchema,
} from "@relay/contracts/entities/document-catalog";
import { entitiesPageSchema, entitySavedSchema } from "@relay/contracts/entities";
import { fixture } from "./helpers/server.js";

/** Библиотека из трёх материалов: прикреплённый Markdown, ссылка и прежняя запись без новых полей. */
async function library(t: TestContext) {
  const { app, workspace, root } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Каталог", summary: "", description: "Требования" },
    },
    "agent",
  );
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA", title: "Деплой" } },
    "agent",
  );
  const rules = await engine.create(
    {
      requestId: "rules",
      data: {
        kind: "document",
        name: "Правила деплоя",
        summary: "",
        body: "## Правила\n",
        documentKind: "rules",
        sectionId: "development",
        pinned: true,
        tags: ["API", "Web"],
        targets: [feature.key],
        relations: [{ target: task.ref, type: "references", description: "Перед деплоем" }],
      },
    },
    "agent",
  );
  const link = await engine.create(
    {
      requestId: "link",
      data: {
        kind: "document",
        name: "Макет",
        summary: "",
        documentKind: "description",
        documentFormat: "link",
        url: "https://example.com/design",
        tags: ["api"],
      },
    },
    "agent",
  );
  const old = await engine.create(
    {
      requestId: "old",
      data: {
        kind: "document",
        name: "Прежний",
        summary: "",
        body: "Текст",
        documentKind: "research",
        targets: [feature.key],
      },
    },
    "agent",
  );
  // Прежняя запись: без documentFormat и tags, как до появления библиотеки материалов.
  const path = join(root, ".relay/entities/documents", `${old.ref.id}.json`);
  const disk = JSON.parse(await readFile(path, "utf8"));
  delete disk.data.documentFormat;
  delete disk.data.tags;
  await writeFile(path, JSON.stringify(disk));
  // Внешняя правка файла требует явного обслуживания индекса, как у пользователя.
  await new GraphService(workspace).reindex();
  const prefix = `/api/v1/projects/${workspace.config.projectId}/entities`;
  return { app, workspace, engine, feature, task, rules, link, old, prefix };
}

async function edges(engine: EntityEngine, id: string) {
  const graph = await new GraphService(engine.workspace).read({ root: `document:${id}` });
  return graph.edges
    .filter((edge) => edge.from.id === id || edge.to.id === id)
    .map((edge) => `${edge.from.kind}:${edge.from.id}>${edge.type}>${edge.to.kind}:${edge.to.id}`)
    .sort();
}

test("REST материалов: фильтры списка, карточка, фасеты и прежние документы", async (t) => {
  const { app, rules, link, old, prefix } = await library(t);
  for (const base of ["/api/v1/entities", prefix]) {
    const list = async (query: string) => {
      const response = await app.inject(`${base}?kind=document&sort=title&${query}`);
      assert.equal(response.statusCode, 200, response.body);
      return entitiesPageSchema.parse(response.json().data).items.map((item) => item.key);
    };
    // Одиночный tags становится массивом; сравнение без учёта регистра, несколько — AND.
    assert.deepEqual(await list("tags=API"), [link.key, rules.key]);
    assert.deepEqual(await list("tags=api&tags=WEB"), [rules.key]);
    assert.deepEqual(await list("documentFormat=link"), [link.key]);
    assert.deepEqual(await list("documentFormat=markdown"), [rules.key, old.key]);
    assert.deepEqual(await list("unattached=true"), [link.key]);
    assert.deepEqual(await list("unattached=false"), [rules.key, old.key]);
    assert.equal(
      (await app.inject(`${base}?kind=document&documentFormat=pdf`)).statusCode,
      400,
      "неизвестный формат",
    );
    const cards = entitiesPageSchema.parse(
      (await app.inject(`${base}?kind=document&sort=title`)).json().data,
    ).items;
    const card = (key: string) => cards.find((item) => item.key === key)!.document!;
    assert.deepEqual(
      { format: card(link.key).format, url: card(link.key).url, tags: card(link.key).tags },
      { format: "link", url: "https://example.com/design", tags: ["api"] },
    );
    // Прежняя запись читается как markdown без тегов и считает совместимый link.
    assert.deepEqual(
      { format: card(old.key).format, tags: card(old.key).tags, links: card(old.key).linkCount },
      { format: "markdown", tags: [], links: 1 },
    );
    assert.equal(card(rules.key).linkCount, 2);

    const facets = await app.inject(`${base}/document-facets`);
    assert.equal(facets.statusCode, 200, facets.body);
    const data = documentFacetsSchema.parse(facets.json().data);
    assert.equal(data.total, 3);
    assert.deepEqual(data.tags, [
      { tag: "api", count: 2 },
      { tag: "Web", count: 1 },
    ]);
    assert.deepEqual(data.formats, [
      { format: "markdown", count: 2 },
      { format: "link", count: 1 },
    ]);
    assert.equal(data.views.unattached, 1);
    assert.equal(data.views.pinned, 1);
    assert.equal(data.sections.find((section) => section.sectionId === "development")?.count, 1);
    // Выбранный тег сужает остальные оси, а счётчик тегов равен выборке после добавления тега.
    const narrowed = documentFacetsSchema.parse(
      (await app.inject(`${base}/document-facets?tags=Api`)).json().data,
    );
    assert.equal(narrowed.total, 2);
    assert.deepEqual(narrowed.tags, [
      { tag: "api", count: 2 },
      { tag: "Web", count: 1 },
    ]);
    assert.deepEqual(narrowed.formats, [
      { format: "markdown", count: 1 },
      { format: "link", count: 1 },
    ]);
    const invalid = await app.inject(`${base}/document-facets?unattached=maybe`);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
  }
});

test("REST материалов: массовое изменение с частичным отказом, конфликтом и сохранением связей", async (t) => {
  const { app, engine, rules, link, old, prefix } = await library(t);
  const before = await engine.get({ ref: rules.key });
  const edgesBefore = await edges(engine, rules.ref.id);
  const response = await app.inject({
    method: "POST",
    url: `${prefix}/document-bulk`,
    payload: {
      items: [
        { ref: rules.key, ifRevision: rules.revision },
        { ref: link.ref.id, ifRevision: link.revision + 5 },
        { ref: "DOC-999", ifRevision: 1 },
        { ref: old.key, ifRevision: old.revision },
      ],
      operation: { type: "addTags", tags: ["Новое", " api "] },
      requestId: "bulk-tags",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = documentBulkResultSchema.parse(response.json().data);
  assert.equal(result.requestId, "bulk-tags");
  assert.deepEqual(
    result.items.map((item) => [item.ref, item.status, item.error?.code]),
    [
      [rules.key, "applied", undefined],
      [link.ref.id, "conflict", "REVISION_CONFLICT"],
      ["DOC-999", "not_found", "ENTITY_NOT_FOUND"],
      [old.key, "applied", undefined],
    ],
  );
  assert.equal(result.items[1]!.revision, link.revision, "при конфликте — актуальная ревизия");
  assert.equal(result.items[1]!.key, link.key);
  assert.deepEqual([result.applied, result.failed], [2, 2]);
  const after = await engine.get({ ref: rules.key });
  assert.equal(after.revision, result.items[0]!.revision);
  assert.equal(after.data.kind, "document");
  assert.equal(before.data.kind, "document");
  if (after.data.kind === "document" && before.data.kind === "document") {
    assert.deepEqual(after.data.tags, ["API", "Web", "Новое"]);
    assert.deepEqual(after.data.links, before.data.links);
    assert.deepEqual(after.data.relations, before.data.relations);
    assert.equal(after.data.body, before.data.body);
  }
  assert.deepEqual(await edges(engine, rules.ref.id), edgesBefore);
  // Прежний документ после записи сохраняет link и получает теги.
  const oldAfter = await engine.get({ ref: old.key });
  if (oldAfter.data.kind === "document") {
    assert.equal(oldAfter.data.links.length, 1);
    assert.deepEqual(oldAfter.data.tags, ["Новое", "api"]);
  }

  // Совпадающее значение — unchanged без новой ревизии.
  const pinned = documentBulkResultSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/entities/document-bulk",
        payload: {
          items: [{ ref: rules.key, ifRevision: after.revision }],
          operation: { type: "pin", pinned: true },
          requestId: "bulk-pin",
        },
      })
    ).json().data,
  );
  assert.deepEqual(pinned.items[0], {
    ref: rules.key,
    status: "unchanged",
    target: rules.ref,
    key: rules.key,
    revision: after.revision,
  });
  assert.deepEqual([pinned.applied, pinned.failed], [0, 0]);
  const moved = documentBulkResultSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/document-bulk`,
        payload: {
          items: [{ ref: rules.key, ifRevision: after.revision }],
          operation: { type: "move", sectionId: null },
          requestId: "bulk-move",
        },
      })
    ).json().data,
  );
  assert.equal(moved.items[0]!.status, "applied");
  const archived = documentBulkResultSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/document-bulk`,
        payload: {
          items: [{ ref: link.key, ifRevision: link.revision }],
          operation: { type: "setStatus", documentStatus: "archived" },
          requestId: "bulk-archive",
        },
      })
    ).json().data,
  );
  assert.equal(archived.items[0]!.status, "applied");
  const view = documentFacetsSchema.parse(
    (await app.inject(`${prefix}/document-facets`)).json().data,
  ).views;
  assert.deepEqual([view.archived, view.unsectioned, view.unattached], [1, 2, 0]);

  for (const payload of [
    {
      items: [
        { ref: rules.key, ifRevision: 1 },
        { ref: rules.key, ifRevision: 2 },
      ],
      operation: { type: "pin", pinned: false },
      requestId: "duplicate",
    },
    { items: [], operation: { type: "pin", pinned: false }, requestId: "empty" },
    {
      items: [{ ref: rules.key, ifRevision: 1 }],
      operation: { type: "rename" },
      requestId: "unknown",
    },
  ]) {
    const failure = await app.inject({
      method: "POST",
      url: `${prefix}/document-bulk`,
      payload,
    });
    assert.equal(failure.statusCode, 400, failure.body);
    assert.equal(failure.json().ok, false);
    assert.equal(failure.json().error.code, "VALIDATION_ERROR");
  }
});

test("REST материалов: одна связь attach/update/detach, ошибки и сохранность остальных связей", async (t) => {
  const { app, engine, feature, task, rules, link, prefix } = await library(t);
  const relate = (payload: object) =>
    app.inject({ method: "POST", url: `${prefix}/relate-document`, payload });
  const attached = await relate({
    ref: link.key,
    ifRevision: link.revision,
    action: "attach",
    target: task.key,
    type: "references",
    description: "Открыть перед деплоем",
    requestId: "attach",
  });
  assert.equal(attached.statusCode, 200, attached.body);
  const saved = entitySavedSchema.parse(attached.json().data);
  assert.deepEqual([saved.action, saved.key, saved.requestId], ["link", link.key, "attach"]);
  assert.ok(
    (await edges(engine, link.ref.id)).some((edge) => edge.includes(`task:${task.ref.id}`)),
  );

  const duplicate = await relate({
    ref: link.key,
    ifRevision: saved.revision,
    action: "attach",
    target: task.ref.id,
    type: "references",
    requestId: "attach-again",
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.json().error.code, "ALREADY_EXISTS");
  const stale = await relate({
    ref: link.key,
    ifRevision: link.revision,
    action: "detach",
    target: task.key,
    type: "references",
    requestId: "stale",
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "REVISION_CONFLICT");
  const missing = await relate({
    ref: link.key,
    ifRevision: saved.revision,
    action: "detach",
    target: task.key,
    type: "documents",
    requestId: "missing",
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().error.code, "RELATION_NOT_FOUND");
  const invalid = await relate({
    ref: link.key,
    ifRevision: saved.revision,
    action: "attach",
    target: task.key,
    type: "references",
    nextType: "documents",
    requestId: "invalid",
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const unknown = await relate({
    ref: link.key,
    ifRevision: saved.revision,
    action: "attach",
    target: "TASK-404",
    type: "references",
    requestId: "unknown",
  });
  assert.equal(unknown.statusCode, 404, unknown.body);

  // update меняет тип и пояснение одной связи; detach снимает только её.
  const updated = entitySavedSchema.parse(
    (
      await relate({
        ref: link.key,
        ifRevision: saved.revision,
        action: "update",
        target: task.key,
        type: "references",
        nextType: "documents",
        description: "Описывает задачу",
        requestId: "update",
      })
    ).json().data,
  );
  const detail = await engine.get({ ref: link.key });
  if (detail.data.kind === "document")
    assert.deepEqual(detail.data.relations, [
      { target: task.ref, type: "documents", description: "Описывает задачу" },
    ]);

  // Совместимая область links: открепление снимает только её, relation и рёбра задачи остаются.
  const before = await engine.get({ ref: rules.key });
  const taskEdges = (await edges(engine, rules.ref.id)).filter((edge) =>
    edge.includes(`task:${task.ref.id}`),
  );
  const detached = await relate({
    ref: rules.key,
    ifRevision: before.revision,
    action: "detach",
    target: feature.key,
    type: "documents",
    requestId: "detach-legacy",
  });
  assert.equal(detached.statusCode, 200, detached.body);
  const rulesAfter = await engine.get({ ref: rules.key });
  if (rulesAfter.data.kind === "document" && before.data.kind === "document") {
    assert.deepEqual(rulesAfter.data.links, []);
    assert.deepEqual(rulesAfter.data.relations, before.data.relations);
  }
  assert.deepEqual(
    (await edges(engine, rules.ref.id)).filter((edge) => edge.includes(`task:${task.ref.id}`)),
    taskEdges,
  );
  assert.ok(
    !(await edges(engine, rules.ref.id)).some((edge) => edge.includes(`feature:${feature.ref.id}`)),
  );
  const final = await relate({
    ref: link.key,
    ifRevision: updated.revision,
    action: "detach",
    target: task.key,
    type: "documents",
    requestId: "detach",
  });
  assert.equal(final.statusCode, 200, final.body);
  const linkAfter = await engine.get({ ref: link.key });
  if (linkAfter.data.kind === "document") assert.deepEqual(linkAfter.data.relations, []);
  assert.deepEqual(await edges(engine, link.ref.id), []);
});

test("REST материалов: обратное чтение для всех видов сущностей", async (t) => {
  const { app, engine, feature, task, rules, link, old, prefix } = await library(t);
  const base = prefix.replace(/\/entities$/, "");
  const post = async (url: string, payload: object) => {
    const response = await app.inject({ method: "POST", url: `${base}${url}`, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const scenario = await post("/entities", {
    requestId: "scenario",
    data: { kind: "scenario", featureId: feature.key, name: "Поиск", description: "Найти" },
  });
  const application = await post("/entities", {
    requestId: "application",
    data: {
      kind: "application",
      name: "API",
      slug: "api",
      type: "backend",
      summary: "",
      description: "Описание",
    },
  });
  const implementation = await post("/entities", {
    requestId: "implementation",
    data: {
      kind: "implementation",
      application: application.key,
      target: feature.key,
      title: "Вклад",
      description: "Описание",
    },
  });
  const plan = await post("/plans", { title: "План", requestId: "plan" });
  const release = await post("/releases", {
    title: "Релиз",
    version: "1.0",
    planIds: [plan.id],
    requestId: "release",
  });
  const all = entitiesPageSchema.parse((await app.inject(`${prefix}?limit=100`)).json().data).items;
  const first = (kind: string) => all.find((item) => item.ref.kind === kind)!.ref;
  const targets = {
    project: first("project"),
    product: first("product"),
    feature: feature.ref,
    scenario: scenario.ref,
    application: application.ref,
    implementation: implementation.ref,
    board: first("board"),
    task: task.ref,
    document: old.ref,
    "work-plan": { kind: "work-plan", id: plan.id },
    release: { kind: "release", id: release.id },
  };
  assert.equal(Object.keys(targets).length, 11);
  let revision = link.revision;
  for (const [kind, target] of Object.entries(targets)) {
    const address = `${target.kind}:${target.id}`;
    const empty = await app.inject(`${prefix}/documents?ref=${encodeURIComponent(address)}`);
    assert.equal(empty.statusCode, 200, `${kind}: ${empty.body}`);
    const before = entityDocumentsPageSchema.parse(empty.json().data);
    assert.equal(before.target.ref.kind, kind);
    revision = (
      await post("/entities/relate-document", {
        ref: link.key,
        ifRevision: revision,
        action: "attach",
        target: address,
        type: "references",
        description: `Для ${kind}`,
        requestId: `attach-${kind}`,
      })
    ).revision;
    const page = entityDocumentsPageSchema.parse(
      (await app.inject(`/api/v1/entities/documents?ref=${encodeURIComponent(address)}`)).json()
        .data,
    );
    assert.equal(page.total, before.total + 1, kind);
    const item = page.items.find((entry) => entry.document.ref.id === link.ref.id)!;
    assert.deepEqual(item.relations, [
      { type: "references", description: `Для ${kind}`, source: "relations" },
    ]);
  }
  // Фича: legacy links двух документов и закреплённый первым; дети (сценарий) не учитываются.
  const featurePage = entityDocumentsPageSchema.parse(
    (await app.inject(`${prefix}/documents?ref=${feature.key}&limit=2`)).json().data,
  );
  assert.equal(featurePage.total, 3);
  assert.equal(featurePage.nextOffset, 2);
  assert.equal(featurePage.items[0]!.document.ref.id, rules.ref.id);
  assert.deepEqual(featurePage.items[0]!.relations, [
    { type: "documents", description: "", source: "links" },
  ]);
  const rest = entityDocumentsPageSchema.parse(
    (
      await app.inject(
        `${prefix}/documents?ref=${feature.key}&offset=2&limit=2&version=${featurePage.version}`,
      )
    ).json().data,
  );
  assert.equal(rest.nextOffset, null);
  assert.equal(
    entityDocumentsPageSchema.parse(
      (await app.inject(`${prefix}/documents?ref=${feature.key}&archived=true`)).json().data,
    ).total,
    0,
  );
  const missing = await app.inject(`${prefix}/documents?ref=FEATURE-404`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "ENTITY_NOT_FOUND");
  assert.equal((await app.inject(`${prefix}/documents`)).statusCode, 400);
  assert.ok(engine);
});

test("HTTP Backend материалов совпадает с local Core и не повторяет запись", async (t) => {
  const { app, workspace, engine, task, rules, link } = await library(t);
  await app.listen(0, "127.0.0.1");
  const backend = await createHttpBackend(await app.getUrl(), workspace.config.projectId);
  assert.deepEqual(
    await backend.entities.documentFacets({ tags: ["API"] }),
    await engine.documentFacets({ tags: ["api"] }),
  );
  const saved = await backend.entities.relateDocument(
    {
      ref: link.key,
      ifRevision: link.revision,
      action: "attach",
      target: task.key,
      type: "references",
      requestId: "backend-attach",
    },
    "agent",
  );
  assert.equal(saved.action, "link");
  await assert.rejects(
    backend.entities.relateDocument(
      {
        ref: link.key,
        ifRevision: saved.revision,
        action: "attach",
        target: task.key,
        type: "references",
        requestId: "backend-again",
      },
      "agent",
    ),
    { code: "ALREADY_EXISTS" },
  );
  await assert.rejects(
    backend.entities.relateDocument(
      {
        ref: link.key,
        ifRevision: saved.revision,
        action: "detach",
        target: task.key,
        type: "documents",
        requestId: "backend-missing",
      },
      "agent",
    ),
    { code: "RELATION_NOT_FOUND" },
  );
  assert.deepEqual(
    await backend.entities.entityDocuments({ ref: task.key }),
    await engine.entityDocuments({ ref: task.key }),
  );
  const bulk = await backend.entities.documentBulk(
    {
      items: [
        { ref: rules.key, ifRevision: rules.revision },
        { ref: link.key, ifRevision: link.revision },
      ],
      operation: { type: "addTags", tags: ["backend"] },
      requestId: "backend-bulk",
    },
    "agent",
  );
  assert.deepEqual(
    bulk.items.map((item) => item.status),
    ["applied", "conflict"],
  );
  assert.equal((await engine.get({ ref: rules.key })).revision, bulk.items[0]!.revision);
});

/** Прежний Server: без возможности материалов и без новых полей карточки и данных документа. */
async function legacyProxy(t: TestContext, upstream: string) {
  const forwarded: string[] = [];
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value as Record<string, unknown>);
    const isDocument = (value as { kind?: unknown }).kind !== undefined;
    return Object.fromEntries(
      entries
        .filter(
          ([name]) =>
            !["format", "documentFormat", "url", "tags"].includes(name) ||
            // Карточка document и данные документа прежнего сервера не содержат новых полей.
            !isDocument,
        )
        .map(([name, item]) => [name, strip(item)]),
    );
  };
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    forwarded.push(`${request.method} ${request.url} ${Buffer.concat(chunks).toString()}`);
    const reply = await fetch(new URL(request.url ?? "/", upstream), {
      method: request.method ?? "GET",
      headers: { "content-type": request.headers["content-type"] ?? "application/json" },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = JSON.parse(
      (await reply.text()).replaceAll("relay-document-materials-v1", "relay-document-materials-v0"),
    );
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(strip(body)));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, forwarded };
}

test("HTTP Backend и прежний Server: чтение работает, новые операции и поля дают SERVER_INCOMPATIBLE", async (t) => {
  const { app, workspace, task, rules, link } = await library(t);
  await app.listen(0, "127.0.0.1");
  const proxy = await legacyProxy(t, await app.getUrl());
  const backend = await createHttpBackend(proxy.url, workspace.config.projectId);
  // Чтение прежних ответов без format/tags: значения по умолчанию, без INVALID_SERVER_RESPONSE.
  const page = await backend.entities.list({ kind: "document", sort: "title" });
  const card = page.items.find((item) => item.key === link.key)!.document!;
  assert.deepEqual([card.format, card.tags, card.url], ["markdown", [], undefined]);
  const detail = await backend.entities.get({ ref: rules.key });
  assert.equal(detail.data.kind, "document");
  assert.equal(detail.document?.format, "markdown");
  assert.equal((await backend.entities.resolve({ ref: rules.key })).key, rules.key);
  assert.ok((await backend.entities.list({ kind: "document", q: "Правила" })).total >= 1);

  const before = proxy.forwarded.length;
  const incompatible = { code: "SERVER_INCOMPATIBLE" };
  await assert.rejects(backend.entities.documentFacets({}), incompatible);
  await assert.rejects(backend.entities.entityDocuments({ ref: task.key }), incompatible);
  await assert.rejects(
    backend.entities.relateDocument(
      {
        ref: link.key,
        ifRevision: link.revision,
        action: "attach",
        target: task.key,
        type: "references",
        requestId: "legacy-relate",
      },
      "agent",
    ),
    incompatible,
  );
  await assert.rejects(
    backend.entities.documentBulk(
      {
        items: [{ ref: link.key, ifRevision: link.revision }],
        operation: { type: "pin", pinned: true },
        requestId: "legacy-bulk",
      },
      "agent",
    ),
    incompatible,
  );
  await assert.rejects(backend.entities.list({ kind: "document", tags: ["api"] }), incompatible);
  await assert.rejects(
    backend.entities.list({ kind: "document", unattached: "true" }),
    incompatible,
  );
  await assert.rejects(
    backend.entities.create(
      {
        requestId: "legacy-link",
        data: {
          kind: "document",
          name: "Ссылка",
          summary: "",
          documentKind: "description",
          documentFormat: "link",
          url: "https://example.com/x",
        },
      },
      "agent",
    ),
    (error: Error & { code?: string; message: string }) =>
      error.code === "SERVER_INCOMPATIBLE" && /documentFormat, url/.test(error.message),
  );
  await assert.rejects(
    backend.entities.update(
      {
        ref: rules.key,
        ifRevision: rules.revision,
        requestId: "legacy-tags",
        changes: { kind: "document", tags: ["x"] },
      },
      "agent",
    ),
    incompatible,
  );
  await assert.rejects(
    backend.product.mutate(
      {
        action: "update",
        id: rules.ref.id,
        ifRevision: rules.revision,
        requestId: "legacy-product",
        fields: { kind: "document", tags: ["x"] },
      } as never,
      "agent",
    ),
    incompatible,
  );
  assert.equal(proxy.forwarded.length, before, "несовместимые запросы не отправляются");

  // Запись без новых полей проходит через прежний сервер.
  const created = await backend.entities.create(
    {
      requestId: "legacy-create",
      data: {
        kind: "document",
        name: "Обычный",
        summary: "",
        body: "Текст",
        documentKind: "rules",
      },
    },
    "agent",
  );
  const updated = await backend.entities.update(
    {
      ref: created.key,
      ifRevision: created.revision,
      requestId: "legacy-update",
      changes: { kind: "document", name: "Обычный 2", pinned: true },
    },
    "agent",
  );
  assert.equal(updated.revision, created.revision + 1);
});
