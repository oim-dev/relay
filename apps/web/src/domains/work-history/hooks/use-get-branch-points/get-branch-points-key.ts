import { WORK_HISTORY_GRAPH_CAPABILITY } from "@relay/contracts/work-history-graph";

/** Проект, ветка, страница и версия отделены от кеша графа и других областей истории. */
export const getBranchPointsKey = (
  projectId: string,
  sessionId: string,
  offset: number,
  version?: string,
) =>
  ["branch-points", WORK_HISTORY_GRAPH_CAPABILITY, projectId, sessionId, offset, version] as const;
