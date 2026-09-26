import { dirname, join, relative } from "node:path";
import { readdir, rmdir, unlink, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Workspace } from "../../storage/workspace.js";
import { ProductRepository } from "../../storage/product.js";
import { BoardRepository } from "../../storage/boards.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { TaskActivityRepository, legacyTaskEvents } from "../../storage/task-activity.js";
import type { ActivityFile } from "../../storage/task-activity.js";
import { GraphRepository } from "../../storage/graph.js";
import { DocumentLinksRepository } from "../../storage/document-links.js";
import { EntityDeletionRepository } from "../../storage/entity-deletion.js";
import { graphReceiptSchema, currentPath, receiptPath, eventPath, graphStoredEventSchema } from "../../storage/graph-format.js";
import type { GraphCurrent, GraphReceipt } from "../../storage/graph-format.js";
import { readJson, exists } from "../../storage/files.js";
import { projectSettings } from "../../storage/project-settings.js";
import * as unified from "../../storage/unified-adapter.js";
import { writeOwnedRelations } from "../../storage/entity-store/relations.js";
import {
  syncBoardRelations,
  syncProductRelations,
  syncProductRootRelations,
  syncTaskRelations,
} from "../entities/owned-relations.js";
import { refreshEntityCards } from "../entities/storage-projection.js";
import { invariant, isErrno } from "../../shared/errors.js";
import { GraphService } from "../graph/service.js";
import { atomicJson } from "../../storage/files.js";
import { digest } from "../../storage/entity-store/format.js";
import { actorSchema, requestIdSchema } from "@relay/contracts/primitives";
import { validateProduct } from "../product/model.js";
import { planningRecords } from "../../storage/planning.js";
import { syncPlanRelations } from "../planning/relations.js";
import { syncReleaseRelations } from "../releases/relations.js";
import { storageMigrationOptionsSchema } from "../../storage/migration/orphan-planning-approval.js";
import type { StorageMigrationOptions } from "../../storage/migration/orphan-planning-approval.js";
export type { StorageMigrationOptions } from "../../storage/migration/orphan-planning-approval.js";

/** Только явное обслуживание меняет физический формат существующего проекта. */
export class StorageService {
  constructor(readonly workspace: Workspace) {}

  /** Новый проект сразу публикуется в актуальном формате, без промежуточных каталогов. */
  async initialize() {
    const workspace = this.workspace;
    await workspace.withEntityStorage(async (store, owned) => {
      invariant(
        !(await exists(workspace.configPath)) && !(await exists(join(store.root, "storage.json"))),
        "ALREADY_INITIALIZED",
        "Конфигурация уже существует",
        4,
      );
      workspace.storageProductId = workspace.config.projectId!;
      await store.transaction(
        owned,
        (tx) =>
          workspace.inStorageSession(tx, owned, async () => {
            const { projectSettings: _settings, ...config } = workspace.config;
            await tx.writeFile(relative(store.root, workspace.configPath), unified.json(config));
            await unified.saveSettings(workspace, workspace.config.projectSettings!, true);
            const at = new Date().toISOString();
            await tx.importRecord({
              schemaVersion: 1,
              dataVersion: 1,
              kind: "product",
              id: "passport",
              revision: 0,
              key: "PRODUCT",
              aliases: [],
              data: { name: "", summary: "", description: "" },
              createdAt: at,
              updatedAt: at,
              createdBy: "relay",
              updatedBy: "relay",
            });
            await new BoardRepository(workspace).initialize(owned);
            for (const [kind, prefix] of [
              ["feature", "FEATURE"],
              ["scenario", "SCENARIO"],
              ["document", "DOC"],
            ] as const)
              await tx.saveKeySpace({
                schemaVersion: 1,
                id: `global-${kind}`,
                entityKind: kind,
                owner: { kind: "project", id: workspace.config.projectId! },
                prefix,
                format: "{prefix}-{number}",
              });
            await syncProductRootRelations(workspace, "relay");
            await refreshEntityCards(workspace, owned);
            await tx.writeFile("storage.json", {
              format: "relay-entities",
              schemaVersion: 3,
              productId: workspace.storageProductId!,
            });
          }),
        true,
      );
    }, true);
  }

  /** Явно согласует предметные группы, сохраняя независимые рёбра и ревизии сущностей. */
  async reconcileRelations(input: { requestId: string }, actor: string) {
    const requestId = requestIdSchema.parse(input.requestId);
    const author = actorSchema.parse(actor);
    return this.workspace.mutate("reconcile-relations", { requestId }, author, async (owned) => {
      invariant(
        this.workspace.storageSession,
        "STORAGE_MIGRATION_REQUIRED",
        "Для согласования предметных связей сначала выполните relay-cli --local storage migrate",
        4,
      );
      const products = await new ProductRepository(this.workspace).all();
      validateProduct(products);
      const boards = await new BoardRepository(this.workspace).all();
      const tasks = await new BoardTaskRepository(this.workspace).all();
      const graph = new GraphRepository(this.workspace);
      const before = (await graph.open(owned)).index.entries;
      await syncProductRootRelations(this.workspace, author);
      await syncBoardRelations(this.workspace, boards, author);
      for (const record of products) await syncProductRelations(this.workspace, record, author);
      await syncTaskRelations(this.workspace, tasks, author);
      for (const plan of await planningRecords(this.workspace, "work-plan"))
        await syncPlanRelations(this.workspace, plan, author);
      for (const release of await planningRecords(this.workspace, "release"))
        await syncReleaseRelations(this.workspace, release, author);
      const after = (await graph.open(owned)).index.entries;
      let added = 0,
        updated = 0,
        removed = 0;
      for (const [id, edge] of after) {
        const previous = before.get(id);
        if (edge.active && !previous?.active) added++;
        else if (!edge.active && previous?.active) removed++;
        else if (edge.active && previous && edge.revision !== previous.revision) updated++;
      }
      return { added, updated, removed, requestId };
    });
  }

  async reindex() {
    invariant(
      await this.workspace.hasUnifiedStorage(),
      "STORAGE_MIGRATION_REQUIRED",
      "Сначала выполните storage migrate",
      4,
    );
    return new GraphService(this.workspace).reindex();
  }

  /** Файловый наблюдатель проверяет только изменённые пути; обычные запросы не сканируют базу. */
  async checkExternalChanges(paths: readonly string[]): Promise<void> {
    const selected = [...new Set(paths)].filter(
      (path) =>
        /^(entities|relations|keyspaces|operations|history)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(
          path,
        ) && !path.split("/").some((part) => part === "." || part === ".." || part === ".indexes"),
    );
    if (!selected.length) return;
    await this.workspace.withEntityStorage(async (store, owned) => {
      const changed: string[] = [];
      await store.transaction(owned, async (snapshot) => {
        for (const path of selected) {
          try {
            const expected = await snapshot.indexGet("file-hashes", path);
            const raw = await snapshot.readFile(path);
            const actual = raw === null ? undefined : digest(raw);
            if (expected !== actual) changed.push(path);
          } catch {
            changed.push(path);
          }
        }
      });
      if (!changed.length) return;
      await atomicJson(
        join(store.root, "runtime/index-stale.json"),
        { paths: changed.slice(0, 20), total: changed.length },
        join(store.root, "runtime"),
        false,
        owned,
      );
      invariant(
        false,
        "STORAGE_INDEX_STALE",
        "Данные изменены вне Core. Выполните storage reindex и перечитайте записи",
        4,
        { paths: changed.slice(0, 20), total: changed.length },
      );
    });
  }

  async migrate(input: StorageMigrationOptions = {}) {
    const options = storageMigrationOptionsSchema.parse(input);
    if (await this.workspace.hasUnifiedStorage()) {
      return this.workspace.withEntityStorage(async (store, owned) => {
        const result = await store.migrateFormat(owned, options);
        await cleanupLegacyDirectories(dirname(this.workspace.configPath));
        return result;
      });
    }
    invariant(!options.orphanPlanning, "STORAGE_MIGRATION_CONFLICT", "Адресное разрешение planning events применимо только к единому хранилищу v1/v2 или проверке результата v3", 4);
    const result = await this.workspace.locked(async (owned) => {
      if (this.workspace.storageSession)
        return { migrated: false, format: "relay-entities", entities: 0 };
      const workspace = this.workspace,
        root = dirname(workspace.configPath);
      const sourceHashes = new Map<string, string>();
      const hashFile = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
      const initialPaths = [workspace.configPath];
      for (const directory of ["product", "boards", "task-activity", "relations", "entity-deletions"])
        initialPaths.push(...await jsonTree(join(root, directory)));
      if (await exists(join(root, "relations.json"))) initialPaths.push(join(root, "relations.json"));
      for (const path of initialPaths) sourceHashes.set(relative(root, path), await hashFile(path));
      const products = new ProductRepository(workspace);
      const productSource = await products.snapshot(owned, false);
      const boards = await new BoardRepository(workspace).all();
      const tasks = await new BoardTaskRepository(workspace).all();
      const graph = new GraphRepository(workspace);
      const graphSource = await graph.open(owned);
      const edges: GraphCurrent[] = [];
      for (const id of graphSource.index.entries.keys())
        edges.push((await graph.get(id, graphSource))!);
      const graphReceipts: { key: string; value: GraphReceipt }[] = [];
      for (const [key, value] of Object.entries(graphSource.legacy?.requests ?? {}))
        graphReceipts.push({ key, value });
      for (const file of await jsonTree(join(root, "relations/requests")))
        graphReceipts.push({
          key: file.slice(file.lastIndexOf("/") + 1, -5),
          value: graphReceiptSchema.parse(await readJson(file)),
        });
      const activity = new TaskActivityRepository(workspace);
      const activityFiles: ActivityFile[] = [];
      for (const path of await jsonTree(activity.root))
        activityFiles.push({
          path: relative(activity.root, path),
          value: await readJson(path, 16 * 1024 * 1024),
        });
      for (const task of tasks)
        if (!(await activity.hasHistory(task)))
          for (const event of legacyTaskEvents(task))
            activityFiles.push(...activity.eventFiles(event));
      const bindings = new Map<string, { owner: { kind: string; id: string }; slot: string }>();
      for (const record of productSource.records)
        if (record.fields.kind === "document")
          for (const binding of Object.values(
            await new DocumentLinksRepository(workspace).bindings(record.id),
          ))
            bindings.set(binding.id, {
              owner: { kind: "document", id: record.id },
              slot: "document-links",
            });
      const reserved = await new EntityDeletionRepository(workspace).reservedKeys();
      const deletionReceipts: { key: string; value: unknown }[] = [];
      for (const path of await jsonTree(join(root, "entity-deletions/receipts")))
        deletionReceipts.push({
          key: path.slice(path.lastIndexOf("/") + 1, -5),
          value: await readJson(path),
        });
      // Удаление адресно: посторонний JSON не становится источником только по расширению.
      const sources: string[] = [];
      for (const path of await products.migrationSources()) sources.push(relative(root, path));
      if (graphSource.legacy) sources.push("relations.json");
      for (const record of productSource.records) {
        if (await exists(join(products.root, products.path(record)))) sources.push(`product/${products.path(record)}`);
        if (record.fields.kind === "document") {
          const path = new DocumentLinksRepository(workspace).bindingPath(record.id);
          if (await exists(path)) sources.push(relative(root, path));
        }
      }
      for (const record of productSource.implementations.values())
        sources.push(`product/${products.implementationPath(record.fields.applicationId, { id: record.id, scenarioId: record.fields.scenarioId })}`);
      for (const board of boards) sources.push(`boards/${board.slug}/board.json`);
      for (const task of tasks) {
        const board = boards.find((entry) => entry.id === task.boardId)!;
        sources.push(`boards/${board.slug}/tasks/${task.id}.json`);
      }
      for (const file of activityFiles) if (await exists(join(activity.root, file.path))) sources.push(relative(root, join(activity.root, file.path)));
      if (!graphSource.legacy) {
        if (await exists(graph.path)) sources.push(relative(root, graph.path));
        for (const edge of edges) sources.push(`relations/${currentPath(edge.edge.id)}`);
        for (const receipt of graphReceipts) sources.push(`relations/${receiptPath(receipt.key)}`);
        for (let sequence = 1; sequence <= graphSource.meta.eventCount; sequence++) {
          const path = `relations/${eventPath(sequence)}`;
          graphStoredEventSchema.parse(await readJson(join(root, path)));
          sources.push(path);
        }
      }
      for (const receipt of deletionReceipts) sources.push(`entity-deletions/receipts/${receipt.key}.json`);
      if (await exists(join(root, "entity-deletions/keys.json"))) sources.push("entity-deletions/keys.json");
      const config = unified.json(await readJson(workspace.configPath)) as Record<string, unknown>;
      const settings = workspace.config.projectSettings ?? {
        version: 1 as const,
        ...projectSettings(workspace.config, workspace.configPath),
      };
      workspace.storageProductId = products.productId;
      await workspace.withEntityStorage(
        (store, migrationOwned) =>
          store.transaction(
            migrationOwned,
            (tx) =>
              workspace.inStorageSession(tx, migrationOwned, async () => {
                // Фиксируем исходный снимок до подготовки целевых записей, не принимая внешнюю правку за базу WAL.
                for (const path of new Set([...sources, relative(root, workspace.configPath)])) {
                  const expected = sourceHashes.get(path);
                  if (expected === undefined && !(await exists(join(root, path)))) continue;
                  const bytes = await readFile(join(root, path));
                  invariant(expected !== undefined && expected === createHash("sha256").update(bytes).digest("hex"),
                    "STORAGE_WRITE_CONFLICT", "Источник изменён во время извлечения legacy-базы", 5, { path });
                  tx.originals.set(path, unified.json(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))));
                }
                tx.originals.set("storage.json", null);
                await unified.saveSettings(workspace, settings, true);
                if (!productSource.records.some((record) => record.fields.kind === "passport")) {
                  const at = new Date().toISOString();
                  await tx.importRecord({
                    schemaVersion: 1,
                    dataVersion: 1,
                    kind: "product",
                    id: "passport",
                    key: "PRODUCT",
                    aliases: [],
                    revision: 0,
                    data: { name: "", summary: "", description: "" },
                    createdAt: at,
                    createdBy: "relay",
                    updatedAt: at,
                    updatedBy: "relay",
                  });
                }
                for (const record of productSource.records.filter(
                  (record) => record.fields.kind !== "scope",
                ))
                  await unified.saveProduct(workspace, record, true);
                for (const board of boards) await unified.saveBoard(workspace, board, true);
                for (const record of productSource.implementations.values())
                  await unified.saveImplementation(workspace, record, true);
                for (const record of productSource.records.filter(
                  (record) => record.fields.kind === "scope",
                ))
                  await unified.saveProduct(workspace, record, true);
                for (const task of tasks) await unified.saveTask(workspace, task, true);
                for (const key of reserved) await tx.reserveLegacyKey(key);
                await new TaskActivityRepository(workspace).publish(activityFiles, owned);
                for (const receipt of deletionReceipts)
                  await tx.saveCompatibilityReceipt(
                    { kind: "project", id: workspace.config.projectId ?? "project" },
                    "deletion-receipt", receipt.key, unified.json(receipt.value),
                  );
                for (const record of edges) {
                  const binding = bindings.get(record.edge.id) ?? {
                    owner: record.edge.from,
                    slot: "diagnostic",
                  };
                  await writeOwnedRelations(tx, binding.owner, [
                    {
                      slot: binding.slot,
                      edge: {
                        ...record.edge,
                        description: record.edge.description.split("\n"),
                        active: record.active,
                        historyCount: record.historyCount,
                        updatedAt: record.edge.createdAt,
                        updatedBy: record.edge.createdBy,
                      },
                    },
                  ]);
                }
                for (const receipt of graphReceipts)
                  await tx.saveCompatibilityReceipt({ kind: "project", id: workspace.config.projectId ?? "project" }, "graph-receipt", receipt.key, unified.json(receipt.value));
                for (const [kind, prefix] of [
                  ["feature", "FEATURE"],
                  ["scenario", "SCENARIO"],
                  ["document", "DOC"],
                ] as const)
                  await tx.saveKeySpace({
                    schemaVersion: 1,
                    id: `global-${kind}`,
                    entityKind: kind,
                    owner: { kind: "project", id: workspace.config.projectId ?? "project" },
                    prefix,
                    format: "{prefix}-{number}",
                  });
                // Это явный этап импорта продуктовых линков. Уже сохранённые ID прикреплений не заменяются.
                await syncProductRootRelations(workspace, "relay");
                await syncBoardRelations(workspace, boards, "relay");
                for (const record of productSource.records)
                  await syncProductRelations(workspace, record, "relay");
                await syncTaskRelations(workspace, tasks, "relay");
                await refreshEntityCards(workspace, owned);
                for (const path of new Set(sources)) if (sourceHashes.has(path)) await tx.writeFile(path, null);
                delete config.projectSettings;
                await tx.writeFile(relative(root, workspace.configPath), unified.json(config));
                await tx.writeFile("storage.json", {
                  format: "relay-entities",
                  schemaVersion: 3,
                  productId: products.productId,
                });
              }),
            true,
          ),
        true,
      );
      return {
        migrated: true,
        format: "relay-entities",
        entities:
          productSource.records.length +
          productSource.implementations.size +
          boards.length +
          tasks.length +
          1 +
          (productSource.records.some((record) => record.fields.kind === "passport") ? 0 : 1),
      };
    });
    await cleanupLegacyDirectories(dirname(this.workspace.configPath));
    return result;
  }
}

/** Удаляются только известный производный кеш и пустые прежние каталоги. */
async function cleanupLegacyDirectories(root: string) {
  await unlink(join(root, "runtime/history-writer.json")).catch((error: unknown) => {
    if (!isErrno(error, "ENOENT")) throw error;
  });
  await unlink(join(root, "product/.indexes/catalog.json")).catch((error: unknown) => {
    if (!isErrno(error, "ENOENT")) throw error;
  });
  const prune = async (path: string): Promise<void> => {
    if (!(await exists(path))) return;
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await prune(join(path, entry.name));
    await rmdir(path).catch((error: unknown) => {
      if (!isErrno(error, "ENOTEMPTY") && !isErrno(error, "ENOENT")) throw error;
    });
  };
  for (const name of ["boards", "tasks", "product", "operations", "history"]) await prune(join(root, name));
}

async function jsonTree(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".indexes") files.push(...(await jsonTree(path)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}
