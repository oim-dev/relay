import type { BreadcrumbRouteHandle, RouteBreadcrumb } from "compositions/widgets/page-breadcrumbs";

/**
 * Добавляет уровни конкретного маршрута к пути его родительских matches.
 */
export const breadcrumbHandle = (...breadcrumbs: RouteBreadcrumb[]): BreadcrumbRouteHandle => ({
  breadcrumbs,
});

/** Каталоги, существующие в дереве URL. */
export const PRODUCT_CRUMBS = {
  FEATURES: { label: "Возможности", path: "/product/features" },
  APPLICATIONS: { label: "Приложения", path: "/product/applications" },
  DOCUMENTS: { label: "Библиотека знаний", path: "/documents" },
  PASSPORT: { label: "Паспорт", path: "/product/passport" },
  EDIT: { label: "Редактирование" },
  BOARDS: { label: "Доски и задачи", path: "/boards" },
} satisfies Record<string, RouteBreadcrumb>;

/**
 * Описывает фичу с именем параметра конкретного маршрута.
 */
export const featureCrumb = (param: string): RouteBreadcrumb => ({
  label: "Фича",
  path: `/product/features/:${param}`,
  source: { kind: "feature", param },
});

/**
 * Описывает приложение, сохраняя его место в продуктовом дереве.
 */
export const applicationCrumb = (param: string): RouteBreadcrumb => ({
  label: "Приложение",
  path: `/product/applications/:${param}`,
  source: { kind: "application", param },
});

/**
 * Описывает сценарий внутри подтверждённого маршрутом родителя.
 */
export const scenarioCrumb = (featureParam: string, param: string): RouteBreadcrumb => ({
  label: "Сценарий",
  path: `/product/features/:${featureParam}/scenarios/:${param}`,
  source: { kind: "scenario", param },
});

/**
 * Описывает реализацию в контексте приложения.
 */
export const implementationCrumb = (param = "entityRef"): RouteBreadcrumb => ({
  label: "Реализация",
  path: `/product/applications/:applicationRef/implementations/:${param}`,
  source: { kind: "implementation", param },
});

/**
 * Описывает документ библиотеки.
 */
export const documentCrumb = (): RouteBreadcrumb => ({
  label: "Документ",
  path: "/documents/:documentId",
  source: { kind: "document", param: "documentId" },
});

/**
 * Описывает доску и возврат к её текущим фильтрам.
 */
export const boardCrumb = (): RouteBreadcrumb => ({
  label: "Доска",
  path: "/boards/:boardSlug",
  source: { kind: "board", param: "boardSlug" },
  preserveBoardFilters: true,
});
