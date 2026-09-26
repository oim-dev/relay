import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProductQueries } from "@relay/core/application/product/queries";
import { ProductRepository } from "@relay/core/storage/product";
import { StorageService } from "../src/application/storage/service.js";
import { failWal } from "./helpers/wal.js";
import { exists } from "../src/storage/files.js";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { fixture } from "./helpers/workspace.js";

test("ключи продукта: конкурентная выдача, разрешение ID/ключа, коллизия без потери идентичности", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const fields = {
    kind: "feature" as const,
    name: "Каталог",
    summary: "Товары",
    description: "## Правила\n\nОписание",
  };
  const created = await Promise.all(
    ["one", "two"].map((requestId) =>
      service.mutate({ action: "create", requestId, fields }, "agent"),
    ),
  );
  assert.deepEqual(new Set(created.map((entry) => entry.key)), new Set(["FEATURE-1", "FEATURE-2"]));
  const first = created[0]!;
  assert.equal((await service.entity(first.key!)).id, first.id);
  assert.equal((await service.entity(first.id)).key, first.key);
  const repository = new ProductRepository(app.workspace);
  const second = created[1]!;
  const path = join(repository.root, "../entities/features", `${second.id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.aliases.push(raw.key);
  raw.key = first.key;
  await writeFile(path, JSON.stringify(raw));
  await new StorageService(app.workspace).reindex();
  await assert.rejects(service.entity(first.key!), { code: "AMBIGUOUS_PRODUCT_KEY" });
  assert.equal((await service.entity(first.id)).id, first.id);
  const fixed = await service.mutate(
    {
      action: "update",
      id: second.id,
      key: "FEATURE-3",
      fields,
      ifRevision: 1,
      requestId: "resolve",
    },
    "agent",
  );
  assert.equal(fixed.id, second.id);
  assert.equal((await service.entity("FEATURE-3")).id, second.id);
  const scenario = await service.mutate(
    {
      action: "create",
      requestId: "scenario",
      fields: {
        kind: "scenario",
        featureId: "FEATURE-3",
        name: "Поиск",
        description: "Найти товар",
      },
    },
    "agent",
  );
  const record = await service.entity(scenario.key!);
  assert.ok(record.fields.kind === "scenario");
  assert.equal(record.fields.featureId, second.id);
  const list = await service.entities({ q: "FEATURE-3", limit: 1 });
  assert.equal(list.items[0]?.id, second.id);
  assert.ok(!JSON.stringify(list).includes("## Правила"));
  await writeFile(
    join(repository.root, "../.indexes", "product-catalog.json"),
    "{прерванный индекс",
  );
  assert.equal((await service.entity(first.id)).id, first.id);
});

test("реализации: ID-пути, отдельное чтение и ревизии, сохранение связей после смены ключа", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const feature = await service.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "Общие требования" },
    },
    "agent",
  );
  const scenario = await service.mutate(
    {
      action: "create",
      requestId: "scenario",
      fields: {
        kind: "scenario",
        featureId: feature.key!,
        name: "Поиск",
        description: "Найти товар",
      },
    },
    "agent",
  );
  const application = await service.mutate(
    {
      action: "create",
      requestId: "app",
      fields: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        summary: "",
        description: "Интерфейс",
        type: "frontend",
      },
    },
    "agent",
  );
  await service.mutate(
    {
      action: "create",
      requestId: "scope",
      ifVersion: (await service.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.key!,
        contracts: [
          {
            featureId: feature.key!,
            scenarioId: null,
            title: "Каталог Web",
            description: "Общий вклад",
            status: "done",
          },
          {
            featureId: feature.key!,
            scenarioId: scenario.key!,
            title: "Поиск Web",
            description: "## Поиск\n\nТекст  \n",
            status: "done",
          },
        ],
      },
    },
    "agent",
  );
  const featureImpl = await service.entity("WEB-FI-1");
  const scenarioImpl = await service.entity("WEB-SI-1");
  assert.equal(scenarioImpl.revision, 1);
  assert.ok(scenarioImpl.fields.kind === "implementation");
  const root = new ProductRepository(app.workspace).root;
  const directory = join(root, "../entities/implementations");
  assert.deepEqual(
    new Set(await readdir(directory)),
    new Set([`${featureImpl.id}.json`, `${scenarioImpl.id}.json`]),
  );
  const stored = JSON.parse(await readFile(join(directory, `${scenarioImpl.id}.json`), "utf8"));
  assert.deepEqual(stored.data.description, ["## Поиск", "", "Текст  ", ""]);
  const scopes = await readdir(join(root, "../entities/scopes"));
  assert.equal(scopes.length, 1);
  const manifest = JSON.parse(await readFile(join(root, "../entities/scopes", scopes[0]!), "utf8"));
  assert.deepEqual(
    new Set(manifest.data.implementations),
    new Set([featureImpl.id, scenarioImpl.id]),
  );
  assert(!JSON.stringify(manifest.data).includes("## Поиск"));
  const task = await new BoardTasksService(app.workspace).create(
    { board: "web", requestId: "task", productLinks: [{ kind: "implementation", id: "WEB-SI-1" }] },
    "agent",
  );
  const first = await service.updateImplementation(
    {
      ref: featureImpl.id,
      title: "Новый каталог",
      ifRevision: featureImpl.revision,
      requestId: "first",
    },
    "agent",
  );
  const command = {
    ref: "WEB-SI-1",
    key: "WEB-SI-99",
    ifRevision: scenarioImpl.revision,
    requestId: "second",
  };
  const second = await service.updateImplementation(command, "agent");
  assert.equal(first.revision, featureImpl.revision + 1);
  assert.equal(second.revision, scenarioImpl.revision + 1);
  await assert.rejects(service.updateImplementation(command, "agent"), {
    code: "INVALID_REFERENCE",
  });
  const renamed = await service.entity("WEB-SI-99");
  assert.ok(renamed.fields.kind === "implementation");
  assert.equal(renamed.id, scenarioImpl.id);
  assert.equal(renamed.fields.scenarioId, scenario.id);
  assert.equal(
    (await service.state()).readiness.find((entry) => entry.id === scenario.id)?.status,
    "partial",
  );
  assert.equal(
    (await new BoardTasksService(app.workspace).get(task.id)).productLinks[0]?.id,
    scenarioImpl.id,
  );
  await assert.rejects(
    service.updateImplementation(
      { ...command, ref: scenarioImpl.id, requestId: "conflict" },
      "agent",
    ),
    { code: "REVISION_CONFLICT" },
  );
});

test("прерванная составная запись восстанавливается, несовместимая внешняя правка не затирается", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const saved = await service.mutate(
    {
      action: "create",
      requestId: "initial",
      fields: { kind: "feature", name: "До", summary: "", description: "Текст" },
    },
    "agent",
  );
  const record = await service.entity(saved.id);
  assert.ok(record.fields.kind === "feature");
  const command = {
    action: "update" as const,
    id: saved.id,
    ifRevision: 1,
    requestId: "update",
    fields: { ...record.fields, name: "После" },
  };
  failWal(t, (stage) => {
    if (stage === "intent") throw new Error("Прервано перед публикацией");
  });
  await assert.rejects(service.mutate(command, "agent"), /Прервано/);
  assert(await exists(join(app.workspace.root, "transactions/pending.json")));
  t.mock.restoreAll();
  assert.equal((await service.entity(saved.id)).fields.kind, "feature");
  assert.equal((await service.entities({ refs: [saved.id] })).items[0]?.title, "После");
  await assert.rejects(service.mutate(command, "agent"), { code: "REVISION_CONFLICT" });
  failWal(t, (stage) => {
    if (stage === "intent") throw new Error("Прервано");
  });
  await assert.rejects(
    service.mutate(
      { ...command, fields: record.fields, ifRevision: 2, requestId: "second" },
      "agent",
    ),
    /Прервано/,
  );
  t.mock.restoreAll();
  const path = join(app.workspace.root, "entities/features", `${saved.id}.json`);
  const external = JSON.parse(await readFile(path, "utf8"));
  external.data.name = "Внешняя правка";
  await writeFile(path, JSON.stringify(external));
  await assert.rejects(service.entity(saved.id), { code: "STORAGE_RECOVERY_CONFLICT" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), external);
  assert(await exists(join(app.workspace.root, "transactions/pending.json")));
});
