import type { z } from "zod";
import type { releaseSummarySchema, releaseCompositionSchema } from "@relay/contracts/releases";
import type { Release, ReleaseComposition, ReleaseSummary } from "../types/release.type";

/**
 * Подготавливает реквизиты выпуска для существующих экранов.
 */
export const releaseView = (release: z.infer<typeof releaseSummarySchema>): Release => ({
  id: release.id,
  key: release.key,
  revision: release.revision,
  title: release.title,
  version: release.version,
  summary: release.summary,
  description: release.description,
  planIds: release.planIds,
  status: release.status,
  plannedFor: release.plannedFor,
  releasedAt: release.releasedAt,
  releasedBy: release.releasedBy,
  updatedAt: release.updatedAt,
  readiness: release.readiness,
});

/**
 * Адаптирует актуальный состав, не приписывая недоступному плану состояние отмены.
 */
export const releaseCompositionView = (
  page: z.infer<typeof releaseCompositionSchema>,
): ReleaseComposition => ({
  ...page,
  items: page.items.map(({ id, plan }) => ({
    id,
    key: plan?.key ?? id,
    title: plan?.title ?? "План недоступен",
    summary: plan?.summary ?? "Уточните выбранный состав.",
    goal: plan?.goal ?? "",
    result: plan?.result ?? "",
    status: plan?.status ?? null,
    done: plan?.counts.completed ?? 0,
    total: plan?.counts.total ?? 0,
    percent: plan?.counts.percent ?? 0,
    isMissing: plan === null,
  })),
});

/**
 * Готовит ввод нового релиза; постоянная запись появится только после подтверждения сервера.
 */
export const createReleaseDraft = (): Release => ({
  id: "new",
  key: "Новый релиз",
  revision: 0,
  title: "",
  version: "",
  summary: "",
  description: "",
  planIds: [],
  status: "planned",
  plannedFor: "",
  releasedAt: null,
  releasedBy: null,
  updatedAt: new Date().toISOString(),
  readiness: { total: 0, ready: 0, missing: 0, percent: 0, canRelease: false },
});

/**
 * Возвращает серверные показатели всего состава, независимо от загруженных планов.
 */
export const getReleaseSummary = (release: Release): ReleaseSummary => release.readiness;
