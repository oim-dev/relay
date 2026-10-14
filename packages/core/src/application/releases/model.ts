import type { PlanningState } from "../planning/model.js";
import type { Release } from "@relay/contracts/releases";
import type { PlanningPageQuery } from "@relay/contracts/planning";
import type { Workspace } from "../../storage/workspace.js";
import { planningPage, planningSession } from "../../storage/planning.js";

/** Выпуск требует и сохранённого завершения плана, и актуального выполнения его состава. */
export function releaseComposition(planIds: readonly string[], state: PlanningState) {
  const items = planIds.map((id) => {
    const plan = state.plans.find((entry) => entry.id === id);
    return { id, plan: plan ? state.summary(plan) : null };
  });
  const total = items.length;
  const ready = items.filter((item) => item.plan?.status === "completed" && item.plan.ready).length;
  return {
    items,
    readiness: {
      total,
      ready,
      missing: items.filter((item) => item.plan === null).length,
      percent: total === 0 ? 0 : ready === total ? 100 : Math.floor((ready * 100) / total),
      canRelease: total > 0 && ready === total,
    },
  };
}

/** Общая проекция состава на уже прочитанном состоянии, без вложенных сервисных чтений. */
export function releaseCompositionPage(
  workspace: Workspace,
  release: Release,
  state: PlanningState,
  query: PlanningPageQuery,
  compact = false,
) {
  const result = releaseComposition(release.planIds, state);
  const source = [
    release,
    planningSession(workspace).state.version,
    state.plans,
    state.stages,
    state.tasks,
    query.limit,
  ];
  return {
    ...planningPage(result.items, query, compact ? [...source, "compact"] : source),
    readiness: {
      ...result.readiness,
      canRelease: release.status === "planned" && result.readiness.canRelease,
    },
  };
}

export function releaseSummary(release: Release, state: PlanningState) {
  const readiness = releaseComposition(release.planIds, state).readiness;
  return {
    ...release,
    readiness: { ...readiness, canRelease: release.status === "planned" && readiness.canRelease },
  };
}
