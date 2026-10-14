/**
 * Замороженные дисковые схемы планирования dataVersion 1 (план v1, отдельные этапы,
 * релиз v1 и технические снимки выпуска).
 *
 * Происхождение: 43d683be11cda57f8861468c20ae14b18cc9e419 (`1afe138^`), команды:
 * - `git show 43d683b:packages/contracts/src/planning.ts` — `workPlanDataSchema`,
 *   `planStageDataSchema`, `planSummarySchema`, `planningCountsSchema`;
 * - `git show 43d683b:packages/contracts/src/releases.ts` — `releaseDataSchema`,
 *   `releaseReadinessSchema`, `releaseSnapshotItemSchema`;
 * - `git show 43d683b:packages/core/src/domain/release-snapshot.ts` — снимок и его запись;
 * - `git show 43d683b:packages/core/src/storage/entity-store/codecs.ts` и
 *   `.../storage/unified-adapter.ts` — дисковая форма: поле `kind` не хранится, Markdown-пути
 *   плана (goal, rationale, boundaries, expectedResult, result), этапа (outcome,
 *   completionConditions), релиза (description), записи снимка (item.content, plan.goal…result).
 * Фикстура: `packages/core/test/fixtures/data-migrations/` (база до 1afe138).
 *
 * Все поля обязательны: прежний кодек записывал данные после применения defaults, поэтому
 * отсутствие поля на диске — повреждение, а не значение по умолчанию.
 */
import { z } from "zod";
import {
  actor,
  markdownLines,
  planningId,
  singleLine,
  text,
  timestamp,
} from "./primitives-43d683b.js";

const KIB = 1024;
const MIB = 1024 * KIB;

export const planStatusV1 = z.enum(["draft", "active", "completed", "cancelled"]);
export const planningScopeV1 = z.strictObject({
  kind: z.enum(["project", "product", "application", "feature", "scenario", "implementation"]),
  id: planningId,
});

/** Поля плана v1 в порядке `workPlanDataSchema` без `kind`. */
const workPlanFieldsV1 = {
  title: singleLine(160),
  summary: text(16 * KIB),
  goal: markdownLines(256 * KIB),
  rationale: markdownLines(256 * KIB),
  boundaries: markdownLines(256 * KIB),
  expectedResult: markdownLines(256 * KIB),
  scope: z.array(planningScopeV1).max(100),
  participants: z.array(actor).max(100),
  projectId: planningId,
  status: planStatusV1,
  result: markdownLines(256 * KIB),
  startedAt: timestamp.nullable(),
  closedAt: timestamp.nullable(),
};
export const workPlanDataV1 = z.strictObject(workPlanFieldsV1);

export const planStageDataV1 = z.strictObject({
  title: singleLine(160),
  summary: text(16 * KIB),
  outcome: markdownLines(256 * KIB),
  completionConditions: markdownLines(256 * KIB),
  projectId: planningId,
  planId: planningId,
  rank: z.number().int().nonnegative(),
  taskIds: z.array(planningId).max(2000),
});

export const releaseStatusV1 = z.enum(["planned", "released", "cancelled"]);
export const releaseDataV1 = z.strictObject({
  title: singleLine(160),
  version: singleLine(80),
  summary: text(16 * KIB),
  description: markdownLines(256 * KIB),
  planIds: z.array(planningId).min(1).max(200),
  plannedFor: z.union([z.literal(""), z.iso.date()]),
  projectId: planningId,
  status: releaseStatusV1,
  releasedAt: timestamp.nullable(),
  releasedBy: actor.nullable(),
  snapshotId: planningId.nullable(),
});

const countsV1 = z.strictObject({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
});
export const releaseReadinessV1 = z.strictObject({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  canRelease: z.boolean(),
});

/** `releaseSnapshotSchema` (domain/release-snapshot.ts), технический вид `release-snapshot`. */
export const releaseSnapshotV1 = z.strictObject({
  releaseId: planningId,
  capturedAt: timestamp,
  capturedBy: actor,
  entryIds: z.array(planningId).max(10000),
  planEntryIds: z.array(planningId).max(200),
  readiness: releaseReadinessV1,
});

/** `planSummarySchema` в дисковой форме записи снимка (Markdown-пути plan.goal…result). */
export const planSummaryDiskV1 = z.strictObject({
  ...workPlanFieldsV1,
  kind: z.literal("work-plan"),
  id: planningId,
  key: z.string(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: actor,
  updatedBy: actor,
  scopeLabels: z.array(z.strictObject({ ref: z.string(), label: z.string() })),
  stageCount: z.number().int().nonnegative(),
  counts: countsV1,
  ready: z.boolean(),
  nextStage: z.strictObject({ id: planningId, title: z.string() }).nullable(),
  stagePreview: z.array(z.strictObject({ id: planningId, completed: z.boolean() })).max(12),
});

/** `releaseSnapshotEntrySchema`, технический вид `release-snapshot-entry`. */
export const releaseSnapshotEntryV1 = z.strictObject({
  snapshotId: planningId,
  item: z.strictObject({
    kind: z.string(),
    id: planningId,
    key: z.string(),
    revision: z.number().int().nonnegative(),
    title: z.string(),
    reason: z.string(),
    content: markdownLines(8 * MIB),
  }),
  plan: planSummaryDiskV1.optional(),
});

export type WorkPlanDataV1 = z.output<typeof workPlanDataV1>;
export type PlanStageDataV1 = z.output<typeof planStageDataV1>;
export type ReleaseDataV1 = z.output<typeof releaseDataV1>;
export type ReleaseSnapshotV1 = z.output<typeof releaseSnapshotV1>;
export type ReleaseSnapshotEntryV1 = z.output<typeof releaseSnapshotEntryV1>;
