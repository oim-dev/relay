/**
 * Отдельный процесс для структурной проверки: считает вызовы `taskCompletions` за одно
 * чтение обзора и одну страницу детализации. Запускается тестом с
 * `--experimental-test-module-mocks`; печатает JSON со счётчиками.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

const completionUrl = new URL("../../src/application/board-tasks/completion.ts", import.meta.url)
  .href;
const real = await import(completionUrl);
let calls = 0;
mock.module(completionUrl, {
  namedExports: {
    ...real,
    taskCompletions: (...args: unknown[]) => {
      calls++;
      return real.taskCompletions(...args);
    },
  },
});
const { initialize } = await import("../../src/storage/workspace.js");
const { ProductQueries } = await import("../../src/application/product/queries.js");
const { BoardTasksService } = await import("../../src/application/board-tasks/service.js");
const { PlanningService } = await import("../../src/application/planning/service.js");
const root = await realpath(await mkdtemp(join(tmpdir(), "tasks-core-count-")));
try {
  const workspace = await initialize(root, "tasks");
  const tasks = new BoardTasksService(workspace);
  const first = await tasks.create(
    { board: "product", column: "in-progress", title: "A", requestId: randomUUID() },
    "agent",
  );
  await tasks.create(
    {
      board: "product",
      column: "review",
      title: "B",
      dependencies: [first.id],
      requestId: randomUUID(),
    },
    "agent",
  );
  await new PlanningService(workspace).create(
    { title: "План", goal: "Цель", requestId: randomUUID() },
    "agent",
  );
  const product = new ProductQueries(workspace);
  calls = 0;
  await product.overview();
  const overview = calls;
  calls = 0;
  await product.overviewMetric({ metric: "blocker-affected", blocker: first.id });
  console.log(JSON.stringify({ overview, metric: calls }));
} finally {
  await rm(root, { recursive: true, force: true });
}
