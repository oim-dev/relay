import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DocumentLinksPage,
  DocumentRelationChange,
  DocumentSectionChange,
} from "@relay/contracts/document-library";
import { defaultConfig } from "@relay/core/domain/config";
import { createHttpBackend } from "../src/backend/http.js";

const context = {
  ok: true,
  data: {
    capabilities: ["relay-projects-v1", "relay-document-library-v1"],
    projectId: "fixed-project",
    config: defaultConfig,
    configPath: "/project/.relay/config.json",
    storagePath: "/project/.relay",
  },
};
const ref = { kind: "document" as const, id: "doc" };
const links: DocumentLinksPage = {
  ref,
  key: "DOC-1",
  title: "Документ",
  revision: 7,
  items: [
    {
      source: "relations",
      target: { kind: "project", id: "fixed-project" },
      type: "documents",
      description: "Полное пояснение  \n",
    },
  ],
  references: [{ ref: { kind: "project", id: "fixed-project" }, key: "PROJECT", title: "Проект" }],
  total: 3,
  nextOffset: 1,
  version: "doc:7",
};
const sections = {
  project: { kind: "project", id: "fixed-project" },
  projectKey: "PROJECT",
  revision: 2,
  items: [{ id: "one", name: "Один" }],
  total: 2,
  nextOffset: 1,
  version: "fixed-project:2",
};
const receipt = { ref, key: "DOC-1", revision: 8, requestId: "correlation", action: "update" };
const relation: DocumentRelationChange = {
  ref: "DOC-1",
  target: "PROJECT",
  source: "relations",
  action: "link",
  ifRevision: 7,
  requestId: "correlation",
};
const section: DocumentSectionChange = {
  action: "move",
  id: "one",
  before: null,
  ifRevision: 2,
  requestId: "correlation",
};

test("Библиотека HTTP: capability проверяется до всех четырёх запросов без full-get fallback", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      ...context,
      data: { ...context.data, capabilities: ["relay-projects-v1"] },
    });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  for (const operation of [
    () => backend.documents.links({ ref: "DOC-1" }),
    () => backend.documents.sections(),
    () => backend.documents.changeRelation(relation, "author"),
    () => backend.documents.changeSection(section, "author"),
  ])
    await assert.rejects(operation(), { code: "SERVER_INCOMPATIBLE", exitCode: 5 });
  assert.equal(calls, 1);
});

test("Библиотека HTTP: одна SDK-операция, pinned ID, query и исходные CAS/actor без скрытых чтений", async (t) => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      ...(init.method ? { method: init.method } : {}),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/context")) return Response.json(context);
    assert(url.includes("/projects/fixed-project/documents/"));
    if (init.method === "POST") return Response.json({ ok: true, data: receipt });
    return Response.json({ ok: true, data: url.includes("/links?") ? links : sections });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
  assert.deepEqual(
    await backend.documents.links({ ref: "DOC-1", offset: 0, limit: 1, version: links.version }),
    links,
  );
  assert.deepEqual(Object.fromEntries(new URL(calls[1]!.url).searchParams), {
    ref: "DOC-1",
    offset: "0",
    limit: "1",
    version: "doc:7",
  });
  assert.deepEqual(
    await backend.documents.sections({ limit: 1, version: sections.version }),
    sections,
  );
  await backend.documents.changeRelation(relation, "fallback");
  assert.deepEqual(calls[3]!.body, { ...relation, relation: "documents", actor: "fallback" });
  await backend.documents.changeRelation(
    { ...relation, description: "", actor: "body-author" },
    "ignored",
  );
  assert.deepEqual(calls[4]!.body, {
    ...relation,
    relation: "documents",
    description: "",
    actor: "body-author",
  });
  await backend.documents.changeSection(section, "fallback");
  assert.deepEqual(calls[5]!.body, { ...section, actor: "fallback" });
  assert.equal(calls.length, 6);
  assert.equal(backend.workspace.projectId, "fixed-project");
});

test("Библиотека HTTP: неверные query/варианты и автор отклоняются до запроса", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(context);
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  for (const operation of [
    () => backend.documents.links({ ref: "DOC-1", limit: 101 }),
    () => backend.documents.sections({ offset: -1 }),
    () =>
      backend.documents.changeRelation(
        { ...relation, source: "links", description: "лишнее" } as DocumentRelationChange,
        "author",
      ),
    () =>
      backend.documents.changeRelation(
        { ...relation, action: "unlink", description: "лишнее" } as DocumentRelationChange,
        "author",
      ),
    () =>
      backend.documents.changeSection(
        { ...section, before: undefined } as unknown as DocumentSectionChange,
        "author",
      ),
    () => backend.documents.changeRelation(relation, ""),
  ])
    await assert.rejects(operation(), { code: "VALIDATION_ERROR" });
  assert.equal(calls, 1);
});

for (const operation of ["relation", "section"] as const)
  for (const failure of ["network", "500", "409", "400", "envelope", "data"] as const)
    test(`Библиотека HTTP: ${operation}, один POST при ${failure} без повторов и подмены ревизии`, async (t) => {
      let writes = 0;
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        if (url.endsWith("/context")) return Response.json(context);
        assert.equal(init.method, "POST");
        const body = JSON.parse(String(init.body));
        assert.equal(body.ifRevision, operation === "relation" ? 7 : 2);
        assert.equal(body.requestId, "correlation");
        writes++;
        if (failure === "network") throw new TypeError("Ответ потерян");
        if (failure === "envelope") return Response.json({ ok: true });
        if (failure === "data")
          return Response.json({ ok: true, data: { ...receipt, revision: "8" } });
        return Response.json(
          { ok: false, error: { code: "REFUSAL", message: "Отказ", exitCode: 4 } },
          { status: Number(failure) },
        );
      });
      const backend = await createHttpBackend("http://127.0.0.1:4700");
      await assert.rejects(
        operation === "relation"
          ? backend.documents.changeRelation(relation, "author")
          : backend.documents.changeSection(section, "author"),
        {
          code:
            failure === "network"
              ? "SERVER_UNAVAILABLE"
              : ["envelope", "data"].includes(failure)
                ? "INVALID_SERVER_RESPONSE"
                : "REFUSAL",
        },
      );
      assert.equal(writes, 1);
    });

test("Библиотека HTTP: guard чтения передаётся без retry, повреждённая страница не принимается", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/context")) return Response.json(context);
    reads++;
    if (reads === 1)
      return Response.json(
        { ok: false, error: { code: "VERSION_CONFLICT", message: "Изменено", exitCode: 2 } },
        { status: 409 },
      );
    return Response.json({ ok: true, data: { ...links, body: "Недопустимое полное содержание" } });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(backend.documents.links({ ref: "DOC-1", version: "doc:7" }), {
    code: "VERSION_CONFLICT",
    exitCode: 2,
  });
  assert.equal(reads, 1);
  await assert.rejects(backend.documents.links({ ref: "DOC-1" }), {
    code: "INVALID_SERVER_RESPONSE",
  });
  assert.equal(reads, 2);
});
