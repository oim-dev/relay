import type { z } from "zod";
import type {
  planSummarySchema,
  stageSummarySchema,
  planningCountsSchema,
  planningCandidatesPageSchema,
} from "@relay/contracts/planning";
import type { PlanningPlan, PlanSummary, PlanStage, PlanningTask } from "../types/planning.type";
import { EMPTY_PLAN_SUMMARY } from "../config/planning.config";

/**
 * Адаптирует готовые серверные показатели, не пересчитывая их по видимым строкам.
 */
export const planningCountsView = (counts: z.infer<typeof planningCountsSchema>): PlanSummary => ({
  total: counts.total,
  done: counts.completed,
  active: counts.active,
  review: counts.review,
  blocked: counts.blocked,
  percent: counts.percent,
});

/**
 * Готовит предметный контракт плана для существующих композиций.
 */
export const planningView = (plan: z.infer<typeof planSummarySchema>): PlanningPlan => ({
  id: plan.id,
  key: plan.key,
  revision: plan.revision,
  title: plan.title,
  summary: plan.summary,
  goal: plan.goal,
  rationale: plan.rationale,
  boundaries: plan.boundaries,
  expectedResult: plan.expectedResult,
  participants: plan.participants,
  status: plan.status,
  scope: plan.scope.map((ref) => `${ref.kind}:${ref.id}`),
  scopeLabels: plan.scopeLabels.map((scope) => scope.label),
  updatedAt: plan.updatedAt,
  result: plan.result,
  stageCount: plan.stageCount,
  stagePreview: plan.stagePreview,
  nextStageTitle: plan.nextStage?.title ?? null,
  progress: planningCountsView(plan.counts),
  isReady: plan.ready,
});

/**
 * Отделяет содержимое этапа от транспортной оболочки и ревизии его агрегата.
 */
export const stageView = (stage: z.infer<typeof stageSummarySchema>): PlanStage => ({
  id: stage.id,
  title: stage.title,
  summary: stage.summary,
  outcome: stage.outcome,
  completionConditions: stage.completionConditions,
  taskIds: stage.taskIds,
  progress: planningCountsView(stage.counts),
});

/**
 * Показывает фактическую колонку и принадлежность задачи, не копируя её данные в план.
 */
export const planningTaskView = (
  task: z.infer<typeof planningCandidatesPageSchema>["items"][number],
): PlanningTask => ({
  id: task.id,
  key: task.key,
  title: task.title || "Без названия",
  board: task.boardSlug,
  status: task.column,
  isCompleted: task.completed,
  ...(task.blocked ? { blocker: `Ожидает обязательства: ${task.blockers.join(", ")}` } : {}),
  assignment:
    task.assignment === null
      ? null
      : {
          planId: task.assignment.planId,
          stageId: task.assignment.stageId,
          label: `${task.assignment.planKey} · ${task.assignment.stageTitle}`,
        },
});

/**
 * Создаёт только ввод формы; постоянный ID и ключ назначит Core.
 */
export const createPlanDraft = (): PlanningPlan => ({
  id: "new",
  key: "Новый план",
  revision: 0,
  title: "",
  summary: "",
  goal: "",
  rationale: "",
  boundaries: "",
  expectedResult: "",
  participants: [],
  status: "draft",
  scope: [],
  scopeLabels: [],
  updatedAt: new Date().toISOString(),
  result: "",
  stageCount: 0,
  stagePreview: [],
  nextStageTitle: null,
  progress: { ...EMPTY_PLAN_SUMMARY },
  isReady: false,
});

/**
 * Возвращает серверную сводку, общую для карточки и полного просмотра.
 */
export const getPlanSummary = (plan: PlanningPlan): PlanSummary => plan.progress;
