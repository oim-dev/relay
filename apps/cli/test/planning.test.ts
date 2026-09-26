import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanningSaved, PlanSummary } from "@relay/contracts/planning";
import { planningCandidatesPageSchema, stagesPageSchema } from "@relay/contracts/planning";
import {
  releaseCompositionSchema,
  releaseSummarySchema,
  releasesPageSchema,
} from "@relay/contracts/releases";
import { entityDetailSchema } from "@relay/contracts/entities";
import { releaseProgressSchema } from "@relay/contracts/progress";
import { openWorkspace } from "@relay/core/storage/workspace";
import { PlanningService } from "@relay/core/application/planning/service";
import { ReleasesService } from "@relay/core/application/releases/service";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { startServer } from "@relay/server-runtime";
import { fixture, invoke, invokeRaw, successful, failed } from "./helpers/cli.js";
import { planningSavedText } from "../src/presentation/planning.js";

test("CLI планирования: предметные аргументы, Markdown, ревизии, этапы и human/JSON", async (t) => {
  const { root } = await fixture(t);
  const created = successful(
    await invoke<PlanningSaved>(root, [
      "--actor",
      "human",
      "plan",
      "create",
      "--title",
      "План CLI",
      "--goal",
      "## Цель\n\nПроверить команду",
      "--request-id",
      "plan",
    ]),
  ).data;
  const stage = successful(
    await invoke<PlanningSaved>(root, [
      "--actor",
      "human",
      "plan",
      "stage",
      "create",
      created.id,
      "--title",
      "Этап",
      "--if-revision",
      created.revision,
      "--request-id",
      "stage",
    ]),
  ).data;
  assert(stage.stageId);
  const updated = successful(
    await invoke<PlanningSaved>(root, [
      "--actor",
      "human",
      "plan",
      "update",
      created.id,
      "--summary",
      "Краткое описание",
      "--if-revision",
      stage.revision,
      "--request-id",
      "update",
    ]),
  ).data;
  assert.equal(updated.revision, stage.revision + 1);
  const plan = successful(await invoke<PlanSummary>(root, ["plan", "get", created.id])).data;
  assert.equal(plan.goal, "## Цель\n\nПроверить команду");
  const text = await invokeRaw(root, ["plan", "get", created.id, "--color", "never"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /План CLI/);
  assert.match(text.stdout, /Проверить команду/);
  assert(!text.stdout.includes('"goal"'));
  const other = successful(
    await invoke<PlanningSaved>(root, [
      "--actor",
      "human",
      "plan",
      "create",
      "--title",
      "План второй",
      "--request-id",
      "second",
    ]),
  ).data;
  const page = await invokeRaw(root, [
    "plan",
    "list",
    "--limit",
    1,
    "--q",
    "П",
    "--color",
    "never",
  ]);
  assert.equal(page.code, 0, page.stderr);
  assert.match(page.stdout, /Продолжение:/);
  assert.match(page.stdout, /--snapshot-version/);
  assert.match(page.stdout, /--q 'П'/);
  const previewArgs = ["release", "preview", "--plans", created.id, other.id, "--limit", 1];
  const preview = releaseCompositionSchema.parse(successful(await invoke(root, previewArgs)).data);
  assert.equal(preview.total, 2);
  assert.equal(preview.readiness.canRelease, false);
  const previewText = await invokeRaw(root, previewArgs);
  assert.equal(previewText.code, 0, previewText.stderr);
  assert(previewText.stdout.includes(`--plans '${created.id}' '${other.id}'`));
  const next = releaseCompositionSchema.parse(
    successful(
      await invoke(root, [...previewArgs, "--offset", 1, "--snapshot-version", preview.version]),
    ).data,
  );
  assert.equal(next.items[0]?.id, other.id);
  const task = successful(
    await invoke<{ id: string }>(root, [
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Выбор CLI",
      "--request-id",
      "candidate",
    ]),
  ).data;
  const candidates = planningCandidatesPageSchema.parse(
    successful(await invoke(root, ["plan", "candidates", "--q", "Выбор", "--board", "product"]))
      .data,
  );
  assert.equal(candidates.items[0]?.id, task.id);
  const targetStage = successful(
    await invoke<PlanningSaved>(root, [
      "plan",
      "stage",
      "create",
      other.id,
      "--title",
      "Целевой этап",
      "--if-revision",
      other.revision,
    ]),
  ).data;
  assert(targetStage.stageId);
  const included = successful(
    await invoke<PlanningSaved>(root, [
      "plan",
      "include",
      created.id,
      stage.stageId,
      "--tasks",
      task.id,
      "--if-revision",
      updated.revision,
    ]),
  ).data;
  const selected = planningCandidatesPageSchema.parse(
    successful(
      await invoke(root, ["plan", "candidates", "--plan", created.key, "--stage", stage.stageId]),
    ).data,
  );
  assert.equal(selected.items[0]?.id, task.id);
  const transfer = [
    "plan",
    "transfer",
    created.key,
    task.id,
    targetStage.stageId,
    "--if-revision",
    included.revision,
    "--target-revision",
    targetStage.revision,
    "--reason",
    "Согласованный перенос",
    "--request-id",
    "transfer",
  ];
  const missingTarget = await invokeRaw(root, transfer);
  assert.equal(missingTarget.code, 2);
  assert.match(missingTarget.stdout, /--target-plan/);
  transfer.push("--target-plan", other.key);
  const moved = successful(await invoke<PlanningSaved>(root, transfer)).data;
  assert.equal(moved.targetRevision, targetStage.revision + 1);
  assert.match(planningSavedText(moved), /Задача перенесена/);
  assert.match(planningSavedText(moved), /Ревизия целевого плана:/);
  failed(await invoke(root, transfer), "REVISION_CONFLICT", 4);
  const movedText = await invokeRaw(root, transfer);
  assert.equal(movedText.code, 4, movedText.stdout + movedText.stderr);
  assert.equal(movedText.stderr, "");
  const release = successful(
    await invoke<PlanningSaved>(root, [
      "--actor",
      "human",
      "release",
      "create",
      "--title",
      "Будущий",
      "--release-version",
      "0.1",
      "--plans",
      created.id,
      "--request-id",
      "release",
    ]),
  ).data;
  assert(release.id);
});

test("CLI stage update: этап за пределами 100 записей, сохранность полей, повтор и ревизия плана в local/HTTP", async (t) => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  // Сервер останавливается до удаления временной базы обработчиком fixture.
  t.after(() => server?.close());
  const { root } = await fixture(t);
  const workspace = await openWorkspace(root);
  assert(workspace.config.projectId);
  const plans = new PlanningService(workspace);
  const plan = await plans.create({ title: "Большой план", requestId: "plan" }, "human");
  const fields = {
    title: "Последний этап",
    summary: "Первая строка\nВторая строка",
    outcome: "## Результат\n\n- Проверка  \n- Приёмка\n",
    completionConditions: "## Условия\n\nСохранить Markdown\n",
  };
  let revision = plan.revision;
  let stageId = "";
  for (let index = 0; index < 101; index++) {
    const stage = await plans.changeStage(
      plan.id,
      {
        action: "create",
        fields: index === 100 ? fields : { title: `Этап ${index + 1}` },
        ifRevision: revision,
        requestId: `stage-${index}`,
      },
      "human",
    );
    revision = stage.revision;
    stageId = stage.stageId;
  }
  const task = await new BoardTasksService(workspace).create(
    {
      board: "product",
      title: "Сохранить состав",
      requestId: "task",
    },
    "human",
  );
  revision = (
    await plans.changeTasks(
      plan.id,
      {
        stage: stageId,
        add: [task.id],
        ifRevision: revision,
        requestId: "include",
      },
      "human",
    )
  ).revision;
  server = await startServer({ cwd: root, actor: "server", port: 0 });
  for (const [mode, transport] of [
    ["local", ["--local"]],
    ["HTTP", ["--server-url", server.url, "--project", workspace.config.projectId]],
  ] as const) {
    const command = [
      ...transport,
      "plan",
      "stage",
      "update",
      plan.key,
      stageId,
      "--title",
      `Обновлённый ${mode}`,
      "--if-revision",
      revision,
      "--request-id",
      `update-${mode}`,
    ];
    const saved = successful(await invoke<PlanningSaved>(root, command)).data;
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.stageId, stageId);
    assert.match(planningSavedText(saved), /Этап изменён/);
    assert(planningSavedText(saved).includes(`ID владельца: ${plan.id}`));
    failed(await invoke(root, command), "REVISION_CONFLICT", 4);
    const repeated = await invokeRaw(root, command);
    assert.equal(repeated.code, 4, repeated.stdout + repeated.stderr);
    assert.equal(repeated.stderr, "");
    const full = entityDetailSchema.parse(
      successful(
        await invoke(root, [...transport, "entities", "get", plan.key, "--max-bytes", 131072]),
      ).data,
    );
    assert.equal(full.data.kind, "work-plan");
    if (full.data.kind !== "work-plan") throw new Error("Ожидался план работ");
    const last = full.data.stages.find((stage) => stage.id === stageId)!;
    assert.deepEqual(last, {
      ...fields,
      id: stageId,
      title: `Обновлённый ${mode}`,
      taskIds: [task.id],
    });
    assert.equal("key" in last, false);
    assert.equal("revision" in last, false);
    failed(
      await invoke(root, [...command.slice(0, -2), "--request-id", `stale-${mode}`]),
      "REVISION_CONFLICT",
      4,
    );
    revision = saved.revision;
  }
  const page = stagesPageSchema.parse(
    successful(
      await invoke(root, ["plan", "stages", plan.key, "--limit", 100, "--max-bytes", 131072]),
    ).data,
  );
  assert.equal(page.nextOffset, 100);
  const text = await invokeRaw(root, [
    "--local",
    "plan",
    "stages",
    plan.key,
    "--limit",
    100,
    "--max-bytes",
    131072,
  ]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /ID этапа/);
  assert.doesNotMatch(text.stdout, /STG-/);
  assert.match(text.stdout, /--local plan stages PLN-1 .*--offset '100'/);
  assert.match(text.stdout, /--max-bytes '131072'/);
  const next = stagesPageSchema.parse(
    successful(
      await invoke(root, [
        "plan",
        "stages",
        plan.key,
        "--limit",
        100,
        "--offset",
        100,
        "--snapshot-version",
        page.version,
      ]),
    ).data,
  );
  assert.equal(next.items[0]?.id, stageId);
  assert.equal(next.nextOffset, null);
  failed(
    await invoke(root, [
      "plan",
      "stage",
      "update",
      plan.key,
      "unknown-stage",
      "--title",
      "Нет",
      "--if-revision",
      revision,
    ]),
    "INVALID_REFERENCE",
    4,
  );
  failed(await invoke(root, ["plan", "candidates", "--stage", stageId]), "INVALID_ARGUMENT");
  const clear = successful(
    await invoke<PlanningSaved>(root, [
      "plan",
      "stage",
      "update",
      plan.key,
      stageId,
      "--summary",
      "",
      "--if-revision",
      revision,
    ]),
  ).data;
  assert.equal(clear.revision, revision + 1);
  assert.equal(
    (
      await plans.stages(plan.id, {
        limit: 100,
        offset: 100,
        version: (await plans.stages(plan.id, { limit: 100 })).version,
      })
    ).items[0]?.summary,
    "",
  );
});

test("CLI частичного изменения этапа: повтор после отдельной правки описания, очистка и пустой ввод в local/HTTP", async (t) => {
  const { root } = await fixture(t);
  const workspace = await openWorkspace(root);
  assert(workspace.config.projectId);
  const plans = new PlanningService(workspace);
  const plan = await plans.create({ title: "Частичное изменение", requestId: "plan" }, "human");
  const fields = {
    title: "Исходный этап",
    summary: "Исходное описание",
    outcome: "## Результат\n\n- Не потерять Markdown\n",
    completionConditions: "## Условия\n\nПроверить повтор\n",
  };
  const stage = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields,
      ifRevision: plan.revision,
      requestId: "stage",
    },
    "human",
  );
  let revision = stage.revision;
  const server = await startServer({ cwd: root, actor: "server", port: 0 });
  t.after(() => server.close());
  for (const [mode, transport] of [
    ["local", ["--local"]],
    ["HTTP", ["--server-url", server.url, "--project", workspace.config.projectId]],
  ] as const) {
    const update = [...transport, "plan", "stage", "update", plan.key, stage.stageId];
    const titleCommand = [
      ...update,
      "--title",
      `Название ${mode}`,
      "--if-revision",
      revision,
      "--request-id",
      `title-${mode}`,
    ];
    const title = successful(await invoke<PlanningSaved>(root, titleCommand)).data;
    assert(planningSavedText(title).includes(`Ревизия: ${title.revision}`));
    assert(planningSavedText(title).includes(`Идентификатор запроса: title-${mode}`));
    const summary = `Отдельная правка ${mode}\nВторая строка`;
    const description = successful(
      await invoke<PlanningSaved>(root, [
        ...update,
        "--summary",
        summary,
        "--if-revision",
        title.revision,
        "--actor",
        "another-agent",
        "--request-id",
        `summary-${mode}`,
      ]),
    ).data;
    failed(await invoke(root, titleCommand), "REVISION_CONFLICT", 4);
    const repeated = await invokeRaw(root, titleCommand);
    assert.equal(repeated.code, 4, repeated.stdout + repeated.stderr);
    assert.equal(repeated.stderr, "");
    const read = async () =>
      stagesPageSchema.parse(
        successful(await invoke(root, [...transport, "plan", "stages", plan.key])).data,
      );
    const afterReplay = await read();
    assert.equal(afterReplay.planRevision, description.revision);
    assert.equal(afterReplay.items[0]?.title, `Название ${mode}`);
    assert.equal(afterReplay.items[0]?.summary, summary);
    assert.equal(afterReplay.items[0]?.outcome, fields.outcome);
    assert.equal(afterReplay.items[0]?.completionConditions, fields.completionConditions);
    const clearCommand = [
      ...update,
      "--summary",
      "",
      "--outcome",
      "",
      "--completion-conditions",
      "",
      "--if-revision",
      description.revision,
      "--request-id",
      `clear-${mode}`,
    ];
    const cleared = successful(await invoke<PlanningSaved>(root, clearCommand)).data;
    failed(await invoke(root, clearCommand), "REVISION_CONFLICT", 4);
    const emptyCommand = [
      ...update,
      "--if-revision",
      cleared.revision,
      "--request-id",
      `empty-${mode}`,
    ];
    failed(await invoke(root, emptyCommand), "INVALID_ARGUMENT");
    const emptyText = await invokeRaw(root, emptyCommand);
    assert.equal(emptyText.code, 2);
    assert.match(emptyText.stdout, /изменени|пол[ея]/i);
    const afterEmpty = await read();
    assert.equal(afterEmpty.planRevision, cleared.revision);
    assert.equal(afterEmpty.items[0]?.title, `Название ${mode}`);
    assert.equal(afterEmpty.items[0]?.summary, "");
    assert.equal(afterEmpty.items[0]?.outcome, "");
    assert.equal(afterEmpty.items[0]?.completionConditions, "");
    const restore = await plans.changeStage(
      plan.id,
      {
        action: "update",
        stage: stage.stageId,
        fields,
        ifRevision: cleared.revision,
        requestId: `restore-${mode}`,
      },
      "human",
    );
    failed(await invoke(root, clearCommand), "REVISION_CONFLICT", 4);
    const afterClearReplay = await read();
    assert.equal(afterClearReplay.planRevision, restore.revision);
    assert.equal(afterClearReplay.items[0]?.summary, fields.summary);
    assert.equal(afterClearReplay.items[0]?.outcome, fields.outcome);
    assert.equal(afterClearReplay.items[0]?.completionConditions, fields.completionConditions);
    revision = restore.revision;
  }
  const help = await invokeRaw(root, ["plan", "stage", "update", "--help"]);
  assert.match(help.stdout, /Изменить только переданные поля этапа/);
  assert.match(help.stdout, /пустая строка очищает/);
});

test("CLI релиза: состав и готовность обновляются после выпуска, human и JSON сохраняют факт выпуска", async (t) => {
  const { root } = await fixture(t);
  const workspace = await openWorkspace(root);
  assert(workspace.config.projectId);
  const plans = new PlanningService(workspace);
  const releases = new ReleasesService(workspace);
  const tasks = new BoardTasksService(workspace);
  const task = await tasks.create(
    { board: "product", title: "Результат", column: "done", requestId: "task" },
    "human",
  );
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const plan = await plans.create(
      { title: `План ${index + 1}`, requestId: `plan-${index}` },
      "human",
    );
    const stage = await plans.changeStage(
      plan.id,
      {
        action: "create",
        fields: { title: "Этап" },
        ifRevision: plan.revision,
        requestId: `stage-${index}`,
      },
      "human",
    );
    const included = await plans.changeTasks(
      plan.id,
      {
        stage: stage.stageId,
        add: [task.id],
        ifRevision: stage.revision,
        requestId: `include-${index}`,
      },
      "human",
    );
    await plans.transition(
      plan.id,
      {
        action: "complete",
        result: "Проверено",
        ifRevision: included.revision,
        requestId: `complete-${index}`,
      },
      "human",
    );
    ids.push(plan.id);
  }
  const release = await releases.create(
    { title: "Проверенный выпуск", version: "1.0", planIds: ids, requestId: "release" },
    "human",
  );
  const publish = [
    "release",
    "publish",
    release.key,
    "--if-revision",
    release.revision,
    "--request-id",
    "publish",
  ];
  successful(await invoke<PlanningSaved>(root, publish));
  const published = releaseSummarySchema.parse(
    successful(await invoke(root, ["release", "get", release.key])).data,
  );
  assert.equal(published.readiness.ready, 2);
  assert.equal("snapshotId" in published, false);
  const oldPage = releaseCompositionSchema.parse(
    successful(await invoke(root, ["release", "plans", release.key, "--limit", 1])).data,
  );
  await tasks.move(task.id, { column: "ready", ifRevision: 1, requestId: "reopen" }, "human");
  failed(await invoke(root, publish), "REVISION_CONFLICT", 4);
  const server = await startServer({ cwd: root, actor: "server", port: 0 });
  t.after(() => server.close());
  for (const transport of [
    ["--local"],
    ["--server-url", server.url, "--project", workspace.config.projectId],
  ]) {
    const command = [...transport, "release", "get", release.key];
    const current = releaseSummarySchema.parse(successful(await invoke(root, command)).data);
    assert.equal(current.status, "released");
    assert.equal(current.releasedAt, published.releasedAt);
    assert.equal(current.releasedBy, published.releasedBy);
    assert.equal(current.readiness.ready, 0);
    const text = await invokeRaw(root, command);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Состояние: Выпущен/);
    assert.match(text.stdout, /Текущая готовность: 0\/2 планов/);
    assert(text.stdout.includes(published.releasedAt!));
    assert.doesNotMatch(text.stdout, /snapshot|снимок|"readiness"/i);
    const first = releaseCompositionSchema.parse(
      successful(await invoke(root, [...transport, "release", "plans", release.key, "--limit", 1]))
        .data,
    );
    assert.equal(first.items[0]?.plan?.counts.completed, 0);
    const next = releaseCompositionSchema.parse(
      successful(
        await invoke(root, [
          ...transport,
          "release",
          "plans",
          release.key,
          "--limit",
          1,
          "--offset",
          1,
          "--snapshot-version",
          first.version,
        ]),
      ).data,
    );
    assert.equal(next.items[0]?.id, ids[1]);
    assert.equal(next.nextOffset, null);
    const compositionText = await invokeRaw(root, [
      ...transport,
      "release",
      "plans",
      release.key,
      "--limit",
      1,
    ]);
    assert.match(compositionText.stdout, /текущая готовность: 0\/2/);
    assert.match(compositionText.stdout, /--snapshot-version/);
    const progress = releaseProgressSchema.parse(
      successful(await invoke(root, [...transport, "progress", "release", release.key])).data,
    );
    assert.equal(progress.completed, false);
    assert.equal(progress.status, "released");
    const progressText = await invokeRaw(root, [...transport, "progress", "release", release.key]);
    assert.match(progressText.stdout, /Состояние: Выпущен/);
    assert.match(progressText.stdout, /Источник: актуальные планы/);
    const list = releasesPageSchema.parse(
      successful(await invoke(root, [...transport, "release", "list", "--status", "released"]))
        .data,
    );
    assert.equal(list.items[0]?.readiness.ready, 0);
  }
  failed(
    await invoke(root, [
      "release",
      "plans",
      release.key,
      "--limit",
      1,
      "--offset",
      1,
      "--snapshot-version",
      oldPage.version,
    ]),
    "PLANNING_CHANGED",
    4,
  );
  for (const args of [
    ["plan", "stage", "update"],
    ["plan", "transfer"],
    ["plan", "candidates"],
    ["release"],
  ]) {
    const help = await invokeRaw(root, [...args, "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Пример/);
    assert.doesNotMatch(help.stdout, /STG-|release snapshot|storage migrate/);
    if (args.includes("transfer")) assert.match(help.stdout, /--target-plan/);
    if (args.includes("candidates")) assert.match(help.stdout, /требует --plan/);
  }
  const removed = await invokeRaw(root, ["release", "snapshot", release.key]);
  assert.equal(removed.code, 2);
});
