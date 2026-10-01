import { progressQuerySchema, workPlanProgressSchema } from "@relay/contracts/progress";
import type { ProgressQuery, ProgressReason } from "@relay/contracts/progress";
import type { Workspace } from "../../storage/workspace.js";
import { planningRecord, planningPage } from "../../storage/planning.js";
import { planningCountsCompleted, readPlanningState } from "../planning/model.js";

/** Расчёт плана и проверка перехода используют одно фактическое выполнение задач. */
export async function workPlanProgress(workspace: Workspace, input: ProgressQuery) {
  const query = progressQuerySchema.parse(input);
  const plan = await planningRecord(workspace, query.ref, "work-plan");
  const state = await readPlanningState(workspace);
  const summary = state.summary(plan);
  const stages = state.stages.filter((stage) => stage.planId === plan.id);
  const taskIds = [...new Set(stages.flatMap((stage) => stage.taskIds))];
  const entity = { kind: "work-plan" as const, id: plan.id, key: plan.key, title: plan.title };
  const reasons: ProgressReason[] = [];
  if (summary.counts.total === 0)
    reasons.push({
      code: "NO_WORK",
      message: "В плане нет задач; пустой состав не является выполнением",
      source: entity,
    });
  if (plan.status === "cancelled")
    reasons.push({ code: "PLAN_CANCELLED", message: "План отменён", source: entity });
  const diverged = plan.status === "completed" && !summary.ready;
  if (diverged)
    reasons.push({
      code: "STATE_DIVERGED",
      message: "План был завершён, но текущие обязательства задач уже не выполнены",
      source: entity,
    });
  const tasks = taskIds.map((id) => {
    const task = state.byTask.get(id)!;
    const address = { kind: "task" as const, id, key: task.key, title: task.title };
    const completion = state.completion.get(id)!;
    if (!completion.completed)
      reasons.push({
        code: "COMPONENT_INCOMPLETE",
        message: `Не выполнена задача ${task.key}; раскройте её критерии и обязательства`,
        source: address,
      });
    return { ...address, column: task.column, completed: completion.completed };
  });
  const source = [workspace.config.projectId, plan, stages, state.tasks, query.limit];
  const page = <T>(items: T[]) => planningPage(items, query, source);
  const { version } = page([]);
  const strip = <T>(items: T[]) => {
    const { version: _version, ...result } = page(items);
    return result;
  };
  return workPlanProgressSchema.parse({
    kind: "work-plan",
    entity,
    version,
    status: plan.status,
    completed: summary.ready && plan.status !== "cancelled",
    counts: summary.counts,
    canStart: plan.status === "draft" && plan.goal.trim() !== "" && summary.counts.total > 0,
    canComplete: (plan.status === "draft" || plan.status === "active") && summary.ready,
    diverged,
    tasks: strip(tasks),
    reasons: strip(reasons),
    stages: strip(
      stages.map((stage) => {
        const counts = state.counts(stage.taskIds);
        return {
          id: stage.id,
          title: stage.title,
          counts,
          completed: planningCountsCompleted(counts),
        };
      }),
    ),
  });
}
