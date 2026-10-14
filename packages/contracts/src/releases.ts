import { z } from "zod";
import {
  text,
  singleLine,
  timestampSchema,
  actorSchema,
  entityReferenceSchema,
} from "./primitives.js";
import {
  planningIdSchema,
  planningMetadata,
  planningWrite,
  planningRevision,
  planningPageQuerySchema,
  planningPage,
  planSummarySchema,
  planCompactSchema,
} from "./planning.js";

export const releaseStatusSchema = z
  .enum(["planned", "released", "cancelled"])
  .describe("Собственное состояние: запланирован, выпущен или отменён");
export const releaseFieldsSchema = z.strictObject({
  title: singleLine(160).describe("Однострочное название релиза"),
  version: singleLine(80).describe("Пользовательское обозначение выпуска; не ревизия записи"),
  summary: text(16 * 1024)
    .default("")
    .describe("Краткое описание обычным многострочным текстом"),
  description: text(256 * 1024)
    .default("")
    .describe("Полное описание выпуска в Markdown"),
  planIds: z
    .array(planningIdSchema)
    .min(1)
    .max(200)
    .describe("Планы целиком по постоянным ID, максимум 200"),
  plannedFor: z
    .union([z.literal(""), z.iso.date()])
    .default("")
    .describe("Плановая дата YYYY-MM-DD либо пустая строка"),
});
export const releaseDataSchema = releaseFieldsSchema.extend({
  kind: z.literal("release").describe("Самостоятельный релиз"),
  projectId: planningIdSchema,
  status: releaseStatusSchema,
  releasedAt: timestampSchema.nullable().describe("Фактическая дата фиксации выпуска"),
  releasedBy: actorSchema.nullable().describe("Автор фиксации выпуска"),
});
export const releaseSchema = releaseDataSchema.extend(planningMetadata);
export const releaseReadinessSchema = z.strictObject({
  total: z.number().int().nonnegative().describe("Все выбранные планы"),
  ready: z.number().int().nonnegative().describe("Завершённые и фактически готовые планы"),
  missing: z.number().int().nonnegative().describe("Недоступные планы"),
  percent: z.number().int().min(0).max(100).describe("Процент готовых планов; пустой состав — 0"),
  canRelease: z.boolean().describe("Весь состав готов к явному выпуску"),
});
export const releaseSummarySchema = releaseSchema.extend({ readiness: releaseReadinessSchema });
export const releasesQuerySchema = planningPageQuerySchema.extend({
  q: z
    .string()
    .max(1024)
    .optional()
    .describe("Поиск по ключу, названию, версии, краткому и полному описанию"),
  status: releaseStatusSchema.optional(),
});
export const releasesPageSchema = planningPage(releaseSummarySchema).extend({
  statusCounts: z
    .record(z.string(), z.number().int().nonnegative())
    .describe("Полные счётчики состояний релизов без поиска, включая all"),
});
export const saveReleaseSchema = releaseFieldsSchema.extend({
  ...planningWrite,
  ifRevision: planningRevision
    .optional()
    .describe("Обязательная ревизия при изменении существующего релиза"),
  status: releaseStatusSchema.default("planned"),
});
export const updateReleaseSchema = saveReleaseSchema.extend({
  ifRevision: planningRevision,
  status: releaseStatusSchema.describe(
    "Явно выбранное состояние; отсутствие не перепланирует отменённый релиз",
  ),
});
export const releaseActionSchema = z.strictObject({
  ...planningWrite,
  ifRevision: planningRevision,
  action: z
    .enum(["plan", "cancel", "release"])
    .describe("Перепланировать, отменить либо явно зафиксировать выпуск"),
});
export const releasePreviewSchema = planningPageQuerySchema.extend({
  plans: z
    .array(entityReferenceSchema)
    .max(200)
    .describe("Выбранные планы, ключи или ID; пустой выбор допускается для формы"),
});
export const releasePlanItemSchema = z.strictObject({
  id: planningIdSchema,
  plan: planSummarySchema
    .nullable()
    .describe("Актуальный план выбранного состава; null при недоступности"),
});
export const releaseCompositionSchema = planningPage(releasePlanItemSchema).extend({
  readiness: releaseReadinessSchema,
});
export const releaseCompactSchema = releaseSummarySchema.pick({
  kind: true,
  id: true,
  key: true,
  revision: true,
  title: true,
  version: true,
  summary: true,
  status: true,
  plannedFor: true,
  releasedAt: true,
  releasedBy: true,
  updatedAt: true,
  readiness: true,
});
export const releasesCompactQuerySchema = releasesQuerySchema.extend({
  projection: z
    .literal("compact")
    .describe("Обзор без полного Markdown-описания и массива planIds"),
});
export const releasesCompactPageSchema = planningPage(releaseCompactSchema).extend({
  statusCounts: releasesPageSchema.shape.statusCounts,
});
export const releaseCompositionCompactQuerySchema = planningPageQuerySchema.extend({
  projection: z
    .literal("compact")
    .describe("Состав с обзорными карточками планов без полного Markdown"),
});
export const releasePreviewCompactSchema = releasePreviewSchema.extend({
  projection: releaseCompositionCompactQuerySchema.shape.projection,
});
export const releaseCompositionCompactSchema = planningPage(
  releasePlanItemSchema.extend({
    plan: planCompactSchema
      .nullable()
      .describe("Актуальная обзорная карточка плана либо null при недоступности"),
  }),
).extend({ readiness: releaseReadinessSchema });
const releasePlanReferencesSchema = z
  .array(entityReferenceSchema.describe("Ключ, ID или work-plan:ID плана"))
  .min(1)
  .max(200)
  .describe(
    "Полный состав: 1–200 ссылок; разрешается и проверяется в одной мутации, без повторов ID",
  );
export const saveReleaseByRefsSchema = saveReleaseSchema.omit({ planIds: true }).extend({
  plans: releasePlanReferencesSchema,
});
export const updateReleaseByRefsSchema = updateReleaseSchema.omit({ planIds: true }).extend({
  plans: releasePlanReferencesSchema,
});
export type Release = z.infer<typeof releaseSchema>;
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;
export type SaveRelease = z.input<typeof saveReleaseSchema>;
export type UpdateRelease = z.input<typeof updateReleaseSchema>;
export type ReleaseAction = z.input<typeof releaseActionSchema>;
export type ReleasesQuery = z.input<typeof releasesQuerySchema>;
export type ReleasePreview = z.input<typeof releasePreviewSchema>;
export type ReleaseCompact = z.infer<typeof releaseCompactSchema>;
export type ReleasesCompactQuery = z.input<typeof releasesCompactQuerySchema>;
export type ReleasesCompactPage = z.infer<typeof releasesCompactPageSchema>;
export type ReleaseCompositionCompactQuery = z.input<typeof releaseCompositionCompactQuerySchema>;
export type ReleasePreviewCompact = z.input<typeof releasePreviewCompactSchema>;
export type ReleaseCompositionCompact = z.infer<typeof releaseCompositionCompactSchema>;
export type SaveReleaseByRefs = z.input<typeof saveReleaseByRefsSchema>;
export type UpdateReleaseByRefs = z.input<typeof updateReleaseByRefsSchema>;
