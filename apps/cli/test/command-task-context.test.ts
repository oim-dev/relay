import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { API_CONTRACT_VERSION } from "@relay/contracts";
import { taskContextSchema, type TaskContext } from "@relay/contracts/task-context";
import { fixture, invokeRaw, successful, failed } from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

/** Продукт с FI, задачей с критерием и двумя документами: задачи и реализации. */
async function seed(root: string) {
  const workspace = await openWorkspace(root);
  const product = new ProductQueries(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "## Фича\nТекст" },
    },
    "agent",
  );
  const application = await product.mutate(
    {
      action: "create",
      requestId: "web",
      fields: {
        kind: "application",
        slug: "web",
        prefix: "WEB",
        name: "Web",
        summary: "",
        description: "## Web",
        type: "frontend",
      },
    },
    "agent",
  );
  await product.mutate(
    {
      action: "create",
      requestId: "scope",
      ifVersion: (await product.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: feature.id,
            scenarioId: null,
            title: "Каталог Web",
            description: "## FI\nВклад",
            status: "none",
          },
        ],
      },
    },
    "agent",
  );
  const fi = await product.entity("WEB-FI-1");
  const task = await new BoardTasksService(workspace).create(
    {
      board: "web",
      title: "Каталог",
      description: "## Цель\nСделать",
      productLinks: [{ kind: "implementation", id: fi.id }],
      acceptanceCriteria: [{ title: "Открывается", summary: "", description: "## Проверка" }],
      requestId: "task",
    },
    "agent",
  );
  const engine = new EntityEngine(workspace);
  for (const [requestId, target, name] of [
    ["task-doc", { kind: "task" as const, id: task.id }, "ТЗ задачи"],
    ["fi-doc", { kind: "implementation" as const, id: fi.id }, "Правила FI"],
  ] as const)
    await engine.create(
      {
        requestId,
        data: {
          kind: "document",
          name,
          summary: "",
          body: `# ${name}`,
          documentKind: "rules",
          relations: [{ target, type: "references", description: "" }],
        },
      },
      "agent",
    );
  return { task, fi };
}

test("task context: JSON local и HTTP совпадают, флаг документов целей, text и ошибки", async (t) => {
  const app = await fixture(t);
  const { task, fi } = await seed(app.root);
  const local = successful(await app.run<TaskContext>(["task", "context", task.key])).data;
  taskContextSchema.parse(local);
  assert.equal(local.contractVersion, 1);
  assert.equal(local.task.criteria[0]?.title, "Открывается");
  assert.deepEqual(
    local.targets.map(({ record }) => record.ref.id),
    [fi.id],
  );
  assert.deepEqual(
    [local.requirements.length, local.applications.length, local.documents.length],
    [1, 1, 1],
  );
  const extended = successful(
    await app.run<TaskContext>(["task", "context", task.key, "--target-documents"]),
  ).data;
  assert.deepEqual(
    extended.documents.map(({ record, reasons }) => [record.title, reasons[0]?.code]),
    [
      ["ТЗ задачи", "task-document"],
      ["Правила FI", "target-document"],
    ],
  );

  const server = await httpServer(t, app.root);
  const remote = successful(
    await app.run<TaskContext>(["--server-url", server.url, "task", "context", task.id]),
  ).data;
  assert.deepEqual(remote, local);

  const text = await invokeRaw(app.root, ["task", "context", task.key, "--target-documents"]);
  assert.equal(text.code, 0, text.stderr);
  for (const fragment of [
    `Контекст исполнения ${task.key}`,
    "Критерий 1: Открывается",
    "Цель: WEB-FI-1",
    "Требование:",
    "Приложение:",
    "Паспорт:",
    "Документ:",
    "# Правила FI",
    "прикреплён к цели",
  ])
    assert(text.stdout.includes(fragment), `${fragment}\n${text.stdout}`);

  failed(await app.run(["task", "context", "WEB-404"]), "NOT_FOUND", 3);
  const help = await invokeRaw(app.root, ["task", "context", "--help"]);
  assert.equal(help.code, 0);
  assert(help.stdout.includes("--target-documents"));
});

test("meta: версии договора без открытия проекта, прежний -V не меняется", async (t) => {
  const app = await fixture(t);
  const json = successful(
    await app.run<{ contractVersion: number; taskContextContractVersion: number; version: string }>(
      ["meta"],
    ),
  ).data;
  assert.equal(json.contractVersion, API_CONTRACT_VERSION);
  assert.equal(json.taskContextContractVersion, 1);
  const version = await invokeRaw(app.root, ["-V"]);
  assert.equal(version.stdout.trim(), json.version);
  const text = await invokeRaw(app.root, ["meta"]);
  assert.equal(text.code, 0);
  assert(text.stdout.includes("Версия договора API"));
});
