import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Исполняется один раз против worktree 3dc1189479e7c479f4bf8a973d8ccd685a0953b5,
// не текущими схемами. Аргументы: старый checkout, новый каталог проекта, каталог oracle.
const [source, project, output] = process.argv.slice(2);
if (!source || !project || !output)
  throw new Error("Нужны checkout, каталог проекта и каталог oracle");
const { initialize } = await import(
  pathToFileURL(join(source, "packages/core/src/storage/workspace.ts")).href
);
const { BoardTasksService } = await import(
  pathToFileURL(join(source, "packages/core/src/application/board-tasks/service.ts")).href
);
const { StorageService } = await import(
  pathToFileURL(join(source, "packages/core/src/application/storage/service.ts")).href
);
const description = "  # Поручение до истории\r\n\r\n- Сохранить **точный** текст 🧪  \n\n";
await mkdir(project, { recursive: true });
await mkdir(output, { recursive: true });
const workspace = await initialize(project, "tasks");
const tasks = new BoardTasksService(workspace);
const task = await tasks.create(
  { board: "product", title: "Задача профиля 2", description, requestId: "profile2-seed" },
  "fixture-author",
);
await new StorageService(workspace).reindex();
await writeFile(
  join(output, "oracle.json"),
  JSON.stringify(
    { description, task: { id: task.id, key: task.key }, profile: 2, historyRecords: 0 },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(output, "steps.jsonl"),
  [
    { operation: "initialize", prefix: "tasks" },
    {
      operation: "BoardTasksService.create",
      id: task.id,
      key: task.key,
      descriptionBytes: Buffer.byteLength(description),
    },
    { operation: "StorageService.reindex" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n",
);
