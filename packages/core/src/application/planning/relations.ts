import type { WorkPlan } from "@relay/contracts/planning";
import type { Workspace } from "../../storage/workspace.js";
import { planningSession } from "../../storage/planning.js";
import { replaceOwnedRelations } from "../../storage/entity-store/relations.js";
import type { RelationSink } from "../entities/owned-relations.js";

/** Явное согласование после предметной записи, в общей восстанавливаемой транзакции. */
export async function syncPlanRelations(
  workspace: Workspace,
  plan: WorkPlan,
  actor: string,
  sink: RelationSink = replaceOwnedRelations,
) {
  const owner = { kind: "work-plan", id: plan.id };
  await sink(
    planningSession(workspace),
    owner,
    "planning-scope",
    [
      {
        type: "part-of",
        from: owner,
        to: { kind: "project", id: plan.projectId },
        description: "",
      },
      ...plan.scope.map((to) => ({ type: "affects", from: owner, to, description: "" })),
    ],
    actor,
  );
  // Этапы — записи плана. Только явные включения дают отдельные связи с планом.
  await sink(
    planningSession(workspace),
    owner,
    "planning-membership",
    [
      ...plan.stages
        .flatMap((stage) => stage.taskIds)
        .map((id) => ({
          type: "part-of",
          from: { kind: "task", id },
          to: owner,
          description: "",
        })),
    ],
    actor,
  );
}
