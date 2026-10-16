import type { WorkGraphEdge } from "../types/work-graph.type";

/**
 * Различает реальные узлы и якоря линий нового графового контракта.
 */
export const getWorkGraphEdgeKey = (edge: WorkGraphEdge): string => {
  if (edge.kind === "fork") return `fork:${edge.fromSessionId}:${edge.to}`;
  if (edge.kind === "branch-end") return `branch-end:${edge.from}:${edge.toSessionId}`;
  return `${edge.kind}:${edge.from ?? "project"}:${edge.to ?? "project"}`;
};
