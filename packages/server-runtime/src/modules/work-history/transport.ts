import { z } from "zod";
import * as history from "@relay/contracts/work-history";
import * as graph from "@relay/contracts/work-history-graph";
import { parse } from "@relay/core/domain/validation";

/** Только wire-форма: null в query передаётся буквальной строкой, а не исчезает. */
export const workSessionsHttpQuerySchema = history.workSessionsQuerySchema.extend({
  parent: history.workSessionsQuerySchema.shape.parent
    .unwrap()
    .unwrap()
    .optional()
    .describe(
      'Прямые дети выбранного родителя; строка "null" — только корни; отсутствие — все ветки',
    ),
});
export const workSessionHistoryHttpQuerySchema = history.workHistoryQuerySchema.omit({ ref: true });
export const workOpenIntentsHttpQuerySchema = history.workOpenIntentsQuerySchema.omit({
  ref: true,
});
export const workHistoryGraphTransportSchemas = {
  WorkHistoryGraphQuery: graph.workHistoryGraphQuerySchema,
  WorkHistoryGraphPointQuery: graph.workHistoryGraphPointQuerySchema,
  WorkHistoryGraphPage: graph.workHistoryGraphPageSchema,
  WorkHistoryGraphPointDetail: graph.workHistoryGraphPointDetailSchema,
  WorkHistoryGraphPoint: graph.workHistoryGraphPointSchema,
  WorkHistoryGraphEdge: graph.workHistoryGraphEdgeSchema,
  WorkHistoryGraphBoundaryNode: graph.workHistoryGraphBoundaryNodeSchema,
  WorkHistoryGraphBranch: graph.workHistoryGraphBranchSchema,
};
export const workHistoryTransportSchemas = {
  ...workHistoryGraphTransportSchemas,
  WorkSessionsQuery: workSessionsHttpQuerySchema,
  WorkHistoryQuery: workSessionHistoryHttpQuerySchema,
  WorkOpenIntentsQuery: workOpenIntentsHttpQuerySchema,
  WorkOpenIntentsPage: history.workOpenIntentsPageSchema,
  WorkSessionOverview: history.workSessionOverviewSchema,
  AgentRunSummary: history.agentRunSummarySchema,
  WorkHistoryPageQuery: history.workHistoryPageQuerySchema,
  WorkSession: history.workSessionSchema,
  AgentRun: history.agentRunSchema,
  WorkCheckpoint: history.workCheckpointSchema,
  WorkSessionsPage: history.workSessionsPageSchema,
  WorkSessionDetail: history.workSessionDetailSchema,
  WorkTreePage: history.workTreePageSchema,
  WorkHistoryPage: history.workHistoryPageSchema,
  WorkContext: history.workContextSchema,
  WorkHistoryMutation: history.workHistoryMutationSchema,
  WorkSessionStart: history.workSessionStartSchema,
  WorkSessionFork: history.workSessionForkSchema,
  WorkSessionAttach: history.workSessionAttachSchema,
  WorkSessionPause: history.workSessionPauseSchema,
  WorkSessionResume: history.workSessionResumeSchema,
  WorkSessionTakeover: history.workSessionTakeoverSchema,
  WorkSessionComplete: history.workSessionCompleteSchema,
  WorkSessionCancel: history.workSessionCancelSchema,
  WorkCheckpointOpen: history.workCheckpointOpenSchema,
  WorkCheckpointSave: history.workCheckpointSaveSchema,
  WorkCheckpointComplete: history.workCheckpointCompleteSchema,
  WorkCheckpointCancel: history.workCheckpointCancelSchema,
};
export const workHistoryInputSchemas = new Set([
  "WorkHistoryGraphQuery",
  "WorkHistoryGraphPointQuery",
  "WorkSessionsQuery",
  "WorkHistoryQuery",
  "WorkOpenIntentsQuery",
  "WorkHistoryPageQuery",
  "WorkSessionStart",
  "WorkSessionFork",
  "WorkSessionAttach",
  "WorkSessionPause",
  "WorkSessionResume",
  "WorkSessionTakeover",
  "WorkSessionComplete",
  "WorkSessionCancel",
  "WorkCheckpointOpen",
  "WorkCheckpointSave",
  "WorkCheckpointComplete",
  "WorkCheckpointCancel",
]);

/** Неверные bool остаются неверными: Boolean("false") здесь недопустим. */
export class WorkHistoryQueryPipe<T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: Record<string, unknown>): T {
    return parse(
      this.schema,
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (key === "unfinished" || key === "includeChildren") {
            if (item === "true") return [key, true];
            if (item === "false") return [key, false];
          }
          if (key === "parent" && item === "null") return [key, null];
          return [key, item];
        }),
      ),
      "параметры истории работы",
    );
  }
}
