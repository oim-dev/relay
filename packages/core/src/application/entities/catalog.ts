import { createHash } from "node:crypto";
import type {
  EntityData,
  EntityDetail,
  EntityKind,
  EntityMetadata,
  EntitySummary,
} from "@relay/contracts/entities";
import { ProductRepository } from "../../storage/product.js";
import { BoardRepository } from "../../storage/boards.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { productState, validateProduct } from "../product/model.js";
import { resolveAddress } from "./resolver.js";
import { EntityDeletionRepository } from "../../storage/entity-deletion.js";
import { documentEntityEntry, documentMetadata } from "../documents/projection.js";
import { planningRecords } from "../../storage/planning.js";
import { projectEntityEntry, readEntityConfig } from "./project.js";
import { boardEntityEntry } from "./board.js";

export type EntityEntry = Omit<EntityDetail, "references" | "metadata"> & {
  aliases: string[];
  selectors: string[];
  filters: Record<string, string | string[] | null>;
};
export type EntityCatalog = {
  entries: EntityEntry[];
  version: string;
  reservedKeys: string[];
  /** Не входит в entries/version и производные карточки. */
  metadata?: ReadonlyMap<string, EntityMetadata>;
};
export const entityAddress = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;
export const entityDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const entitySummary = ({
  ref,
  key,
  title,
  summary,
  revision,
  status,
  active,
  context,
  document,
}: EntitySummary): EntitySummary => ({
  ref,
  key,
  title,
  summary,
  revision,
  status,
  active,
  ...(context === undefined ? {} : { context }),
  ...(document === undefined ? {} : { document }),
});

/** Разрешает назначенный адрес; строковый префикс никогда не определяет владельца записи. */
export function resolveEntity(
  catalog: EntityCatalog,
  input: string,
  expected?: EntityKind | readonly EntityKind[],
): EntityEntry {
  return resolveAddress(catalog.entries, input, expected);
}

/** Проверяет также алиасы, чтобы переименование не передало прежний адрес другой записи. */
export function assertEntityKeyAvailable(
  catalog: EntityCatalog,
  key: string,
  own?: { kind: string; id: string },
) {
  invariant(
    !catalog.reservedKeys.includes(key) &&
      !catalog.entries.some(
        (entry) =>
          (!own || entityAddress(entry.ref) !== entityAddress(own)) &&
          (entry.key === key || entry.aliases.includes(key) || entry.ref.id === key),
      ),
    "ENTITY_KEY_CONFLICT",
    "Ключ занят или сохранён как прежний адрес другой сущности",
    4,
  );
}

/** Каталог девяти видов под общей блокировкой; владельцы сохраняют единственные предметные записи. */
export async function readEntityCatalog(
  workspace: Workspace,
  owned: () => void,
): Promise<EntityCatalog> {
  const config = await readEntityConfig(workspace);
  const repository = new ProductRepository(workspace);
  const source = await repository.snapshot(owned);
  validateProduct(source.records);
  const boards = await new BoardRepository(workspace).all();
  const tasks = await new BoardTaskRepository(workspace).all();
  const state = productState(repository.productId, source.records, tasks);
  const entries: EntityEntry[] = [];
  const metadata = new Map<string, EntityMetadata>();
  const add = (
    kind: EntityKind,
    id: string,
    key: string,
    title: string,
    summary: string,
    revision: number,
    data: EntityData,
    options: Partial<
      Pick<
        EntityEntry,
        "aliases" | "selectors" | "filters" | "status" | "active" | "document" | "context"
      >
    > = {},
  ) => {
    entries.push({
      ref: { kind, id },
      key,
      title,
      summary,
      revision,
      data,
      aliases: [],
      selectors: [],
      filters: {},
      status: null,
      active: true,
      ...options,
    });
  };
  entries.push(projectEntityEntry(config, workspace.configPath));
  if (!source.records.some((record) => record.fields.kind === "passport"))
    add(
      "product",
      "passport",
      "PRODUCT",
      "Продукт (паспорт не заполнен)",
      "",
      0,
      { kind: "product", name: "", summary: "", description: "" },
      { status: "uninitialized" },
    );
  for (const record of state.records) {
    const fields = record.fields;
    if (fields.kind === "document") {
      entries.push(
        documentEntityEntry({ ...record, fields }, config.projectSettings?.documentSections),
      );
      metadata.set(`document:${record.id}`, documentMetadata(record));
      continue;
    }
    if (fields.kind === "scope") {
      for (const contract of fields.contracts) {
        const stored = source.implementations.get(contract.id);
        add(
          "implementation",
          contract.id,
          contract.key ?? contract.id,
          contract.title,
          "",
          contract.revision ?? record.revision,
          {
            kind: "implementation",
            applicationId: fields.applicationId,
            featureId: contract.featureId,
            scenarioId: contract.scenarioId,
            title: contract.title,
            description: contract.description,
            status: contract.status,
            active: contract.active,
            basis: contract.basis,
          },
          {
            aliases: stored?.reservedKeys ?? [],
            status: contract.active ? contract.status : "inactive",
            active: contract.active,
            filters: {
              application: fields.applicationId,
              feature: contract.featureId,
              scenario: contract.scenarioId,
              target: contract.scenarioId ?? contract.featureId,
            },
          },
        );
      }
      continue;
    }
    const kind = fields.kind === "passport" ? "product" : fields.kind;
    const readiness = state.readiness.find((entry) => entry.id === record.id);
    add(
      kind,
      record.id,
      record.key ?? record.id,
      fields.name,
      "summary" in fields ? fields.summary : "",
      record.revision,
      fields.kind === "passport" ? { ...fields, kind: "product" } : fields,
      {
        aliases: record.reservedKeys ?? [],
        status: readiness?.status ?? null,
        filters: fields.kind === "scenario" ? { feature: fields.featureId } : {},
      },
    );
  }
  for (const board of boards) {
    const app = state.records.find((record) => record.id === board.applicationId);
    const name =
      app?.fields.kind === "application"
        ? app.fields.name
        : board.kind === "product"
          ? "Продукт"
          : "Инфраструктура";
    entries.push(boardEntityEntry(board, name));
  }
  for (const task of tasks) {
    const board = boards.find((entry) => entry.id === task.boardId);
    const {
      version: _version,
      id: _id,
      key: _key,
      keys: _keys,
      revision: _revision,
      requests: _requests,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      events: _events,
      acceptanceCriteria: _acceptanceCriteria,
      ...data
    } = task;
    add(
      "task",
      task.id,
      task.key,
      task.title || "Без названия",
      "",
      task.revision,
      { ...data, kind: "task" },
      {
        aliases: task.keys.filter((key) => key !== task.key),
        status: task.column,
        filters: {
          board: task.boardId,
          application: board?.applicationId ?? null,
          parent: task.parentId,
          target: task.productLinks.map((link) => link.id),
        },
      },
    );
  }
  if (workspace.storageSession) {
    for (const kind of ["work-plan", "release"] as const) {
      for (const record of await planningRecords(workspace, kind)) {
        const {
          id,
          key,
          revision,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          createdBy: _createdBy,
          updatedBy: _updatedBy,
          ...data
        } = record;
        add(kind, id, key, record.title, record.summary, revision, data, {
          status: "status" in record ? record.status : null,
        });
      }
    }
  }
  for (const entry of entries) {
    const data = entry.data;
    const parentId =
      data.kind === "implementation"
        ? data.applicationId
        : data.kind === "task"
          ? data.boardId
          : data.kind === "scenario"
            ? data.featureId
            : null;
    const parent = entries.find((candidate) => candidate.ref.id === parentId);
    if (parent) entry.context = `${parent.key} · ${parent.title}`;
  }
  entries.sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref)));
  const reservedKeys = await new EntityDeletionRepository(workspace).reservedKeys();
  return { entries, reservedKeys, version: entityDigest([entries, reservedKeys]), metadata };
}
