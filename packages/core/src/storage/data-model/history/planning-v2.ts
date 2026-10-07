/**
 * Замороженные дисковые схемы выхода перехода planning-v1-to-v2: план работ и релиз
 * dataVersion 2, запись совместимости прежнего адреса этапа `plan-stage` dataVersion 2.
 *
 * Происхождение плана и релиза: HEAD 4321233 (= v0.9.2 по Contracts),
 * `git show 4321233:packages/contracts/src/planning.ts` (`workPlanDataSchema`, `planStageSchema`),
 * `git show 4321233:packages/contracts/src/releases.ts` (`releaseDataSchema`),
 * `git show 4321233:packages/core/src/storage/entity-store/codecs.ts` (Markdown-пути плана,
 * включая `stages.*.outcome` и `stages.*.completionConditions`, путь релиза `description`).
 * Примитивы на 4321233 совпадают с 43d683b (`git diff 43d683b 4321233 -- primitives.ts` меняет
 * только описания и удаляет неиспользуемые схемы событий), поэтому используется та же копия.
 *
 * `plan-stage` v2 введена переходом: данные `{ planId }`, содержание этапа принадлежит
 * только `work-plan.stages[]`. Тест сверяет эти схемы с текущими кодеками.
 */
import { z } from "zod";
import { markdownLines, planningId, singleLine, text } from "./primitives-43d683b.js";
import { releaseDataV1, workPlanDataV1 } from "./planning-v1.js";

const KIB = 1024;

export const planStageInPlanV2 = z.strictObject({
  title: singleLine(160),
  summary: text(16 * KIB),
  outcome: markdownLines(256 * KIB),
  completionConditions: markdownLines(256 * KIB),
  id: planningId,
  taskIds: z.array(planningId).max(2000),
});

const plan = workPlanDataV1.shape;
/** Порядок ключей совпадает с текущим `workPlanDataSchema` без `kind`. */
export const workPlanDataV2 = z.strictObject({
  title: plan.title,
  summary: plan.summary,
  goal: plan.goal,
  rationale: plan.rationale,
  boundaries: plan.boundaries,
  expectedResult: plan.expectedResult,
  scope: plan.scope,
  participants: plan.participants,
  projectId: plan.projectId,
  stages: z.array(planStageInPlanV2).max(200),
  status: plan.status,
  result: plan.result,
  startedAt: plan.startedAt,
  closedAt: plan.closedAt,
});

export const releaseDataV2 = releaseDataV1.omit({ snapshotId: true });

/** Запись совместимости прежнего адреса этапа: только план-владелец содержания. */
export const planStageDataV2 = z.strictObject({ planId: planningId });

export type WorkPlanDataV2 = z.output<typeof workPlanDataV2>;
export type ReleaseDataV2 = z.output<typeof releaseDataV2>;
export type PlanStageDataV2 = z.output<typeof planStageDataV2>;
