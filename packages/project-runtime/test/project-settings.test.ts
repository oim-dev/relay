import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@relay/core/domain/config";
import { initialize } from "@relay/core/storage/workspace";
import { createHttpBackend } from "../src/backend/http.js";
import { createLocalBackend } from "../src/backend/local.js";

async function persistentFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "runtime") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory())
      for (const [child, value] of Object.entries(await persistentFiles(path)))
        files[join(entry.name, child)] = value;
    else files[entry.name] = (await readFile(path)).toString("base64");
  }
  return files;
}

test("settings local: актуальное чтение, name/slug, CAS, no-op и сохранение паспорта", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-settings-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const backend = await createLocalBackend(root);
  const other = await createLocalBackend(root);
  const initial = await backend.projectSettings.get();
  const sections = [
    { id: "second", name: "Второй 🧪" },
    { id: "first", name: "Первый 東京" },
  ];
  const updated = await other.entities.update(
    {
      ref: "PROJECT",
      ifRevision: initial.revision,
      changes: { kind: "project", documentSections: sections },
      requestId: "sections",
    },
    "settings-test",
  );
  await other.entities.rename(
    {
      ref: "PROJECT",
      key: "PROJECT-CURRENT",
      ifRevision: updated.revision,
      requestId: "rename",
    },
    "settings-test",
  );
  const before = await persistentFiles(join(root, ".relay"));
  const fresh = await backend.projectSettings.get();
  assert.deepEqual(fresh.documentSections, sections);
  assert.equal(fresh.revision, initial.revision + 2);
  assert.deepEqual(await persistentFiles(join(root, ".relay")), before);
  const keys = await backend.entities.keys({ ref: "PROJECT" });
  const command = { name: "  Имя 🧪 東京  ", slug: "new-address", ifRevision: fresh.revision };
  const saved = await backend.projectSettings.save(command);
  assert.equal(saved.name, command.name.trim());
  assert.equal(saved.slug, command.slug);
  assert.equal(saved.revision, fresh.revision + 1);
  assert.deepEqual(saved.documentSections, sections);
  assert.deepEqual(await other.projectSettings.get(), saved);
  const after = await persistentFiles(join(root, ".relay"));
  // Предметный no-op Core допускается даже с прежней ревизией.
  assert.deepEqual(await backend.projectSettings.save(command), saved);
  assert.deepEqual(await persistentFiles(join(root, ".relay")), after);
  await assert.rejects(backend.projectSettings.save({ ...command, slug: "stale-address" }), {
    code: "REVISION_CONFLICT",
    exitCode: 4,
  });
  assert.deepEqual(await persistentFiles(join(root, ".relay")), after);
  const detail = await backend.entities.get({ ref: "PROJECT", kind: "project" });
  assert.equal(detail.ref.id, workspace.config.projectId);
  assert.equal(detail.key, "PROJECT-CURRENT");
  assert.equal(detail.data.kind, "project");
  if (detail.data.kind === "project") {
    assert.equal(detail.data.slug, saved.slug);
    assert.deepEqual(detail.data.documentSections, sections);
  }
  assert.deepEqual((await backend.entities.keys({ ref: "PROJECT" })).items, keys.items);
  // Старое чтение нельзя соединять со свежей ревизией после конкурентной записи.
  const concurrent = await other.projectSettings.save({
    name: "Конкурентное имя",
    slug: saved.slug,
    ifRevision: saved.revision,
  });
  const reread = await backend.projectSettings.get();
  assert.deepEqual(reread, concurrent);
  await assert.rejects(
    backend.projectSettings.save({
      name: reread.name,
      slug: "client-address",
      ifRevision: saved.revision,
    }),
    { code: "REVISION_CONFLICT" },
  );
  assert.deepEqual(await backend.projectSettings.get(), concurrent);
});

const context = {
  ok: true,
  data: {
    capabilities: ["relay-projects-v1"],
    projectId: "fixed-project",
    config: defaultConfig,
    configPath: "/project/.relay/config.json",
    storagePath: "/project/.relay",
  },
};

test("settings HTTP: SDK GET/PUT закреплены по ID, ввод проверяется до запроса", async (t) => {
  const requests: string[] = [];
  const settings = { name: "Имя", slug: "new-address", revision: 8 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${url}`);
    if (url.endsWith("/projects/registration/context")) return Response.json(context);
    assert.equal(url, "http://127.0.0.1:4700/api/v1/projects/fixed-project/context/settings");
    if (init.method === "PUT")
      assert.deepEqual(JSON.parse(String(init.body)), {
        name: "Имя",
        slug: "new-address",
        ifRevision: 3,
      });
    else assert.equal(init.method, "GET");
    return Response.json({ ok: true, data: settings });
  });
  const backend = await createHttpBackend("http://127.0.0.1:4700", "registration");
  assert.deepEqual(await backend.projectSettings.get(), settings);
  assert.deepEqual(
    await backend.projectSettings.save({ name: "  Имя  ", slug: "new-address", ifRevision: 3 }),
    settings,
  );
  await assert.rejects(
    backend.projectSettings.save({ name: "Имя", slug: "bad slug", ifRevision: 8 }),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(requests.length, 3);
});

for (const failure of ["network", "500", "409", "envelope", "data", "json"] as const)
  test(`settings HTTP: PUT не повторяется при ${failure}`, async (t) => {
    let writes = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/context")) return Response.json(context);
      assert.equal(init.method, "PUT");
      writes++;
      if (failure === "network") throw new TypeError("Ответ потерян после записи");
      if (failure === "envelope") return Response.json({ unexpected: true });
      if (failure === "data") return Response.json({ ok: true, data: { name: "Имя" } });
      if (failure === "json") return new Response("{", { status: 200 });
      return Response.json(
        {
          ok: false,
          error: { code: "TEST_ERROR", message: "Ошибка", exitCode: 4, details: { expected: 7 } },
        },
        { status: Number(failure) },
      );
    });
    const backend = await createHttpBackend("http://127.0.0.1:4700");
    await assert.rejects(
      backend.projectSettings.save({ name: "Имя", slug: "new-address", ifRevision: 7 }),
      {
        code: ["network", "json"].includes(failure)
          ? "SERVER_UNAVAILABLE"
          : ["envelope", "data"].includes(failure)
            ? "INVALID_SERVER_RESPONSE"
            : "TEST_ERROR",
        ...(["500", "409"].includes(failure) ? { exitCode: 4, details: { expected: 7 } } : {}),
      },
    );
    assert.equal(writes, 1);
  });

test("settings HTTP: чтение проверяет предметный ответ", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(url.endsWith("/context") ? context : { ok: true, data: { revision: 1 } }),
  );
  const backend = await createHttpBackend("http://127.0.0.1:4700");
  await assert.rejects(backend.projectSettings.get(), { code: "INVALID_SERVER_RESPONSE" });
});
