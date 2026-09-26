import assert from "node:assert/strict";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Workspace } from "../../src/storage/workspace.js";
import { ProductRepository } from "../../src/storage/product.js";
import { BoardRepository } from "../../src/storage/boards.js";
import { BoardTaskRepository } from "../../src/storage/board-tasks.js";
import { encodeProduct } from "../../src/storage/product-codec.js";
import { encodeImplementation } from "../../src/domain/product-implementation.js";
import { readOwned, publicRelation } from "../../src/storage/entity-store/relations.js";
import { entityRefSchema } from "@relay/contracts/entities/graph";
import { graphDigest } from "../../src/storage/graph-format.js";
import { forgetStorageSegments } from "../../src/storage/entity-store/hash-index.js";
import { json, settings } from "../../src/storage/unified-adapter.js";
import { z } from "zod";

/** Явные старые JSON-данные для теста миграции. Это не production writer и не обратная миграция продукта. */
export async function writeLegacyMigrationFixture(workspace: Workspace) {
  const root = dirname(workspace.configPath);
  assert(root.startsWith(`${await realpath(tmpdir())}${sep}`), "Фикстура допустима только во временном каталоге");
  assert(basename(dirname(root)).startsWith("tasks-core-"), "Ожидается собственный каталог helpers/workspace.fixture, не пользовательская копия базы");
  const files = await workspace.locked(async (owned) => {
    const tx = workspace.storageSession!;
    assert(tx);
    const output = new Map<string, unknown>();
    output.set("config.json", { ...workspace.config, projectSettings: await settings(workspace) });
    const products = new ProductRepository(workspace);
    const source = await products.snapshot(owned, false);
    for (const record of source.records) {
      const stored = record.fields.kind === "scope"
        ? { ...record, version: 3, storage: "references", fields: {
          kind: "scope", applicationId: record.fields.applicationId,
          contracts: record.fields.contracts.map((entry) => ({ id: entry.id, directory: entry.scenarioId === null ? "features" : "scenarios" })),
        } } : encodeProduct(record);
      output.set(`product/${products.path(record)}`, stored);
    }
    for (const record of source.implementations.values())
      output.set(`product/${products.implementationPath(record.fields.applicationId, { id: record.id, scenarioId: record.fields.scenarioId })}`, encodeImplementation(record));
    const boards = await new BoardRepository(workspace).all();
    for (const board of boards) output.set(`boards/${board.slug}/board.json`, board);
    const tasks = await new BoardTaskRepository(workspace).all();
    const prepared = new BoardTaskRepository(workspace).prepare(tasks.map((task) => ({
      slug: boards.find((board) => board.id === task.boardId)!.slug, task,
    })), []);
    for (const { slug, task } of prepared.writes) output.set(`boards/${slug}/tasks/${task.id}.json`, task);
    for (const task of tasks) {
      const record = await tx.get({ kind: "task", id: task.id });
      output.set(`task-activity/${task.id}/meta.json`, { version: 1, sequence: record.commentSequence ?? 0 });
      for (const comment of record.comments ?? []) {
        output.set(`task-activity/${task.id}/events/${comment.id}.json`, comment);
        const { description: _description, changes: _changes, ...summary } = comment;
        output.set(`task-activity/${task.id}/summaries/${comment.id}.json`, summary);
      }
    }
    const graphRequests: Record<string, unknown> = {};
    for (const [, value] of await tx.indexEntries("records")) {
      const { ref, deleted } = z.object({ ref: entityRefSchema, deleted: z.boolean() }).parse(value);
      assert(!deleted && ref.kind !== "work-plan" && ref.kind !== "release", "Этот набор фикстур описывает только живой продукт и задачи");
      const record = await tx.get(ref);
      for (const receipt of record.receipts ?? []) {
        if (receipt.namespace !== "legacy:task-comment-receipt" && receipt.namespace !== "legacy:graph-receipt") continue;
        const { key, value } = z.object({ key: z.string(), value: z.json() }).parse(receipt.result);
        if (receipt.namespace === "legacy:graph-receipt") graphRequests[key] = value;
        else output.set(`task-activity/receipts/${key}.json`, value);
      }
    }
    const owners = new Map<string, z.infer<typeof entityRefSchema>>();
    for (const [, value] of await tx.indexEntries("edges")) {
      const { owner } = z.object({ owner: entityRefSchema }).parse(value);
      owners.set(`${owner.kind}:${owner.id}`, owner);
    }
    const edges = [];
    for (const owner of owners.values()) {
      const bindings: Record<string, unknown> = {};
      for (const entry of (await readOwned(tx, owner)).entries) {
        // Эти предметные группы в старом формате ещё не существовали.
        if (entry.slot !== "diagnostic" && entry.slot !== "document-links") continue;
        assert(entry.edge.active, "Для отозванных рёбер нужна отдельная замороженная фикстура");
        const edge = publicRelation(entry);
        edges.push({ ...edge, description: edge.description.split("\n") });
        if (entry.slot === "document-links") bindings[graphDigest([edge.from, edge.type, edge.to])] = {
          id: edge.id, from: edge.from, to: edge.to, type: edge.type,
        };
      }
      if (Object.keys(bindings).length) output.set(`product/.document-links/${owner.id}.json`, { version: 1, bindings });
    }
    output.set("relations.json", { schemaVersion: 1, revision: edges.length, edges, events: [], requests: graphRequests });
    return output;
  });
  for (const name of ["entities", "relations", "keyspaces", ".indexes", "storage.json"])
    await rm(join(root, name), { recursive: true, force: true });
  forgetStorageSegments(root);
  for (const [path, value] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(json(value)));
  }
}
