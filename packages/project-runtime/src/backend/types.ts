import type { Config } from "@relay/core/domain/config";
import type { ProjectSettings, SaveProjectSettings } from "@relay/core/domain/project-settings";
import type { validateWorkspace } from "@relay/core/application/validate";
import type { Workspace } from "@relay/core/storage/workspace";
import type { ProductQueries } from "@relay/core/application/product/queries";
import type { BoardTasksService } from "@relay/core/application/board-tasks/service";
import type { BoardsService } from "@relay/core/application/boards/service";
import type { GraphService } from "@relay/core/application/graph/service";
import type { EntityEngine } from "@relay/core/application/entities/service";
import type { EntityDeletionService } from "@relay/core/application/entities/deletion";
import type { DocumentLibraryService } from "@relay/core/application/documents/library";
import type { ProgressService } from "@relay/core/application/progress/service";
import type { PlanningService } from "@relay/core/application/planning/service";
import type { ReleasesService } from "@relay/core/application/releases/service";

export interface WorkspaceInfo {
  /** Подтверждённый ID HTTP-контекста; в local — только сохранённый config.projectId. */
  projectId?: string;
  config: Config;
  configPath: string;
  root: string;
}
export interface Backend {
  projectSettings: {
    get(): Promise<ProjectSettings>;
    save(input: SaveProjectSettings): Promise<ProjectSettings>;
  };
  plans: Pick<
    PlanningService,
    | "list"
    | "listCompact"
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
    | "list"
    | "listCompact"
    | "get"
    | "composition"
    | "compositionCompact"
    | "preview"
    | "previewCompact"
    | "create"
    | "createByRefs"
    | "update"
    | "updateByRefs"
    | "transition"
  >;
  progress: Pick<
    ProgressService,
    | "task"
    | "taskDependencies"
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
  deletion: Pick<EntityDeletionService, "preview" | "delete">;
  documents: Pick<
    DocumentLibraryService,
    "links" | "sections" | "changeRelation" | "changeSection"
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
    | "validate"
    | "lint"
    | "overviewMap"
    | "participation"
    | "replaceParticipation"
    | "implementation"
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
