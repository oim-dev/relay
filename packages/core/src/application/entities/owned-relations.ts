import type { Workspace } from "../../storage/workspace.js";
import type { ProductRecord, ProductContract } from "../../domain/product.js";
import type { ProductImplementation } from "../../domain/product-implementation.js";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import type { Board } from "../../domain/board.js";
import { ProductRepository } from "../../storage/product.js";
import { BoardRepository } from "../../storage/boards.js";
import { replaceOwnedRelations } from "../../storage/entity-store/relations.js";
import type { DesiredRelation } from "../../storage/entity-store/relations.js";
import { invariant } from "../../shared/errors.js";

/** Общий получатель предметной группы: запись либо read-only сравнение желаемого набора. */
export type RelationSink = typeof replaceOwnedRelations;

/** Сохраняет обязательную принадлежность единственного продукта проекту, включая пустой паспорт. */
export async function syncProductRootRelations(
  workspace: Workspace,
  actor: string,
  sink: RelationSink = replaceOwnedRelations,
): Promise<void> {
  const tx = workspace.storageSession;
  if (!tx) return;
  const owner = { kind: "product", id: "passport" };
  await sink(
    tx,
    owner,
    "product-links",
    [
      {
        type: "part-of",
        from: owner,
        to: { kind: "project", id: workspace.config.projectId ?? "project" },
        description: "",
      },
    ],
    actor,
  );
}

export async function syncTaskRelations(
  workspace: Workspace,
  tasks: readonly BoardTaskRecord[],
  actor?: string,
  sink: RelationSink = replaceOwnedRelations,
) {
  const tx = workspace.storageSession;
  if (!tx) return;
  for (const task of tasks) {
    const owner = { kind: "task", id: task.id };
    const links: DesiredRelation[] = [
      { type: "part-of", from: owner, to: { kind: "board", id: task.boardId }, description: "" },
      ...task.productLinks.map((to) => ({ type: "implements", from: owner, to, description: "" })),
      ...task.dependencies.map((id) => ({
        type: "depends-on",
        from: owner,
        to: { kind: "task", id },
        description: "",
      })),
      ...task.related.map((id) => ({
        type: "related",
        from: owner,
        to: { kind: "task", id },
        description: "",
      })),
      ...(task.parentId
        ? [
            {
              type: "part-of",
              from: owner,
              to: { kind: "task", id: task.parentId },
              description: "",
            },
          ]
        : []),
    ];
    await sink(tx, owner, "task-links", links, actor ?? task.updatedBy);
  }
}

export async function syncBoardRelations(
  workspace: Workspace,
  boards: readonly Board[],
  actor?: string,
  sink: RelationSink = replaceOwnedRelations,
) {
  if (!workspace.storageSession) return;
  for (const board of boards) {
    const owner = { kind: "board", id: board.id };
    await sink(
      workspace.storageSession,
      owner,
      "board-links",
      board.applicationId
        ? [
            {
              type: "part-of",
              from: owner,
              to: { kind: "application", id: board.applicationId },
              description: "",
            },
          ]
        : [],
      actor ?? board.createdBy,
    );
  }
}

export async function syncImplementationRelations(
  workspace: Workspace,
  record: ProductImplementation,
  actor?: string,
  contracts?: readonly ProductContract[],
  sink: RelationSink = replaceOwnedRelations,
) {
  if (!workspace.storageSession) return;
  const owner = { kind: "implementation", id: record.id };
  let parentId: string | undefined;
  if (record.fields.scenarioId !== null) {
    const scope =
      contracts ??
      (await new ProductRepository(workspace).all()).flatMap((entry) =>
        entry.fields.kind === "scope" && entry.fields.applicationId === record.fields.applicationId
          ? entry.fields.contracts
          : [],
      );
    parentId = scope.find(
      (entry) => entry.featureId === record.fields.featureId && entry.scenarioId === null,
    )?.id;
    invariant(
      parentId || !record.fields.active,
      "INVALID_REFERENCE",
      "У активной сценарной реализации отсутствует реализация фичи",
      4,
    );
  }
  await sink(
    workspace.storageSession,
    owner,
    "implementation-links",
    [
      {
        type: "part-of",
        from: owner,
        to: { kind: "application", id: record.fields.applicationId },
        description: "",
      },
      {
        type: "implements",
        from: owner,
        to: record.fields.scenarioId
          ? { kind: "scenario", id: record.fields.scenarioId }
          : { kind: "feature", id: record.fields.featureId },
        description: "",
      },
      ...(parentId
        ? [
            {
              type: "part-of",
              from: owner,
              to: { kind: "implementation", id: parentId },
              description: "",
            },
          ]
        : []),
    ],
    actor ?? record.updatedBy,
  );
}

export async function syncProductRelations(
  workspace: Workspace,
  record: ProductRecord,
  actor?: string,
  sink: RelationSink = replaceOwnedRelations,
) {
  const tx = workspace.storageSession;
  if (!tx) return;
  const fields = record.fields;
  if (fields.kind === "passport" || fields.kind === "feature")
    await syncProductRootRelations(workspace, actor ?? record.updatedBy, sink);
  if (fields.kind === "feature") {
    const owner = { kind: "feature", id: record.id };
    await sink(
      tx,
      owner,
      "feature-links",
      [{ type: "part-of", from: owner, to: { kind: "product", id: "passport" }, description: "" }],
      actor ?? record.updatedBy,
    );
  } else if (fields.kind === "scenario") {
    const owner = { kind: "scenario", id: record.id };
    await sink(
      tx,
      owner,
      "scenario-links",
      [
        {
          type: "part-of",
          from: owner,
          to: { kind: "feature", id: fields.featureId },
          description: "",
        },
      ],
      actor ?? record.updatedBy,
    );
  } else if (fields.kind === "document") {
    const owner = { kind: "document", id: record.id };
    await sink(
      tx,
      owner,
      "document-links",
      [
        ...fields.links.map((link) => ({
          type: "documents",
          from: owner,
          to: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
          description: "",
        })),
        ...(fields.relations ?? []).map((link) => ({
          type: link.type,
          from: link.type === "references" ? link.target : owner,
          to: link.type === "references" ? owner : link.target,
          description: link.description,
        })),
      ],
      actor ?? record.updatedBy,
    );
  } else if (fields.kind === "scope") {
    const repository = new ProductRepository(workspace);
    for (const contract of fields.contracts)
      await syncImplementationRelations(
        workspace,
        await repository.implementation(
          fields.applicationId,
          contract.id,
          contract.scenarioId !== null,
        ),
        actor,
        fields.contracts,
        sink,
      );
  } else if (fields.kind === "application") {
    await syncBoardRelations(
      workspace,
      (await new BoardRepository(workspace).all()).filter(
        (board) => board.applicationId === record.id,
      ),
      actor,
      sink,
    );
  }
}
