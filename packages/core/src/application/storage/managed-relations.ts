import { entityAddress } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { Workspace } from "../../storage/workspace.js";
import { ProductRepository } from "../../storage/product.js";
import { BoardRepository } from "../../storage/boards.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { planningRecords } from "../../storage/planning.js";
import { readOwned } from "../../storage/entity-store/relations.js";
import type { DesiredRelation } from "../../storage/entity-store/relations.js";
import { AppError } from "../../shared/errors.js";
import {
  syncProductRootRelations,
  syncProductRelations,
  syncBoardRelations,
  syncTaskRelations,
} from "../entities/owned-relations.js";
import type { RelationSink } from "../entities/owned-relations.js";
import { syncPlanRelations } from "../planning/relations.js";
import { syncReleaseRelations } from "../releases/relations.js";

const signature = (edge: DesiredRelation) =>
  JSON.stringify([edge.type, entityAddress(edge.from), entityAddress(edge.to)]);

/** Тот же предметный набор, что у явного reconcile, но получатель только собирает ожидания. */
export async function checkManagedRelations(workspace: Workspace): Promise<AppError[]> {
  const groups = new Map<
    string,
    { owner: EntityRef; slot: string; desired: readonly DesiredRelation[] }
  >();
  const collect: RelationSink = async (_session, owner, slot, desired) => {
    groups.set(JSON.stringify([entityAddress(owner), slot]), { owner, slot, desired });
    return [];
  };
  const actor = "relay";
  await syncProductRootRelations(workspace, actor, collect);
  await syncBoardRelations(workspace, await new BoardRepository(workspace).all(), actor, collect);
  for (const record of await new ProductRepository(workspace).all())
    await syncProductRelations(workspace, record, actor, collect);
  await syncTaskRelations(
    workspace,
    await new BoardTaskRepository(workspace).all(),
    actor,
    collect,
  );
  for (const plan of await planningRecords(workspace, "work-plan"))
    await syncPlanRelations(workspace, plan, actor, collect);
  for (const release of await planningRecords(workspace, "release"))
    await syncReleaseRelations(workspace, release, actor, collect);

  const tx = workspace.storageSession!;
  const owned = new Map<string, Awaited<ReturnType<typeof readOwned>>>();
  const failures: AppError[] = [];
  for (const { owner, slot, desired } of groups.values()) {
    const address = entityAddress(owner);
    if (!owned.has(address)) owned.set(address, await readOwned(tx, owner));
    const actual = owned
      .get(address)!
      .entries.filter((entry) => entry.slot === slot && entry.edge.active);
    const remaining = new Map<string, typeof actual>();
    for (const entry of actual) {
      const key = signature({ ...entry.edge, description: entry.edge.description.join("\n") });
      const candidates = remaining.get(key) ?? [];
      candidates.push(entry);
      remaining.set(key, candidates);
    }
    const missing: DesiredRelation[] = [];
    const drift: { id: string; expected: string; actual: string }[] = [];
    for (const wanted of desired) {
      const candidates = remaining.get(signature(wanted));
      // Параллельные связи — мультимножество, а не Set по концам.
      const exact =
        candidates?.findIndex(
          (entry) => entry.edge.description.join("\n") === wanted.description,
        ) ?? -1;
      const found = candidates?.splice(exact < 0 ? 0 : exact, 1)[0];
      if (!found) missing.push(wanted);
      else if (found.edge.description.join("\n") !== wanted.description)
        drift.push({
          id: found.edge.id,
          expected: wanted.description,
          actual: found.edge.description.join("\n"),
        });
    }
    const extra = [...remaining.values()].flat().map(({ edge }) => ({
      id: edge.id,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      description: edge.description.join("\n"),
    }));
    if (missing.length || extra.length || drift.length)
      failures.push(
        new AppError(
          "MANAGED_RELATIONS_MISMATCH",
          "Управляемые отношения расходятся с предметными ссылками",
          5,
          {
            path: `relations/${tx.store.registry.definition(owner.kind).collection}/${owner.id}.json`,
            ref: owner,
            slot,
            missing,
            extra,
            drift,
          },
        ),
      );
  }
  return failures;
}
