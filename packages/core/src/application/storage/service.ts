import { join, relative } from "node:path";
import type { Workspace } from "../../storage/workspace.js";
import { ProductRepository } from "../../storage/product.js";
import { BoardRepository } from "../../storage/boards.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { GraphRepository } from "../../storage/graph.js";
import { exists } from "../../storage/files.js";
import * as unified from "../../storage/unified-adapter.js";
import {
  syncBoardRelations,
  syncProductRelations,
  syncProductRootRelations,
  syncTaskRelations,
} from "../entities/owned-relations.js";
import { refreshEntityCards } from "../entities/storage-projection.js";
import { invariant } from "../../shared/errors.js";
import { GraphService } from "../graph/service.js";
import { atomicJson } from "../../storage/files.js";
import { digest, jsonValue } from "../../storage/entity-store/format.js";
import { actorSchema, requestIdSchema } from "@relay/contracts/primitives";
import { validateProduct } from "../product/model.js";
import { planningRecords } from "../../storage/planning.js";
import { syncPlanRelations } from "../planning/relations.js";
import { syncReleaseRelations } from "../releases/relations.js";
import { storageMigrateOptionsSchema } from "@relay/contracts/storage-maintenance";
import type { StorageMigrateOptions } from "@relay/contracts/storage-maintenance";
import { currentManifest } from "../../storage/data-model/manifest.js";
import { migrateStorage } from "./maintenance.js";
/** Параметры `migrate`: `backupDir` и `ifPlan` по схеме Contracts. */
export type StorageMigrationOptions = StorageMigrateOptions;

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
            // Новая база сразу получает маркер текущего профиля модели данных.
            await tx.writeFile(
              "storage.json",
              jsonValue(currentManifest(workspace.storageProductId!)),
            );
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

  /**
   * Явный перенос: тонкая обёртка над `migrateStorage` (одна реализация с CLI и runner).
   * Любая поддерживаемая раскладка и профиль идут через исполнитель модели данных: план,
   * backup (`backupDir` обязателен для изменяющего переноса), одна публикация WAL.
   */
  async migrate(input: StorageMigrateOptions = {}) {
    return migrateStorage(
      { configPath: this.workspace.configPath },
      storageMigrateOptionsSchema.parse(input),
    );
  }
}
