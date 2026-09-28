import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanningSaved, PlanSummary, PlanStage } from "@relay/contracts/planning";
import type { Progress } from "@relay/contracts/progress";
import { startServer } from "@relay/server-runtime";
import { openWorkspace } from "@relay/core/storage/workspace";
import { PlanningService } from "@relay/core/application/planning/service";
import { fixture, invoke, invokeRaw, successful, failed } from "./helpers/cli.js";

type Page<T> = { items: T[]; total: number; nextOffset: number | null; version: string };
type Stage = PlanStage & { planId: string; planKey: string; planRevision: number };
const narrow = { env: { COLUMNS: "40", FORCE_COLOR: "3", NO_COLOR: undefined } };

function human(result: Awaited<ReturnType<typeof invokeRaw>>, fragments: string[]) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|"ok"\s*:|\[object Object\]/);
  for (const fragment of fragments)
    assert.ok(result.stdout.includes(fragment), `Нет ${fragment}:\n${result.stdout}`);
  return result.stdout;
}

test(
  "plan stage за первой сотней: страницы, get/update/move/remove и guards в local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    t.after(async () => {
      await server?.close();
    });
    const { root, run } = await fixture(t);
    const workspace = await openWorkspace(root);
    assert.ok(workspace.config.projectId);
    const plans = new PlanningService(workspace);
    // Подготовка только предметными операциями; проверяемые чтения и изменения — через CLI.
    const plan = await plans.create(
      { title: "Больше ста этапов", requestId: "large-plan" },
      "test-agent",
    );
    let revision = plan.revision;
    const expected = new Map<string, PlanStage>();
    let order: string[] = [];
    for (let index = 0; index < 104; index++) {
      const fields = {
        title: `Этап ${index + 1}`,
        summary: `Описание ${index + 1}\nВторая строка 世界`,
        outcome: `## Результат ${index + 1}\n\n- Приёмка  \n\n\`\`\`text\n  значимый отступ\n\`\`\`\n`,
        completionConditions: `## Условия ${index + 1}\n\nСохранить весь Markdown\n`,
      };
      const created = await plans.changeStage(
        plan.id,
        {
          action: "create",
          fields,
          ifRevision: revision,
          requestId: `seed-stage-${index}`,
        },
        "test-agent",
      );
      assert.ok(created.stageId);
      revision = created.revision;
      order.push(created.stageId);
      expected.set(created.stageId, { ...fields, id: created.stageId, taskIds: [] });
    }
    const stage101 = order[100]!;
    const stage102 = order[101]!;
    const stage103 = order[102]!;
    const stage104 = order[103]!;
    const task = successful(
      await run<{ key: string; ref: { id: string } }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Состав 101-го этапа",
      ]),
    ).data;
    revision = (
      await plans.changeTasks(
        plan.id,
        {
          stage: stage101,
          add: [task.ref.id],
          ifRevision: revision,
          requestId: "seed-stage-tasks",
        },
        "test-agent",
      )
    ).revision;
    expected.get(stage101)!.taskIds = [task.ref.id];
    server = await startServer({ cwd: root, actor: "test-server", port: 0 });
    for (const [mode, transport, removable] of [
      ["local", ["--local"], stage104],
      ["HTTP", ["--server-url", server.url, "--project", workspace.config.projectId], stage103],
    ] as const) {
      const listCommand = [...transport, "plan", "stage", "list", plan.key];
      const read = async (id: string) =>
        successful(await run<Stage>([...transport, "plan", "stage", "get", plan.key, id])).data;
      const checkPages = async () => {
        const first = successful(
          await run<Page<PlanStage> & { planRevision: number }>([...listCommand, "--limit", 100]),
        );
        assert.equal(first.data.planRevision, revision);
        assert.equal(first.meta?.page?.count, 100);
        assert.equal(first.meta?.page?.total, order.length);
        assert.equal(first.meta?.page?.limit, 100);
        assert.deepEqual(
          first.data.items.map((item) => item.id),
          order.slice(0, 100),
        );
        assert.ok(first.meta?.page?.nextCursor);
        // Ни limit, ни offset, ни версия не передаются повторно: их восстанавливает cursor.
        const rest = successful(
          await run<Page<PlanStage> & { planRevision: number }>([
            ...listCommand,
            "--cursor",
            first.meta.page.nextCursor,
          ]),
        );
        assert.equal(rest.data.planRevision, revision);
        assert.equal(rest.meta?.page?.count, order.length - 100);
        assert.equal(rest.meta?.page?.total, order.length);
        assert.equal(rest.meta?.page?.limit, 100);
        assert.equal(rest.meta?.page?.nextCursor, null);
        assert.equal(rest.meta?.page?.nextCommand, null);
        assert.equal(rest.data.version, first.data.version);
        assert.deepEqual(
          rest.data.items.map((item) => item.id),
          order.slice(100),
        );
        assert.equal(
          new Set([...first.data.items, ...rest.data.items].map((item) => item.id)).size,
          order.length,
        );
        return first.meta.page.nextCursor;
      };
      assert.ok(order.indexOf(stage101) >= 100 && order.indexOf(stage102) >= 100);
      const cursor = await checkPages();
      for (const id of [stage101, stage102]) {
        assert.deepEqual(await read(id), {
          ...expected.get(id),
          planId: plan.id,
          planKey: plan.key,
          planRevision: revision,
        });
        human(await invokeRaw(root, [...transport, "plan", "stage", "get", plan.key, id], narrow), [
          plan.key,
          id,
          expected.get(id)!.title,
          "Ревизия плана",
          "## Результат",
          "  значимый отступ",
          "Сохранить весь Markdown",
        ]);
      }
      const update = [
        ...transport,
        "plan",
        "stage",
        "update",
        plan.key,
        stage101,
        "--title",
        `Обновлённый ${mode}`,
        "--if-revision",
        revision,
        "--request-id",
        `update-${mode}`,
      ];
      const saved = successful(await run<PlanningSaved>(update)).data;
      assert.equal(saved.revision, revision + 1);
      assert.equal(saved.stageId, stage101);
      revision = saved.revision;
      expected.get(stage101)!.title = `Обновлённый ${mode}`;
      const afterUpdate = await read(stage101);
      assert.deepEqual(afterUpdate, {
        ...expected.get(stage101),
        planId: plan.id,
        planKey: plan.key,
        planRevision: revision,
      });
      failed(await run(update), "REVISION_CONFLICT", 4);
      failed(
        await run([...update.slice(0, -2), "--request-id", `different-stale-${mode}`]),
        "REVISION_CONFLICT",
        4,
      );
      const repeated = await invokeRaw(root, update, narrow);
      assert.equal(repeated.code, 4);
      assert.equal(repeated.stderr, "");
      assert.deepEqual(await read(stage101), afterUpdate);
      failed(await run([...listCommand, "--cursor", cursor]), "PLANNING_CHANGED", 4);
      failed(
        await run([
          ...transport,
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
      assert.deepEqual(await read(stage101), afterUpdate);
      const clear = successful(
        await run<PlanningSaved>([
          ...transport,
          "plan",
          "stage",
          "update",
          plan.key,
          stage101,
          "--summary",
          "",
          "--if-revision",
          revision,
        ]),
      ).data;
      assert.equal(clear.revision, revision + 1);
      revision = clear.revision;
      expected.get(stage101)!.summary = "";
      assert.deepEqual(await read(stage101), {
        ...expected.get(stage101),
        planId: plan.id,
        planKey: plan.key,
        planRevision: revision,
      });
      assert.ok(order.indexOf(removable) >= 100);
      const remove = [
        ...transport,
        "plan",
        "stage",
        "remove",
        plan.key,
        removable,
        "--if-revision",
        revision,
      ];
      const removed = successful(await run<PlanningSaved>(remove)).data;
      assert.equal(removed.revision, revision + 1);
      revision = removed.revision;
      order = order.filter((id) => id !== removable);
      failed(await run(remove), "REVISION_CONFLICT", 4);
      failed(
        await run([...transport, "plan", "stage", "get", plan.key, removable]),
        "NOT_FOUND",
        4,
      );
      assert.ok(order.indexOf(stage102) >= 100);
      const move = [
        ...transport,
        "plan",
        "stage",
        "move",
        plan.key,
        stage102,
        "--before",
        order[0]!,
        "--if-revision",
        revision,
      ];
      const moved = successful(await run<PlanningSaved>(move)).data;
      assert.equal(moved.revision, revision + 1);
      revision = moved.revision;
      order = [stage102, ...order.filter((id) => id !== stage102)];
      failed(await run(move), "REVISION_CONFLICT", 4);
      await checkPages();
      const last = successful(
        await run<PlanningSaved>([
          ...transport,
          "plan",
          "stage",
          "move",
          plan.key,
          stage102,
          "--if-revision",
          revision,
        ]),
      ).data;
      assert.equal(last.revision, revision + 1);
      revision = last.revision;
      order = [...order.filter((id) => id !== stage102), stage102];
      await checkPages();
      assert.deepEqual(await read(stage101), {
        ...expected.get(stage101),
        planId: plan.id,
        planKey: plan.key,
        planRevision: revision,
      });
      assert.deepEqual(await read(stage102), {
        ...expected.get(stage102),
        planId: plan.id,
        planKey: plan.key,
        planRevision: revision,
      });
      assert.equal(
        successful(await run<PlanSummary>(["--local", "plan", "get", plan.key])).data.stageCount,
        order.length,
      );
    }
  },
);

test(
  "plan human: квитанции действий, полный этап без встроенного списка задач и исполнимые следующие шаги",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const other = await fixture(t);
    const config = join(root, ".relay/config.json");
    const executeHint = async (text: string) => {
      const command = text.split("\n").find((line) => line.startsWith("npx @oim-dev/relay-cli "));
      assert.ok(command, "Квитанция даёт копируемую команду чтения");
      const args = command
        .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
        .slice(2)
        .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg));
      assert.ok(args.includes("--config"));
      successful(await invoke(other.root, args, { env: { RELAY_CONFIG: undefined } }));
      return args;
    };
    const receipt = async (
      args: Array<string | number>,
      action: RegExp,
      key: string,
      revision: number,
      stageId?: string,
    ) => {
      const text = human(
        await invokeRaw(other.root, args, { env: { ...narrow.env, RELAY_CONFIG: config } }),
        [key, "Ревизия"],
      );
      assert.match(text.replace(/\s+/g, " "), action);
      assert.match(text, new RegExp(`Ревизия:\\s*${revision}(?:\\s|$)`));
      if (stageId) assert.ok(text.includes(stageId), "Квитанция адресует изменённый этап");
      await executeHint(text);
      return text;
    };
    await receipt(["plan", "create", "--title", "Читаемая квитанция"], /создан/i, "PLN-1", 1);
    const empty = human(await invokeRaw(root, ["plan", "get", "PLN-1"], narrow), [
      "PLN-1",
      "Черновик",
    ]);
    assert.match(empty.replace(/\s+/g, " "), /Цель:.*[Нн]е задана/);
    assert.match(empty.replace(/\s+/g, " "), /Состав:.*[Зз]адач нет/);
    assert.doesNotMatch(empty, /Обоснование|Ожидаемый результат|Краткое описание|Границы|Итог/);
    await receipt(
      ["plan", "update", "PLN-1", "--goal", "Цель", "--if-revision", 1],
      /сохранен|сохранён/i,
      "PLN-1",
      2,
    );
    const fullStageText =
      Array.from({ length: 600 }, (_, index) => `Этап-строка-${index}: полное содержание`).join(
        "\n",
      ) + "\nКОНЕЦ-ЭТАПА";
    const texts = {
      summary: "Краткое этапа",
      outcome: "## Результат 世界\n\n```text\n  сохранить отступ\n```\n\n" + fullStageText,
      completionConditions: "## Условия\n\n- Внешняя приёмка",
    };
    const created = await receipt(
      [
        "plan",
        "stage",
        "create",
        "PLN-1",
        "--title",
        "Читаемый этап",
        "--summary",
        texts.summary,
        "--outcome",
        texts.outcome,
        "--completion-conditions",
        texts.completionConditions,
        "--if-revision",
        2,
      ],
      /[Ээ]тап создан/,
      "PLN-1",
      3,
    );
    const stages = successful(await run<Page<PlanStage>>(["plan", "stage", "list", "PLN-1"])).data
      .items;
    const stage = stages[0]!;
    assert.ok(created.includes(stage.id));
    await receipt(
      [
        "plan",
        "stage",
        "update",
        "PLN-1",
        stage.id,
        "--title",
        "Уточнённый этап",
        "--if-revision",
        3,
      ],
      /[Ээ]тап изменён/,
      "PLN-1",
      4,
      stage.id,
    );
    await receipt(
      ["plan", "stage", "move", "PLN-1", stage.id, "--if-revision", 4],
      /[Пп]орядок.*изменён/,
      "PLN-1",
      5,
      stage.id,
    );
    const tasks: { key: string; ref: { id: string } }[] = [];
    for (let i = 0; i < 2; i++)
      tasks.push(
        successful(
          await run<{ key: string; ref: { id: string } }>([
            "task",
            "create",
            "--board",
            "product",
            "--title",
            `Состав ${i}`,
            "--column",
            "done",
          ]),
        ).data,
      );
    await receipt(
      [
        "plan",
        "stage",
        "task",
        "add",
        "PLN-1",
        stage.id,
        "--tasks",
        ...tasks.map((x) => x.key),
        "--if-revision",
        5,
      ],
      /[Зз]адач|[Сс]остав/,
      "PLN-1",
      6,
      stage.id,
    );
    const detail = successful(await run<Stage>(["plan", "stage", "get", "PLN-1", stage.id])).data;
    assert.deepEqual(
      detail.taskIds,
      tasks.map((x) => x.ref.id),
    );
    assert.deepEqual(
      [detail.summary, detail.outcome, detail.completionConditions],
      [texts.summary, texts.outcome, texts.completionConditions],
    );
    const stageText = human(
      await invokeRaw(root, ["plan", "stage", "get", "PLN-1", stage.id], narrow),
      [
        stage.id,
        "PLN-1",
        "Уточнённый этап",
        "Краткое этапа",
        "## Результат",
        "  сохранить отступ",
        "Внешняя приёмка",
      ],
    );
    assert.match(stageText, /Задач в составе:\s*2/);
    assert.ok(stageText.includes("КОНЕЦ-ЭТАПА"));
    for (let index = 0; index < 600; index++)
      assert.ok(stageText.includes(`Этап-строка-${index}:`), `Потеряна строка этапа ${index}`);
    for (const task of tasks) {
      assert.ok(!stageText.includes(task.ref.id));
      assert.ok(!stageText.includes(task.key));
    }
    const hint = await executeHint(stageText);
    assert.deepEqual(hint.slice(-6), ["plan", "stage", "task", "list", "PLN-1", stage.id]);
    await receipt(
      [
        "plan",
        "stage",
        "task",
        "remove",
        "PLN-1",
        stage.id,
        "--tasks",
        tasks[1]!.key,
        "--if-revision",
        6,
      ],
      /[Зз]адач|[Сс]остав/,
      "PLN-1",
      7,
      stage.id,
    );
    await receipt(["plan", "start", "PLN-1", "--if-revision", 7], /[Пп]лан начат/, "PLN-1", 8);
    await receipt(
      ["plan", "complete", "PLN-1", "--result", "Итог проверен", "--if-revision", 8],
      /[Пп]лан завершён/,
      "PLN-1",
      9,
    );
    await receipt(["plan", "create", "--title", "Отменяемый"], /создан/i, "PLN-2", 1);
    await receipt(
      ["plan", "stage", "create", "PLN-2", "--title", "Удаляемый этап", "--if-revision", 1],
      /[Ээ]тап создан/,
      "PLN-2",
      2,
    );
    const removed = successful(await run<Page<PlanStage>>(["plan", "stage", "list", "PLN-2"])).data
      .items[0]!;
    await receipt(
      ["plan", "stage", "remove", "PLN-2", removed.id, "--if-revision", 2],
      /[Ээ]тап удалён/,
      "PLN-2",
      3,
      removed.id,
    );
    await receipt(
      ["plan", "cancel", "PLN-2", "--result", "Причина отмены", "--if-revision", 3],
      /[Оо]тмен/,
      "PLN-2",
      4,
    );
  },
);

test(
  "plan: полное содержание, частичные записи этапов, порядок и все операции состава",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const read = async (key: string) =>
      successful(await run<PlanSummary>(["plan", "get", key])).data;
    const markdown = "## Проверка 世界\n\n- результат\n\n```text\n  отступ\n```\n";
    const large =
      Array.from({ length: 900 }, (_, i) => `Строка-${i}: полный текст 世界`).join("\n") +
      "\nКОНЕЦ-ПЛАНА";
    const file = join(root, "цель с пробелом.md");
    await writeFile(file, large);
    const plan = await save([
      "plan",
      "create",
      "--title",
      "Проверка плана 世界",
      "--goal-file",
      file,
      "--summary",
      "Две строки\nВторая",
      "--rationale",
      markdown,
      "--boundaries",
      "Границы",
      "--expected-result",
      "Ожидание",
      "--participants",
      "Иван",
      "agent",
      "--scope",
      "PRODUCT",
      "--request-id",
      "new-plan",
    ]);
    assert.deepEqual(plan, {
      id: plan.id,
      key: "PLN-1",
      revision: 1,
      action: "create",
      requestId: "new-plan",
    });
    const original = await read(plan.key);
    assert.equal(original.status, "draft");
    assert.equal(original.goal, large);
    assert.equal(original.rationale, markdown);
    assert.deepEqual(original.participants, ["Иван", "agent"]);
    assert.equal(original.scope.length, 1);
    const text = human(await invokeRaw(root, ["plan", "get", plan.key], narrow), [
      plan.key,
      "Черновик",
      "Ревизия",
      "Границы",
      "Ожидание",
      "КОНЕЦ-ПЛАНА",
      "```text",
      "  отступ",
    ]);
    for (let i = 0; i < 900; i++) assert.ok(text.includes(`Строка-${i}:`), `Усечена строка ${i}`);
    assert.doesNotMatch(text, /Итог\s*\n[-─]+\s*\n(?:—|Не задано)/);
    let state = await save([
      "plan",
      "update",
      plan.key,
      "--summary-file",
      "-",
      "--if-revision",
      plan.revision,
    ]);
    // Пустой stdin — явная очистка, не отсутствие поля.
    assert.equal((await read(plan.key)).summary, "");
    assert.equal((await read(plan.key)).goal, large);
    failed(
      await run(["plan", "update", plan.key, "--goal", "Потерять", "--if-revision", plan.revision]),
      "REVISION_CONFLICT",
      4,
    );
    state = await save([
      "plan",
      "update",
      plan.key,
      "--clear-scope",
      "--if-revision",
      state.revision,
    ]);
    assert.deepEqual((await read(plan.key)).scope, []);
    const first = await save([
      "plan",
      "stage",
      "create",
      plan.key,
      "--title",
      "Первый",
      "--summary",
      "Описание этапа",
      "--outcome",
      markdown,
      "--completion-conditions",
      markdown + "Условие",
      "--if-revision",
      state.revision,
    ]);
    assert.ok(first.stageId);
    const second = await save([
      "plan",
      "stage",
      "create",
      plan.key,
      "--title",
      "Второй",
      "--if-revision",
      first.revision,
    ]);
    assert.ok(second.stageId);
    state = await save([
      "plan",
      "stage",
      "update",
      plan.key,
      first.stageId,
      "--title",
      "Первый уточнён",
      "--if-revision",
      second.revision,
    ]);
    const stageRead = async () =>
      successful(await run<Stage>(["plan", "stage", "get", plan.key, first.stageId!])).data;
    assert.deepEqual(await stageRead(), {
      id: first.stageId,
      title: "Первый уточнён",
      summary: "Описание этапа",
      outcome: markdown,
      completionConditions: markdown + "Условие",
      taskIds: [],
      planId: plan.id,
      planKey: plan.key,
      planRevision: state.revision,
    });
    human(await invokeRaw(root, ["plan", "stage", "get", plan.key, first.stageId], narrow), [
      "Первый уточнён",
      first.stageId,
      plan.key,
      "Ревизия",
      "Описание этапа",
      "```text",
      "Условие",
    ]);
    failed(
      await run([
        "plan",
        "stage",
        "update",
        plan.key,
        first.stageId,
        "--if-revision",
        state.revision,
      ]),
      "INVALID_ARGUMENT",
    );
    const beforeInvalid = await stageRead();
    failed(
      await run([
        "plan",
        "stage",
        "update",
        plan.key,
        first.stageId,
        "--outcome",
        "x",
        "--outcome-file",
        file,
        "--if-revision",
        state.revision,
      ]),
      "CONFLICTING_OPTIONS",
    );
    assert.deepEqual(await stageRead(), beforeInvalid);
    state = await save([
      "plan",
      "stage",
      "move",
      plan.key,
      second.stageId,
      "--before",
      first.stageId,
      "--if-revision",
      state.revision,
    ]);
    const stages = () => run<Page<PlanStage>>(["plan", "stage", "list", plan.key]);
    assert.deepEqual(
      successful(await stages()).data.items.map((x) => x.id),
      [second.stageId, first.stageId],
    );
    const firstStagePage = successful(
      await run<Page<PlanStage>>(["plan", "stage", "list", plan.key, "--limit", 1]),
    );
    assert.equal(firstStagePage.meta?.page?.total, 2);
    assert.ok(firstStagePage.meta?.page?.nextCursor);
    const secondStagePage = successful(
      await run<Page<PlanStage>>([
        "plan",
        "stage",
        "list",
        plan.key,
        "--cursor",
        firstStagePage.meta.page.nextCursor,
      ]),
    );
    assert.deepEqual(
      [...firstStagePage.data.items, ...secondStagePage.data.items].map((x) => x.id),
      [second.stageId, first.stageId],
    );
    assert.equal(secondStagePage.meta?.page?.nextCursor, null);
    state = await save([
      "plan",
      "stage",
      "move",
      plan.key,
      second.stageId,
      "--if-revision",
      state.revision,
    ]);
    assert.deepEqual(
      successful(await stages()).data.items.map((x) => x.id),
      [first.stageId, second.stageId],
    );
    const task = successful(
      await run<{ ref: { id: string }; key: string }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Реальная задача",
      ]),
    ).data;
    state = await save([
      "plan",
      "stage",
      "task",
      "add",
      plan.key,
      first.stageId,
      "--tasks",
      task.key,
      "--if-revision",
      state.revision,
    ]);
    const tasks = successful(
      await run<Page<{ id: string; key: string; completed: boolean }>>([
        "plan",
        "stage",
        "task",
        "list",
        plan.key,
        first.stageId,
      ]),
    );
    assert.deepEqual(
      tasks.data.items.map((x) => [x.id, x.key, x.completed]),
      [[task.ref.id, task.key, false]],
    );
    assert.deepEqual((await stageRead()).taskIds, [task.ref.id]);
    const beforeRemoval = await read(plan.key);
    const refusal = await run([
      "plan",
      "stage",
      "remove",
      plan.key,
      first.stageId,
      "--if-revision",
      state.revision,
    ]);
    assert.notEqual(refusal.code, 0);
    assert.ok(!refusal.body.ok);
    assert.match(refusal.body.error.message, /задач|пуст/i);
    assert.deepEqual(await read(plan.key), beforeRemoval);
    state = await save([
      "plan",
      "stage",
      "task",
      "remove",
      plan.key,
      first.stageId,
      "--tasks",
      task.key,
      "--if-revision",
      state.revision,
    ]);
    assert.deepEqual((await stageRead()).taskIds, []);
    successful(await run(["task", "get", task.key]));
    state = await save([
      "plan",
      "stage",
      "remove",
      plan.key,
      second.stageId,
      "--if-revision",
      state.revision,
    ]);
    assert.deepEqual(
      successful(await stages()).data.items.map((x) => x.id),
      [first.stageId],
    );
    state = await save([
      "plan",
      "stage",
      "update",
      plan.key,
      first.stageId,
      "--summary",
      "",
      "--outcome",
      "",
      "--completion-conditions",
      "",
      "--if-revision",
      state.revision,
    ]);
    const cleared = await stageRead();
    assert.deepEqual(
      [cleared.summary, cleared.outcome, cleared.completionConditions],
      ["", "", ""],
    );
    human(await invokeRaw(root, ["plan", "stage", "list", plan.key], narrow), [
      first.stageId,
      "Первый уточнён",
    ]);
    human(
      await invokeRaw(root, ["plan", "stage", "task", "list", plan.key, first.stageId], narrow),
      ["нет"],
    );
    const empty = successful(await run<Page<unknown>>(["plan", "list", "--q", "НЕСУЩЕСТВУЮЩИЙ"]));
    assert.deepEqual(empty.data.items, []);
    assert.equal(empty.meta?.page?.total, 0);
    human(await invokeRaw(root, ["plan", "list", "--q", "НЕСУЩЕСТВУЮЩИЙ"], narrow), ["нет"]);
  },
);

test(
  "plan transfer: обе ревизии, атомарный отказ, внутри/между планами и закрытые memberships",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const get = async (key: string) =>
      successful(await run<PlanSummary>(["plan", "get", key])).data;
    const p = await save(["plan", "create", "--title", "Источник", "--goal", "Цель"]);
    const a = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "А",
      "--if-revision",
      p.revision,
    ]);
    const b = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "Б",
      "--if-revision",
      a.revision,
    ]);
    const q = await save(["plan", "create", "--title", "Получатель", "--goal", "Цель"]);
    const c = await save([
      "plan",
      "stage",
      "create",
      q.key,
      "--title",
      "В",
      "--if-revision",
      q.revision,
    ]);
    assert.ok(a.stageId && b.stageId && c.stageId);
    const task = successful(
      await run<{ key: string }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Переносимая",
      ]),
    ).data.key;
    let source = await save([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      a.stageId,
      "--tasks",
      task,
      "--if-revision",
      b.revision,
    ]);
    const transfer = (target: string, stage: string, sr: number, tr: number) => [
      "plan",
      "stage",
      "task",
      "transfer",
      p.key,
      task,
      stage,
      "--target-plan",
      target,
      "--if-revision",
      sr,
      "--target-revision",
      tr,
      "--reason",
      "## Пересмотр\n\nОбъём согласован",
    ];
    const stage = async (plan: string, id: string) =>
      successful(await run<Stage>(["plan", "stage", "get", plan, id])).data;
    const before = await Promise.all([
      get(p.key),
      get(q.key),
      stage(p.key, a.stageId),
      stage(q.key, c.stageId),
    ]);
    for (const [sr, tr] of [
      [source.revision - 1, c.revision],
      [source.revision, c.revision - 1],
    ]) {
      failed(await run(transfer(q.key, c.stageId, sr!, tr!)), "REVISION_CONFLICT", 4);
      assert.deepEqual(
        await Promise.all([
          get(p.key),
          get(q.key),
          stage(p.key, a.stageId),
          stage(q.key, c.stageId),
        ]),
        before,
      );
    }
    source = await save(transfer(p.key, b.stageId, source.revision, source.revision));
    assert.deepEqual((await stage(p.key, a.stageId)).taskIds, []);
    assert.equal((await stage(p.key, b.stageId)).taskIds.length, 1);
    const receipt = human(
      await invokeRaw(root, transfer(q.key, c.stageId, source.revision, c.revision), narrow),
      ["перенесена", "Ревизия", String(source.revision + 1), String(c.revision + 1)],
    );
    assert.match(receipt, /целевого плана/i);
    assert.deepEqual((await stage(p.key, b.stageId)).taskIds, []);
    assert.equal((await stage(q.key, c.stageId)).taskIds.length, 1);
    const memberships = async () =>
      successful(
        await run<Page<{ planKey: string; stageId: string; current: boolean }>>([
          "plan",
          "task",
          "memberships",
          task,
        ]),
      ).data.items;
    assert.deepEqual(
      (await memberships()).map((x) => [x.planKey, x.stageId, x.current]),
      [[q.key, c.stageId, true]],
    );
    const cancelled = await save([
      "plan",
      "cancel",
      q.key,
      "--result",
      "Объём пересмотрен",
      "--if-revision",
      (await get(q.key)).revision,
    ]);
    assert.equal((await get(q.key)).status, "cancelled");
    assert.equal((await get(q.key)).result, "Объём пересмотрен");
    await save([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      a.stageId,
      "--tasks",
      task,
      "--if-revision",
      (await get(p.key)).revision,
    ]);
    assert.deepEqual(
      new Set((await memberships()).map((x) => `${x.planKey}:${x.current}`)),
      new Set([`${p.key}:true`, `${q.key}:false`]),
    );
    const firstMembership = successful(
      await run<Page<{ planKey: string; current: boolean }>>([
        "plan",
        "task",
        "memberships",
        task,
        "--limit",
        1,
      ]),
    );
    assert.equal(firstMembership.meta?.page?.total, 2);
    assert.ok(firstMembership.meta?.page?.nextCursor);
    const lastMembership = successful(
      await run<Page<{ planKey: string; current: boolean }>>([
        "plan",
        "task",
        "memberships",
        task,
        "--cursor",
        firstMembership.meta.page.nextCursor,
      ]),
    );
    assert.deepEqual(
      new Set(
        [...firstMembership.data.items, ...lastMembership.data.items].map(
          (x) => `${x.planKey}:${x.current}`,
        ),
      ),
      new Set([`${p.key}:true`, `${q.key}:false`]),
    );
    assert.equal(lastMembership.meta?.page?.nextCursor, null);
    const closedMutation = await run([
      "plan",
      "update",
      q.key,
      "--title",
      "Нельзя",
      "--if-revision",
      cancelled.revision,
    ]);
    assert.notEqual(closedMutation.code, 0);
    assert.equal((await get(q.key)).revision, cancelled.revision);
    human(await invokeRaw(root, ["plan", "task", "memberships", task], narrow), [
      p.key,
      q.key,
      "Текущее",
      "Закрытый",
    ]);
  },
);

test(
  "plan/release: local и HTTP сохраняют одинаковый состав, ревизии и причины отказа",
  { timeout: 180_000 },
  async (t) => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    t.after(async () => {
      await server?.close();
    });
    const { root, run } = await fixture(t);
    server = await startServer({ cwd: root, actor: "test-server", port: 0 });
    for (const transport of [["--local"], ["--server-url", server.url]]) {
      const save = async (args: Array<string | number>) =>
        successful(await run<PlanningSaved>([...transport, ...args])).data;
      const p = await save([
        "plan",
        "create",
        "--title",
        "Транспорт",
        "--goal",
        "Сохранить состав",
      ]);
      const s = await save([
        "plan",
        "stage",
        "create",
        p.key,
        "--title",
        "Этап транспорта",
        "--outcome",
        "## Итог\n\nНе потерять",
        "--if-revision",
        p.revision,
      ]);
      assert.ok(s.stageId);
      const tasks = [];
      for (let i = 0; i < 2; i++)
        tasks.push(
          successful(
            await run<{ key: string; ref: { id: string } }>([
              ...transport,
              "task",
              "create",
              "--board",
              "product",
              "--title",
              `Транспорт ${i}`,
            ]),
          ).data,
        );
      const included = await save([
        "plan",
        "stage",
        "task",
        "add",
        p.key,
        s.stageId,
        "--tasks",
        ...tasks.map((x) => x.key),
        "--if-revision",
        s.revision,
      ]);
      const updated = await save([
        "plan",
        "stage",
        "update",
        p.key,
        s.stageId,
        "--summary",
        "Только summary",
        "--if-revision",
        included.revision,
      ]);
      failed(
        await run([
          ...transport,
          "plan",
          "stage",
          "update",
          p.key,
          s.stageId,
          "--outcome",
          "Старое",
          "--if-revision",
          included.revision,
        ]),
        "REVISION_CONFLICT",
        4,
      );
      const detail = successful(
        await run<Stage>(["--local", "plan", "stage", "get", p.key, s.stageId]),
      ).data;
      assert.equal(detail.planRevision, updated.revision);
      assert.equal(detail.outcome, "## Итог\n\nНе потерять");
      assert.equal(detail.summary, "Только summary");
      assert.deepEqual(
        detail.taskIds,
        tasks.map((x) => x.ref.id),
      );
      const page = successful(
        await run<Page<{ key: string }>>([
          ...transport,
          "plan",
          "stage",
          "task",
          "list",
          p.key,
          s.stageId,
          "--limit",
          1,
        ]),
      );
      assert.equal(page.meta?.page?.total, 2);
      assert.ok(page.meta?.page?.nextCursor);
      const next = successful(
        await run<Page<{ key: string }>>([
          ...transport,
          "plan",
          "stage",
          "task",
          "list",
          p.key,
          s.stageId,
          "--cursor",
          page.meta.page.nextCursor,
        ]),
      );
      assert.deepEqual(
        new Set([...page.data.items, ...next.data.items].map((x) => x.key)),
        new Set(tasks.map((x) => x.key)),
      );
      const r = await save([
        "release",
        "create",
        "--title",
        "Транспорт релиза",
        "--release-version",
        "1",
        "--plans",
        p.key,
        "--description",
        "Описание сохранено",
      ]);
      await save(["release", "update", r.key, "--summary", "Summary", "--if-revision", r.revision]);
      for (const args of [
        ["plan", "get", p.key],
        ["plan", "progress", p.key],
        ["release", "get", r.key],
        ["release", "progress", r.key],
        ["release", "plans", r.key],
      ]) {
        assert.deepEqual(
          successful(await run(["--local", ...args])).data,
          successful(await run(["--server-url", server.url, ...args])).data,
        );
        human(await invokeRaw(root, [...transport, ...args], narrow), [args[2]!]);
      }
      const refusal = await invokeRaw(
        root,
        [...transport, "release", "publish", r.key, "--if-revision", 2],
        narrow,
      );
      assert.notEqual(refusal.code, 0);
      assert.equal(refusal.stderr, "");
      assert.match(refusal.stdout, /план|готов|заверш/i);
    }
  },
);

test(
  "plan/release/progress: русская help всех листьев без проекта",
  { timeout: 120_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "relay-planning-help-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const leaves = [
      ...["list", "get", "create", "update", "start", "complete", "cancel", "progress"].map((x) => [
        "plan",
        x,
      ]),
      ...["list", "get", "create", "update", "move", "remove"].map((x) => ["plan", "stage", x]),
      ...["list", "add", "remove", "transfer"].map((x) => ["plan", "stage", "task", x]),
      ...["candidates", "memberships"].map((x) => ["plan", "task", x]),
      ...[
        "list",
        "get",
        "create",
        "update",
        "preview",
        "plan",
        "cancel",
        "publish",
        "plans",
        "progress",
      ].map((x) => ["release", x]),
      ...["product", "application", "feature", "scenario", "implementation", "task"].map((x) => [
        x,
        "progress",
      ]),
    ];
    for (const leaf of leaves) {
      const help = human(await invokeRaw(cwd, [...leaf, "--help"], narrow), [
        "npx @oim-dev/relay-cli",
      ]);
      assert.match(help, /[А-Яа-яЁё]/);
      assert.match(help, /Пример/);
      assert.doesNotMatch(help, /--max-bytes|--color|--offset|--snapshot-version/);
    }
  },
);

test(
  "plan lifecycle: причины отказа, start/complete и историческое завершение при потере готовности",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const p = await save(["plan", "create", "--title", "Жизненный цикл"]);
    const refusal = await invokeRaw(
      root,
      ["plan", "start", p.key, "--if-revision", p.revision],
      narrow,
    );
    assert.notEqual(refusal.code, 0);
    assert.equal(refusal.stderr, "");
    assert.match(refusal.stdout, /цел[ьи]|задач|состав/i);
    let state = await save([
      "plan",
      "update",
      p.key,
      "--goal",
      "Цель цикла",
      "--if-revision",
      p.revision,
    ]);
    const s = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "Работа",
      "--if-revision",
      state.revision,
    ]);
    assert.ok(s.stageId);
    const task = successful(
      await run<{ key: string; revision: number }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Результат цикла",
      ]),
    ).data;
    state = await save([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      s.stageId,
      "--tasks",
      task.key,
      "--if-revision",
      s.revision,
    ]);
    state = await save(["plan", "start", p.key, "--if-revision", state.revision]);
    assert.equal(successful(await run<PlanSummary>(["plan", "get", p.key])).data.status, "active");
    const incomplete = await invokeRaw(
      root,
      ["plan", "complete", p.key, "--result", "Итог", "--if-revision", state.revision],
      narrow,
    );
    assert.notEqual(incomplete.code, 0);
    assert.match(incomplete.stdout, /задач|выполн|готов/i);
    const progress = successful(await run<Progress>(["plan", "progress", p.key])).data;
    assert.equal(progress.kind, "work-plan");
    if (progress.kind !== "work-plan") throw new Error("Ожидался прогресс плана");
    assert.equal(progress.canComplete, false);
    assert.equal(progress.counts.total, 1);
    assert.ok(progress.reasons.items.length);
    human(await invokeRaw(root, ["plan", "progress", p.key], narrow), [
      p.key,
      "Не выполнено",
      "В работе",
    ]);
    const done = successful(
      await run<{ revision: number }>([
        "task",
        "move",
        task.key,
        "--column",
        "done",
        "--if-revision",
        task.revision,
      ]),
    ).data;
    const missingResult = await run([
      "plan",
      "complete",
      p.key,
      "--result-file",
      "-",
      "--if-revision",
      state.revision,
    ]);
    assert.notEqual(missingResult.code, 0);
    const result = "## Итог\n\nРезультат проверен 世界";
    state = successful(
      await run<PlanningSaved>(
        ["plan", "complete", p.key, "--result-file", "-", "--if-revision", state.revision],
        { input: result },
      ),
    ).data;
    const historical = successful(await run<PlanSummary>(["plan", "get", p.key])).data;
    assert.equal(historical.status, "completed");
    assert.equal(historical.result, result);
    assert.equal(historical.ready, true);
    successful(
      await run(["task", "move", task.key, "--column", "ready", "--if-revision", done.revision]),
    );
    const current = successful(await run<PlanSummary>(["plan", "get", p.key])).data;
    assert.equal(current.status, "completed");
    assert.equal(current.revision, state.revision);
    assert.equal(current.closedAt, historical.closedAt);
    assert.equal(current.ready, false);
    const diverged = successful(await run<Progress>(["plan", "progress", p.key])).data;
    assert.equal(diverged.kind, "work-plan");
    if (diverged.kind !== "work-plan") throw new Error("Ожидался план");
    assert.equal(diverged.completed, false);
    assert.equal(diverged.diverged, true);
    assert.equal(diverged.status, "completed");
    human(await invokeRaw(root, ["plan", "get", p.key], narrow), [
      p.key,
      "Завершён",
      "Результат проверен",
      "0/1",
    ]);
    human(await invokeRaw(root, ["plan", "progress", p.key], narrow), [
      p.key,
      "Завершён",
      "Не выполнено",
      "Расхождение",
    ]);
  },
);

test(
  "plan candidates и list: фильтры до страниц, копируемый nextCommand с RELAY_CONFIG",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const elsewhere = await mkdtemp(join(tmpdir(), "relay-plan-other-"));
    t.after(() => rm(elsewhere, { recursive: true, force: true }));
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const p = await save(["plan", "create", "--title", "Совпадение один"]);
    await save(["plan", "create", "--title", "Не подходит"]);
    await save(["plan", "create", "--title", "Совпадение два"]);
    const s = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "Состав",
      "--if-revision",
      p.revision,
    ]);
    assert.ok(s.stageId);
    const keys: string[] = [];
    for (const title of [
      "Шум",
      "Кандидат занят",
      "Кандидат свободен",
      "Кандидат отменён",
      "Кандидат другой",
    ]) {
      keys.push(
        successful(
          await run<{ key: string }>([
            "task",
            "create",
            "--board",
            "product",
            "--title",
            title,
            ...(title.includes("отменён") ? ["--column", "cancelled"] : []),
          ]),
        ).data.key,
      );
    }
    await save([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      s.stageId,
      "--tasks",
      keys[1]!,
      "--if-revision",
      s.revision,
    ]);
    const command = ["plan", "task", "candidates"];
    const first = successful(
      await run<Page<{ key: string }>>([
        ...command,
        "--q",
        "Кандидат",
        "--board",
        "product",
        "--available-only",
        "true",
        "--limit",
        1,
      ]),
    );
    assert.equal(first.meta?.page?.total, 2);
    assert.equal(first.data.items.length, 1);
    assert.ok(first.meta?.page?.nextCursor);
    const second = successful(
      await run<Page<{ key: string }>>([...command, "--cursor", first.meta.page.nextCursor]),
    );
    assert.deepEqual(
      new Set([...first.data.items, ...second.data.items].map((x) => x.key)),
      new Set([keys[2], keys[4]]),
    );
    assert.equal(second.meta?.page?.nextCursor, null);
    const selected = successful(
      await run<Page<{ key: string }>>([
        ...command,
        "--q",
        "Кандидат",
        "--plan",
        p.key,
        "--stage",
        s.stageId,
        "--available-only",
        "true",
      ]),
    );
    assert.ok(selected.data.items.some((x) => x.key === keys[1]));
    const empty = successful(await run<Page<unknown>>([...command, "--q", "нет такой задачи"]));
    assert.deepEqual(empty.data.items, []);
    assert.equal(empty.meta?.page?.count, 0);
    human(await invokeRaw(root, [...command, "--available-only", "false"], narrow), [
      "Задачи",
      keys[1]!,
      keys[3]!,
    ]);
    const page = successful(
      await invoke<Page<PlanSummary>>(
        elsewhere,
        ["--local", "plan", "list", "--q", "Совпадение", "--status", "draft", "--limit", 1],
        { env: { RELAY_CONFIG: join(root, ".relay/config.json") } },
      ),
    );
    assert.equal(page.meta?.page?.total, 2);
    const next = page.meta?.page?.nextCommand;
    const humanPage = human(
      await invokeRaw(
        elsewhere,
        ["--local", "plan", "list", "--q", "Совпадение", "--status", "draft", "--limit", 1],
        { env: { ...narrow.env, RELAY_CONFIG: join(root, ".relay/config.json") } },
      ),
      [page.data.items[0]!.key, "Черновик"],
    );
    assert.ok(next);
    const humanNext = humanPage
      .split("\n")
      .find((line) => line.startsWith("npx @oim-dev/relay-cli "));
    assert.ok(humanNext, "Подсказка копируется одной строкой при ширине 40");
    assert.ok(humanNext.includes("--cursor"));
    assert.ok(humanNext.includes("--config"));
    assert.ok(next.startsWith("npx @oim-dev/relay-cli "));
    assert.ok(next.includes("--config"));
    assert.ok(next.includes("--local"));
    assert.doesNotMatch(next, /\n/);
    // Разбор POSIX-кавычек без shell и без запуска npx: исполняется тот же локальный CLI.
    const tokens = (command: string) =>
      command
        .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
        .slice(2)
        .map((x) => (x.startsWith("'") ? x.slice(1, -1).replaceAll("'\\''", "'") : x));
    const continued = successful(
      await invoke<Page<PlanSummary>>(elsewhere, tokens(next), {
        env: { RELAY_CONFIG: undefined },
      }),
    );
    const continuedHuman = successful(
      await invoke<Page<PlanSummary>>(elsewhere, tokens(humanNext), {
        env: { RELAY_CONFIG: undefined },
      }),
    );
    assert.deepEqual(continuedHuman.data, continued.data);
    assert.equal(continued.data.items.length, 1);
    assert.notEqual(continued.data.items[0]!.id, page.data.items[0]!.id);
    assert.equal(continued.meta?.page?.nextCursor, null);
  },
);
