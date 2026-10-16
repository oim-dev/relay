import { workHistoryGraphPageSchema } from "@relay/contracts/work-history-graph";
import { getProjectApi } from "infra/tasks-api";
import { WorkHistoryError } from "../errors/work-history.error";
import { readWorkData } from "../helpers/read-work-data";
import { getWorkPointPresentation } from "../helpers/point-presentation";
import type { BranchPointPage } from "../types/branch-points.type";

/** Читает все точки выбранной линии, независимо от окна основного графа и потомков. */
export const getBranchPointsPage = async (
  projectId: string,
  sessionId: string,
  offset: number,
  version?: string,
): Promise<BranchPointPage> => {
  const page = await readWorkData(workHistoryGraphPageSchema, () =>
    getProjectApi(projectId).workHistory.getWorkHistoryGraph({
      ref: sessionId,
      includeChildren: false,
      order: "desc",
      offset,
      limit: 20,
      version,
    }),
  );
  if (version !== undefined && page.version !== version)
    throw new WorkHistoryError("VERSION_CONFLICT", "История ветки изменилась. Перечитайте список.");
  if (page.scopeRootId !== sessionId)
    throw new WorkHistoryError("INVALID_RESPONSE", "Сервер вернул другую область истории ветки.");
  const branchesById = new Map(page.branches.map((branch) => [branch.id, branch]));
  const runsById = new Map(page.runs.map((run) => [run.id, run]));
  const items = page.items.map((point) => {
    const branch = branchesById.get(point.sessionId);
    if (point.sessionId !== sessionId || branch === undefined)
      throw new WorkHistoryError("INVALID_RESPONSE", "Сервер вернул точки вне выбранной ветки.");
    const run = point.runId === null ? null : (runsById.get(point.runId) ?? null);
    const { id, title, summary, at } = point;
    const { label } = getWorkPointPresentation(point, run, branch);
    return { id, title, summary, at, label };
  });
  return { items, total: page.total, offset, nextOffset: page.nextOffset, version: page.version };
};
