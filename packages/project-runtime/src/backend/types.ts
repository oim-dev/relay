import type { Config } from "@relay/core/domain/config";
import type { validateWorkspace } from "@relay/core/application/validate";
import type { Workspace } from "@relay/core/storage/workspace";
import type { ProductQueries } from "@relay/core/application/product/queries";
import type { BoardTasksService } from "@relay/core/application/board-tasks/service";
import type { BoardsService } from "@relay/core/application/boards/service";
import type { GraphService } from "@relay/core/application/graph/service";
import type { EntityEngine } from "@relay/core/application/entities/service";
import type { ProgressService } from "@relay/core/application/progress/service";
import type { PlanningService } from "@relay/core/application/planning/service";
import type { ReleasesService } from "@relay/core/application/releases/service";

export interface WorkspaceInfo {
  config: Config;
  configPath: string;
  root: string;
}
export interface Backend {
  plans: Pick<
    PlanningService,
    | "list"
    | "get"
    | "stages"
    | "tasks"
    | "memberships"
    | "candidates"
    | "create"
    | "update"
    | "transition"
    | "changeStage"
    | "changeTasks"
    | "transfer"
  >;
  releases: Pick<
    ReleasesService,
    "list" | "get" | "composition" | "preview" | "create" | "update" | "transition"
  >;
  progress: Pick<
    ProgressService,
    | "task"
    | "implementation"
    | "scenario"
    | "feature"
    | "application"
    | "product"
    | "workPlan"
    | "release"
  >;
  entities: Pick<
    EntityEngine,
    | "types"
    | "describe"
    | "list"
    | "get"
    | "resolve"
    | "keys"
    | "keySpaces"
    | "create"
    | "update"
    | "rename"
    | "moveTask"
    | "linkTask"
    | "documentFacets"
    | "documentBulk"
    | "relateDocument"
    | "entityDocuments"
  >;
  graph: Pick<GraphService, "read" | "context" | "mutate">;
  boardTasks: Pick<
    BoardTasksService,
    | "list"
    | "get"
    | "links"
    | "create"
    | "update"
    | "move"
    | "link"
    | "listCriteria"
    | "getCriterion"
    | "changeCriterion"
    | "listComments"
    | "getComment"
    | "publishComment"
  >;
  boards: Pick<BoardsService, "list" | "get">;
  product: Pick<
    ProductQueries,
    | "state"
    | "mutate"
    | "overview"
    | "overviewMetric"
    | "list"
    | "context"
    | "entities"
    | "entity"
    | "updateImplementation"
  >;
  kind: "local" | "http";
  workspace: WorkspaceInfo;
  validate(): ReturnType<typeof validateWorkspace>;
  localWorkspace?: Workspace;
}
