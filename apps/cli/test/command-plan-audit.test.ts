import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PlanSummary, PlanningSaved, PlanStage } from "@relay/contracts/planning";
import type { EntitySaved } from "@relay/contracts/entities";
import { AppError } from "@relay/core/shared/errors";
import { planListText, planCountFields, planPresentedError } from "../src/presentation/plans.js";
import { PresentedError } from "../src/output.js";
import { failed, invoke, invokeRaw, successful, tempDirectory } from "./helpers/cli.js";

const narrow = { env: { COLUMNS: "40", FORCE_COLOR: "3", NO_COLOR: undefined } };
type Page<T> = { items: T[]; total: number; nextOffset: number | null; version: string };
const human = (result: Awaited<ReturnType<typeof invokeRaw>>) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b/);
  return result.stdout;
};
// Фикстура не содержит сложного shell-ввода. Пользовательский Markdown не исполняется.
const hintTokens = (text: string, path: string) => {
  const hint = text
    .slice(text.lastIndexOf("───\n"))
    .split("\n")
    .find((line) => line.startsWith("npx @oim-dev/relay-cli ") && line.includes(path));
  assert.ok(hint, `Нет команды ${path}:\n${text}`);
  return hint
    .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
    .slice(2)
    .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg));
};

test(
  "PLAN-01: clear-participants, пропуск, конфликт, stale и help без проекта",
  { timeout: 120_000 },
  async (t) => {
    const base = await tempDirectory(t);
    assert.match(
      human(await invokeRaw(base, ["plan", "update", "--help"], narrow)),
      /--clear-participants/,
    );
    const root = join(base, "project with spaces");
    await mkdir(root);
    successful(await invoke(root, ["init"]));
    const run = <T = unknown>(args: (string | number)[]) => invoke<T>(root, args);
    const plan = successful(
      await run<PlanningSaved>([
        "plan",
        "create",
        "--title",
        "Участники",
        "--participants",
        "Иван",
        "agent",
      ]),
    ).data;
    const read = async () => successful(await run<PlanSummary>(["plan", "get", plan.key])).data;
    const omitted = successful(
      await run<PlanningSaved>([
        "plan",
        "update",
        plan.key,
        "--summary",
        "Сохранить набор",
        "--if-revision",
        1,
      ]),
    ).data;
    assert.deepEqual((await read()).participants, ["Иван", "agent"]);
    const before = await read();
    failed(
      await run([
        "plan",
        "update",
        plan.key,
        "--participants",
        "Другой",
        "--clear-participants",
        "--if-revision",
        omitted.revision,
      ]),
      "CONFLICTING_OPTIONS",
    );
    failed(
      await run(["plan", "update", plan.key, "--clear-participants", "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    assert.deepEqual(await read(), before);
    successful(
      await run([
        "plan",
        "update",
        plan.key,
        "--clear-participants",
        "--if-revision",
        omitted.revision,
      ]),
    );
    assert.deepEqual((await read()).participants, []);
    assert.equal((await read()).summary, "Сохранить набор");
  },
);

test(
  "PLAN-02/03: local list→get→stage→task, counts, фильтры, membership и recovery",
  { timeout: 180_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const root = join(base, "plan project with spaces");
    await mkdir(root);
    successful(await invoke(root, ["init"]));
    const config = join(root, ".relay/config.json");
    const global = ["--local", "--config", config];
    const run = <T = unknown>(args: (string | number)[]) => invoke<T>(base, [...global, ...args]);
    const raw = (args: (string | number)[]) => invokeRaw(base, [...global, ...args], narrow);
    const readHint = async (text: string, path: string) => {
      const args = hintTokens(text, path);
      assert.ok(args.includes(config));
      assert.ok(args.includes("--local"));
      return human(await invokeRaw(base, args, narrow));
    };
    const markdown =
      "\n\n# Цель 世界\n\n```text\n\tзначимый отступ\n```\n\nКоманды CLI — вне содержания\nНЕ-ВЫПОЛНЯТЬ\n\n";
    const p = successful(
      await run<PlanningSaved>([
        "plan",
        "create",
        "--title",
        "План — не название этапа",
        "--goal",
        markdown,
        "--rationale",
        markdown,
      ]),
    ).data;
    const s = successful(
      await run<PlanningSaved>([
        "plan",
        "stage",
        "create",
        p.key,
        "--title",
        "Отдельный этап 世界",
        "--outcome",
        markdown,
        "--if-revision",
        p.revision,
      ]),
    ).data;
    assert.ok(s.stageId);
    const blocker = successful(
      await run<EntitySaved>(["task", "create", "--board", "product", "--title", "Внешний блокер"]),
    ).data;
    const blocked = successful(
      await run<EntitySaved>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Заблокированная",
        "--column",
        "ready",
        "--dependencies",
        blocker.key,
      ]),
    ).data;
    const ready = successful(
      await run<EntitySaved>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Свободная",
        "--column",
        "ready",
      ]),
    ).data;
    const included = successful(
      await run<PlanningSaved>([
        "plan",
        "stage",
        "task",
        "add",
        p.key,
        s.stageId,
        "--tasks",
        blocked.key,
        ready.key,
        "--if-revision",
        s.revision,
      ]),
    ).data;
    const list = human(await raw(["plan", "list"]));
    assert.doesNotMatch(list, /^npx /m);
    const detail = human(await raw(["plan", "get", p.key]));
    assert.ok(detail.includes(markdown));
    assert.match(detail, /Заблокировано:\s*1/);
    assert.match(detail, /На проверке:\s*0/);
    const stages = human(await raw(["plan", "stage", "list", p.key]));
    assert.ok(stages.includes(s.stageId));
    const stage = human(await raw(["plan", "stage", "get", p.key, s.stageId]));
    assert.ok(stage.includes(markdown));
    const tasks = human(await raw(["plan", "stage", "task", "list", p.key, s.stageId]));
    assert.match(tasks, /Заблокирована:\s*Да/);
    assert.match(tasks, /Готова к работе:\s*Да/);
    human(await raw(["task", "get", blocked.key]));
    human(await raw(["task", "progress", blocked.key]));
    human(await raw(["inspect", "graph", "list", "--root", p.key]));
    const candidates = human(
      await raw([
        "plan",
        "task",
        "candidates",
        "--plan",
        p.key,
        "--stage",
        s.stageId,
        "--available-only",
        "true",
      ]),
    );
    assert.match(candidates, /Только доступные:\s*true/);
    assert.ok(candidates.includes(s.stageId));
    assert.match(candidates, /Этап:\s*Отдельный этап/);
    const memberships = human(await raw(["plan", "task", "memberships", blocked.key]));
    if (memberships.includes(p.key)) {
      assert.ok(memberships.includes("План — не название этапа"));
      human(await raw(["plan", "stage", "get", p.key, s.stageId]));
    }
    const query = ["plan", "task", "candidates", "--available-only", "false", "--limit", 1];
    const first = successful(await run<Page<{ key: string }>>(query));
    assert.ok(first.meta?.page?.nextCursor);
    const next = human(
      await raw(["plan", "task", "candidates", "--cursor", first.meta.page.nextCursor]),
    );
    assert.match(next, /Только доступные:\s*false/);
    const full = successful(await run<Page<PlanSummary>>(["plan", "list"])).data.items[0]!;
    assert.equal(full.goal, markdown);
    assert.equal(full.rationale, markdown);
    assert.equal(full.counts.blocked, 1);
    for (const [args, code, path] of [
      [
        ["plan", "complete", p.key, "--if-revision", included.revision, "--result", "Итог"],
        "PLAN_INCOMPLETE",
        "plan progress",
      ],
      [
        ["plan", "stage", "remove", p.key, s.stageId, "--if-revision", included.revision],
        "STAGE_NOT_EMPTY",
        "plan stage task list",
      ],
      [
        ["plan", "update", p.key, "--title", "Старая запись", "--if-revision", 1],
        "REVISION_CONFLICT",
        "plan get",
      ],
      [["plan", "stage", "get", p.key, "missing-stage"], "NOT_FOUND", "plan stage list"],
    ] as const) {
      const result = await raw([...args]);
      assert.equal(result.code, 4, result.stdout);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.includes(code));
      await readHint(result.stdout, path);
    }
    const second = successful(
      await run<PlanningSaved>([
        "plan",
        "stage",
        "create",
        p.key,
        "--title",
        "Другой этап",
        "--if-revision",
        included.revision,
      ]),
    ).data;
    const duplicate = await raw([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      second.stageId!,
      "--tasks",
      blocked.key,
      "--if-revision",
      second.revision,
    ]);
    assert.equal(duplicate.code, 4, duplicate.stdout);
    assert.ok(duplicate.stdout.includes("TASK_IN_PLAN"));
    await readHint(duplicate.stdout, "plan task memberships");
    successful(
      await run([
        "plan",
        "cancel",
        p.key,
        "--result",
        "Пересмотр",
        "--if-revision",
        second.revision,
      ]),
    );
    const closed = human(await raw(["plan", "task", "memberships", blocked.key]));
    assert.match(closed, /Состояние плана:\s*Отменён/);
    assert.match(closed, /Участие:\s*Закрытый план/);
    assert.ok(closed.includes("План — не название этапа"));
    human(await raw(["plan", "stage", "get", p.key, s.stageId]));
    const empty = human(await raw(["plan", "list", "--q", "НЕСУЩЕСТВУЮЩИЙ"]));
    assert.match(empty, /записей нет/);
    assert.doesNotMatch(empty, /npx @oim-dev\/relay-cli plan get/);
    const stageJson = successful(
      await run<PlanStage>(["plan", "stage", "get", p.key, s.stageId]),
    ).data;
    assert.equal(stageJson.outcome, markdown);
  },
);

test("PLAN-02/03: 20 строк без повторной справки; HTTP details и JSON ошибки не переписываются", (t) => {
  for (const width of [40, 100]) {
    const text = planListText(
      "Планы работ",
      Array.from({ length: 20 }, (_, i) => ({
        key: `PLN-${i + 1}`,
        title: `Похожее название 世界 ${i + 1}`,
        fields: planCountFields({
          total: 20,
          completed: 0,
          active: 0,
          review: 0,
          blocked: 20,
          percent: 0,
        }),
      })),
      {},
      { width, color: false },
      [
        {
          label: "Пример первого ключа; подставьте выбранный",
          command: "npx @oim-dev/relay-cli plan get PLN-1",
        },
      ],
    );
    assert.equal(text.split("\n").filter((line) => line.startsWith("npx ")).length, 0);
    assert.equal((text.match(/Заблокировано:\s*20/g) ?? []).length, 20);
    assert.ok(text.includes("PLN-20"));
    assert.doesNotMatch(text, /\u001b/);
    t.diagnostic(
      `Макет 20 планов, width=${width}: ${Buffer.byteLength(text)} байт UTF-8, ${text.split("\n").length} строк, без меню и footer страницы.`,
    );
  }
  const details = {
    requestId: "test",
    url: "http://127.0.0.1:1",
    serverDetails: { taskId: "task-id", stageId: "other" },
  };
  const original = new AppError("TASK_IN_PLAN", "Задача занята", 4, details);
  const presented = planPresentedError(original, {
    plan: "PLN-1",
    task: "WRONG-1",
    action: "add",
    invoke: (args) => `npx @oim-dev/relay-cli ${args.join(" ")}`,
  });
  assert.ok(presented instanceof PresentedError);
  assert.equal(presented.code, original.code);
  assert.equal(presented.message, original.message);
  assert.equal(presented.details, details);
  assert.match(presented.text({ width: 40, color: false }), /plan task memberships task-id/);
});
