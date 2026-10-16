import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import type { EntitySaved } from "@relay/contracts/entities";
import type { PlanningSaved } from "@relay/contracts/planning";
import type { Progress, ReleaseProgress, WorkPlanProgress } from "@relay/contracts/progress";
import { progressText } from "../src/presentation/progress.js";
import { fixture, invokeRaw, successful } from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

const invocation = (args: readonly string[]) => `npx @oim-dev/relay-cli ${args.join(" ")}`;
const compact = (text: string) => text.replace(/\s+/g, " ");
function reasonMessages(data: Progress, text: string) {
  assert.equal(text.split("\n").filter((x) => x.startsWith("→ ")).length, 0);
  for (const reason of data.reasons.items) {
    assert.ok(compact(text).includes(reason.code));
    assert.ok(text.includes(reason.source.key ?? `${reason.source.kind}:${reason.source.id}`));
    const expected =
      reason.code === "COMPONENT_INCOMPLETE" &&
      reason.message === `Не выполнена составляющая: ${reason.source.title}`
        ? "Не выполнена составляющая."
        : reason.message;
    assert.ok(compact(text).includes(compact(expected)), `${reason.code}: ${text}`);
  }
}

test(
  "APP-08/IMP-09/PLAN-06: композиция реального прогресса и независимые страницы восьми видов local/HTTP",
  { timeout: 240_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const entity = async (args: (string | number)[]) =>
      successful(await run<EntitySaved>(args)).data;
    const savePlan = async (args: (string | number)[]) =>
      successful(await run<PlanningSaved>(args)).data;
    await entity(["product", "create", "--name", "Продукт", "--description", "Состав"]);
    const feature = await entity([
      "feature",
      "create",
      "--name",
      "Фича",
      "--description",
      "Требования",
    ]);
    const scenario = await entity([
      "scenario",
      "create",
      "--feature",
      feature.key,
      "--name",
      "Сценарий",
      "--description",
      "Правила",
    ]);
    const app = await entity([
      "application",
      "create",
      "--name",
      "Приложение",
      "--slug",
      "audit",
      "--prefix",
      "AUD",
      "--description",
      "Назначение",
    ]);
    const fi = await entity([
      "implementation",
      "create",
      "--application",
      app.key,
      "--target",
      feature.key,
      "--title",
      "Реализация фичи с длинным отличительным названием",
      "--description",
      "FI",
    ]);
    const si = await entity([
      "implementation",
      "create",
      "--application",
      app.key,
      "--target",
      scenario.key,
      "--title",
      "Реализация сценария с уникальным названием",
      "--description",
      "SI",
    ]);
    const task = await entity([
      "task",
      "create",
      "--board",
      "audit",
      "--title",
      "Задача состава с уникальным названием",
      "--targets",
      si.key,
    ]);
    const plan = await savePlan(["plan", "create", "--title", "План"]);
    const stage = await savePlan([
      "plan",
      "stage",
      "create",
      plan.key,
      "--title",
      "Этап",
      "--if-revision",
      plan.revision,
    ]);
    await savePlan([
      "plan",
      "stage",
      "task",
      "add",
      plan.key,
      stage.stageId!,
      "--tasks",
      task.key,
      "--if-revision",
      stage.revision,
    ]);
    const release = await savePlan([
      "release",
      "create",
      "--title",
      "Релиз",
      "--release-version",
      "1",
      "--plans",
      plan.key,
    ]);
    const server = await httpServer(t, root);
    const cases = [
      ["task", task.key],
      ["implementation", fi.key],
      ["implementation", si.key],
      ["scenario", scenario.key],
      ["feature", feature.key],
      ["application", app.key],
      ["product"],
      ["plan", plan.key],
      ["release", release.key],
    ];
    for (const [kind, ref] of cases) {
      const command = [kind!, "progress", ...(ref ? [ref] : [])];
      const local = successful(await run<Progress>([...command, "--limit", 100]));
      const remote = successful(
        await run<Progress>(["--server-url", server.url, ...command, "--limit", 100]),
      );
      assert.deepEqual(remote.data, local.data);
      for (const width of [24, 40, 100, 160]) {
        const text = progressText(local.data, { limit: 100 }, { width, color: false }, invocation);
        reasonMessages(local.data, text);
        assert.doesNotMatch(text, /\u001b/);
        for (const line of text.split("\n")) {
          if (line.startsWith("→ ") || line.startsWith("npx @oim-dev/relay-cli ")) continue;
          assert.ok(stringWidth(line) <= width, `Ширина ${width}: ${line}`);
        }
      }
      const actual = await invokeRaw(root, ["--server-url", server.url, ...command]);
      assert.equal(actual.code, 0, actual.stdout + actual.stderr);
      assert.equal(actual.stderr, "");
      reasonMessages(local.data, actual.stdout);
      const page = successful(await run<Progress>([...command, "--limit", 1]));
      const lists = Object.values(page.data).filter(
        (x): x is { items: unknown[]; total: number; nextOffset: number | null } =>
          !!x && typeof x === "object" && "items" in x && "total" in x && "nextOffset" in x,
      );
      assert.equal(
        page.meta?.page?.count,
        lists.reduce((n, x) => n + x.items.length, 0),
      );
      assert.equal(
        page.meta?.page?.total,
        lists.reduce((n, x) => n + x.total, 0),
      );
      if (["application", "implementation", "plan"].includes(kind!)) {
        const text = progressText(
          local.data,
          { limit: 100 },
          { width: 160, color: false },
          invocation,
        );
        for (const reason of local.data.reasons.items) {
          if (
            reason.code !== "COMPONENT_INCOMPLETE" &&
            !(local.data.kind === "work-plan" && reason.source.kind === "task")
          )
            continue;
          assert.equal(text.split(reason.source.title).length - 1, 1, text);
        }
      }
      if (local.data.kind !== "application") continue;
      // Контроль представления сверх живого сценария: несовпадающие страницы, несколько
      // разных причин одного адреса, новая серверная формулировка и неизвестный код.
      const data = structuredClone(local.data);
      const source = data.implementations.items[0]!;
      const offPage = data.implementations.items[1]!;
      assert.ok(source && offPage);
      data.implementations.items = [source];
      data.implementations.nextOffset = 1;
      data.reasons.items = [
        {
          code: "COMPONENT_INCOMPLETE",
          message: `Не выполнена составляющая: ${source.title}`,
          source,
        },
        { code: "NO_WORK", message: "Нет собственной работы: особое условие", source },
        // Намеренный выход за текущую enum-схему: защитный тест представления будущего DTO,
        // не утверждение, что нынешний Backend принимает такой машинный код.
        {
          code: "FUTURE_REASON",
          message: "Неизвестная причина 世界 должна сохраниться",
          source,
        } as unknown as Progress["reasons"]["items"][number],
        {
          code: "COMPONENT_INCOMPLETE",
          message: "Новая формулировка известной причины без сокращения",
          source: offPage,
        },
        {
          code: "STATE_DIVERGED",
          message: "Сохранённое состояние расходится с текущей готовностью",
          source: data.entity,
        },
      ];
      data.reasons.total = 7;
      data.reasons.nextOffset = 5;
      const before = structuredClone(data);
      const text = progressText(data, { limit: 5 }, { width: 100, color: false }, invocation);
      reasonMessages(data, text);
      assert.match(text, /Реализации · показано 1 из 2/);
      assert.match(text, /Причины · показано 5 из 7/);
      assert.match(text, /Причин у составляющих выше: 3\. Отдельно: 2\./);
      assert.ok(text.includes(offPage.title));
      assert.deepEqual(data, before, "Представление не меняет DTO и независимые коллекции");
    }
  },
);

test(
  "PLAN-03/REL-01: полный blocked и чтение готового состава без причин local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const entity = async (args: (string | number)[]) =>
      successful(await run<EntitySaved>(args)).data;
    const savedPlan = async (args: (string | number)[]) =>
      successful(await run<PlanningSaved>(args)).data;
    const dependency = await entity([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Внешнее обязательство",
    ]);
    const tasks = [];
    for (let i = 0; i < 2; i++)
      tasks.push(
        await entity([
          "task",
          "create",
          "--board",
          "product",
          "--title",
          `Заблокированная задача ${i}`,
          "--dependencies",
          dependency.key,
        ]),
      );
    const blocked = await savedPlan([
      "plan",
      "create",
      "--title",
      "План с двумя блокировками",
      "--goal",
      "Разобрать внешнее обязательство",
    ]);
    const stage = await savedPlan([
      "plan",
      "stage",
      "create",
      blocked.key,
      "--title",
      "Заблокированный этап",
      "--if-revision",
      blocked.revision,
    ]);
    await savedPlan([
      "plan",
      "stage",
      "task",
      "add",
      blocked.key,
      stage.stageId!,
      "--tasks",
      ...tasks.map((x) => x.key),
      "--if-revision",
      stage.revision,
    ]);
    const plans: PlanningSaved[] = [];
    const summaries = new Map<string, string>();
    for (let i = 0; i < 2; i++) {
      const done = await entity([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        `Выполненная работа ${i}`,
        "--column",
        "done",
      ]);
      const summary =
        `Полная аннотация плана ${i}. ` +
        "Проверены условия, результат и границы. ".repeat(12) +
        `END_PLAN_SUMMARY_${i}`;
      const plan = await savedPlan([
        "plan",
        "create",
        "--title",
        `Готовый план ${i}`,
        "--summary",
        summary,
      ]);
      const planStage = await savedPlan([
        "plan",
        "stage",
        "create",
        plan.key,
        "--title",
        "Выполненный этап",
        "--if-revision",
        plan.revision,
      ]);
      const added = await savedPlan([
        "plan",
        "stage",
        "task",
        "add",
        plan.key,
        planStage.stageId!,
        "--tasks",
        done.key,
        "--if-revision",
        planStage.revision,
      ]);
      plans.push(
        await savedPlan([
          "plan",
          "complete",
          plan.key,
          "--result",
          "Фактически выполнено",
          "--if-revision",
          added.revision,
        ]),
      );
      summaries.set(plan.key, summary);
    }
    const release = await savedPlan([
      "release",
      "create",
      "--title",
      "Готовый релиз",
      "--release-version",
      "1",
      "--plans",
      ...plans.map((x) => x.key),
    ]);
    const server = await httpServer(t, root);
    let ready: ReleaseProgress | undefined;
    for (const transport of [["--local"], ["--server-url", server.url]]) {
      const blockedArgs = [...transport, "plan", "progress", blocked.key, "--limit", "1"];
      const data = successful(await run<WorkPlanProgress>(blockedArgs));
      assert.equal(data.data.counts.blocked, 2);
      assert.equal(
        data.data.counts.total,
        2,
        "Внешний blocker не добавляется в собственный состав",
      );
      assert.equal(data.data.tasks.items.length, 1);
      assert.equal(data.data.stages.items[0]!.counts.blocked, 2);
      const text = await invokeRaw(root, blockedArgs, { env: { COLUMNS: "24" } });
      assert.equal(text.code, 0, text.stdout + text.stderr);
      assert.equal(text.stderr, "");
      assert.match(compact(text.stdout), /Заблокировано задач: 2/);
      assert.match(compact(text.stdout), /Заблокировано задач этапа: 2/);
      assert.ok(text.stdout.includes(stage.stageId!));
      assert.deepEqual(
        successful(await run<WorkPlanProgress>(blockedArgs)).data,
        data.data,
        "Human-only представление не меняет JSON и полный итог",
      );
      const command = [...transport, "release", "progress", release.key];
      const full = successful(await run<ReleaseProgress>([...command, "--limit", 100]));
      ready = full.data;
      assert.equal(full.data.completed, true);
      assert.equal(full.data.reasons.total, 0);
      assert.equal(full.data.plans.total, 2);
      const fullText = await invokeRaw(root, [...command, "--limit", "100"]);
      assert.equal(fullText.code, 0);
      assert.equal(
        fullText.stdout.split("\n").filter((x) => x.startsWith("npx ") && x.includes(" plan get "))
          .length,
        0,
        "Список не повторяет справку get",
      );
      let cursor: string | null = null;
      const opened: string[] = [];
      do {
        const args: string[] = [...command, ...(cursor ? ["--cursor", cursor] : ["--limit", "1"])];
        const page: ReturnType<typeof successful<ReleaseProgress>> = successful(
          await run<ReleaseProgress>(args),
        );
        const human = await invokeRaw(root, args, { env: { COLUMNS: "40" } });
        assert.equal(human.code, 0, human.stdout + human.stderr);
        assert.equal(human.stderr, "");
        const hints = human.stdout
          .split("\n")
          .filter((x) => x.startsWith("npx ") && x.includes(" plan get "));
        assert.equal(hints.length, 0, human.stdout);
        const plan = page.data.plans.items[0]!;
        const detail = await invokeRaw(root, [...transport, "plan", "get", plan.key!]);
        assert.equal(detail.code, 0, detail.stdout + detail.stderr);
        assert.equal(detail.stderr, "");
        assert.ok(
          compact(detail.stdout).includes(compact(summaries.get(plan.key!)!)),
          "Адресное чтение сохраняет всю длинную аннотацию плана",
        );
        assert.equal(page.meta?.page?.count, 1);
        assert.equal(page.meta?.page?.total, 2);
        opened.push(plan.id);
        cursor = page.meta?.page?.nextCursor ?? null;
      } while (cursor);
      assert.deepEqual(
        opened,
        full.data.plans.items.map((x) => x.id),
      );
    }
    assert.ok(ready);
    const empty = structuredClone(ready);
    empty.plans.items = [];
    empty.plans.nextOffset = null;
    const noExample = progressText(empty, { limit: 1 }, { width: 100, color: false }, invocation);
    assert.doesNotMatch(noExample, /npx @oim-dev\/relay-cli/);
    assert.match(noExample, /показано 0 из 2/);
  },
);
