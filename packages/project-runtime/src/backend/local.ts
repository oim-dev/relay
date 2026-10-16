import { validateWorkspace } from "@relay/core/application/validate";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { openWorkspace } from "@relay/core/storage/workspace";
import { projectSettings } from "@relay/core/storage/project-settings";
import type { Backend } from "./types.js";
import { ProductQueries } from "@relay/core/application/product/queries";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { BoardsService } from "@relay/core/application/boards/service";
import { GraphService } from "@relay/core/application/graph/service";
import { EntityEngine } from "@relay/core/application/entities/service";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";
import { DocumentLibraryService } from "@relay/core/application/documents/library";
import { ProgressService } from "@relay/core/application/progress/service";
import { PlanningService } from "@relay/core/application/planning/service";
import { ReleasesService } from "@relay/core/application/releases/service";
import { WorkHistoryService } from "@relay/core/application/work-history/service";

export async function createLocalBackend(
  cwd: string,
  config?: string,
  options: { createLegacyDirectories?: boolean } = {},
): Promise<Backend> {
  const workspace = await openWorkspace(cwd, config, options);
  return {
    kind: "local",
    workHistory: new WorkHistoryService(workspace),
    projectSettings: {
      get: () =>
        workspace.locked(async () => projectSettings(workspace.config, workspace.configPath)),
      save: (input) => saveProjectSettings(workspace, input),
    },
    plans: new PlanningService(workspace),
    releases: new ReleasesService(workspace),
    progress: new ProgressService(workspace),
    entities: new EntityEngine(workspace),
    deletion: new EntityDeletionService(workspace),
    documents: new DocumentLibraryService(workspace),
    graph: new GraphService(workspace),
    boardTasks: new BoardTasksService(workspace),
    boards: new BoardsService(workspace),
    product: new ProductQueries(workspace),
    workspace: {
      ...(workspace.config.projectId === undefined
        ? {}
        : { projectId: workspace.config.projectId }),
      config: workspace.config,
      configPath: workspace.configPath,
      root: workspace.dataRoot,
    },
    localWorkspace: workspace,
    validate: () => validateWorkspace(workspace),
  };
}
