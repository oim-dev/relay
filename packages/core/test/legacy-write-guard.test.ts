import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { legacyWorkspace, seedLegacyTask } from "./helpers/workspace.js";
import { productRecordSchema } from "../src/domain/product.js";
import { encodeProduct } from "../src/storage/product-codec.js";
import { graphDigest } from "../src/storage/graph-format.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { GraphService } from "../src/application/graph/service.js";
import { saveProjectSettings } from "../src/application/project-settings/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { GraphRepository } from "../src/storage/graph.js";
import { DocumentLinksRepository } from "../src/storage/document-links.js";
import type { GraphSnapshot } from "../src/storage/graph.js";
import { HashIndex } from "../src/storage/entity-store/hash-index.js";
import { digest, jsonValue, stateSchema } from "../src/storage/entity-store/format.js";
import { migrationBackupDir } from "./helpers/migration-bases.js";

async function files(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      for (const [key, value] of await files(root, path)) result.set(key, value);
    else if (entry.isFile()) result.set(path, await readFile(join(root, path), "utf8"));
  }
  return result;
}
async function put(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value));
}

/** Замороженная пустая база v1/v2 формируется данными, не вызовом старого writer. */
async function fixture(t: TestContext, version: "legacy" | 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), "relay-write-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (version === "legacy") return { root, workspace: await legacyWorkspace(root) };
  await initialize(root, "tasks");
  const storage = join(root, ".relay");
  const state = stateSchema.parse(
    JSON.parse(await readFile(join(storage, ".indexes/state.json"), "utf8")),
  );
  const hashes = new Map<string, ReturnType<typeof jsonValue>>();
  for (const [path, text] of await files(join(storage, "entities"))) {
    const record = JSON.parse(text);
    record.schemaVersion = 1;
    delete record.receipts;
    await put(storage, `entities/${path}`, record);
    hashes.set(`entities/${path}`, digest(jsonValue(record)));
  }
  const index = new HashIndex(storage);
  state.roots["file-hashes"] = await index.update(state.roots["file-hashes"] ?? null, hashes);
  for (const change of index.changes(Object.values(state.roots)))
    await put(storage, change.path, change.after);
  await put(storage, ".indexes/state.json", state);
  await put(storage, "storage.json", { format: "relay-entities", schemaVersion: version });
  return { root, workspace: await openWorkspace(root) };
}

for (const version of ["legacy", 1, 2] as const)
  test(`${version}: обычная запись запрещена без новых файлов; storage migrate открывает запись`, async (t) => {
    const { root, workspace } = await fixture(t, version);
    const before = await files(join(root, ".relay"));
    const tasks = new BoardTasksService(workspace);
    const entities = new EntityEngine(workspace);
    const graph = new GraphService(workspace);
    const command = { board: "product", title: "Новая задача", requestId: "create" };
    const operations = [
      () => tasks.create(command, "agent"),
      () =>
        tasks.update(
          "PRODUCT-1",
          { ifRevision: 1, title: "Изменение", requestId: "update" },
          "agent",
        ),
      () =>
        tasks.publishComment("PRODUCT-1", {
          title: "Сообщение",
          description: "Текст",
          actor: "agent",
          actorRole: "worker",
          requestId: "comment",
        }),
      () =>
        entities.create(
          {
            data: { kind: "feature", name: "Фича", summary: "Кратко", description: "Описание" },
            requestId: "feature",
          },
          "agent",
        ),
      () =>
        new EntityDeletionService(workspace).delete(
          { ref: "PRODUCT-1", kind: "task", ifVersion: "0".repeat(64), requestId: "delete" },
          "agent",
        ),
      () =>
        graph.mutate(
          {
            ifVersion: "0".repeat(64),
            requestId: "graph",
            operations: [
              {
                action: "add",
                from: "PRODUCT",
                to: "PROJECT",
                type: "references",
                description: "",
              },
            ],
          },
          "agent",
        ),
      () =>
        saveProjectSettings(workspace, {
          name: "Изменённый проект",
          slug: "changed",
          ifRevision: 1,
        }),
      () => graph.migrate(),
      () => graph.reindex(),
      () => new StorageService(workspace).reindex(),
      () =>
        new GraphRepository(workspace).prepareCommit(
          {} as GraphSnapshot,
          [],
          [],
          "key",
          "hash",
          () => ({ ids: [], version: "", revision: 0, requestId: "x" }),
        ),
    ];
    for (const operation of operations)
      await assert.rejects(operation(), { code: "STORAGE_MIGRATION_REQUIRED" });
    assert.deepEqual(await files(join(root, ".relay")), before);
    assert.equal(
      (await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() }))
        .migrated,
      true,
    );
    const saved = await tasks.create(command, "agent");
    assert.notEqual((await tasks.create(command, "agent")).id, saved.id);
    const after = await files(join(root, ".relay"));
    assert.equal(JSON.parse(after.get("storage.json")!).schemaVersion, 4);
    assert.equal(JSON.parse(after.get(`entities/tasks/${saved.id}.json`)!).schemaVersion, 3);
    assert(
      ![...after.keys()].some((path) => /^(history|operations|relations\/history)\//.test(path)),
    );
  });

for (const crash of [0, 1, 2])
  test(`миграция завершает прежнее прикрепление без квитанции; сбой контрольной точки ${crash}`, async (t) => {
    const { root, workspace } = await fixture(t, "legacy");
    const task = await seedLegacyTask(workspace);
    const at = "2026-09-26T00:00:00.000Z";
    const from = { kind: "task", id: task.id };
    const to = { kind: "document", id: "LegacyD1" };
    const record = productRecordSchema.parse({
      version: 1,
      productId: "Legacy01",
      id: to.id,
      key: "DOC-1",
      revision: 1,
      fields: {
        kind: "document",
        name: "Документ",
        summary: "Контекст",
        body: "Текст",
        documentKind: "proposal",
        links: [],
        relations: [{ type: "references", target: from, description: "Прочитать" }],
      },
      createdAt: at,
      updatedAt: at,
      createdBy: "agent",
      updatedBy: "agent",
      events: [],
      requests: {},
    });
    await put(join(root, ".relay"), "product/.transactions/document-links.json", {
      version: 1,
      documentId: to.id,
      actor: "agent",
      requestKey: "pending",
      bindingHash: null,
      files: [{ path: `documents/${to.id}.json`, before: null, after: encodeProduct(record) }],
      bindings: {},
      steps: [
        {
          key: graphDigest([from, "references", to]),
          operation: { action: "add", type: "references", from, to, description: "Прочитать" },
        },
      ],
      cursor: 0,
      command: null,
    });
    const pending = await files(join(root, ".relay"));
    // Новая команда не запускает старый writer даже при наличии прежнего намерения.
    await assert.rejects(
      new BoardTasksService(workspace).create({ board: "product", requestId: "blocked" }, "agent"),
      { code: "STORAGE_MIGRATION_REQUIRED" },
    );
    assert.deepEqual(await files(join(root, ".relay")), pending);
    // Завершается только уже записанное намерение, без генерации аудита.
    if (crash) {
      const write = DocumentLinksRepository.prototype.writePending;
      let checkpoints = 0;
      t.mock.method(
        DocumentLinksRepository.prototype,
        "writePending",
        async function (this: DocumentLinksRepository, ...args: Parameters<typeof write>) {
          if (args[0].cursor > 0 && ++checkpoints === crash)
            throw new Error("Сбой контрольной точки");
          return write.apply(this, args);
        },
      );
      await assert.rejects(
        workspace.locked(async () => {}),
        /Сбой контрольной точки/,
      );
      t.mock.restoreAll();
    }
    await workspace.locked(async () => {});
    const recovered = await files(join(root, ".relay"));
    assert(
      ![...recovered.keys()].some((path) =>
        /^(history|operations|relations\/(history|requests))\//.test(path),
      ),
    );
    assert(!recovered.has("product/.transactions/document-links.json"));
    await new StorageService(workspace).migrate({ backupDir: await migrationBackupDir() });
    const context = await new GraphService(workspace).context({ root: task.id });
    assert.equal(
      context.edges.filter((edge) => edge.type === "references" && edge.to.id === to.id).length,
      1,
    );
  });
