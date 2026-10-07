import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "../src/application/storage/service.js";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EntityEngine } from "@relay/core/application/entities/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { ProductRepository } from "@relay/core/storage/product";
import { GraphService } from "@relay/core/application/graph/service";
import { fixture } from "./helpers/workspace.js";
import { migrationBackupDir } from "./helpers/migration-bases.js";

test("библиотека: черновик, атомарные связи с задачей, Markdown, CAS и повтор", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const task = await engine.create(
    { data: { kind: "task", board: "BOARD-INFRA", title: "Настроить деплой" }, requestId: "task" },
    "agent",
  );
  const command = {
    data: {
      kind: "document" as const,
      name: "Проект выкладки",
      summary: "Когда читать\nПеред изменением pipeline",
      body: "## Проект\n\n  Точный текст  \n",
      documentKind: "proposal" as const,
      sectionId: "infrastructure",
      relations: [
        {
          target: task.ref,
          type: "references" as const,
          description: "## Контекст\n\n  Перед деплоем  \n",
        },
      ],
    },
    requestId: "document",
  };
  const saved = await engine.create(command, "agent");
  assert.equal((await engine.get({ ref: saved.key })).ref.id, saved.ref.id);
  const entry = await engine.get({ ref: saved.key });
  assert.equal(entry.status, "draft");
  assert.equal(entry.document?.kind, "proposal");
  assert.equal(entry.references[0]?.ref.id, task.ref.id);
  assert.equal((await engine.list({ kind: "document", target: task.key })).total, 1);
  assert.equal(
    (await engine.list({ kind: "document", q: "Точный текст" })).items[0]?.document?.excerpt,
    command.data.body,
  );
  // Продуктовый сценарий уже установил отдельную связь; чтение ничего не создаёт.
  const graph = await new GraphService(workspace).read({ root: task.key });
  const attachment = graph.edges.filter(
    (edge) =>
      edge.type === "references" && edge.from.id === task.ref.id && edge.to.id === saved.ref.id,
  );
  assert.equal(attachment.length, 1);
  assert.equal(attachment[0]?.source, "graph");
  assert.equal(attachment[0]?.description, command.data.relations[0]!.description);
  const repository = new ProductRepository(workspace);
  const path = join(repository.root, "../entities/documents", `${saved.ref.id}.json`);
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(disk.schemaVersion, 3);
  assert.deepEqual(disk.data.body, command.data.body.split("\n"));
  assert.deepEqual(
    disk.data.relations[0].description,
    command.data.relations[0]!.description.split("\n"),
  );
  const update = {
    ref: saved.key,
    ifRevision: 1,
    requestId: "accept",
    changes: {
      kind: "document" as const,
      documentStatus: "active" as const,
      documentKind: "decision" as const,
    },
  };
  const accepted = await engine.update(update, "agent");
  await assert.rejects(engine.update(update, "agent"), { code: "REVISION_CONFLICT" });
  await assert.rejects(engine.update({ ...update, requestId: "stale" }, "agent"), {
    code: "REVISION_CONFLICT",
  });
  assert.equal((await engine.get({ ref: saved.key })).document?.status, "active");
  await assert.rejects(
    engine.update(
      {
        ref: saved.key,
        ifRevision: accepted.revision,
        requestId: "invalid",
        changes: {
          kind: "document",
          body: "Не должно сохраниться",
          relations: [
            { target: { kind: "task", id: "missing" }, type: "references", description: "" },
          ],
        },
      },
      "agent",
    ),
  );
  const unchanged = await engine.get({ ref: saved.key });
  assert.equal(unchanged.data.kind === "document" && unchanged.data.body, command.data.body);
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.key, kind: "task" });
  assert.ok(preview.detached.some((item) => item.ref.id === saved.ref.id));
  await deletion.delete(
    { ref: task.key, kind: "task", ifVersion: preview.version, requestId: "delete-task" },
    "agent",
  );
  const remaining = await engine.get({ ref: saved.key });
  assert.equal(remaining.data.kind === "document" && remaining.data.relations?.length, 0);
});

test("библиотека: разделы, архив, полный поиск и версионированные страницы", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const project = await engine.get({ ref: "PROJECT" });
  await engine.update(
    {
      ref: "PROJECT",
      ifRevision: project.revision,
      requestId: "sections",
      changes: {
        kind: "project",
        documentSections: [{ id: "custom", name: "Особенности окружения" }],
      },
    },
    "agent",
  );
  for (let index = 0; index < 3; index++)
    await engine.create(
      {
        requestId: `doc-${index}`,
        data: {
          kind: "document",
          name: `Инструкция ${index}`,
          summary: "",
          body: `Окружение ${index}`,
          documentKind: "instruction",
          sectionId: "custom",
          documentStatus: index === 2 ? "archived" : "active",
          pinned: index === 0,
        },
      },
      "agent",
    );
  const page = await engine.list({
    kind: "document",
    section: "custom",
    archived: "false",
    limit: 1,
  });
  assert.equal(page.total, 2);
  assert.ok("libraryCounts" in page);
  assert.equal(page.libraryCounts?.archived, 1);
  assert.equal(page.libraryCounts?.pinned, 1);
  assert.equal(page.libraryCounts?.["section:custom"], 2);
  const next = await engine.list({
    kind: "document",
    section: "custom",
    archived: "false",
    limit: 1,
    offset: 1,
    version: page.version,
  });
  assert.notEqual(next.items[0]?.ref.id, page.items[0]?.ref.id);
  assert.equal(next.nextOffset, null);
  const currentProject = await engine.get({ ref: "PROJECT" });
  await engine.update(
    {
      ref: "PROJECT",
      ifRevision: currentProject.revision,
      requestId: "remove-section",
      changes: { kind: "project", documentSections: [] },
    },
    "agent",
  );
  await assert.rejects(engine.list({ kind: "document", offset: 1, version: page.version }), {
    code: "ENTITIES_CHANGED",
  });
  assert.equal((await engine.list({ kind: "document", section: "none" })).total, 3);
  assert.equal((await engine.list({ kind: "document", q: "Окружение 1" })).total, 1);
});

test("библиотека: повторяемая миграция прежнего документа сохраняет текст, ID и ревизию", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const saved = await engine.create(
    {
      requestId: "legacy",
      data: {
        kind: "document",
        name: "Прежний материал",
        summary: "",
        body: "## Текст\r\n\n  Отступ  \n",
        documentKind: "description",
      },
    },
    "agent",
  );
  const repository = new ProductRepository(workspace);
  await writeLegacyMigrationFixture(workspace);
  const path = join(repository.root, "documents", `${saved.ref.id}.json`);
  const disk = JSON.parse(await readFile(path, "utf8"));
  disk.version = 3;
  delete disk.fields.relations;
  delete disk.fields.documentStatus;
  delete disk.fields.sectionId;
  delete disk.fields.pinned;
  await writeFile(path, JSON.stringify(disk));
  const before = await engine.get({ ref: saved.key });
  assert.equal(before.document?.status, "active");
  assert.equal(
    (await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() }))
      .migrated,
    true,
  );
  assert.equal(
    (await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() }))
      .migrated,
    false,
  );
  assert.deepEqual(await engine.get({ ref: saved.key }), before);
  assert.equal(
    JSON.parse(
      await readFile(
        join(repository.root, "../entities/documents", `${saved.ref.id}.json`),
        "utf8",
      ),
    ).schemaVersion,
    3,
  );
});
