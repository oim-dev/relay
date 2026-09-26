import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EntityEngine } from "@relay/core/application/entities/service";
import { GraphService } from "@relay/core/application/graph/service";
import { GraphRepository } from "@relay/core/storage/graph";
import { readOwned } from "../src/storage/entity-store/relations.js";
import { StorageService } from "../src/application/storage/service.js";
import { exists } from "../src/storage/files.js";
import { failWal } from "./helpers/wal.js";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { openWorkspace } from "@relay/core/storage/workspace";
import { fixture } from "./helpers/workspace.js";

for (const stage of ["product", "graph-before", "graph-after"] as const) {
  test(`прикрепления: восстановление после сбоя ${stage}, перечитывание состояния без повтора`, async (t) => {
    const { workspace, root } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const task = await engine.create(
      { data: { kind: "task", board: "BOARD-INFRA", title: "Контекст" }, requestId: "task" },
      "agent",
    );
    const command = {
      requestId: "document",
      data: {
        kind: "document" as const,
        name: "Инструкция",
        summary: "",
        body: "## Текст\n",
        documentKind: "instruction" as const,
        relations: [{ target: task.ref, type: "references" as const, description: "Пояснение" }],
      },
    };
    failWal(t, (phase, path) => {
      if (
        (stage === "product" && phase === "file" && path?.startsWith("entities/documents/")) ||
        (stage === "graph-before" && phase === "intent") ||
        (stage === "graph-after" && phase === "file" && path?.startsWith("relations/documents/"))
      )
        throw new Error(`Сбой ${stage}`);
    });
    await assert.rejects(engine.create(command, "agent"), /Сбой|Потерян/);
    const pending = join(dirname(workspace.configPath), "transactions/pending.json");
    assert(await exists(pending));
    t.mock.restoreAll();
    const restarted = await openWorkspace(root);
    const nextEngine = new EntityEngine(restarted);
    const saved = (await nextEngine.list({ kind: "document" })).items[0]!;
    assert(saved);
    const graph = new GraphService(restarted);
    const edges = (await graph.read({ root: task.key })).edges.filter(
      (edge) =>
        edge.type === "references" && edge.from.id === task.ref.id && edge.to.id === saved.ref.id,
    );
    assert.equal(edges.length, 1);
    const owned = await restarted.locked(() => readOwned(restarted.storageSession!, saved.ref));
    assert.equal(
      owned.entries.filter((entry) => entry.slot === "document-links" && entry.edge.active).length,
      1,
    );
    assert.equal(
      owned.entries.find((entry) => entry.edge.id === edges[0]!.id)?.edge.description.join("\n"),
      "Пояснение",
    );
    assert.equal(await exists(pending), false);
  });
}

test("прикрепления: редактура сохраняет ID, открепление не снимает независимые рёбра", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const graph = new GraphService(workspace);
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-INFRA" }, requestId: "task" },
    "agent",
  );
  const relation = {
    target: task.ref,
    type: "references" as const,
    description: "Старое пояснение",
  };
  const saved = await engine.create(
    {
      requestId: "doc",
      data: {
        kind: "document",
        name: "Знание",
        summary: "",
        body: "Текст",
        documentKind: "description",
        relations: [relation],
      },
    },
    "agent",
  );
  const before = await graph.read({ root: saved.key });
  const attachment = before.edges.find(
    (edge) =>
      edge.type === "references" && edge.from.id === task.ref.id && edge.to.id === saved.ref.id,
  );
  assert(attachment);
  const id = attachment.id;
  const independent = await graph.mutate(
    {
      requestId: "independent",
      ifVersion: before.version,
      operations: [
        {
          action: "add",
          from: task.ref,
          to: saved.ref,
          type: "related",
          description: "Независимый факт",
        },
      ],
    },
    "operator",
  );
  const edited = await engine.update(
    {
      ref: saved.key,
      ifRevision: saved.revision,
      requestId: "edit",
      changes: {
        kind: "document",
        relations: [{ ...relation, description: "Новое пояснение" }],
      },
    },
    "agent",
  );
  const after = await graph.read({ root: saved.key });
  assert.equal(after.edges.find((edge) => edge.id === id)?.description, "Новое пояснение");
  assert.equal(after.edges.find((edge) => edge.id === id)?.revision, 2);
  await engine.update(
    {
      ref: saved.key,
      ifRevision: edited.revision,
      requestId: "detach",
      changes: { kind: "document", relations: [] },
    },
    "agent",
  );
  const remaining = await graph.read({ root: saved.key });
  assert(!remaining.edges.some((edge) => edge.id === id));
  assert.equal(
    remaining.edges.find((edge) => edge.id === independent.ids[0])?.description,
    "Независимый факт",
  );
  const owned = await workspace.locked(() => readOwned(workspace.storageSession!, saved.ref));
  assert.equal(owned.entries.find((entry) => entry.edge.id === id)?.edge.active, false);
  assert.equal(owned.entries.find((entry) => entry.edge.id === id)?.edge.revision, 3);
});

test("прикрепления: legacy-линк импортируется явным storage migrate, а не чтением", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const document = await engine.create(
    {
      requestId: "doc",
      data: {
        kind: "document",
        name: "Материал",
        summary: "",
        body: "Текст",
        documentKind: "description",
      },
    },
    "agent",
  );
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Фича", summary: "", description: "Поведение" },
    },
    "agent",
  );
  await writeLegacyMigrationFixture(workspace);
  const path = join(dirname(workspace.configPath), "product/documents", `${document.ref.id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.fields.links = [{ kind: "feature", id: feature.ref.id }];
  await writeFile(path, JSON.stringify(raw));
  const before = await readFile(path, "utf8");
  assert.equal((await engine.get({ ref: document.key })).references[0]?.ref.id, feature.ref.id);
  assert.equal((await new GraphService(workspace).read()).totalEdges, 0);
  assert.equal(await readFile(path, "utf8"), before);
  await new StorageService(workspace).migrate();
  const repository = new GraphRepository(workspace);
  const snapshot = await workspace.locked((owned) => repository.open(owned));
  const attached = snapshot.index.active.filter(
    (edge) =>
      edge.type === "documents" &&
      edge.from.id === document.ref.id &&
      edge.to.id === feature.ref.id,
  );
  assert.equal(attached.length, 1);
  const same = await engine.update(
    {
      ref: document.key,
      ifRevision: document.revision,
      requestId: "text",
      changes: { kind: "document", body: "Обновлённый текст" },
    },
    "agent",
  );
  assert.equal(same.ref.id, document.ref.id);
  const after = (await new GraphService(workspace).read()).edges.filter(
    (edge) => edge.type === "documents" && edge.from.id === document.ref.id,
  );
  assert.deepEqual(
    after.map((edge) => edge.id),
    attached.map((edge) => edge.id),
  );
});
