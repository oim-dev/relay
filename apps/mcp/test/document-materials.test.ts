import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { initialize } from "@relay/core/storage/workspace";
import { startServer } from "@relay/server-runtime";
import {
  entityDetailSchema,
  entitySavedSchema,
  entitiesPageSchema,
} from "@relay/contracts/entities";
import {
  documentBulkResultSchema,
  documentFacetsSchema,
  entityDocumentsPageSchema,
} from "@relay/contracts/entities/document-catalog";
import { startMcp } from "../src/server.js";

const materialTools = [
  "entity_document_facets",
  "entity_documents_list",
  "entity_document_bulk",
  "entity_document_relate",
];

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-mcp-materials-"));
  const closers: { close(): Promise<unknown> }[] = [];
  t.after(async () => {
    for (const item of closers.reverse()) await item.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "a"));
  await initialize(join(root, "a"), "tasks");
  const api = await startServer({
    cwd: root,
    port: 0,
    actor: "api",
    config: join(root, "a/.relay/config.json"),
  });
  closers.push(api);
  const connect = async (serverUrl: string) => {
    const mcp = await startMcp({ cwd: root, port: 0, serverUrl });
    closers.push(mcp);
    const client = new Client({ name: "агент-материалов", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)) as Transport);
    closers.push(client);
    return client;
  };
  return { api, connect, closers };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const body = z
    .object({
      ok: z.boolean(),
      data: z.record(z.string(), z.unknown()).optional(),
      error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
    })
    .parse(result.structuredContent);
  const text = z.object({ text: z.string() }).parse(result.content[0]).text;
  assert.equal(result.isError === true, !body.ok, name);
  return { ...body, text };
}

const write = (requestId: string) => ({ actor: "agent", requestId });

test("MCP материалов: ссылки и теги, фильтры, фасеты, одна связь, обратное чтение и массовая квитанция", async (t) => {
  const app = await setup(t);
  const client = await app.connect(app.api.url);
  const { tools } = await client.listTools();
  for (const name of materialTools)
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
  const create = tools.find((tool) => tool.name === "entity_document_create")!;
  assert.equal(create.inputSchema.required?.includes("body"), false);
  const createProperties = create.inputSchema.properties as Record<
    string,
    { description?: string }
  >;
  for (const name of ["documentFormat", "url", "tags", "body"])
    assert.match(createProperties[name]?.description ?? "", /[А-Яа-яЁё]/, name);
  assert.match(createProperties.body?.description ?? "", /link/);
  const relate = tools.find((tool) => tool.name === "entity_document_relate")!;
  assert.deepEqual([...(relate.inputSchema.required ?? [])].sort(), [
    "action",
    "actor",
    "ifRevision",
    "ref",
    "requestId",
    "target",
    "type",
  ]);
  assert.match(relate.description ?? "", /RELATION_NOT_FOUND/);

  const feature = entitySavedSchema.parse(
    (
      await call(client, "entity_feature_create", {
        name: "Поиск",
        summary: "",
        description: "## Требования\n\nНайти товар",
        ...write("feature"),
      })
    ).data,
  );
  const link = entitySavedSchema.parse(
    (
      await call(client, "entity_document_create", {
        name: "Внешняя спецификация API",
        summary: "Читать перед изменением поиска",
        documentKind: "specification",
        documentFormat: "link",
        url: "https://example.com/spec",
        tags: ["Архитектура", " api ", "API"],
        ...write("link"),
      })
    ).data,
  );
  const linkDetail = entityDetailSchema.parse(
    (await call(client, "entity_get", { ref: link.key })).data,
  );
  assert.equal(linkDetail.data.kind, "document");
  if (linkDetail.data.kind !== "document") throw new Error("Ожидался документ");
  assert.equal(linkDetail.data.documentFormat, "link");
  assert.equal(linkDetail.data.url, "https://example.com/spec");
  assert.deepEqual(linkDetail.data.tags, ["Архитектура", "api"]);
  const markdown = entitySavedSchema.parse(
    (
      await call(client, "entity_document_create", {
        name: "Правила поиска",
        summary: "",
        body: "## Правила\n\nУчитывать регистр",
        documentKind: "rules",
        tags: ["API"],
        ...write("markdown"),
      })
    ).data,
  );
  const withoutUrl = await call(client, "entity_document_create", {
    name: "Ссылка без адреса",
    summary: "",
    documentKind: "research",
    documentFormat: "link",
    ...write("link-no-url"),
  });
  assert.equal(withoutUrl.ok, false);
  assert.match(withoutUrl.error?.message ?? "", /[А-Яа-яЁё]/);
  const emptyMarkdown = await call(client, "entity_document_create", {
    name: "Пустой текст",
    summary: "",
    documentKind: "rules",
    ...write("empty-markdown"),
  });
  assert.equal(emptyMarkdown.ok, false);

  const list = async (filters: Record<string, unknown>) =>
    entitiesPageSchema.parse(
      (await call(client, "entities_list", { kind: "document", ...filters })).data,
    );
  assert.deepEqual(
    (await list({ tags: ["api", "архитектура"] })).items.map((item) => item.key),
    [link.key],
  );
  assert.equal((await list({ tags: ["api"] })).total, 2);
  assert.deepEqual(
    (await list({ documentFormat: "link" })).items.map((item) => item.document?.format),
    ["link"],
  );
  assert.equal((await list({ unattached: "true" })).total, 2);
  assert.equal((await list({ q: "example.com" })).total, 1);

  const facets = documentFacetsSchema.parse((await call(client, "entity_document_facets")).data);
  assert.equal(facets.total, 2);
  assert.equal(facets.tags.find((tag) => tag.tag.toLowerCase() === "api")?.count, 2);
  assert.equal(facets.formats.find((format) => format.format === "link")?.count, 1);
  assert.equal(facets.views.unattached, 2);
  const narrowed = documentFacetsSchema.parse(
    (await call(client, "entity_document_facets", { documentFormat: "link" })).data,
  );
  assert.equal(narrowed.total, 1);
  assert.equal(narrowed.formats.find((format) => format.format === "markdown")?.count, 1);

  const relateArgs = {
    ref: link.key,
    action: "attach",
    target: feature.key,
    type: "references",
    description: "Источник требований",
  };
  const attached = entitySavedSchema.parse(
    (
      await call(client, "entity_document_relate", {
        ...relateArgs,
        ifRevision: link.revision,
        ...write("attach"),
      })
    ).data,
  );
  assert.equal(attached.action, "link");
  const duplicate = await call(client, "entity_document_relate", {
    ...relateArgs,
    ifRevision: attached.revision,
    ...write("attach-again"),
  });
  assert.equal(duplicate.error?.code, "ALREADY_EXISTS");
  const stale = await call(client, "entity_document_relate", {
    ...relateArgs,
    type: "documents",
    ifRevision: link.revision,
    ...write("attach-stale"),
  });
  assert.equal(stale.error?.code, "REVISION_CONFLICT");
  const missing = await call(client, "entity_document_relate", {
    ref: link.key,
    action: "detach",
    target: feature.key,
    type: "documents",
    ifRevision: attached.revision,
    ...write("detach-missing"),
  });
  assert.equal(missing.error?.code, "RELATION_NOT_FOUND");
  const changed = entitySavedSchema.parse(
    (
      await call(client, "entity_document_relate", {
        ref: link.key,
        action: "update",
        target: feature.key,
        type: "references",
        nextType: "documents",
        description: "Описывает поиск",
        ifRevision: attached.revision,
        ...write("relation-update"),
      })
    ).data,
  );
  const used = entityDocumentsPageSchema.parse(
    (await call(client, "entity_documents_list", { ref: feature.key })).data,
  );
  assert.equal(used.total, 1);
  assert.equal(used.items[0]?.document.key, link.key);
  assert.deepEqual(used.items[0]?.relations, [
    { type: "documents", description: "Описывает поиск", source: "relations" },
  ]);
  assert.equal((await list({ unattached: "true" })).total, 1);

  const bulk = await call(client, "entity_document_bulk", {
    items: [
      { ref: link.key, ifRevision: changed.revision },
      { ref: markdown.key, ifRevision: markdown.revision + 5 },
      { ref: "DOC-404", ifRevision: 1 },
    ],
    operation: { type: "addTags", tags: ["Срочно"] },
    ...write("bulk"),
  });
  assert.equal(bulk.ok, true);
  const receipt = documentBulkResultSchema.parse(bulk.data);
  assert.deepEqual(
    receipt.items.map((item) => item.status),
    ["applied", "conflict", "not_found"],
  );
  assert.equal(receipt.applied, 1);
  assert.equal(receipt.failed, 2);
  assert.equal(receipt.items[1]?.revision, markdown.revision);
  for (const item of receipt.items) assert.ok(bulk.text.includes(`${item.ref}: ${item.status}`));
  assert.match(bulk.text, /не повторяется автоматически/);
  assert.equal((await list({ tags: ["срочно"] })).total, 1);
  const repeated = await call(client, "entity_document_bulk", {
    items: [
      { ref: markdown.key, ifRevision: markdown.revision },
      { ref: markdown.key, ifRevision: markdown.revision },
    ],
    operation: { type: "pin", pinned: true },
    ...write("bulk-repeated"),
  });
  assert.equal(repeated.error?.code, "VALIDATION_ERROR");
  assert.equal((await list({ pinned: "true" })).total, 0);

  const detached = await call(client, "entity_document_relate", {
    ref: link.key,
    action: "detach",
    target: feature.key,
    type: "documents",
    ifRevision: receipt.items[0]!.revision,
    ...write("detach"),
  });
  assert.equal(detached.ok, true);
  assert.equal(
    entityDocumentsPageSchema.parse(
      (await call(client, "entity_documents_list", { ref: feature.key })).data,
    ).total,
    0,
  );

  const converted = await call(client, "entity_document_update", {
    ref: link.key,
    ifRevision: entitySavedSchema.parse(detached.data).revision,
    documentFormat: "markdown",
    body: "## Конспект\n\nПеренесено из ссылки",
    tags: [],
    ...write("to-markdown"),
  });
  assert.equal(converted.ok, true);
  const convertedDetail = entityDetailSchema.parse(
    (await call(client, "entity_get", { ref: link.key })).data,
  );
  if (convertedDetail.data.kind !== "document") throw new Error("Ожидался документ");
  assert.equal(convertedDetail.data.documentFormat, "markdown");
  assert.equal(convertedDetail.data.url, undefined);
  assert.deepEqual(convertedDetail.data.tags, []);
});

test("MCP материалов: прежний Server без возможности даёт SERVER_INCOMPATIBLE до запроса", async (t) => {
  const app = await setup(t);
  const upstream = new URL(app.api.url);
  // Прокси скрывает возможность материалов в ответах контекста, остальное передаёт без изменений.
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name, value]) => typeof value === "string" && !["host", "content-length"].includes(name),
      ),
    ) as Record<string, string>;
    const reply = await fetch(new URL(request.url ?? "/", upstream), {
      method: request.method ?? "GET",
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const text = (await reply.text()).replaceAll(
      "relay-document-materials-v1",
      "relay-document-materials-v0",
    );
    response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "" });
    response.end(text);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  app.closers.push({
    close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  });
  const client = await app.connect(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  for (const [name, args] of [
    ["entity_document_facets", {}],
    ["entity_documents_list", { ref: "PRODUCT" }],
    [
      "entity_document_bulk",
      {
        items: [{ ref: "DOC-1", ifRevision: 1 }],
        operation: { type: "pin", pinned: true },
        ...write("old-bulk"),
      },
    ],
    [
      "entity_document_relate",
      {
        ref: "DOC-1",
        ifRevision: 1,
        action: "attach",
        target: "PRODUCT",
        type: "references",
        ...write("old-relate"),
      },
    ],
  ] as const) {
    const result = await call(client, name, args);
    assert.equal(result.error?.code, "SERVER_INCOMPATIBLE", name);
    assert.match(result.error?.message ?? "", /Обновите/);
  }
  assert.equal((await call(client, "entities_list", { kind: "document" })).ok, true);
});
