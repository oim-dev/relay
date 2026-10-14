import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EntityEngine } from "@relay/core/application/entities/service";
import { initialize } from "@relay/core/storage/workspace";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { createHttpBackend } from "@relay/project-runtime/backend/http";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { fixture } from "./helpers/server.js";

for (const scoped of [false, true])
  test(`Библиотека REST ${scoped ? "scoped" : "local"}: страницы без текста, CAS и метаданные`, async (t) => {
    const { app, workspace, root } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const features = [];
    for (let index = 0; index < 4; index++)
      features.push(
        await engine.create(
          {
            data: {
              kind: "feature",
              name: `Цель ${index}`,
              summary: "",
              description: "Описание цели",
            },
            requestId: `target-${index}`,
          },
          "creator",
        ),
      );
    const body = "Невидимое полное содержание документа 🧪\n" + "x".repeat(250 * 1024);
    const created = await engine.create(
      {
        data: {
          kind: "document",
          name: "Материал",
          summary: "",
          body,
          documentKind: "rules",
          relations: features.slice(0, 3).map((target, index) => ({
            target: target.ref,
            type: "documents",
            description: `Пояснение-${index}`,
          })),
        },
        requestId: "document",
      },
      "creator",
    );
    const context = (await app.inject("/api/v1/context")).json().data;
    assert(context.capabilities.includes("relay-document-library-v1"));
    const prefix = scoped ? `/api/v1/projects/${context.projectId}` : "/api/v1";
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const wireBytes = new Map<string, number>();
    const get = async (path: string, status = 200) => {
      const response = await fetch(`${origin}${prefix}${path}`);
      const text = await response.text();
      assert.equal(response.status, status, text);
      wireBytes.set(path, Buffer.byteLength(text));
      const envelope = JSON.parse(text);
      return envelope.data ?? envelope.error;
    };
    const post = async (path: string, payload: object, status = 200) => {
      const response = await app.inject({ method: "POST", url: `${prefix}${path}`, payload });
      assert.equal(response.statusCode, status, response.body);
      return response.json().data ?? response.json().error;
    };
    const links = await get(`/documents/links?ref=${created.key}&limit=1`);
    assert.equal(links.items.length, 1);
    assert.equal(links.total, 3);
    assert.equal(links.nextOffset, 1);
    assert.equal(links.version, `${created.ref.id}:${created.revision}`);
    assert.equal(links.references.length, 1);
    assert.deepEqual(Object.keys(links.references[0]).sort(), ["key", "ref", "title"]);
    assert(!JSON.stringify(links).includes(body));
    assert(!JSON.stringify(links).includes("Пояснение-1"));
    assert(!JSON.stringify(links).includes("Пояснение-2"));
    const next = await get(
      `/documents/links?ref=${created.key}&offset=1&limit=1&version=${encodeURIComponent(links.version)}`,
    );
    assert.equal(next.items[0].description, "Пояснение-1");
    assert.equal((await get(`/documents/links?ref=${created.key}&limit=100`)).items.length, 3);
    for (const query of ["limit=101", "limit=0", "offset=-1", "unexpected=1"])
      assert.equal(
        (await get(`/documents/links?ref=${created.key}&${query}`, 400)).code,
        "VALIDATION_ERROR",
      );
    assert.equal((await get("/documents/links?ref=DOC-MISSING", 404)).code, "ENTITY_NOT_FOUND");

    const command = {
      ref: created.key,
      target: features[0]!.key,
      source: "relations",
      action: "link",
      ifRevision: created.revision,
      requestId: "same-link",
    };
    const saved = await post("/documents/relations", command);
    assert.equal(saved.revision, created.revision + 1);
    assert.equal(
      (await get(`/documents/links?ref=${created.key}&limit=1`)).items[0].description,
      "Пояснение-0",
    );
    assert.equal((await post("/documents/relations", command, 409)).code, "REVISION_CONFLICT");
    const staleLinks = await get(
      `/documents/links?ref=${created.key}&version=${encodeURIComponent(links.version)}`,
      409,
    );
    assert.equal(staleLinks.code, "VERSION_CONFLICT");
    assert.equal(staleLinks.exitCode, 2);
    const detail = await get(`/entities/get?ref=${created.key}`);
    const pageBytes = wireBytes.get(`/documents/links?ref=${created.key}&limit=1`)!;
    const detailBytes = wireBytes.get(`/entities/get?ref=${created.key}`)!;
    assert(detailBytes > 250 * 1024);
    assert(pageBytes < 2000);
    t.diagnostic(`HTTP JSON bytes: links(limit=1)=${pageBytes}, entities/get=${detailBytes}`);
    assert.deepEqual(detail, await engine.get({ ref: created.key }));
    assert.deepEqual(
      detail,
      await (await createLocalBackend(root)).entities.get({ ref: created.key }),
    );
    assert(detail.metadata);
    assert.equal(detail.data.kind, "document");
    assert(detail.data.kind === "document");
    assert.equal(detail.metadata.createdBy, "creator");
    assert.equal(detail.metadata.updatedBy, "web-human");
    assert.equal(detail.data.body, body);
    const changed = await post("/documents/relations", {
      ...command,
      ifRevision: saved.revision,
      description: "",
      actor: "explicit-author",
    });
    assert.equal(
      (await get(`/entities/get?ref=${created.key}`)).metadata.updatedBy,
      "explicit-author",
    );
    assert.equal(
      (await get(`/documents/links?ref=${created.key}&limit=1`)).items[0].description,
      "",
    );
    assert.equal(
      (
        await post(
          "/documents/relations",
          { ...command, ifRevision: changed.revision, action: "unlink", description: "запрещено" },
          400,
        )
      ).code,
      "VALIDATION_ERROR",
    );

    const secondType = await post("/documents/relations", {
      ...command,
      relation: "references",
      ifRevision: changed.revision,
      requestId: "second-type",
    });
    const duplicateTargets = await get(`/documents/links?ref=${created.key}&limit=100`);
    assert.equal(duplicateTargets.items.length, 4);
    assert.equal(
      duplicateTargets.references.length,
      3,
      "Уникальные цели страницы не дублируются по типу отношения",
    );
    const conflictingLegacy = await post(
      "/documents/relations",
      {
        ref: created.key,
        target: features[0]!.key,
        source: "links",
        action: "link",
        ifRevision: secondType.revision,
        requestId: "conflicting-legacy",
      },
      409,
    );
    assert.equal(conflictingLegacy.code, "INVALID_REFERENCE");
    const legacy = await post("/documents/relations", {
      ref: created.key,
      target: features[3]!.key,
      source: "links",
      action: "link",
      ifRevision: secondType.revision,
      requestId: "legacy-link",
    });
    const combined = await get(`/documents/links?ref=${created.key}&limit=100`);
    assert.equal(combined.total, 5);
    assert.equal(combined.references.length, 4);
    assert.equal(combined.items[4].source, "links");
    assert.equal(combined.items[4].description, "");
    await post("/documents/relations", {
      ref: created.key,
      target: features[3]!.key,
      source: "links",
      action: "unlink",
      ifRevision: legacy.revision,
      requestId: "legacy-unlink",
    });
    assert.equal((await get(`/documents/links?ref=${created.key}`)).total, 4);
    assert.equal(
      (
        await post(
          "/documents/relations",
          { ...command, ifRevision: changed.revision, source: "links", relation: "documents" },
          400,
        )
      ).code,
      "VALIDATION_ERROR",
    );

    let sections = await get("/documents/sections");
    const initialSections: { id: string; name: string }[] = sections.items;
    for (const id of ["first", "second", "third"])
      sections = await post("/documents/sections", {
        action: "create",
        id,
        name: id,
        ifRevision: sections.revision,
        requestId: `section-${id}`,
      });
    sections = await get("/documents/sections?limit=1");
    assert.equal(sections.items.length, 1);
    assert.equal(sections.total, initialSections.length + 3);
    assert.equal(sections.nextOffset, 1);
    assert.equal(sections.version, `${sections.project.id}:${sections.revision}`);
    assert.equal("data" in sections, false);
    const moved = await post("/documents/sections", {
      action: "move",
      id: "first",
      before: null,
      ifRevision: sections.revision,
      requestId: "move",
    });
    assert.deepEqual(
      (await get("/documents/sections")).items.map((item: { id: string }) => item.id),
      [...initialSections.map((item) => item.id), "second", "third", "first"],
    );
    assert.equal(
      (await get(`/documents/sections?version=${encodeURIComponent(sections.version)}`, 409)).code,
      "VERSION_CONFLICT",
    );
    assert.equal(
      (
        await post(
          "/documents/sections",
          { action: "remove", id: "first", ifRevision: sections.revision, requestId: "stale" },
          409,
        )
      ).code,
      "REVISION_CONFLICT",
    );
    await post("/documents/sections", {
      action: "remove",
      id: "first",
      ifRevision: moved.revision,
      requestId: "remove",
    });
    assert.equal((await get("/documents/sections?limit=101", 400)).code, "VALIDATION_ERROR");
  });

test("Библиотека Backend: одна операция плюс context, общий local/HTTP результат и закреплённый workspace", async (t) => {
  const { root, workspace } = await fixture(t);
  const other = join(root, "other");
  const registry = join(root, "registry");
  await mkdir(other);
  await mkdir(registry);
  const otherWorkspace = await initialize(other, "tasks");
  const registration = await initializeRegistry(registry);
  await registerProject(registration.configPath, "chosen", { path: root });
  await registerProject(registration.configPath, "other", { path: other });
  const server = await startServer({ cwd: registry, actor: "server", port: 0 });
  // Второй сервер наблюдает общий root: закрываем его до after-hook фикстуры,
  // иначе удаление базы может столкнуться с ещё работающим watcher.
  try {
    const calls: string[] = [];
    let metadataMode: "complete" | "absent" | "partial" = "complete";
    let loseWriteResponse = false;
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push(url);
      const response = await fetch(url, init);
      if (loseWriteResponse && init?.method === "POST" && url.endsWith("/documents/relations")) {
        await response.text();
        throw new TypeError("Соединение потеряно после успешной записи");
      }
      if (metadataMode !== "complete" && url.includes("/entities/get?")) {
        const envelope = await response.json();
        if (metadataMode === "absent") delete envelope.data.metadata;
        else envelope.data.metadata = { createdAt: envelope.data.metadata.createdAt };
        return Response.json(envelope);
      }
      return response;
    });
    const backend = await createHttpBackend(server.url, "chosen");
    const local = await createLocalBackend(root);
    const sections = await backend.documents.sections({ limit: 1 });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /\/projects\/chosen\/context$/);
    assert(calls[1]!.includes(`/projects/${workspace.config.projectId}/documents/sections?`));
    assert.deepEqual(sections, await local.documents.sections({ limit: 1 }));
    await backend.documents.changeSection(
      {
        action: "create",
        id: "http",
        name: "HTTP",
        ifRevision: sections.revision,
        requestId: "http-section",
        actor: "body-author",
      },
      "fallback",
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(
      await backend.entities.get({ ref: "PROJECT" }),
      await local.entities.get({ ref: "PROJECT" }),
    );
    assert.deepEqual(
      (await (await createLocalBackend(other)).documents.sections()).items,
      (await local.documents.sections()).items.filter((item) => item.id !== "http"),
    );
    const document = await local.entities.create(
      {
        data: {
          kind: "document",
          name: "Документ",
          summary: "",
          body: "Текст",
          documentKind: "rules",
        },
        requestId: "metadata-document",
      },
      "creator",
    );
    const countBeforeWrite = calls.length;
    await backend.documents.changeRelation(
      {
        ref: document.key,
        target: "PROJECT",
        source: "relations",
        action: "link",
        ifRevision: document.revision,
        requestId: "http-link",
        actor: "body-author",
      },
      "fallback",
    );
    assert.equal(calls.length, countBeforeWrite + 1);
    const localDetail = await local.entities.get({ ref: document.key });
    assert.equal(localDetail.metadata?.updatedBy, "body-author");
    assert.deepEqual(await backend.entities.get({ ref: document.key }), localDetail);
    assert.deepEqual(
      await backend.documents.links({ ref: document.key, limit: 1 }),
      await local.documents.links({ ref: document.key, limit: 1 }),
    );
    loseWriteResponse = true;
    const beforeLoss = calls.length;
    await assert.rejects(
      backend.documents.changeRelation(
        {
          ref: document.key,
          target: "PROJECT",
          source: "relations",
          action: "link",
          description: "Запись завершилась, ответ потерян",
          ifRevision: localDetail.revision,
          requestId: "lost-response",
        },
        "fallback",
      ),
      { code: "SERVER_UNAVAILABLE" },
    );
    assert.equal(calls.length, beforeLoss + 1);
    loseWriteResponse = false;
    const afterLoss = await local.documents.links({ ref: document.key });
    assert.equal(afterLoss.revision, localDetail.revision + 1);
    assert.equal(afterLoss.items[0]?.description, "Запись завершилась, ответ потерян");
    metadataMode = "absent";
    assert.equal((await backend.entities.get({ ref: document.key })).metadata, undefined);
    metadataMode = "partial";
    await assert.rejects(backend.entities.get({ ref: document.key }), {
      code: "INVALID_SERVER_RESPONSE",
    });
    metadataMode = "complete";
    await registerProject(registration.configPath, "chosen", { path: other }, true);
    assert.notEqual(workspace.config.projectId, otherWorkspace.config.projectId);
    await assert.rejects(backend.documents.sections(), { code: "PROJECT_NOT_FOUND" });
  } finally {
    await server.close();
  }
});
