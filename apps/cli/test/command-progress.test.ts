import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stringWidth from "string-width";
import type { Progress } from "@relay/contracts/progress";
import type { PlanningSaved } from "@relay/contracts/planning";
import { fixture, invoke, invokeRaw, successful, failed } from "./helpers/cli.js";

type Collection = { items: unknown[]; total: number; nextOffset: number | null };
function collections(data: Progress): Record<string, Collection> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([, value]) =>
        value &&
        typeof value === "object" &&
        "items" in value &&
        "total" in value &&
        "nextOffset" in value,
    ),
  );
}
function totals(data: Progress) {
  const names = new Set(Object.keys(collections(data)));
  // Версия непрозрачна и может включать limit запроса; итоги — нет.
  return Object.fromEntries(
    Object.entries(data).filter(([name]) => name !== "version" && !names.has(name)),
  );
}
function human(result: Awaited<ReturnType<typeof invokeRaw>>, parts: string[]) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|"ok"\s*:|\[object Object\]/);
  for (const part of parts)
    assert.ok(
      result.stdout.replace(/\s/g, "").includes(part.replace(/\s/g, "")),
      `Нет ${part}:\n${result.stdout}`,
    );
  return result.stdout;
}
const narrow = { env: { COLUMNS: "40", FORCE_COLOR: "3", NO_COLOR: undefined } };

test(
  "progress: восемь видов, FI/SI, все подсписки без пропусков, суммарная страница и неизменные полные итоги",
  { timeout: 240_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const entity = async (args: Array<string | number>) =>
      successful(
        await run<{ ref: { kind: string; id: string }; key: string; revision: number }>(args),
      ).data;
    const plan = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    await entity([
      "product",
      "create",
      "--name",
      "Продукт проверки",
      "--description",
      "Полный состав",
    ]);
    const features = [];
    for (let i = 0; i < 3; i++)
      features.push(
        await entity(["feature", "create", "--name", `Фича ${i}`, "--description", "Требование"]),
      );
    const feature = features[0]!;
    const app = await entity([
      "application",
      "create",
      "--name",
      "Приложение",
      "--slug",
      "progress-app",
      "--prefix",
      "PRG",
      "--description",
      "Приложение теста",
    ]);
    const fi = await entity([
      "implementation",
      "create",
      "--application",
      app.key,
      "--target",
      feature.key,
      "--title",
      "Реализация фичи",
      "--description",
      "Вклад FI",
    ]);
    const scenarios = [],
      implementations = [];
    for (let i = 0; i < 3; i++) {
      const scenario = await entity([
        "scenario",
        "create",
        "--feature",
        feature.key,
        "--name",
        `Сценарий ${i}`,
        "--description",
        "Шаги",
      ]);
      scenarios.push(scenario);
      implementations.push(
        await entity([
          "implementation",
          "create",
          "--application",
          app.key,
          "--target",
          scenario.key,
          "--title",
          `Реализация ${i}`,
          "--description",
          "Вклад SI",
        ]),
      );
    }
    const work = [];
    for (let i = 0; i < 3; i++)
      work.push(
        await entity([
          "task",
          "create",
          "--board",
          "progress-app",
          "--title",
          `Работа ${i}`,
          "--targets",
          fi.key,
          implementations[i]!.key,
        ]),
      );
    await entity(["task", "create", "--board", "progress-app", "--title", "Техническая без целей"]);
    const direct = await entity([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Прямая продуктовая",
      "--targets",
      feature.key,
      scenarios[0]!.key,
    ]);
    const dependencies: Awaited<ReturnType<typeof entity>>[] = [];
    for (let i = 0; i < 3; i++)
      dependencies.push(
        await entity(["task", "create", "--board", "product", "--title", `Зависимость ${i}`]),
      );
    const task = await entity([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Задача с обязательствами",
      "--dependencies",
      ...dependencies.map((x) => x.key),
      "--criterion-title",
      "a=Первый критерий",
      "--criterion-title",
      "b=Второй критерий",
      "--criterion-title",
      "c=Третий критерий",
    ]);
    const children: Awaited<ReturnType<typeof entity>>[] = [];
    for (let i = 0; i < 2; i++)
      children.push(
        await entity([
          "task",
          "create",
          "--board",
          "product",
          "--title",
          `Подзадача ${i}`,
          "--parent",
          task.key,
        ]),
      );
    const p = await plan([
      "plan",
      "create",
      "--title",
      "План прогресса",
      "--goal",
      "Все обязательства",
    ]);
    let revision = p.revision;
    for (let i = 0; i < 3; i++) {
      const stage = await plan([
        "plan",
        "stage",
        "create",
        p.key,
        "--title",
        `Этап ${i}`,
        "--if-revision",
        revision,
      ]);
      assert.ok(stage.stageId);
      revision = (
        await plan([
          "plan",
          "stage",
          "task",
          "add",
          p.key,
          stage.stageId,
          "--tasks",
          work[i]!.key,
          "--if-revision",
          stage.revision,
        ])
      ).revision;
    }
    const other = await plan(["plan", "create", "--title", "Пустой обязательный план"]);
    const release = await plan([
      "release",
      "create",
      "--title",
      "Выпуск прогресса",
      "--release-version",
      "1",
      "--plans",
      p.key,
      other.key,
    ]);
    const cases: { kind: Progress["kind"]; command: string[]; key: string; title: string }[] = [
      {
        kind: "task",
        command: ["task", "progress", task.key],
        key: task.key,
        title: "Задача с обязательствами",
      },
      {
        kind: "implementation",
        command: ["implementation", "progress", fi.key],
        key: fi.key,
        title: "Реализация фичи",
      },
      {
        kind: "implementation",
        command: ["implementation", "progress", implementations[0]!.key],
        key: implementations[0]!.key,
        title: "Реализация 0",
      },
      {
        kind: "scenario",
        command: ["scenario", "progress", scenarios[0]!.key],
        key: scenarios[0]!.key,
        title: "Сценарий 0",
      },
      {
        kind: "feature",
        command: ["feature", "progress", feature.key],
        key: feature.key,
        title: "Фича 0",
      },
      {
        kind: "application",
        command: ["application", "progress", app.key],
        key: app.key,
        title: "Приложение",
      },
      {
        kind: "product",
        command: ["product", "progress"],
        key: "PRODUCT",
        title: "Продукт проверки",
      },
      {
        kind: "work-plan",
        command: ["plan", "progress", p.key],
        key: p.key,
        title: "План прогресса",
      },
      {
        kind: "release",
        command: ["release", "progress", release.key],
        key: release.key,
        title: "Выпуск прогресса",
      },
    ];
    for (const entry of cases)
      await t.test(entry.command.join(" "), async () => {
        const full = successful(await run<Progress>([...entry.command, "--limit", 100]));
        assert.equal(full.data.kind, entry.kind);
        assert.equal(full.data.entity.key, entry.key);
        assert.equal(full.data.entity.title, entry.title);
        assert.equal(full.data.completed, false);
        assert.ok(full.data.reasons.total > 0);
        const expected = collections(full.data);
        for (const [name, list] of Object.entries(expected)) {
          assert.equal(list.items.length, list.total, `${name}: полный контрольный ответ`);
          assert.equal(list.nextOffset, null);
        }
        const gathered: Record<string, unknown[]> = Object.fromEntries(
          Object.keys(expected).map((key) => [key, []]),
        );
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let pages = 0;
        let version: string | undefined;
        do {
          const part: ReturnType<typeof successful<Progress>> = successful(
            await run<Progress>([
              ...entry.command,
              ...(cursor ? ["--cursor", cursor] : ["--limit", 1]),
            ]),
          );
          assert.deepEqual(
            totals(part.data),
            totals(full.data),
            "Пагинация не меняет готовность, итоги и адрес",
          );
          version ??= part.data.version;
          assert.equal(part.data.version, version, "Продолжение сохраняет исходную версию");
          const lists = collections(part.data);
          assert.deepEqual(Object.keys(lists), Object.keys(expected));
          let count = 0,
            total = 0;
          for (const [name, list] of Object.entries(lists)) {
            assert.ok(list.items.length <= 1, `${name}: limit применяется отдельно`);
            assert.equal(list.total, expected[name]!.total, `${name}: полный total`);
            gathered[name]!.push(...list.items);
            count += list.items.length;
            total += list.total;
          }
          assert.equal(part.meta?.page?.count, count);
          assert.equal(part.meta?.page?.total, total);
          assert.equal(part.meta?.page?.limit, 1);
          assert.equal(part.meta?.page?.consistency, "snapshot");
          cursor = part.meta?.page?.nextCursor ?? null;
          if (cursor) {
            assert.ok(!cursors.has(cursor), "Продолжение не зациклено");
            cursors.add(cursor);
            assert.ok(part.meta?.page?.nextCommand);
          } else assert.equal(part.meta?.page?.nextCommand, null);
          assert.ok(++pages < 100, "Ограничение числа страниц теста");
        } while (cursor);
        for (const [name, list] of Object.entries(expected))
          assert.deepEqual(
            gathered[name],
            list.items,
            `${entry.kind}/${name}: без потерь, дублей и перестановок`,
          );
        assert.equal(
          full.meta?.page?.total,
          Object.values(expected).reduce((sum, list) => sum + list.total, 0),
        );
        const text = human(await invokeRaw(root, entry.command, narrow), [
          entry.key,
          entry.title,
          "Не выполнено",
          ...full.data.reasons.items.map((reason) => reason.message),
          ...full.data.reasons.items.map(
            (reason) => reason.source.key ?? `${reason.source.kind}:${reason.source.id}`,
          ),
          ...Object.values(expected).flatMap((list) =>
            list.items.flatMap((item) =>
              item && typeof item === "object" && "title" in item ? [String(item.title)] : [],
            ),
          ),
        ]);
        for (const line of text.split("\n")) {
          if (line.includes("npx @oim-dev/relay-cli")) continue;
          assert.ok(stringWidth(line.trimEnd()) <= 40, `Строка шире 40 колонок: ${line}`);
        }
        const limitedText = human(await invokeRaw(root, [...entry.command, "--limit", 1], narrow), [
          entry.key,
          "Не выполнено",
        ]);
        const labels: Record<string, string> = {
          criteria: "Критерии приёмки",
          children: "Подзадачи",
          dependencies: "Обязательные зависимости",
          reasons: "Причины",
          implementations: "Реализации",
          scenarios: "Сценарии",
          features: "Фичи",
          stages: "Этапы",
          plans: "Планы",
          tasks: entry.kind === "work-plan" ? "Явный состав задач" : "Прямые задачи",
        };
        for (const [name, list] of Object.entries(expected)) {
          if (!list.total) continue;
          assert.ok(
            limitedText
              .replace(/\s+/g, " ")
              .includes(`${labels[name]} · показано 1 из ${list.total}`),
            `Нет счётчика списка ${name}`,
          );
        }
        const fullCount =
          full.data.kind === "task"
            ? full.data.acceptance
            : full.data.kind === "release"
              ? full.data.readiness
              : full.data.counts;
        assert.ok(
          limitedText.includes(`0/${fullCount.total}`),
          "Human-итог не подменён размером страницы",
        );
        assert.ok(
          text.includes("npx @oim-dev/relay-cli"),
          "Причина должна вести к следующей операции",
        );
        const reasonCommands = text
          .split("\n")
          .filter((line) => line.startsWith("→ npx @oim-dev/relay-cli "));
        assert.equal(
          reasonCommands.length,
          full.data.reasons.items.length,
          "У каждой причины есть адресный следующий шаг",
        );
        const selfKind = entry.kind === "work-plan" ? "plan" : entry.kind;
        for (const line of reasonCommands) {
          const args = line
            .slice(2)
            .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
            .slice(2)
            .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg));
          const isSelfProgress = args.some(
            (arg, index) =>
              arg === selfKind &&
              args[index + 1] === "progress" &&
              (entry.kind === "product" || args[index + 2] === entry.key),
          );
          assert.equal(isSelfProgress, false, "Причина не отправляет снова в тот же прогресс");
        }
        if (full.data.kind === "task") {
          assert.deepEqual(full.data.acceptance, { total: 3, completed: 0 });
          assert.equal(full.data.canComplete, false);
          assert.deepEqual(
            full.data.children.items.map((x) => x.id).sort(),
            children.map((x) => x.ref.id).sort(),
          );
          assert.deepEqual(
            full.data.dependencies.items.map((x) => x.id).sort(),
            dependencies.map((x) => x.ref.id).sort(),
          );
          assert.ok(full.data.reasons.items.some((x) => x.code === "CRITERION_INCOMPLETE"));
          assert.match(text, /Первый критерий/);
          assert.match(text, /0\/3/);
        } else if (full.data.kind === "application") {
          assert.equal(full.data.businessTasks.total, 3);
          assert.equal(full.data.allTasks.total, 4);
          assert.equal(full.data.counts.total, 3, "Одна задача с FI+SI не считается дважды");
        } else if (full.data.kind === "implementation") {
          assert.equal(full.data.active, true);
          assert.equal(full.data.implementationKind, entry.key === fi.key ? "FI" : "SI");
          assert.equal(full.data.counts.total, entry.key === fi.key ? 3 : 1);
        } else if (full.data.kind === "feature") {
          assert.equal(full.data.scenarios.total, 3);
          assert.equal(full.data.counts.total, 4);
          assert.ok(full.data.tasks.items.some((x) => x.id === direct.ref.id));
        } else if (full.data.kind === "scenario") {
          assert.equal(full.data.counts.total, 2);
          assert.equal(full.data.implementations.total, 1);
          assert.ok(full.data.tasks.items.some((x) => x.id === direct.ref.id));
        } else if (full.data.kind === "product") {
          assert.equal(full.data.features.total, 3);
          assert.equal(full.data.counts.total, 4);
        } else if (full.data.kind === "work-plan") {
          assert.equal(full.data.stages.total, 3);
          assert.equal(full.data.counts.total, 3);
          assert.equal(full.data.canStart, true);
        } else if (full.data.kind === "release")
          assert.deepEqual(full.data.readiness, {
            total: 2,
            ready: 0,
            missing: 0,
            percent: 0,
            canRelease: false,
          });
      });
  },
);

test(
  "progress: пустые секции не шумят; причины, копируемое продолжение, привязка cursor и snapshot conflict",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const elsewhere = await mkdtemp(join(tmpdir(), "relay-progress-other-"));
    t.after(() => rm(elsewhere, { recursive: true, force: true }));
    const task = successful(
      await run<{ key: string; revision: number }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Одинокая задача",
        "--criterion-title",
        "a=Первое условие",
        "--criterion-title",
        "b=Второе условие",
      ]),
    ).data;
    const command = ["task", "progress", task.key];
    const first = successful(
      await invoke<Progress>(elsewhere, ["--local", ...command, "--limit", 1], {
        env: { RELAY_CONFIG: join(root, ".relay/config.json") },
      }),
    );
    assert.ok(first.meta?.page?.nextCursor);
    assert.ok(first.meta.page.nextCommand);
    const next = first.meta.page.nextCommand;
    assert.ok(next.startsWith("npx @oim-dev/relay-cli "));
    assert.ok(next.includes("--local"));
    assert.ok(next.includes("--config"));
    assert.doesNotMatch(next, /\n/);
    const tokens = next
      .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
      .slice(2)
      .map((x) => (x.startsWith("'") ? x.slice(1, -1).replaceAll("'\\''", "'") : x));
    const second = successful(
      await invoke<Progress>(elsewhere, tokens, { env: { RELAY_CONFIG: undefined } }),
    );
    assert.deepEqual(totals(second.data), totals(first.data));
    assert.notDeepEqual(second.data.reasons.items, first.data.reasons.items);
    failed(
      await run(["plan", "progress", "PLN-1", "--cursor", first.meta.page.nextCursor]),
      "INVALID_CURSOR",
    );
    successful(
      await run([
        "task",
        "update",
        task.key,
        "--title",
        "Правка после страницы",
        "--if-revision",
        task.revision,
      ]),
    );
    const changed = await invoke(root, [
      "--local",
      ...command,
      "--cursor",
      first.meta.page.nextCursor,
    ]);
    assert.notEqual(changed.code, 0);
    assert.ok(!changed.body.ok);
    assert.match(changed.body.error.code, /CHANGED|CONFLICT/);
    const text = human(await invokeRaw(root, command, narrow), [
      task.key,
      "Правка после страницы",
      "Первое условие",
      "Второе условие",
      "Не выполнено",
    ]);
    assert.doesNotMatch(
      text,
      /Подзадачи[^\n]*0 из 0|Обязательные зависимости[^\n]*0 из 0|На этой странице записей нет\./,
      "Пустые необязательные секции не должны создавать шум",
    );
  },
);
