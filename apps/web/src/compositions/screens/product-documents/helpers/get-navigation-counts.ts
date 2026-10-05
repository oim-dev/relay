import type { MaterialFacets } from "domains/documents";

/**
 * Переводит серверные счётчики в числа навигации: представления и разделы.
 * Пока счётчики не прочитаны, чисел нет — по загруженной странице они не считаются.
 */
export const getNavigationCounts = (
  facets: MaterialFacets | undefined,
): Partial<Record<string, number>> => {
  if (facets === undefined) return {};
  const sections = facets.sections.map((entry) => [
    entry.sectionId === null ? "none" : `section:${entry.sectionId}`,
    entry.count,
  ]);
  return {
    ...Object.fromEntries(sections),
    all: facets.views.all,
    pinned: facets.views.pinned,
    draft: facets.views.draft,
    none: facets.views.unsectioned,
    unattached: facets.views.unattached,
    archived: facets.views.archived,
  };
};
