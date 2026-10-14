import { createHash } from "node:crypto";
import { taskDependenciesQuerySchema, taskDependenciesPageSchema } from "@relay/contracts/progress";
import type { TaskDependenciesQuery } from "@relay/contracts/progress";
import type { Workspace } from "../../storage/workspace.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { resolveAddress } from "../entities/resolver.js";
import { taskCompletions } from "../board-tasks/completion.js";
import { validateBoardTasks } from "../board-tasks/service.js";
import { invariant } from "../../shared/errors.js";

/** Только зависимости: согласованное чтение задач без продукта, досок и планирования. */
export async function taskDependencies(workspace: Workspace, input: TaskDependenciesQuery) {
  const query = taskDependenciesQuerySchema.parse(input);
  const tasks = (await new BoardTaskRepository(workspace).all()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  validateBoardTasks(tasks, workspace.storageSession !== undefined);
  const task = resolveAddress(
    tasks.map((task) => ({
      ref: { kind: "task", id: task.id },
      key: task.key,
      aliases: task.keys,
      task,
    })),
    query.ref,
    "task",
  ).task;
  const completion = taskCompletions(tasks);
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        workspace.config.projectId,
        "task-dependencies",
        task.id,
        query.limit,
        tasks,
      ]),
    )
    .digest("hex");
  invariant(
    query.offset === 0 || query.version !== undefined,
    "INVALID_ARGUMENT",
    "Для продолжения укажите версию первой страницы",
    2,
  );
  invariant(
    query.version === undefined || query.version === version,
    "PROGRESS_CHANGED",
    "Зависимости изменились. Начните чтение с первой страницы",
    4,
  );
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const address = (entry: typeof task) => ({
    kind: "task" as const,
    id: entry.id,
    key: entry.key,
    title: entry.title,
  });
  return taskDependenciesPageSchema.parse({
    entity: address(task),
    version,
    items: task.dependencies.slice(query.offset, query.offset + query.limit).map((id) => {
      const dependency = byId.get(id)!;
      return {
        ...address(dependency),
        column: dependency.column,
        completed: completion.get(id)!.completed,
      };
    }),
    total: task.dependencies.length,
    nextOffset:
      query.offset + query.limit < task.dependencies.length ? query.offset + query.limit : null,
  });
}
