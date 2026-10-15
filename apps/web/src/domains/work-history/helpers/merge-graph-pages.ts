import type { WorkHistoryGraphPage } from "@relay/contracts/work-history-graph";
import type { WorkGraph } from "../types/work-graph.type";
import { getWorkGraphEdgeKey } from "./graph-edge-key";

/**
 * Соединяет только непрерывный префикс одной версии. Загруженные концы удаляются из boundaries,
 * но невидимые концы связей никогда не превращаются в новые корни или терминальные точки.
 */
export const mergeGraphPages = (
  pages: WorkHistoryGraphPage[] | undefined,
): { graph: WorkGraph | null; hasMore: boolean } => {
  const first = pages?.[0];
  if (first === undefined) return { graph: null, hasMore: false };
  const points = new Map(first.items.map((point) => [point.id, point]));
  const branches = new Map(first.branches.map((branch) => [branch.id, branch]));
  const runs = new Map(first.runs.map((run) => [run.id, run]));
  const boundaries = new Map(first.boundaryNodes.map((node) => [node.id, node]));
  const edges = new Map(first.edges.map((edge) => [getWorkGraphEdgeKey(edge), edge]));
  let last = first;
  for (const page of pages ?? []) {
    if (page.version !== first.version) break;
    for (const point of page.items) points.set(point.id, point);
    for (const branch of page.branches) branches.set(branch.id, branch);
    for (const run of page.runs) runs.set(run.id, run);
    for (const node of page.boundaryNodes) boundaries.set(node.id, node);
    for (const edge of page.edges) edges.set(getWorkGraphEdgeKey(edge), edge);
    last = page;
  }
  for (const id of points.keys()) boundaries.delete(id);
  const visibleBranches = new Set([...points.values()].map((point) => point.sessionId));
  return {
    graph: {
      items: [...points.values()],
      openEnds: first.openEnds,
      branches: [...branches.values()].map((branch) => ({
        ...branch,
        contextOnly: !visibleBranches.has(branch.id),
      })),
      runs: [...runs.values()],
      edges: [...edges.values()],
      boundaryNodes: [...boundaries.values()],
      total: first.total,
      version: first.version,
    },
    hasMore: last.nextOffset !== null,
  };
};
