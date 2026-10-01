import type { PlanningCounts, WorkPlan } from "@relay/contracts/planning";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import { planningRecords, planningSession } from "../../storage/planning.js";
import type { Workspace } from "../../storage/workspace.js";
import { taskCompletions } from "../board-tasks/completion.js";
import { invariant } from "../../shared/errors.js";

/** Непустой состав, все задачи которого фактически выполнены; общее правило этапа и плана. */
export function planningCountsCompleted(counts: Pick<PlanningCounts, "total" | "completed">) {
  return counts.total > 0 && counts.completed === counts.total;
}

/**
 * Согласованный предметный снимок; граф и число загруженных строк не определяют состав.
 * Уже прочитанные в той же сессии задачи можно передать, чтобы не читать их повторно.
 */
export async function readPlanningState(workspace: Workspace, preloaded?: BoardTaskRecord[]) {
  planningSession(workspace);
  const plans = await planningRecords(workspace, "work-plan");
  const stages = plans.flatMap((plan) =>
    plan.stages.map((stage) => ({ ...stage, planId: plan.id })),
  );
  const tasks = preloaded ?? (await new BoardTaskRepository(workspace).all());
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const current = new Map<string, { planId: string; stageId: string }>();
  const scopeLabels = new Map<string, string>();
  for (const plan of plans)
    for (const ref of plan.scope) {
      const address = `${ref.kind}:${ref.id}`;
      if (!scopeLabels.has(address)) {
        const card = await planningSession(workspace).resolve(address, ref.kind);
        scopeLabels.set(address, `${card.key} · ${card.title}`);
      }
    }
  const perPlan = new Map<string, Set<string>>();
  for (const plan of plans)
    invariant(
      new Set(plan.stages.map((stage) => stage.id)).size === plan.stages.length,
      "DUPLICATE_VALUE",
      `В плане ${plan.key} повторяется ID этапа`,
      4,
    );
  for (const stage of stages) {
    const plan = plans.find((entry) => entry.id === stage.planId);
    invariant(plan, "INVALID_REFERENCE", `Этап ${stage.id} ссылается на отсутствующий план`, 4);
    const ids = perPlan.get(plan.id) ?? new Set<string>();
    for (const id of stage.taskIds) {
      invariant(
        byTask.has(id),
        "INVALID_REFERENCE",
        `Этап ${stage.id} ссылается на отсутствующую task:${id}`,
        4,
      );
      invariant(
        !ids.has(id),
        "DUPLICATE_VALUE",
        `Задача task:${id} повторяется в плане ${plan.key}`,
        4,
      );
      ids.add(id);
      if (plan.status === "draft" || plan.status === "active") {
        invariant(
          !current.has(id),
          "TASK_IN_PLAN",
          `Задача task:${id} уже включена в текущий план`,
          4,
        );
        current.set(id, { planId: plan.id, stageId: stage.id });
      }
    }
    perPlan.set(plan.id, ids);
  }
  const completion = taskCompletions(tasks);
  const counts = (ids: readonly string[]): PlanningCounts => {
    const selected = [...new Set(ids)].map((id) => {
      const task = byTask.get(id);
      invariant(task, "INVALID_REFERENCE", `Не найдена task:${id}`, 4);
      return task;
    });
    const completed = selected.filter((task) => completion.get(task.id)!.completed).length;
    return {
      total: selected.length,
      completed,
      active: selected.filter((task) => task.column === "in-progress").length,
      review: selected.filter((task) => task.column === "review").length,
      blocked: selected.filter((task) => completion.get(task.id)!.blockers.length > 0).length,
      percent:
        selected.length === 0
          ? 0
          : completed === selected.length
            ? 100
            : Math.floor((completed * 100) / selected.length),
    };
  };
  const summary = (plan: WorkPlan) => {
    const { stages: _stages, ...fields } = plan;
    const selected = stages.filter((stage) => stage.planId === plan.id);
    const progress = counts(selected.flatMap((stage) => stage.taskIds));
    const next = selected.find((stage) => {
      const progress = counts(stage.taskIds);
      return !planningCountsCompleted(progress);
    });
    return {
      ...fields,
      stageCount: selected.length,
      counts: progress,
      scopeLabels: plan.scope.map((ref) => ({
        ref: `${ref.kind}:${ref.id}`,
        label: scopeLabels.get(`${ref.kind}:${ref.id}`)!,
      })),
      nextStage: next ? { id: next.id, title: next.title } : null,
      stagePreview: selected.slice(0, 12).map((stage) => {
        const progress = counts(stage.taskIds);
        return {
          id: stage.id,
          completed: planningCountsCompleted(progress),
        };
      }),
      ready: planningCountsCompleted(progress),
    };
  };
  return { plans, stages, tasks, byTask, current, completion, counts, summary };
}
export type PlanningState = Awaited<ReturnType<typeof readPlanningState>>;
