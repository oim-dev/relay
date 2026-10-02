import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EntityEngine } from "@relay/core/application/entities/service";
import { GraphService } from "@relay/core/application/graph/service";
import { ProductRepository } from "@relay/core/storage/product";
import { StorageService } from "@relay/core/application/storage/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { validateWorkspace } from "@relay/core/application/validate";
import { matchesTarget } from "@relay/core/application/entities/document-library";
import { fixture } from "./helpers/workspace.js";

type Engine = EntityEngine;
let sequence = 0;
const rid = (name: string) => `${name}-${++sequence}`;

/** Фича со сценарием, задача и движок; документы создаются в каждом тесте. */
async function library(t: TestContext) {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Каталог", summary: "", description: "Требования" },
    },
    "agent",
  );
  const scenario = await engine.create(
    {
      requestId: "scenario",
      data: { kind: "scenario", featureId: feature.key, name: "Поиск", description: "Найти" },
    },
    "agent",
  );
  const task = await engine.create(
    { requestId: "task", data: { kind: "task", board: "BOARD-INFRA", title: "Деплой" } },
    "agent",
  );
  return { workspace, engine, feature, scenario, task };
}

async function documentData(engine: Engine, ref: string) {
  const detail = await engine.get({ ref });
  assert.equal(detail.data.kind, "document");
  return { detail, data: detail.data as Extract<typeof detail.data, { kind: "document" }> };
}

async function documentEdges(engine: Engine, id: string) {
  const graph = await new GraphService(engine.workspace).read({ root: `document:${id}` });
  return graph.edges
    .filter((edge) => edge.from.id === id || edge.to.id === id)
    .map((edge) => `${edge.from.kind}:${edge.from.id}>${edge.type}>${edge.to.kind}:${edge.to.id}`)
    .sort();
}

test("материалы: формат link, валидация адреса и смена URL/формата без потери связей", async (t) => {
  const { engine, feature, task } = await library(t);
  const base = {
    kind: "document" as const,
    name: "Макет",
    summary: "",
    documentKind: "description" as const,
  };
  // Ссылка без Markdown допустима; адрес обязателен и только http/https.
  const link = await engine.create(
    {
      requestId: "link",
      data: {
        ...base,
        documentFormat: "link",
        url: "https://example.com/design?id=1#frame",
        targets: [feature.key],
        relations: [{ target: task.ref, type: "references", description: "Перед деплоем" }],
      },
    },
    "agent",
  );
  let { detail, data } = await documentData(engine, link.key);
  assert.equal(data.body, "");
  assert.equal(detail.document?.format, "link");
  assert.equal(detail.document?.url, "https://example.com/design?id=1#frame");
  const edgesBefore = await documentEdges(engine, link.ref.id);
  assert.equal(edgesBefore.length, 2);
  for (const [url, documentFormat] of [
    [undefined, "link"],
    ["ftp://example.com/file", "link"],
    ["javascript:alert(1)", "link"],
    ["/relative/path", "link"],
    ["https://example.com", "markdown"],
  ] as const)
    await assert.rejects(
      engine.create(
        {
          requestId: rid("bad"),
          data: { ...base, body: "Текст", documentFormat, ...(url ? { url } : {}) },
        },
        "agent",
      ),
      { code: "VALIDATION_ERROR" },
      `${documentFormat} ${url}`,
    );
  await assert.rejects(
    engine.create({ requestId: "empty", data: { ...base, body: "  \n" } }, "agent"),
    { code: "VALIDATION_ERROR" },
  );

  // Смена адреса и пояснения сохраняет ID, links, relations и рёбра графа.
  const changed = await engine.update(
    {
      ref: link.key,
      ifRevision: link.revision,
      requestId: "url",
      changes: { kind: "document", url: "http://intranet.local/v2", body: "## Зачем\nМакет v2" },
    },
    "agent",
  );
  ({ detail, data } = await documentData(engine, link.key));
  assert.equal(detail.ref.id, link.ref.id);
  assert.equal(data.url, "http://intranet.local/v2");
  assert.equal(data.links.length, 1);
  assert.equal(data.relations?.length, 1);
  assert.deepEqual(await documentEdges(engine, link.ref.id), edgesBefore);
  await assert.rejects(
    engine.update(
      {
        ref: link.key,
        ifRevision: changed.revision,
        requestId: "bad-url",
        changes: { kind: "document", url: "mailto:a@b.c" },
      },
      "agent",
    ),
    { code: "VALIDATION_ERROR" },
  );

  // Переход в Markdown снимает адрес, но требует непустого текста; связи остаются.
  const markdown = await engine.update(
    {
      ref: link.key,
      ifRevision: changed.revision,
      requestId: "to-markdown",
      changes: { kind: "document", documentFormat: "markdown" },
    },
    "agent",
  );
  ({ detail, data } = await documentData(engine, link.key));
  assert.equal(detail.document?.format, "markdown");
  assert.equal(data.url, undefined);
  assert.equal(data.body, "## Зачем\nМакет v2");
  assert.equal(data.links.length, 1);
  assert.deepEqual(await documentEdges(engine, link.ref.id), edgesBefore);
  await assert.rejects(
    engine.update(
      {
        ref: link.key,
        ifRevision: markdown.revision,
        requestId: "clear-body",
        changes: { kind: "document", body: "" },
      },
      "agent",
    ),
    { code: "VALIDATION_ERROR" },
  );
  await assert.rejects(
    engine.update(
      {
        ref: link.key,
        ifRevision: markdown.revision,
        requestId: "url-on-markdown",
        changes: { kind: "document", url: "https://example.com" },
      },
      "agent",
    ),
    { code: "VALIDATION_ERROR" },
  );
  // Тип и формат независимы: решение может быть внешней ссылкой.
  await engine.update(
    {
      ref: link.key,
      ifRevision: markdown.revision,
      requestId: "decision-link",
      changes: {
        kind: "document",
        documentKind: "decision",
        documentFormat: "link",
        url: "https://example.com/adr/1",
      },
    },
    "agent",
  );
  ({ detail, data } = await documentData(engine, link.key));
  assert.equal(detail.document?.kind, "decision");
  assert.equal(detail.document?.format, "link");
  assert.equal(data.links.length, 1);
  assert.equal(data.relations?.length, 1);
});

test("материалы: прежняя запись без формата и тегов читается и изменяется без потерь", async (t) => {
  const { workspace, engine, feature, task } = await library(t);
  const saved = await engine.create(
    {
      requestId: "old",
      data: {
        kind: "document",
        name: "Прежний",
        summary: "",
        body: "Текст\r\n  с отступом ",
        documentKind: "rules",
        sectionId: "development",
        pinned: true,
        targets: [feature.key],
        relations: [{ target: task.ref, type: "references", description: "Пояснение" }],
      },
    },
    "agent",
  );
  const path = join(
    new ProductRepository(workspace).root,
    "../entities/documents",
    `${saved.ref.id}.json`,
  );
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(disk.data.documentFormat, "markdown");
  delete disk.data.documentFormat;
  delete disk.data.tags;
  await writeFile(path, JSON.stringify(disk));
  // Внешняя правка файла — штатный путь storage reindex, а не скрытое чтение мимо индекса.
  await new StorageService(workspace).reindex();
  const { detail, data } = await documentData(engine, saved.key);
  assert.equal(data.documentFormat, undefined);
  assert.equal(detail.document?.format, "markdown");
  assert.deepEqual(detail.document?.tags, []);
  assert.equal(
    (await engine.list({ kind: "document", documentFormat: "markdown" })).items[0]?.ref.id,
    saved.ref.id,
  );
  const edges = await documentEdges(engine, saved.ref.id);
  await engine.update(
    {
      ref: saved.key,
      ifRevision: detail.revision,
      requestId: "rename",
      changes: { kind: "document", name: "Новое название", tags: ["Правила"] },
    },
    "agent",
  );
  const after = await documentData(engine, saved.key);
  assert.equal(after.detail.ref.id, saved.ref.id);
  assert.equal(after.data.body, "Текст\r\n  с отступом ");
  assert.equal(after.data.sectionId, "development");
  assert.equal(after.data.pinned, true);
  assert.deepEqual(after.data.links, data.links);
  assert.deepEqual(after.data.relations, data.relations);
  assert.deepEqual(after.data.tags, ["Правила"]);
  assert.deepEqual(await documentEdges(engine, saved.ref.id), edges);
});

test("материалы: нормализация тегов и лимиты", async (t) => {
  const { engine } = await library(t);
  const saved = await engine.create(
    {
      requestId: "tags",
      data: {
        kind: "document",
        name: "Теги",
        summary: "",
        body: "Текст",
        documentKind: "research",
        tags: ["  API ", "api", "", "   ", "Дизайн", "ДИЗАЙН ", "UX"],
      },
    },
    "agent",
  );
  assert.deepEqual((await engine.get({ ref: saved.key })).document?.tags, ["API", "Дизайн", "UX"]);
  for (const tags of [
    Array.from({ length: 21 }, (_, index) => `t${index}`),
    ["x".repeat(51)],
    ["две\nстроки"],
  ])
    await assert.rejects(
      engine.create(
        {
          requestId: rid("tags"),
          data: {
            kind: "document",
            name: "Т",
            summary: "",
            body: "Т",
            documentKind: "rules",
            tags,
          },
        },
        "agent",
      ),
      { code: "VALIDATION_ERROR" },
    );
  // Ровно 50 символов допустимы; сравнение без учёта регистра в фильтре.
  await engine.create(
    {
      requestId: "tag-50",
      data: {
        kind: "document",
        name: "Т50",
        summary: "",
        body: "Т",
        documentKind: "rules",
        tags: ["я".repeat(50)],
      },
    },
    "agent",
  );
  assert.equal((await engine.list({ kind: "document", tags: ["api", " дизайн"] })).total, 1);
});

/** Набор материалов для каталога: разные разделы, теги, форматы, типы и состояния. */
async function catalogFixture(t: TestContext) {
  const context = await library(t);
  const { engine, feature, scenario, task } = context;
  const make = async (name: string, data: Record<string, unknown>) =>
    engine.create(
      {
        requestId: rid("doc"),
        data: {
          kind: "document",
          name,
          summary: "",
          body: `Текст ${name}`,
          documentKind: "description",
          ...data,
        } as never,
      },
      "agent",
    );
  const docs = {
    a: await make("A", {
      sectionId: "product",
      tags: ["api", "web"],
      pinned: true,
      documentStatus: "active",
      targets: [feature.key],
    }),
    b: await make("B", {
      sectionId: "product",
      tags: ["API"],
      documentFormat: "link",
      url: "https://example.com/b",
      body: "",
      documentKind: "decision",
      relations: [{ target: scenario.ref, type: "documents", description: "" }],
    }),
    c: await make("C", { sectionId: null, tags: ["web"], documentKind: "rules" }),
    d: await make("D", {
      sectionId: "architecture",
      tags: ["api", "web"],
      documentStatus: "archived",
      relations: [{ target: task.ref, type: "references", description: "" }],
    }),
    e: await make("E", { sectionId: null, documentStatus: "active", pinned: true }),
  };
  return { ...context, docs };
}

test("материалы: фильтры каталога и их сочетание, сортировка и продолжение страниц", async (t) => {
  const { engine, docs, feature, scenario } = await catalogFixture(t);
  const names = async (query: Parameters<Engine["list"]>[0]) =>
    (await engine.list({ kind: "document", sort: "title", ...query })).items.map(
      (item) => item.title,
    );
  assert.deepEqual(await names({ tags: ["API"] }), ["A", "B", "D"]);
  assert.deepEqual(await names({ tags: ["api", "web"] }), ["A", "D"]);
  assert.deepEqual(await names({ tags: ["api", "web"], archived: "false" }), ["A"]);
  assert.deepEqual(await names({ documentFormat: "link" }), ["B"]);
  assert.deepEqual(await names({ documentFormat: "markdown", section: "none" }), ["C", "E"]);
  assert.deepEqual(await names({ unattached: "true" }), ["C", "E"]);
  assert.deepEqual(await names({ unattached: "false", archived: "false" }), ["A", "B"]);
  assert.deepEqual(await names({ status: "draft" }), ["B", "C"]);
  assert.deepEqual(await names({ status: "archived" }), ["D"]);
  assert.deepEqual(await names({ pinned: "true", section: "none" }), ["E"]);
  assert.deepEqual(await names({ documentKind: "decision", tags: ["api"] }), ["B"]);
  // Прикрепление к фиче не распространяется на сценарий и наоборот.
  assert.deepEqual(await names({ target: feature.key }), ["A"]);
  assert.deepEqual(await names({ target: scenario.key }), ["B"]);
  assert.deepEqual(await names({ q: "example.com" }), ["B"]);
  await assert.rejects(engine.list({ kind: "task", tags: ["api"] }), {
    code: "UNSUPPORTED_ENTITY_FILTER",
  });

  // Последнее изменение поднимает документ вверх без порога давности.
  const c = await engine.get({ ref: docs.c.key });
  await engine.update(
    {
      ref: docs.c.key,
      ifRevision: c.revision,
      requestId: "touch",
      changes: { kind: "document", summary: "Обновлено" },
    },
    "agent",
  );
  const first = await engine.list({ kind: "document", sort: "updated", limit: 2 });
  assert.equal(first.items[0]?.title, "C");
  assert.equal(first.total, 5);
  const seen = first.items.map((item) => item.title);
  let offset = first.nextOffset;
  while (offset !== null) {
    const page = await engine.list({
      kind: "document",
      sort: "updated",
      limit: 2,
      offset,
      version: first.version,
    });
    seen.push(...page.items.map((item) => item.title));
    offset = page.nextOffset;
  }
  assert.deepEqual([...seen].sort(), ["A", "B", "C", "D", "E"]);
  assert.equal(new Set(seen).size, 5);
});

test("материалы: счётчики считаются по полным данным с объявленной областью", async (t) => {
  const { engine } = await catalogFixture(t);
  const all = await engine.documentFacets();
  assert.equal(all.total, 5);
  assert.deepEqual(all.views, {
    all: 4,
    pinned: 2,
    draft: 2,
    unsectioned: 2,
    unattached: 2,
    archived: 1,
  });
  assert.deepEqual(
    all.sections.map((entry) => [entry.sectionId, entry.count]),
    [
      ["product", 2],
      ["architecture", 1],
      ["development", 0],
      ["infrastructure", 0],
      ["processes", 0],
      [null, 2],
    ],
  );
  assert.deepEqual(all.tags, [
    { tag: "api", count: 3 },
    { tag: "web", count: 3 },
  ]);
  assert.deepEqual(all.formats, [
    { format: "markdown", count: 4 },
    { format: "link", count: 1 },
  ]);
  assert.equal(all.kinds.find((entry) => entry.kind === "description")?.count, 3);
  assert.deepEqual(
    all.statuses.map((entry) => [entry.status, entry.count]),
    [
      ["draft", 2],
      ["active", 2],
      ["archived", 1],
    ],
  );
  // Страница не влияет на счётчики; ось не сужается собственным фильтром.
  const scoped = await engine.documentFacets({
    archived: "false",
    tags: ["api"],
    section: "product",
    documentFormat: "link",
  });
  assert.equal(scoped.total, 1);
  assert.deepEqual(scoped.formats, [
    { format: "markdown", count: 1 },
    { format: "link", count: 1 },
  ]);
  assert.deepEqual(
    scoped.sections.filter((entry) => entry.count > 0),
    [{ sectionId: "product", count: 1 }],
  );
  assert.deepEqual(scoped.tags, [{ tag: "API", count: 1 }]);
  // Представления зависят только от содержательных фильтров: архив и раздел не скрывают их.
  assert.deepEqual(scoped.views, {
    all: 1,
    pinned: 0,
    draft: 1,
    unsectioned: 0,
    unattached: 0,
    archived: 0,
  });
  const archivedScope = await engine.documentFacets({ archived: "true" });
  assert.equal(archivedScope.total, 1);
  assert.equal(archivedScope.statuses.find((entry) => entry.status === "draft")?.count, 2);
  assert.equal(archivedScope.version, (await engine.list({ kind: "document" })).version);
});

test("материалы: массовая операция с частичным отказом, конфликтом и сохранением связей", async (t) => {
  const { engine, docs } = await catalogFixture(t);
  const before = {
    a: await documentData(engine, docs.a.key),
    b: await documentData(engine, docs.b.key),
    d: await documentData(engine, docs.d.key),
  };
  // Чужое изменение B после чтения списка.
  await engine.update(
    {
      ref: docs.b.key,
      ifRevision: before.b.detail.revision,
      requestId: "foreign",
      changes: { kind: "document", summary: "Чужая правка" },
    },
    "other",
  );
  const result = await engine.documentBulk(
    {
      requestId: "bulk-tags",
      operation: { type: "addTags", tags: [" Важное ", "API"] },
      items: [
        { ref: docs.a.key, ifRevision: before.a.detail.revision },
        { ref: docs.b.key, ifRevision: before.b.detail.revision },
        { ref: "DOC-999", ifRevision: 1 },
        { ref: docs.d.key, ifRevision: before.d.detail.revision },
      ],
    },
    "agent",
  );
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["applied", "conflict", "not_found", "applied"],
  );
  assert.equal(result.applied, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.items[1]?.revision, before.b.detail.revision + 1);
  assert.equal(result.items[1]?.error?.code, "REVISION_CONFLICT");
  assert.equal(result.items[2]?.error?.code, "ENTITY_NOT_FOUND");
  const a = await documentData(engine, docs.a.key);
  assert.deepEqual(a.data.tags, ["api", "web", "Важное"]);
  assert.equal(a.detail.revision, result.items[0]?.revision);
  assert.deepEqual(a.data.links, before.a.data.links);
  const b = await documentData(engine, docs.b.key);
  assert.deepEqual(b.data.tags, ["API"]);
  assert.equal(b.data.summary, "Чужая правка");
  const d = await documentData(engine, docs.d.key);
  assert.deepEqual(d.data.relations, before.d.data.relations);

  // Перемещение: несуществующий раздел — ошибка данных; null и снятие тегов.
  const move = await engine.documentBulk(
    {
      requestId: "bulk-move",
      operation: { type: "move", sectionId: "missing" },
      items: [{ ref: docs.a.key, ifRevision: a.detail.revision }],
    },
    "agent",
  );
  assert.equal(move.items[0]?.status, "invalid");
  const toNone = await engine.documentBulk(
    {
      requestId: "bulk-none",
      operation: { type: "move", sectionId: null },
      items: [
        { ref: docs.a.key, ifRevision: a.detail.revision },
        { ref: docs.c.key, ifRevision: (await engine.get({ ref: docs.c.key })).revision },
      ],
    },
    "agent",
  );
  assert.deepEqual(
    toNone.items.map((item) => item.status),
    ["applied", "unchanged"],
  );
  const removed = await engine.documentBulk(
    {
      requestId: "bulk-remove",
      operation: { type: "removeTags", tags: ["важное", "WEB"] },
      items: [{ ref: docs.a.key, ifRevision: toNone.items[0]!.revision! }],
    },
    "agent",
  );
  assert.equal(removed.items[0]?.status, "applied");
  const final = await documentData(engine, docs.a.key);
  assert.deepEqual(final.data.tags, ["api"]);
  assert.equal(final.data.sectionId, null);
  assert.deepEqual(final.data.links, before.a.data.links);
  assert.deepEqual(final.data.relations, before.a.data.relations);
  const archived = await engine.documentBulk(
    {
      requestId: "bulk-archive",
      operation: { type: "setStatus", documentStatus: "archived" },
      items: [{ ref: docs.a.key, ifRevision: final.detail.revision }],
    },
    "agent",
  );
  assert.equal(archived.items[0]?.status, "applied");
  assert.equal((await engine.get({ ref: docs.a.key })).document?.status, "archived");
  await assert.rejects(
    engine.documentBulk(
      {
        requestId: "dup",
        operation: { type: "pin", pinned: true },
        items: [
          { ref: docs.a.key, ifRevision: 1 },
          { ref: docs.a.key, ifRevision: 1 },
        ],
      },
      "agent",
    ),
    { code: "VALIDATION_ERROR" },
  );
});

test("материалы: одна связь документа, обратный запрос сущности и Markdown-ссылки", async (t) => {
  const { engine, feature, scenario, task } = await library(t);
  const saved = await engine.create(
    {
      requestId: "rel",
      data: {
        kind: "document",
        name: "Правила поиска",
        summary: "",
        body: `См. [сценарий](${scenario.key}) и [задачу](https://relay.local/${task.key})`,
        documentKind: "rules",
        targets: [feature.key],
        relations: [{ target: task.ref, type: "references", description: "Перед деплоем" }],
      },
    },
    "agent",
  );
  // Markdown-ссылки не создают отношений.
  assert.equal((await engine.entityDocuments({ ref: scenario.key })).total, 0);
  const attached = await engine.relateDocument(
    {
      ref: saved.key,
      ifRevision: saved.revision,
      requestId: "attach",
      action: "attach",
      target: scenario.key,
      type: "documents",
      description: "Описывает поиск",
    },
    "agent",
  );
  assert.equal(attached.action, "link");
  let data = (await documentData(engine, saved.key)).data;
  assert.equal(data.links.length, 1);
  assert.equal(data.relations?.length, 2);
  // Родитель не получает материал ребёнка, ребёнок — родителя.
  const featureDocs = await engine.entityDocuments({ ref: feature.key });
  assert.deepEqual(featureDocs.items[0]?.relations, [
    { type: "documents", description: "", source: "links" },
  ]);
  const scenarioDocs = await engine.entityDocuments({ ref: scenario.key });
  assert.equal(scenarioDocs.total, 1);
  assert.equal(scenarioDocs.items[0]?.relations[0]?.description, "Описывает поиск");
  assert.equal(scenarioDocs.items[0]?.document.document?.format, "markdown");
  assert.equal(scenarioDocs.target.ref.id, scenario.ref.id);
  await assert.rejects(
    engine.relateDocument(
      {
        ref: saved.key,
        ifRevision: attached.revision,
        requestId: "dup",
        action: "attach",
        target: scenario.key,
        type: "documents",
      },
      "agent",
    ),
    { code: "ALREADY_EXISTS" },
  );
  await assert.rejects(
    engine.relateDocument(
      {
        ref: saved.key,
        ifRevision: saved.revision,
        requestId: "stale",
        action: "detach",
        target: task.key,
        type: "references",
      },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
  // Изменение типа и пояснения одной связи сохраняет прочие и рёбра пишутся сразу.
  const retyped = await engine.relateDocument(
    {
      ref: saved.key,
      ifRevision: attached.revision,
      requestId: "retype",
      action: "update",
      target: task.key,
      type: "references",
      nextType: "documents",
      description: "Документ описывает задачу",
    },
    "agent",
  );
  data = (await documentData(engine, saved.key)).data;
  assert.deepEqual(data.relations?.[0], {
    target: task.ref,
    type: "documents",
    description: "Документ описывает задачу",
  });
  assert.equal(data.links.length, 1);
  assert.deepEqual(await documentEdges(engine, saved.ref.id), [
    `document:${saved.ref.id}>documents>feature:${feature.ref.id}`,
    `document:${saved.ref.id}>documents>scenario:${scenario.ref.id}`,
    `document:${saved.ref.id}>documents>task:${task.ref.id}`,
  ]);
  // Совместимую область можно открепить, остальные связи остаются.
  const detached = await engine.relateDocument(
    {
      ref: saved.key,
      ifRevision: retyped.revision,
      requestId: "detach-legacy",
      action: "detach",
      target: feature.key,
      type: "documents",
    },
    "agent",
  );
  data = (await documentData(engine, saved.key)).data;
  assert.deepEqual(data.links, []);
  assert.equal(data.relations?.length, 2);
  assert.equal((await engine.entityDocuments({ ref: feature.key })).total, 0);
  await assert.rejects(
    engine.relateDocument(
      {
        ref: saved.key,
        ifRevision: detached.revision,
        requestId: "missing",
        action: "detach",
        target: feature.key,
        type: "documents",
      },
      "agent",
    ),
    { code: "RELATION_NOT_FOUND" },
  );
  // Архивный материал виден с признаком и фильтруется.
  await engine.update(
    {
      ref: saved.key,
      ifRevision: detached.revision,
      requestId: "archive",
      changes: { kind: "document", documentStatus: "archived" },
    },
    "agent",
  );
  const archived = await engine.entityDocuments({ ref: task.key });
  assert.equal(archived.items[0]?.archived, true);
  assert.equal((await engine.entityDocuments({ ref: task.key, archived: "false" })).total, 0);
});

test("материалы: фильтр цели документа учитывает вид, ID разных видов могут совпадать", async (t) => {
  const { engine, scenario } = await catalogFixture(t);
  // ID уникальны внутри области вида (задачи, доски, планы, продукт выделяются отдельно).
  const entry = (filters: Record<string, string[]>) =>
    ({ filters }) as unknown as Parameters<typeof matchesTarget>[0];
  const document = entry({ target: ["Same0001"], targetAddress: ["task:Same0001"] });
  assert.equal(matchesTarget(document, "target", { kind: "task", id: "Same0001" }), true);
  assert.equal(matchesTarget(document, "target", { kind: "feature", id: "Same0001" }), false);
  // Прочие виды сохраняют прежнее сравнение ID внутри своих целей.
  const task = entry({ target: ["Same0001"] });
  assert.equal(matchesTarget(task, "target", { kind: "feature", id: "Same0001" }), true);
  // Прежние форматы параметра: ключ, ID и kind:ID.
  for (const target of [scenario.key, scenario.ref.id, `scenario:${scenario.ref.id}`])
    assert.deepEqual(
      (await engine.list({ kind: "document", target })).items.map((item) => item.title),
      ["B"],
    );
  assert.equal((await engine.documentFacets({ target: `scenario:${scenario.ref.id}` })).total, 1);
});

test("материалы: индекс карточек прежней версии не ломает запись сущностей и doctor", async (t) => {
  const { workspace, engine, feature } = await library(t);
  const markdown = await engine.create(
    {
      requestId: "old-card",
      data: { kind: "document", name: "Старый", summary: "", body: "Текст", documentKind: "rules" },
    },
    "agent",
  );
  const link = await engine.create(
    {
      requestId: "old-link-card",
      data: {
        kind: "document",
        name: "Ссылка",
        summary: "",
        documentKind: "description",
        documentFormat: "link",
        url: "https://example.com/spec",
        tags: ["API"],
      },
    },
    "agent",
  );
  // Образец прежнего формата: карточка документа без format, url и tags, как писала прежняя версия.
  await workspace.withEntityStorage((store, owned) =>
    store.transaction(owned, async (session) => {
      for (const ref of [markdown.ref, link.ref]) {
        const address = `${ref.kind}:${ref.id}`;
        const card = structuredClone((await session.indexGet("cards", address)) as never) as {
          document: Record<string, unknown>;
        };
        assert.equal(typeof card.document.format, "string");
        delete card.document.format;
        delete card.document.url;
        delete card.document.tags;
        session.indexSet("cards", address, card as never);
      }
    }),
  );
  const stored = await workspace.withEntityStorage((store, owned) =>
    store.transaction(owned, (session) => session.indexGet("cards", `document:${link.ref.id}`)),
  );
  assert.equal((stored as { document: Record<string, unknown> }).document.format, undefined);
  assert.equal((await validateWorkspace(workspace)).valid, true);
  // Записи разных сущностей проходят, карточки обновляются до текущего формата.
  const current = await engine.get({ ref: feature.key });
  await engine.update(
    {
      ref: feature.key,
      ifRevision: current.revision,
      requestId: "feature-after-old-index",
      changes: { kind: "feature", summary: "Обновлено" },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "task-after-old-index",
      data: { kind: "task", board: "BOARD-INFRA", title: "Новая" },
    },
    "agent",
  );
  const resolved = await engine.resolve({ ref: link.key });
  assert.equal(resolved.document?.format, "link");
  assert.deepEqual(resolved.document?.tags, ["API"]);
  assert.equal((await engine.get({ ref: markdown.key })).document?.format, "markdown");
  assert.equal((await validateWorkspace(workspace)).valid, true);
});

test("материалы: сохранение продукта без формата и адреса сохраняет ссылку", async (t) => {
  const { workspace, engine } = await library(t);
  const link = await engine.create(
    {
      requestId: "product-save-link",
      data: {
        kind: "document",
        name: "Ссылка",
        summary: "",
        documentKind: "description",
        documentFormat: "link",
        url: "https://example.com/spec",
        tags: ["API"],
        sectionId: "product",
      },
    },
    "agent",
  );
  // Прежний путь записи (MCP product_document_save, REST product mutate) не знает новых полей.
  const saved = await new ProductQueries(workspace).mutate(
    {
      action: "update",
      id: link.ref.id,
      ifRevision: link.revision,
      requestId: "legacy-save",
      fields: {
        kind: "document",
        name: "Ссылка v2",
        summary: "",
        body: "",
        documentKind: "description",
        links: [],
      },
    },
    "agent",
  );
  const { detail, data } = await documentData(engine, link.key);
  assert.equal(detail.revision, saved.revision);
  assert.equal(data.name, "Ссылка v2");
  assert.equal(data.documentFormat, "link");
  assert.equal(data.url, "https://example.com/spec");
  assert.deepEqual(data.tags, ["API"]);
  assert.equal(data.sectionId, "product");
});

test("материалы: ошибки ссылок документа имеют согласованные коды завершения", async (t) => {
  const { engine, task } = await library(t);
  const saved = await engine.create(
    {
      requestId: "codes",
      data: { kind: "document", name: "Коды", summary: "", body: "Текст", documentKind: "rules" },
    },
    "agent",
  );
  const change = (requestId: string, changes: Record<string, unknown>) =>
    engine.update(
      {
        ref: saved.key,
        ifRevision: saved.revision,
        requestId,
        changes: { kind: "document", ...changes } as never,
      },
      "agent",
    );
  // INVALID_REFERENCE во всём Core — конфликт данных (exitCode 4, HTTP 409).
  await assert.rejects(change("missing-section", { sectionId: "missing" }), {
    code: "INVALID_REFERENCE",
    exitCode: 4,
  });
  await assert.rejects(
    change("self", {
      relations: [{ target: saved.ref, type: "references", description: "" }],
    }),
    { code: "INVALID_REFERENCE", exitCode: 4 },
  );
  const relation = (action: "attach" | "detach", requestId: string) =>
    engine.relateDocument(
      {
        ref: saved.key,
        ifRevision: saved.revision,
        requestId,
        action,
        target: task.key,
        type: "references",
      },
      "agent",
    );
  await assert.rejects(relation("detach", "absent"), { code: "RELATION_NOT_FOUND", exitCode: 3 });
  await assert.rejects(change("empty", { body: " " }), { code: "VALIDATION_ERROR", exitCode: 2 });
  const attached = await relation("attach", "attach");
  await assert.rejects(
    engine.relateDocument(
      {
        ref: saved.key,
        ifRevision: attached.revision,
        requestId: "again",
        action: "attach",
        target: task.key,
        type: "references",
      },
      "agent",
    ),
    { code: "ALREADY_EXISTS", exitCode: 4 },
  );
});
