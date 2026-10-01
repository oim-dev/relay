/** Ключ кеша обзора проекта. */
export type ProductOverviewKey = readonly ["product-overview", string];

/**
 * Ключ обзора по постоянному ID проекта: общий для чтения среза и его перечитывания
 * после конфликта версии полного списка метрики.
 */
export const getProductOverviewKey = (projectId: string): ProductOverviewKey => [
  "product-overview",
  projectId,
];
