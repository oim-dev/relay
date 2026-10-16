import type { BranchPointPage, BranchPointsState } from "../types/branch-points.type";

/** Объединяет непрерывный префикс одной версии, не выдавая страницу за всю ветку. */
export const mergeBranchPointPages = (
  pages: BranchPointPage[] | undefined,
): Pick<BranchPointsState, "items" | "total" | "hasMore"> => {
  const first = pages?.[0];
  if (first === undefined) return { items: [], total: null, hasMore: false };
  const pointsById = new Map(first.items.map((point) => [point.id, point]));
  let nextOffset = first.nextOffset;
  for (const page of pages?.slice(1) ?? []) {
    if (nextOffset === null || page.offset !== nextOffset || page.version !== first.version) break;
    for (const point of page.items) pointsById.set(point.id, point);
    nextOffset = page.nextOffset;
  }
  return { items: [...pointsById.values()], total: first.total, hasMore: nextOffset !== null };
};
