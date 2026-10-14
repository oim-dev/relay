import type { Workspace } from "../storage/workspace.js";
import { readEntityCatalog } from "./entities/catalog.js";
import { validateBoardTasks } from "./board-tasks/service.js";
import { BoardTaskRepository } from "../storage/board-tasks.js";
import { readPlanningState } from "./planning/model.js";
import { withWorkspaceValidation } from "./storage/validation.js";
import { checkManagedRelations } from "./storage/managed-relations.js";

/** Проверяет действующие записи и связи под единой блокировкой проекта. */
export async function validateWorkspace(workspace: Workspace) {
  return withWorkspaceValidation(workspace, async (issues, owned) => {
    const catalog = await issues.check("catalog", () => readEntityCatalog(workspace, owned));
    const tasks = await issues.check("tasks", async () => {
      const records = await new BoardTaskRepository(workspace).all();
      validateBoardTasks(records);
      return records;
    });
    await issues.check("planning", () => readPlanningState(workspace));
    // Сравнение не вызывает replaceOwnedRelations и выполняется в read-only StorageSession.
    const mismatches = await issues.check("managed-relations", () =>
      checkManagedRelations(workspace),
    );
    for (const mismatch of mismatches ?? []) issues.add(mismatch, "managed-relations");
    return {
      valid: true,
      entities: catalog?.entries.length ?? 0,
      tasks: tasks?.length ?? 0,
      boards: catalog?.entries.filter((entry) => entry.ref.kind === "board").length ?? 0,
    };
  });
}
