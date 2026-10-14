import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { EntitiesPage, EntityDetail, EntitySaved } from "@relay/contracts/entities";
import type { Backend } from "../src/backend/types.js";
import { fixture, invoke, invokeRaw, successful, failed, type RunOptions } from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

type Links = Omit<
  Awaited<ReturnType<Backend["documents"]["links"]>>,
  "key" | "title" | "references"
>;
type Sections = Omit<Awaited<ReturnType<Backend["documents"]["sections"]>>, "projectKey">;
type Request = { method: string; url: string; body?: Record<string, unknown> };
const hints = (stdout: string) =>
  stdout.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli "));

for (const transport of ["local", "HTTP"] as const)
  test(`document library ${transport}: серверные страницы, одна запись и metadata`, async (t) => {
    const app = await fixture(t);
    const requests: Request[] = [];
    let flags = ["--local"];
    if (transport === "HTTP") {
      const server = await httpServer(t, app.root);
      const proxy = await httpProxy(t, async (request, response, signal) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        requests.push({
          method: request.method!,
          url: request.url!,
          ...(body ? { body: JSON.parse(body) } : {}),
        });
        const upstream = await fetch(`${server.url}${request.url}`, {
          signal,
          method: request.method!,
          ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      });
      flags = ["--server-url", proxy.url];
    }
    const run = <T = unknown>(args: Array<string | number>, options?: RunOptions) =>
      invoke<T>(app.root, [...flags, ...args], options);
    const checkWire = (method: "GET" | "POST") => {
      if (transport !== "HTTP") return;
      assert.deepEqual(
        requests.map((item) => item.method),
        ["GET", method],
      );
      assert.match(requests[0]!.url, /\/context$/);
      assert.match(requests[1]!.url, /\/documents\//);
      assert.ok(
        requests.every((item) => !/entities\/get|resolve|graph|product\/entity/.test(item.url)),
      );
      t.diagnostic(JSON.stringify(requests));
    };
    const create = async (kind: "feature" | "document", name: string, extra: string[] = []) =>
      successful(
        await run<EntitySaved>([
          kind,
          "create",
          "--name",
          name,
          kind === "document" ? "--body" : "--description",
          kind === "document" ? "BODY-НЕ-СТРАНИЦА\n".repeat(4000) : "Полное требование",
          ...extra,
        ]),
      ).data;
    const feature = await create("feature", "Адресная цель 雪");
    const legacy = await create("feature", "Прежняя область");
    const document = await create("document", "Материал 👩‍💻", [
      "--actor",
      "автор создания",
      "--targets",
      legacy.key,
      "--relations",
      JSON.stringify([
        { target: feature.ref, type: "documents", description: "\n## Пояснение\n\nПолностью.\n" },
        { target: feature.ref, type: "references", description: "Второе направление" },
      ]),
    ]);
    const initial = successful(await run<EntityDetail>(["document", "get", document.key])).data;
    assert.deepEqual(Object.keys(initial.metadata!).sort(), [
      "createdAt",
      "createdBy",
      "updatedAt",
      "updatedBy",
    ]);
    assert.equal(initial.metadata!.createdBy, "автор создания");
    assert.equal(initial.metadata!.updatedBy, "автор создания");
    requests.length = 0;
    const first = successful(await run<Links>(["document", "links", document.key, "--limit", 1]));
    checkWire("GET");
    assert.deepEqual(Object.keys(first.data).sort(), [
      "items",
      "nextOffset",
      "ref",
      "revision",
      "total",
      "version",
    ]);
    assert.equal(first.data.version, `${document.ref.id}:${document.revision}`);
    assert.equal(first.data.total, 3);
    assert.equal(first.data.items.length, 1);
    assert.ok(!JSON.stringify(first).includes("BODY-НЕ-СТРАНИЦА"));
    const cursor = first.meta!.page!.nextCursor!;
    requests.length = 0;
    const second = successful(
      await run<Links>(["document", "links", document.key, "--cursor", cursor]),
    );
    checkWire("GET");
    assert.equal(second.data.items.length, 1);
    assert.equal(second.data.items[0]!.type, "references");
    if (transport === "HTTP") {
      const url = new URL(requests[1]!.url, "http://fixture");
      assert.equal(url.searchParams.get("offset"), "1");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(url.searchParams.get("version"), first.data.version);
    }
    const third = successful(
      await run<Links>([
        "document",
        "links",
        document.key,
        "--cursor",
        second.meta!.page!.nextCursor!,
      ]),
    );
    assert.equal(third.data.items[0]!.source, "links");
    assert.equal(third.meta!.page!.nextCursor, null);
    for (const width of [40, 100]) {
      requests.length = 0;
      const human = await invokeRaw(
        app.root,
        [...flags, "document", "links", document.key, "--limit", 1],
        { env: { COLUMNS: String(width) } },
      );
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      checkWire("GET");
      assert.match(human.stdout, /Прикрепления DOC-/);
      assert.match(human.stdout, /## Пояснение/);
      assert.ok(hints(human.stdout).some((line) => line.endsWith(`feature get ${feature.key}`)));
      assert.doesNotMatch(human.stdout, /BODY-НЕ-СТРАНИЦА|\u001b/);
    }
    const description = "\n## Новое пояснение\n\n  Отступ 雪\n\n";
    requests.length = 0;
    const linked = successful(
      await run<EntitySaved>(
        [
          "document",
          "link",
          document.key,
          "--target",
          feature.key,
          "--if-revision",
          1,
          "--description-file",
          "-",
          "--actor",
          "автор изменения",
          "--request-id",
          "relation-correlation",
        ],
        { input: description },
      ),
    ).data;
    checkWire("POST");
    if (transport === "HTTP")
      assert.deepEqual(requests[1]!.body, {
        ref: document.key,
        target: feature.key,
        source: "relations",
        action: "link",
        relation: "documents",
        description,
        ifRevision: 1,
        requestId: "relation-correlation",
        actor: "автор изменения",
      });
    requests.length = 0;
    failed(
      await run(["document", "links", document.key, "--cursor", cursor]),
      "VERSION_CONFLICT",
      2,
    );
    checkWire("GET");
    const updated = successful(await run<EntityDetail>(["document", "get", document.key])).data;
    assert.equal(updated.metadata!.createdAt, initial.metadata!.createdAt);
    assert.equal(updated.metadata!.createdBy, "автор создания");
    assert.equal(updated.metadata!.updatedBy, "автор изменения");
    assert.notEqual(updated.metadata!.updatedAt, initial.metadata!.updatedAt);
    requests.length = 0;
    const human = await invokeRaw(app.root, [...flags, "document", "get", document.key], {
      env: { COLUMNS: "100" },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /Изменил:\s*автор изменения/);
    assert.ok(human.stdout.includes(updated.metadata!.updatedAt));
    if (transport === "HTTP") {
      assert.deepEqual(
        requests.map((item) => item.method),
        ["GET", "GET"],
      );
      assert.match(requests[1]!.url, /\/entities\/get\?/);
    }
    requests.length = 0;
    const kept = successful(
      await run<EntitySaved>([
        "document",
        "link",
        document.key,
        "--target",
        feature.key,
        "--if-revision",
        linked.revision,
      ]),
    ).data;
    checkWire("POST");
    if (transport === "HTTP") assert.ok(!Object.hasOwn(requests[1]!.body!, "description"));
    assert.equal(
      successful(await run<Links>(["document", "links", document.key])).data.items[0]!.description,
      description,
    );
    for (const extra of [
      ["--description", "inline", "--description-file", "missing.md"],
      ["--legacy", "--description-file", "missing.md"],
      ["--clear-description", "--description-file", "missing.md"],
    ]) {
      requests.length = 0;
      const error = await run([
        "document",
        "link",
        document.key,
        "--target",
        feature.key,
        "--if-revision",
        kept.revision,
        ...extra,
      ]);
      failed(error, extra[0] === "--description" ? "CONFLICTING_OPTIONS" : "INVALID_ARGUMENT");
      assert.equal(requests.filter((item) => item.method === "POST").length, 0);
    }
    requests.length = 0;
    failed(
      await run(["document", "unlink", document.key, "--target", feature.key, "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    checkWire("POST");
    const cleared = successful(
      await run<EntitySaved>([
        "document",
        "link",
        document.key,
        "--target",
        feature.key,
        "--clear-description",
        "--if-revision",
        kept.revision,
      ]),
    ).data;
    assert.equal(
      successful(await run<Links>(["document", "links", document.key])).data.items[0]!.description,
      "",
    );
    requests.length = 0;
    const unlinked = successful(
      await run<EntitySaved>([
        "document",
        "unlink",
        document.key,
        "--target",
        legacy.key,
        "--legacy",
        "--if-revision",
        cleared.revision,
      ]),
    ).data;
    checkWire("POST");
    if (transport === "HTTP") {
      assert.equal(requests[1]!.body!.source, "links");
      assert.ok(!Object.hasOwn(requests[1]!.body!, "relation"));
      assert.ok(!Object.hasOwn(requests[1]!.body!, "description"));
    }
    const remaining = successful(await run<Links>(["document", "links", document.key])).data;
    assert.equal(remaining.revision, unlinked.revision);
    assert.equal(remaining.total, 2);
    requests.length = 0;
    const sections = successful(await run<Sections>(["document", "section", "list", "--limit", 1]));
    checkWire("GET");
    assert.deepEqual(Object.keys(sections.data).sort(), [
      "items",
      "nextOffset",
      "project",
      "revision",
      "total",
      "version",
    ]);
    assert.equal(sections.data.version, `${sections.data.project.id}:${sections.data.revision}`);
    requests.length = 0;
    successful(
      await run(["document", "section", "list", "--cursor", sections.meta!.page!.nextCursor!]),
    );
    checkWire("GET");
    if (transport === "HTTP")
      assert.equal(
        new URL(requests[1]!.url, "http://fixture").searchParams.get("version"),
        sections.data.version,
      );
    const file = join(app.root, "название ' раздела.txt");
    await writeFile(file, "Имя из файла 雪");
    requests.length = 0;
    const created = successful(
      await run<EntitySaved>([
        "document",
        "section",
        "create",
        "custom",
        "--name-file",
        file,
        "--if-revision",
        sections.data.revision,
        "--request-id",
        "section-correlation",
      ]),
    ).data;
    checkWire("POST");
    if (transport === "HTTP")
      assert.deepEqual(requests[1]!.body, {
        action: "create",
        id: "custom",
        name: "Имя из файла 雪",
        ifRevision: sections.data.revision,
        requestId: "section-correlation",
        actor: "test-agent",
      });
    failed(
      await run(["document", "section", "list", "--cursor", sections.meta!.page!.nextCursor!]),
      "VERSION_CONFLICT",
      2,
    );
    const renamed = successful(
      await run<EntitySaved>(
        [
          "document",
          "section",
          "update",
          "custom",
          "--name-file",
          "-",
          "--if-revision",
          created.revision,
        ],
        { input: "Имя из stdin" },
      ),
    ).data;
    for (const extra of [["--name", "inline", "--name-file", "missing.txt"], []]) {
      requests.length = 0;
      failed(
        await run([
          "document",
          "section",
          "update",
          "custom",
          "--if-revision",
          renamed.revision,
          ...extra,
        ]),
        extra.length ? "CONFLICTING_OPTIONS" : "INVALID_ARGUMENT",
      );
      assert.equal(requests.filter((item) => item.method === "POST").length, 0);
    }
    requests.length = 0;
    const moved = successful(
      await run<EntitySaved>([
        "document",
        "section",
        "move",
        "custom",
        "--last",
        "--if-revision",
        renamed.revision,
      ]),
    ).data;
    checkWire("POST");
    if (transport === "HTTP") assert.equal(requests[1]!.body!.before, null);
    requests.length = 0;
    successful(
      await run(["document", "section", "remove", "custom", "--if-revision", moved.revision]),
    );
    checkWire("POST");
    successful(await run(["doctor", "check"]));
  });

test("document list: новый guard и безопасный отказ курсора прежнего алгоритма", async (t) => {
  const app = await fixture(t);
  for (const name of ["Первый", "Второй"])
    successful(
      await app.run(["document", "create", "--name", name, "--body", "Искомый маркер ДОКУМЕНТЫ"]),
    );
  const first = successful(
    await app.run<EntitiesPage>(["document", "list", "--q", "ДОКУМЕНТЫ", "--limit", 1]),
  );
  assert.match(first.data.version, /^documents-v1:[a-f0-9]{64}$/);
  assert.equal(first.data.total, 2);
  assert.match(first.data.items[0]!.document!.excerpt!, /ДОКУМЕНТЫ/);
  const cursor = first.meta!.page!.nextCursor!;
  const second = successful(await app.run<EntitiesPage>(["document", "list", "--cursor", cursor]));
  assert.equal(second.data.total, 2);
  assert.notEqual(first.data.items[0]!.key, second.data.items[0]!.key);
  assert.equal(second.meta!.page!.nextCursor, null);
  // Моделируем старый opaque hash, сохраняя команду, ref, фильтры и подключение wrapper.
  const previous = JSON.parse(Buffer.from(cursor, "base64url").toString());
  previous.version = "f".repeat(64);
  const stale = Buffer.from(JSON.stringify(previous)).toString("base64url");
  failed(await app.run(["document", "list", "--cursor", stale]), "ENTITIES_CHANGED", 4);
  const text = await invokeRaw(app.root, ["document", "list", "--cursor", stale]);
  assert.equal(text.code, 4, text.stdout);
  assert.equal(text.stderr, "");
  assert.match(text.stdout.replace(/\s+/g, " "), /Начните чтение заново без --cursor/);
});

test("document metadata HTTP: текущая запись и совместимость ответа без metadata", async (t) => {
  const app = await fixture(t);
  const document = successful(
    await app.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Прежний ответ",
      "--body",
      "Без выдуманных метаданных",
    ]),
  ).data;
  const actual = successful(await app.run<EntityDetail>(["document", "get", document.key])).data;
  const { metadata: _metadata, ...legacyDetail } = actual;
  const server = await httpServer(t, app.root);
  const requests: string[] = [];
  let legacyResponse = false;
  const proxy = await httpProxy(t, async (request, response, signal) => {
    requests.push(request.url!);
    assert.equal(request.method, "GET");
    const upstream = await fetch(`${server.url}${request.url}`, { signal });
    const body = JSON.parse(await upstream.text());
    if (legacyResponse && request.url!.includes("/entities/get")) delete body.data.metadata;
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const flags = ["--server-url", proxy.url];
  assert.deepEqual(
    successful(await invoke<EntityDetail>(app.root, [...flags, "document", "get", document.key]))
      .data,
    actual,
  );
  assert.equal(requests.length, 2);
  requests.length = 0;
  const current = await invokeRaw(app.root, [...flags, "document", "get", document.key]);
  assert.equal(current.code, 0, current.stdout);
  assert.equal(current.stderr, "");
  assert.match(current.stdout, /Изменил:\s*test-agent/);
  assert.ok(current.stdout.includes(actual.metadata!.updatedAt));
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /\/context$/);
  assert.match(requests[1]!, /\/entities\/get\?/);
  legacyResponse = true;
  assert.deepEqual(
    successful(await invoke<EntityDetail>(app.root, [...flags, "document", "get", document.key]))
      .data,
    legacyDetail,
  );
  requests.length = 0;
  const human = await invokeRaw(app.root, [...flags, "document", "get", document.key]);
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  assert.doesNotMatch(human.stdout, /Изменил:|Создал:/);
  assert.ok(human.stdout.includes(actual.document!.updatedAt));
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /\/context$/);
  assert.match(requests[1]!, /\/entities\/get\?/);
});

test("document library HTTP: прежняя цель plan-stage и отсутствие capability без fallback", async (t) => {
  const app = await fixture(t);
  const document = successful(
    await app.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Прежний ответ",
      "--body",
      "Без выдуманных метаданных",
    ]),
  ).data;
  const actual = successful(await app.run<EntityDetail>(["document", "get", document.key])).data;
  const server = await httpServer(t, app.root);
  const requests: string[] = [];
  let mode: "plan-stage" | "capability" = "plan-stage";
  const proxy = await httpProxy(t, async (request, response, signal) => {
    requests.push(request.url!);
    assert.equal(request.method, "GET", "Несовместимый сервер не должен получить запись");
    const upstream = await fetch(`${server.url}${request.url}`, { signal });
    const body = JSON.parse(await upstream.text());
    if (mode === "capability" && Array.isArray(body?.data?.capabilities))
      body.data.capabilities = body.data.capabilities.filter(
        (name: string) => name !== "relay-document-library-v1",
      );
    if (mode === "plan-stage" && request.url!.includes("/documents/links")) {
      body.data.items = [
        {
          source: "relations",
          target: { kind: "plan-stage", id: "legacy-stage" },
          type: "references",
          description: "Историческое прикрепление",
        },
      ];
      body.data.references = [];
      body.data.total = 1;
      body.data.nextOffset = null;
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const flags = ["--server-url", proxy.url];
  const oldTarget = await invokeRaw(app.root, [...flags, "document", "links", document.key]);
  assert.equal(oldTarget.code, 0, oldTarget.stdout);
  assert.match(oldTarget.stdout, /plan-stage:legacy-stage/);
  assert.match(oldTarget.stdout, /Историческое прикрепление/);
  assert.equal(hints(oldTarget.stdout).length, 1);
  assert.match(hints(oldTarget.stdout)[0]!, /inspect graph list/);
  mode = "capability";
  for (const args of [
    ["document", "links", document.key],
    ["document", "section", "list"],
    ["document", "link", document.key, "--target", "PROJECT", "--if-revision", "1"],
    ["document", "unlink", document.key, "--target", "PROJECT", "--if-revision", "1"],
    ["document", "section", "create", "blocked", "--name", "Не создать", "--if-revision", "1"],
  ]) {
    requests.length = 0;
    failed(await invoke(app.root, [...flags, ...args]), "SERVER_INCOMPATIBLE", 5);
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.match(requests[0]!, /\/context$/);
  }
  assert.deepEqual(
    successful(await app.run<EntityDetail>(["document", "get", document.key])).data,
    actual,
  );
});
