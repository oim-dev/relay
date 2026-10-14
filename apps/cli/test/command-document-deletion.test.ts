import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import type {
  EntityDeleted,
  EntityDeletionPreview,
  EntityDetail,
  EntitySaved,
} from "@relay/contracts/entities";
import { shellCommand } from "../src/command-kit.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixture,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

// Фикстуры ниже не содержат пользовательских псевдокоманд; читаем только их служебные подсказки.
const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
const human = (result: Awaited<ReturnType<typeof invokeRaw>>) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|\[object Object\]/);
  return result.stdout;
};
async function follow(cwd: string, command: string) {
  const result = await promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `npx() { shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${command}`,
    ],
    { cwd, env: cliEnv({ RELAY_ACTOR: undefined }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}
type Request = { method: string; url: string; body?: Record<string, unknown> };

test("document deletion: help без базы, только явное подтверждение и без страниц", async (t) => {
  const cwd = await tempDirectory(t);
  const help = human(await invokeRaw(cwd, ["document", "--help"]));
  assert.match(help, /delete-preview/);
  assert.match(help, /delete/);
  for (const action of ["delete-preview", "delete"]) {
    const text = human(await invokeRaw(cwd, ["document", action, "--help"]));
    assert.match(text, /--if-version/);
    assert.match(text, /Примеры:/);
    assert.match(text.replace(/\s+/g, " "), /другие документы сохраняются/);
  }
  for (const args of [
    ["delete", "DOC-1"],
    ["delete", "DOC-1", "--if-version", "version", "--yes"],
    ["delete-preview", "DOC-1", "--limit", "1"],
    ["delete-preview", "DOC-1", "--cursor", "opaque"],
  ])
    failed(await invoke(cwd, ["document", ...args]), "INVALID_ARGUMENT");
  assert.deepEqual(await readdir(cwd), []);
});

for (const mode of ["local", "http"] as const)
  test(`document deletion ${mode}: жизненный цикл`, { timeout: 180_000 }, async (t) => {
    const app = await fixture(t);
    const requests: Request[] = [];
    let flags: string[] = ["--local"];
    if (mode === "http") {
      const server = await httpServer(t, app.root);
      const proxy = await httpProxy(t, async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        requests.push({
          method: request.method!,
          url: request.url!,
          ...(body ? { body: JSON.parse(body) } : {}),
        });
        const upstream = await fetch(`${server.url}${request.url}`, {
          method: request.method!,
          ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      });
      flags = ["--server-url", proxy.url];
    }
    const run = <T = unknown>(args: Array<string | number>, env?: NodeJS.ProcessEnv) =>
      invoke<T>(app.root, [...flags, ...args], env ? { env } : {});
    const text = async (args: Array<string | number>, width = 40, env?: NodeJS.ProcessEnv) =>
      human(
        await invokeRaw(app.root, [...flags, ...args], {
          env: { COLUMNS: String(width), FORCE_COLOR: "3", ...env },
        }),
      );
    const feature = successful(
      await run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Самостоятельная цель 雪 👩‍💻",
        "--description",
        "Полное требование",
      ]),
    ).data;
    const legacy = successful(
      await run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Прежняя область",
        "--description",
        "Не удалять вместе с документом",
      ]),
    ).data;
    const body = "\n## Материал\n\n  Точный текст 雪 👩‍💻\n\n```text\n\tкод\n```\n\n";
    const document = successful(
      await run<EntitySaved>([
        "document",
        "create",
        "--name",
        "Удаляемый материал 雪 👩‍💻",
        "--body",
        body,
        "--targets",
        legacy.key,
        "--relations",
        JSON.stringify([
          { target: feature.ref, type: "documents", description: "Полное пояснение" },
          { target: feature.ref, type: "references", description: "Другое направление" },
        ]),
      ]),
    ).data;
    const other = successful(
      await run<EntitySaved>([
        "document",
        "create",
        "--name",
        "Сохраняемый материал",
        "--body",
        body,
        "--relations",
        JSON.stringify([
          { target: document.ref, type: "references", description: "Снимется" },
          { target: document.ref, type: "documents", description: "Тоже снимется" },
          { target: feature.ref, type: "documents", description: "Сохранится" },
        ]),
      ]),
    ).data;
    const renamed = successful(
      await run<EntitySaved>([
        "document",
        "rename",
        document.key,
        "RULES-1",
        "--if-revision",
        document.revision,
      ]),
    ).data;
    const before = successful(await run<EntityDetail>(["document", "get", other.key])).data;
    const read = await text(["document", "get", document.key]);
    assert.ok(read.includes(body));
    const previewHint = hints(read).find((line) =>
      line.includes("document delete-preview RULES-1"),
    );
    assert.ok(previewHint, read);
    assert.match(await follow(app.root, previewHint), /Полный каскад удаления/);
    requests.length = 0;
    const preview = successful(
      await run<EntityDeletionPreview>(["document", "delete-preview", document.key]),
    );
    if (mode === "http")
      assert.deepEqual(
        requests.map((item) => item.method),
        ["GET", "GET"],
      );
    assert.equal(preview.meta?.page, undefined);
    assert.deepEqual(preview.data.target.ref, document.ref);
    assert.equal(preview.data.target.key, renamed.key);
    assert.deepEqual(
      preview.data.deleted.map((item) => item.ref),
      [document.ref],
    );
    assert.deepEqual(
      new Set(preview.data.detached.map((item) => item.ref.id)),
      new Set([feature.ref.id, legacy.ref.id, other.ref.id]),
    );
    assert.equal(preview.data.relations, 5);
    const withoutActor = await text(["document", "delete-preview", document.key], 40, {
      RELAY_ACTOR: undefined,
    });
    assert.ok(hints(withoutActor)[0]!.endsWith("document delete --help"));
    assert.doesNotMatch(withoutActor, /delete RULES-1 --if-version/);
    for (const width of [40, 100]) {
      const output = await text(["document", "delete-preview", document.key], width, {
        RELAY_ACTOR: "author 'env'",
      });
      assert.ok(output.includes(preview.data.version));
      for (const item of [...preview.data.deleted, ...preview.data.detached])
        for (const value of [item.key, item.ref.id, item.ref.kind])
          assert.ok(output.includes(value), output);
      assert.equal(hints(output).length, 1);
      assert.ok(hints(output)[0]!.includes(`--if-version ${preview.data.version}`));
      assert.match(hints(output)[0]!, /--actor/);
      assert.doesNotMatch(output, /Показано:|Есть продолжение|Конец списка/);
      t.diagnostic(
        `${mode} preview ${width}: ${Buffer.byteLength(output)} байт, ${output.split("\n").length - 1} строк`,
      );
    }
    assert.deepEqual(
      successful(await run<EntityDeletionPreview>(["document", "delete-preview", document.key]))
        .data,
      preview.data,
    );
    failed(
      await run(["document", "delete", document.key, "--if-version", preview.data.version], {
        RELAY_ACTOR: undefined,
      }),
      "ACTOR_REQUIRED",
    );
    successful(
      await run([
        "document",
        "update",
        document.key,
        "--document-status",
        "active",
        "--if-revision",
        renamed.revision,
      ]),
    );
    requests.length = 0;
    failed(
      await run(["document", "delete", document.key, "--if-version", preview.data.version]),
      "REVISION_CONFLICT",
      4,
    );
    if (mode === "http")
      assert.deepEqual(
        requests.map((item) => item.method),
        ["GET", "POST"],
      );
    const stale = await invokeRaw(app.root, [
      ...flags,
      "document",
      "delete",
      document.key,
      "--if-version",
      preview.data.version,
    ]);
    assert.equal(stale.code, 4, stale.stdout);
    assert.equal(stale.stderr, "");
    assert.match(stale.stdout, /document delete-preview/);
    assert.doesNotMatch(stale.stdout, /document delete .*--if-version/);
    successful(await run(["document", "get", document.key]));
    // Документ не входит в допустимые виды plan.scope. Не создаём невозможный блокер
    // подменой хранилища: планы ссылаются на самостоятельные сохраняемые цели.
    failed(
      await run(["plan", "create", "--title", "Недопустимая область", "--scope", document.key]),
      "VALIDATION_ERROR",
    );
    const plan = successful(
      await run<{ key: string; revision: number }>([
        "plan",
        "create",
        "--title",
        "Открытый план",
        "--scope",
        feature.key,
      ]),
    ).data;
    const closedPlan = successful(
      await run<{ key: string; revision: number }>([
        "plan",
        "create",
        "--title",
        "Закрытый план",
        "--scope",
        legacy.key,
      ]),
    ).data;
    successful(
      await run([
        "plan",
        "cancel",
        closedPlan.key,
        "--result",
        "Сохраняем область",
        "--if-revision",
        closedPlan.revision,
      ]),
    );
    const planBefore = successful(await run(["plan", "get", plan.key])).data;
    const closedBefore = successful(await run(["plan", "get", closedPlan.key])).data;
    const fresh = successful(
      await run<EntityDeletionPreview>(["document", "delete-preview", document.key]),
    ).data;
    requests.length = 0;
    const receipt = await text([
      "document",
      "delete",
      document.key,
      "--if-version",
      fresh.version,
      "--actor",
      "document-author",
      "--request-id",
      "document-correlation",
    ]);
    if (mode === "http") {
      assert.deepEqual(
        requests.map((item) => item.method),
        ["GET", "POST"],
      );
      assert.deepEqual(requests[1]!.body, {
        kind: "document",
        ref: document.key,
        ifVersion: fresh.version,
        actor: "document-author",
        requestId: "document-correlation",
      });
    }
    assert.match(receipt, /Каскад удалён/);
    assert.match(receipt, /document-correlation/);
    assert.equal(hints(receipt).length, 1);
    assert.ok(hints(receipt)[0]!.endsWith("document list"));
    assert.doesNotMatch(receipt, /document get|document delete /);
    assert.match(await follow(app.root, hints(receipt)[0]!), /Сохраняемый материал/);
    for (const ref of [document.key, renamed.key, `document:${document.ref.id}`])
      failed(await run(["document", "get", ref]), "ENTITY_NOT_FOUND", 3);
    for (const target of [feature, legacy]) {
      const detail = successful(await run<EntityDetail>(["feature", "get", target.key])).data;
      assert.equal(detail.revision, target.revision);
    }
    const after = successful(await run<EntityDetail>(["document", "get", other.key])).data;
    assert.equal(after.data.kind, "document");
    if (after.data.kind !== "document" || before.data.kind !== "document")
      throw new Error("Ожидался документ");
    assert.equal(after.data.body, body);
    assert.deepEqual(
      after.data.relations,
      before.data.relations!.filter((item) => item.target.id !== document.ref.id),
    );
    assert.ok(after.revision > before.revision);
    successful(await run(["doctor", "check"]));
    for (const reserved of [document.key, renamed.key])
      failed(
        await run(["document", "rename", other.key, reserved, "--if-revision", after.revision]),
        "ENTITY_KEY_CONFLICT",
        4,
      );
    assert.deepEqual(successful(await run(["plan", "get", plan.key])).data, planBefore);
    assert.deepEqual(successful(await run(["plan", "get", closedPlan.key])).data, closedBefore);
    const simple = successful(
      await run<EntitySaved>([
        "document",
        "create",
        "--name",
        "Без прикреплений",
        "--body",
        "Одноразовый",
      ]),
    ).data;
    const emptyPreview = successful(
      await run<EntityDeletionPreview>(["document", "delete-preview", simple.key]),
    ).data;
    assert.equal(emptyPreview.detached.length, 0);
    assert.equal(emptyPreview.relations, 0);
    assert.match(await text(["document", "delete-preview", simple.key]), /Нет записей/);
    const deleted = successful(
      await run<EntityDeleted>([
        "document",
        "delete",
        simple.key,
        "--if-version",
        emptyPreview.version,
        "--request-id",
        "json-correlation",
      ]),
    ).data;
    assert.deepEqual(deleted, {
      action: "delete",
      ref: simple.ref,
      requestId: "json-correlation",
      deleted: 1,
      detached: 0,
      relations: 0,
    });
    successful(await run(["doctor", "check"]));
  });

test("document delete HTTP: потеря ответа без повтора", { timeout: 90_000 }, async (t) => {
  const app = await fixture(t);
  const document = successful(
    await app.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Ответ будет потерян",
      "--body",
      "Удаляемый материал",
    ]),
  ).data;
  const other = successful(
    await app.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Внешний материал",
      "--body",
      "Сохранится",
      "--relations",
      JSON.stringify([{ target: document.ref, type: "references" }]),
    ]),
  ).data;
  const server = await httpServer(t, app.root);
  const requests: Request[] = [];
  const proxy = await httpProxy(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({
      method: request.method!,
      url: request.url!,
      ...(body ? { body: JSON.parse(body) } : {}),
    });
    const upstream = await fetch(`${server.url}${request.url}`, {
      method: request.method!,
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
    });
    const text = await upstream.text();
    if (request.method === "POST" && request.url!.endsWith("/entities/delete")) {
      assert.equal(upstream.status, 200, text);
      assert.equal(JSON.parse(text).data.deleted, 1);
      response.destroy();
    } else {
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(text);
    }
  });
  const flags = ["--server-url", proxy.url];
  const preview = successful(
    await invoke<EntityDeletionPreview>(app.root, [
      ...flags,
      "document",
      "delete-preview",
      document.key,
    ]),
  ).data;
  requests.length = 0;
  const result = await invokeRaw(app.root, [
    ...flags,
    "document",
    "delete",
    document.key,
    "--if-version",
    preview.version,
    "--request-id",
    "lost-correlation",
  ]);
  assert.equal(result.code, 5, result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout.replace(/\s+/g, " "), /не повторяйте POST вслепую/);
  assert.deepEqual(
    requests.map((item) => item.method),
    ["GET", "POST"],
  );
  assert.deepEqual(requests[1]!.body, {
    kind: "document",
    ref: document.key,
    ifVersion: preview.version,
    actor: "test-agent",
    requestId: "lost-correlation",
  });
  assert.equal(hints(result.stdout).length, 1);
  assert.match(hints(result.stdout)[0]!, /document list$/);
  assert.match(await follow(app.root, hints(result.stdout)[0]!), /Внешний материал/);
  failed(
    await invoke(app.root, [...flags, "document", "get", document.key]),
    "ENTITY_NOT_FOUND",
    3,
  );
  const surviving = successful(
    await invoke<EntityDetail>(app.root, [...flags, "document", "get", other.key]),
  ).data;
  assert.equal(surviving.data.kind, "document");
  if (surviving.data.kind !== "document") throw new Error("Ожидался документ");
  assert.deepEqual(surviving.data.relations, []);
  successful(await invoke(app.root, [...flags, "doctor", "check"]));
  assert.equal(requests.filter((item) => item.method === "POST").length, 1);
});
