import {
  deleteEntitySchema,
  entityDeletionQuerySchema,
  entityDeletionPreviewSchema,
} from "@relay/contracts/entities";
import type {
  DeleteEntity,
  EntityDeleted,
  EntityDeletionQuery,
  EntityDeletionPreview,
} from "@relay/contracts/entities";
import { actorSchema } from "@relay/contracts/primitives";
import { ProductRepository, PRODUCT_DIRECTORIES } from "../../storage/product.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { BoardRepository } from "../../storage/boards.js";
import { GraphRepository } from "../../storage/graph.js";
import { TaskActivityRepository } from "../../storage/task-activity.js";
import { EntityDeletionRepository } from "../../storage/entity-deletion.js";
import type { DeletionFile } from "../../storage/entity-deletion.js";
import type { Workspace } from "../../storage/workspace.js";
import type { GraphCurrent } from "../../storage/graph-format.js";
import { invariant } from "../../shared/errors.js";
import { parse } from "../../domain/validation.js";
import {
  entityAddress,
  entityDigest,
  entitySummary,
  readEntityCatalog,
  resolveEntity,
} from "./catalog.js";
import { validateProduct } from "../product/model.js";
import type { ProductRecord } from "../../domain/product.js";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import { syncProductRelations, syncTaskRelations } from "./owned-relations.js";
import { json } from "../../storage/unified-adapter.js";

const detachProduct = (
  record: ProductRecord,
  has: (kind: string, id: string | null) => boolean,
): ProductRecord => {
  const next = structuredClone(record);
  if (next.fields.kind === "document") {
    next.fields.links = next.fields.links.filter(
      (link) => link.kind === "product" || !has(link.kind, link.id),
    );
    if (next.fields.relations)
      next.fields.relations = next.fields.relations.filter(
        (link) => !has(link.target.kind, link.target.id),
      );
  }
  if (next.fields.kind === "scope")
    next.fields.contracts = next.fields.contracts.filter(
      (entry) => !has("implementation", entry.id),
    );
  return next;
};
const detachTask = (
  task: BoardTaskRecord,
  has: (kind: string, id: string | null) => boolean,
): BoardTaskRecord => ({
  ...structuredClone(task),
  dependencies: task.dependencies.filter((id) => !has("task", id)),
  related: task.related.filter((id) => !has("task", id)),
  parentId: has("task", task.parentId) ? null : task.parentId,
  productLinks: task.productLinks.filter((link) => !has(link.kind, link.id)),
});

/** Каскад принадлежности и очистка внешних ссылок — общий сценарий для всех интерфейсов. */
export class EntityDeletionService {
  constructor(readonly workspace: Workspace) {}

  private async snapshot(input: EntityDeletionQuery, owned: () => void) {
    const catalog = await readEntityCatalog(this.workspace, owned);
    const target = resolveEntity(catalog, input.ref, input.kind);
    const deleted = new Set([entityAddress(target.ref)]);
    const has = (kind: string, id: string | null): boolean =>
      id !== null && deleted.has(`${kind}:${id}`);
    // Принадлежность не равна произвольной связи: документы и внешние задачи не входят в каскад.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of catalog.entries) {
        const data = entry.data;
        const isChild =
          (data.kind === "scenario" && has("feature", data.featureId)) ||
          (data.kind === "board" && has("application", data.applicationId)) ||
          (data.kind === "task" && has("board", data.boardId)) ||
          (data.kind === "implementation" &&
            (has("application", data.applicationId) ||
              has("feature", data.featureId) ||
              has("scenario", data.scenarioId) ||
              (target.data.kind === "implementation" &&
                target.data.scenarioId === null &&
                target.data.applicationId === data.applicationId &&
                target.data.featureId === data.featureId)));
        if (isChild && !deleted.has(entityAddress(entry.ref))) {
          deleted.add(entityAddress(entry.ref));
          expanded = true;
        }
      }
    }
    for (const entry of catalog.entries) {
      const data = entry.data;
      if (data.kind === "work-plan")
        invariant(
          !data.stages.some((stage) => stage.taskIds.some((id) => has("task", id))),
          "PLANNING_REFERENCE_IN_USE",
          `Удаление затрагивает задачи плана ${entry.key}. Сначала явно пересмотрите его состав.`,
          4,
        );
      if (data.kind === "work-plan")
        invariant(
          !data.scope.some((ref) => has(ref.kind, ref.id)),
          "PLANNING_REFERENCE_IN_USE",
          `Область используется планом ${entry.key}. Сначала явно пересмотрите область плана.`,
          4,
        );
    }
    const detached = new Set<string>();
    for (const entry of catalog.entries) {
      if (deleted.has(entityAddress(entry.ref))) continue;
      const data = entry.data;
      const isDetached =
        (data.kind === "document" &&
          (data.links.some((link) => link.kind !== "product" && has(link.kind, link.id)) ||
            data.relations?.some((link) => has(link.target.kind, link.target.id)))) ||
        (data.kind === "task" &&
          (has("task", data.parentId) ||
            [...data.dependencies, ...data.related].some((id) => has("task", id)) ||
            data.productLinks.some((link) => has(link.kind, link.id)) ||
            catalog.entries.some(
              (other) =>
                other.data.kind === "task" &&
                deleted.has(entityAddress(other.ref)) &&
                (other.data.parentId === entry.ref.id ||
                  other.data.dependencies.includes(entry.ref.id) ||
                  other.data.related.includes(entry.ref.id)),
            )));
      if (isDetached) detached.add(entityAddress(entry.ref));
    }
    const graph = new GraphRepository(this.workspace);
    const graphState = await graph.open(owned);
    invariant(
      !graphState.legacy,
      "GRAPH_MIGRATION_REQUIRED",
      "Перед удалением выполните миграцию графа",
      4,
    );
    const edges = graphState.index.active.filter(
      (edge) => deleted.has(entityAddress(edge.from)) || deleted.has(entityAddress(edge.to)),
    );
    for (const edge of edges) {
      for (const endpoint of [edge.from, edge.to]) {
        if (!deleted.has(entityAddress(endpoint))) detached.add(entityAddress(endpoint));
      }
    }
    invariant(
      deleted.size <= 1000 && detached.size <= 1000,
      "RESPONSE_TOO_LARGE",
      "Состав удаления превышает 1000 записей; удалите дочерние сущности отдельно",
      4,
    );
    const preview = entityDeletionPreviewSchema.parse({
      target: entitySummary(target),
      version: entityDigest([
        target.ref,
        catalog.version,
        graphState.meta,
        await new TaskActivityRepository(this.workspace).signal(),
      ]),
      deleted: catalog.entries
        .filter((entry) => deleted.has(entityAddress(entry.ref)))
        .map(entitySummary),
      detached: catalog.entries
        .filter((entry) => detached.has(entityAddress(entry.ref)))
        .map(entitySummary),
      relations: edges.length,
    });
    return { preview, has, graph, graphState, edges, catalog };
  }

  async preview(input: EntityDeletionQuery): Promise<EntityDeletionPreview> {
    const query = parse(entityDeletionQuerySchema, input, "предпросмотр удаления");
    return this.workspace.locked(async (owned) => (await this.snapshot(query, owned)).preview);
  }

  async delete(input: DeleteEntity, defaultActor: string): Promise<EntityDeleted> {
    const command = parse(deleteEntitySchema, input, "удаление сущности");
    const actor = parse(actorSchema, command.actor ?? defaultActor, "автор удаления");
    const key = entityDigest([actor, command.requestId]);
    const hash = entityDigest({ ...command, actor });
    return this.workspace.mutate("entity-delete", command, actor, async (owned) => {
      const repository = new EntityDeletionRepository(this.workspace);
      const receipt = await repository.receipt(key);
      if (receipt) {
        invariant(
          receipt.hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "Ключ удаления использован с другим содержимым",
          4,
        );
        return receipt.result;
      }
      const { preview, has, graph, graphState, edges, catalog } = await this.snapshot(
        command,
        owned,
      );
      invariant(
        command.ifVersion === preview.version,
        "REVISION_CONFLICT",
        "Состав удаления изменился. Обновите предпросмотр и подтвердите его заново",
        4,
      );
      if (this.workspace.storageSession)
        return this.deleteUnified(preview, has, actor, key, hash, command.requestId, owned);
      const products = new ProductRepository(this.workspace);
      const beforeProducts = await products.all();
      const beforeTasks = await new BoardTaskRepository(this.workspace).all();
      const boards = await new BoardRepository(this.workspace).all();
      const files = new Map<string, DeletionFile>();
      const add = (file: DeletionFile): void => {
        files.set(file.path, file);
      };
      const at = new Date().toISOString();
      const afterProducts = [];
      for (const record of beforeProducts) {
        const fields = record.fields;
        const isDeleted =
          has(fields.kind, record.id) ||
          (fields.kind === "scope" && has("application", fields.applicationId));
        if (isDeleted) {
          if (fields.kind === "document")
            add({ path: `product/.document-links/${record.id}.json`, after: null });
          for (const path of new Set([
            products.path(record),
            `${PRODUCT_DIRECTORIES[fields.kind]}/${record.id}.json`.replace(/^\//, ""),
            `${record.id}.json`,
          ]))
            add({ path: `product/${path}`, after: null });
          if (fields.kind === "application")
            for (const file of await repository.files(`product/applications/${record.id}`))
              add(file);
          continue;
        }
        const next = detachProduct(record, has);
        if (record.fields.kind === "scope") {
          for (const contract of record.fields.contracts.filter((entry) =>
            has("implementation", entry.id),
          ))
            add({
              path: `product/${products.implementationPath(record.fields.applicationId, contract)}`,
              after: null,
            });
        }
        if (JSON.stringify(next.fields) !== JSON.stringify(record.fields)) {
          next.revision++;
          next.updatedAt = at;
          next.updatedBy = actor;
          next.events.push({ revision: next.revision, actor, at });
          for (const file of await products.prepare(next))
            add({ ...file, path: `product/${file.path}` });
        }
        afterProducts.push(next);
      }
      validateProduct(afterProducts);
      const afterTasks = beforeTasks
        .filter((task) => !has("task", task.id))
        .map((task) => {
          const next = detachTask(task, has);
          if (JSON.stringify(next) !== JSON.stringify(task)) {
            next.revision++;
            next.updatedAt = at;
            next.updatedBy = actor;
          }
          return next;
        });
      for (const next of afterTasks) {
        const previous = beforeTasks.find((task) => task.id === next.id);
        if (JSON.stringify(next) === JSON.stringify(previous)) continue;
        const board = boards.find((entry) => entry.id === next.boardId);
        invariant(board, "INVALID_DATA", "Доска задачи не найдена", 5);
        const prepared = new BoardTaskRepository(this.workspace).prepare(
          [{ slug: board.slug, task: next }],
          [],
        );
        add({
          path: `boards/${board.slug}/tasks/${next.id}.json`,
          after: prepared.writes[0]?.task,
        });
      }
      for (const task of beforeTasks.filter((entry) => has("task", entry.id))) {
        const board = boards.find((entry) => entry.id === task.boardId);
        invariant(board, "INVALID_DATA", "Доска задачи не найдена", 5);
        add({ path: `boards/${board.slug}/tasks/${task.id}.json`, after: null });
        for (const file of await repository.files(`task-activity/${task.id}`)) add(file);
      }
      const deletedBoards = boards.filter((board) => has("board", board.id));
      for (const board of deletedBoards)
        for (const file of await repository.files(`boards/${board.slug}`)) add(file);
      const graphRecords: GraphCurrent[] = [];
      for (const edge of edges) {
        const existing = await graph.get(edge.id, graphState);
        invariant(existing, "INVALID_DATA", "Не найдена удаляемая связь", 5);
        graphRecords.push({
          ...existing,
          active: false,
          historyCount: existing.historyCount + 1,
          edge: { ...existing.edge, revision: existing.edge.revision + 1 },
        });
      }
      if (graphRecords.length > 0) {
        const prepared = await graph.prepareCommit(
          graphState,
          graphRecords,
          graphRecords.map((record) => ({
            action: "remove",
            edge: record.edge,
            actor,
            at,
            revision: graphState.meta.revision + 1,
          })),
          key,
          hash,
          (version, revision) => ({
            ids: edges.map((edge) => edge.id),
            version,
            revision,
            requestId: command.requestId,
          }),
        );
        for (const file of prepared.changes) add({ ...file, path: `relations/${file.path}` });
      }
      const result: EntityDeleted = {
        action: "delete",
        ref: preview.target.ref,
        requestId: command.requestId,
        deleted: preview.deleted.length,
        detached: preview.detached.length,
        relations: preview.relations,
      };
      add({
        path: "entity-deletions/keys.json",
        after: [
          ...new Set([
            ...catalog.reservedKeys,
            ...catalog.entries
              .filter((entry) => has(entry.ref.kind, entry.ref.id))
              .flatMap((entry) => [entry.key, ...entry.aliases]),
          ]),
        ].sort(),
      });
      add({ path: `entity-deletions/receipts/${key}.json`, after: { hash, result } });
      await repository.publish(
        [...files.values()],
        deletedBoards.map((board) => `boards/${board.slug}`),
        owned,
      );
      return result;
    });
  }

  private async deleteUnified(
    preview: EntityDeletionPreview,
    has: (kind: string, id: string | null) => boolean,
    actor: string,
    key: string,
    hash: string,
    requestId: string,
    owned: () => void,
  ): Promise<EntityDeleted> {
    const session = this.workspace.storageSession!;
    const products = new ProductRepository(this.workspace);
    const beforeProducts = await products.all();
    const taskRepository = new BoardTaskRepository(this.workspace);
    const beforeTasks = await taskRepository.all();
    const boards = await new BoardRepository(this.workspace).all();
    const at = new Date().toISOString();
    const removed = [...preview.deleted.map((entry) => ({ ...entry.ref }))] as {
      kind: string;
      id: string;
    }[];
    const afterProducts: ProductRecord[] = [];
    for (const record of beforeProducts) {
      if (has(record.fields.kind, record.id)) continue;
      if (record.fields.kind === "scope" && has("application", record.fields.applicationId)) {
        removed.push({ kind: "scope", id: record.id });
        continue;
      }
      const next = detachProduct(record, has);
      if (JSON.stringify(next.fields) !== JSON.stringify(record.fields)) {
        next.revision++;
        next.updatedAt = at;
        next.updatedBy = actor;
        next.events.push({ revision: next.revision, actor, at });
        await products.save(next, false, owned);
        await syncProductRelations(this.workspace, next);
      }
      afterProducts.push(next);
    }
    validateProduct(afterProducts);
    const afterTasks = beforeTasks
      .filter((task) => !has("task", task.id))
      .map((task) => {
        const next = detachTask(task, has);
        if (JSON.stringify(next) !== JSON.stringify(task)) {
          next.revision++;
          next.updatedAt = at;
          next.updatedBy = actor;
        }
        return next;
      });
    const changed = afterTasks.filter(
      (task) =>
        JSON.stringify(task) !== JSON.stringify(beforeTasks.find((entry) => entry.id === task.id)),
    );
    await taskRepository.save(
      changed.map((task) => ({
        slug: boards.find((board) => board.id === task.boardId)!.slug,
        task,
      })),
      [],
      owned,
      [],
    );
    await syncTaskRelations(this.workspace, changed);
    const graph = new GraphRepository(this.workspace),
      state = await graph.open(owned);
    const edges = state.index.active.filter(
      (edge) => has(edge.from.kind, edge.from.id) || has(edge.to.kind, edge.to.id),
    );
    const records: GraphCurrent[] = [];
    for (const edge of edges) {
      const current = (await graph.get(edge.id, state))!;
      records.push({
        active: false,
        historyCount: current.historyCount + 1,
        edge: { ...current.edge, revision: current.edge.revision + 1 },
      });
    }
    if (records.length)
      await graph.commit(
        state,
        records,
        records.map((record) => ({
          action: "remove",
          edge: record.edge,
          actor,
          at,
          revision: state.meta.revision + 1,
        })),
        key,
        hash,
        (version, revision) => ({
          ids: records.map((record) => record.edge.id),
          version,
          revision,
          requestId,
        }),
        owned,
      );
    for (const ref of removed) {
      const record = await session.get(ref);
      await session.remove(ref, record.revision, actor);
    }
    const result: EntityDeleted = {
      action: "delete",
      ref: preview.target.ref,
      requestId,
      deleted: preview.deleted.length,
      detached: preview.detached.length,
      relations: preview.relations,
    };
    session.setCommandOwner(result.ref);
    await session.saveCompatibilityReceipt(result.ref, "deletion-receipt", key, json({ hash, result }));
    return result;
  }
}
