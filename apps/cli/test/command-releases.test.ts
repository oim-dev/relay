import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanningSaved, PlanSummary } from "@relay/contracts/planning";
import type { ReleaseSummary } from "@relay/contracts/releases";
import type { Progress } from "@relay/contracts/progress";
import { fixture, invoke, invokeRaw, successful, failed } from "./helpers/cli.js";

type Composition = {
  items: { id: string; plan: PlanSummary | null }[];
  total: number;
  nextOffset: number | null;
  version: string;
  readiness: {
    total: number;
    ready: number;
    missing: number;
    percent: number;
    canRelease: boolean;
  };
};
const narrow = { env: { COLUMNS: "40", FORCE_COLOR: "3", NO_COLOR: undefined } };
function human(result: Awaited<ReturnType<typeof invokeRaw>>, fragments: string[]) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|"ok"\s*:|\[object Object\]/);
  for (const part of fragments)
    assert.ok(
      result.stdout.replace(/\s/g, "").includes(part.replace(/\s/g, "")),
      `Нет ${part}:\n${result.stdout}`,
    );
  return result.stdout;
}

test(
  "release preview: полный явный выбор виден до состава первой и cursor-only второй страницы",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const create = async (title: string) =>
      successful(await run<PlanningSaved>(["plan", "create", "--title", title])).data;
    const first = await create("Первый выбранный");
    const excluded = await create("Не выбранный");
    const last = await create("Последний выбранный");
    assert.deepEqual([first.key, excluded.key, last.key], ["PLN-1", "PLN-2", "PLN-3"]);
    const args = ["release", "preview", "--plans", first.key, last.key, "--limit", 1];
    const before = successful(await run(["release", "list"])).data;
    const page = successful(await run<Composition>(args));
    assert.deepEqual(
      page.data.items.map((item) => item.id),
      [first.id],
    );
    assert.ok(page.meta?.page?.nextCursor);
    const continuation = ["release", "preview", "--cursor", page.meta.page.nextCursor];
    const next = successful(await run<Composition>(continuation));
    assert.deepEqual(
      next.data.items.map((item) => item.id),
      [last.id],
    );
    for (const result of [page, next]) {
      assert.equal(result.meta?.page?.count, 1);
      assert.equal(result.meta?.page?.total, 2);
      assert.equal(result.meta?.page?.limit, 1);
      assert.equal(result.meta?.page?.consistency, "snapshot");
      assert.deepEqual(result.data.readiness, {
        total: 2,
        ready: 0,
        missing: 0,
        percent: 0,
        canRelease: false,
      });
    }
    assert.equal(next.meta?.page?.nextCursor, null);
    assert.equal(next.meta?.page?.nextCommand, null);
    const selectionBeforeItem = (text: string, itemKey: string, itemTitle: string) => {
      // Ключи в nextCommand и в самой строке состава не доказывают видимость выбора.
      const visible = text
        .split("\n")
        .filter((line) => !line.includes("npx @oim-dev/relay-cli"))
        .join("\n")
        .replace(/\s+/g, " ");
      const titleAt = visible.indexOf(itemTitle);
      assert.ok(titleAt >= 0, "Показана ожидаемая строка состава");
      const bodyAt = visible.lastIndexOf(itemKey, titleAt);
      assert.ok(bodyAt >= 0, "Строка состава адресована ключом плана");
      const summary = visible.slice(0, bodyAt);
      assert.match(summary, /выбранные планы/i);
      const keys = summary.match(/\bPLN-\d+\b/g) ?? [];
      assert.deepEqual(
        keys,
        [first.key, last.key],
        "До тела страницы виден весь выбор, а не только текущий план",
      );
      assert.ok(!summary.includes(excluded.key));
      return keys;
    };
    for (const width of ["24", "40", "100"]) {
      const options = { env: { ...narrow.env, COLUMNS: width } };
      const firstText = human(await invokeRaw(root, args, options), [
        first.key,
        last.key,
        "Первый выбранный",
        "0/2",
      ]);
      const nextText = human(await invokeRaw(root, continuation, options), [
        first.key,
        last.key,
        "Последний выбранный",
        "0/2",
      ]);
      assert.deepEqual(
        selectionBeforeItem(nextText, last.key, "Последний выбранный"),
        selectionBeforeItem(firstText, first.key, "Первый выбранный"),
        "Cursor восстанавливает полный набор выбранных планов в видимой сводке",
      );
      assert.ok(
        !firstText.replace(/\s+/g, " ").includes("Последний выбранный"),
        "Тело первой страницы ограничено одним планом",
      );
      assert.ok(
        !nextText.replace(/\s+/g, " ").includes("Первый выбранный"),
        "Тело второй страницы не повторяет первый план",
      );
      const empty = human(await invokeRaw(root, ["release", "preview"], options), ["0/0"]);
      assert.match(
        empty.replace(/\s+/g, " "),
        /планы не выбраны/i,
        "Пустой выбор отличим от пустой страницы непустого состава",
      );
      for (const text of [firstText, nextText, empty]) {
        assert.equal(
          text.match(/^Показано:/gm)?.length,
          1,
          `Ровно один общий footer при ширине ${width}`,
        );
      }
    }
    const emptyJson = successful(await run<Composition>(["release", "preview"]));
    assert.deepEqual(emptyJson.data.items, []);
    assert.equal(emptyJson.data.readiness.canRelease, false);
    assert.equal(emptyJson.meta?.page?.total, 0);
    assert.equal(emptyJson.meta?.page?.nextCursor, null);
    assert.deepEqual(
      successful(await run(["release", "list"])).data,
      before,
      "Preview не создаёт релиз",
    );
  },
);

test(
  "release: preview без записи, полный Markdown, RMW сохраняет поля, stale не перезаписывает",
  { timeout: 150_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const get = async (key: string) =>
      successful(await run<ReleaseSummary>(["release", "get", key])).data;
    const p = await save(["plan", "create", "--title", "Первый план"]);
    const q = await save(["plan", "create", "--title", "Второй план"]);
    const empty = successful(await run<Composition>(["release", "preview"]));
    assert.deepEqual(empty.data.items, []);
    assert.deepEqual(empty.data.readiness, {
      total: 0,
      ready: 0,
      missing: 0,
      percent: 0,
      canRelease: false,
    });
    assert.deepEqual(empty.meta?.page, {
      count: 0,
      total: 0,
      limit: 20,
      consistency: "snapshot",
      nextCursor: null,
      nextCommand: null,
    });
    human(await invokeRaw(root, ["release", "preview"], narrow), ["0/0", "нет"]);
    const before = successful(await run(["release", "list"])).data;
    const preview = successful(
      await run<Composition>(["release", "preview", "--plans", p.key, q.key, "--limit", 1], {
        env: { RELAY_ACTOR: undefined },
      }),
    );
    assert.deepEqual(preview.data.readiness, {
      total: 2,
      ready: 0,
      missing: 0,
      percent: 0,
      canRelease: false,
    });
    assert.equal(preview.meta?.page?.total, 2);
    assert.equal(preview.meta?.page?.count, 1);
    assert.ok(preview.meta?.page?.nextCursor);
    const continued = successful(
      await run<Composition>(["release", "preview", "--cursor", preview.meta.page.nextCursor]),
    );
    assert.deepEqual(
      [...preview.data.items, ...continued.data.items].map((x) => x.id),
      [p.id, q.id],
    );
    assert.deepEqual(continued.data.readiness, preview.data.readiness);
    assert.equal(continued.meta?.page?.nextCursor, null);
    assert.deepEqual(successful(await run(["release", "list"])).data, before);
    human(await invokeRaw(root, ["release", "preview", "--plans", p.key, q.key], narrow), [
      p.key,
      q.key,
      "Черновик",
      "0/2",
    ]);
    const description =
      "## Выпуск 世界\n\n```text\n  значимый отступ\n```\n\n" +
      Array.from({ length: 900 }, (_, i) => `Поставка-${i}: без усечения`).join("\n") +
      "\nКОНЕЦ-РЕЛИЗА";
    const file = join(root, "полное описание.md");
    await writeFile(file, description);
    const r = await save([
      "release",
      "create",
      "--title",
      "Первый выпуск",
      "--release-version",
      "1.0-世界",
      "--plans",
      p.key,
      q.key,
      "--summary",
      "Краткое\nВторая строка",
      "--description-file",
      file,
      "--planned-for",
      "2026-12-01",
      "--request-id",
      "release-create",
    ]);
    assert.deepEqual(r, {
      id: r.id,
      key: "REL-1",
      revision: 1,
      action: "create",
      requestId: "release-create",
    });
    const original = await get(r.key);
    assert.equal(original.description, description);
    assert.equal(original.status, "planned");
    assert.equal(original.version, "1.0-世界");
    assert.deepEqual(original.planIds, [p.id, q.id]);
    assert.equal(original.plannedFor, "2026-12-01");
    const text = human(await invokeRaw(root, ["release", "get", r.key], narrow), [
      r.key,
      "Запланирован",
      "Ревизия",
      "1.0-世界",
      "КОНЕЦ-РЕЛИЗА",
      "```text",
      "  значимый отступ",
    ]);
    for (let i = 0; i < 900; i++) assert.ok(text.includes(`Поставка-${i}:`), `Потерян текст ${i}`);
    let state = await save([
      "release",
      "update",
      r.key,
      "--summary",
      "Уточнено",
      "--if-revision",
      r.revision,
    ]);
    let current = await get(r.key);
    for (const field of [
      "title",
      "version",
      "description",
      "plannedFor",
      "status",
      "planIds",
    ] as const)
      assert.deepEqual(current[field], original[field], field);
    assert.equal(current.summary, "Уточнено");
    assert.equal(current.revision, r.revision + 1);
    state = await save([
      "release",
      "update",
      r.key,
      "--description",
      "## Чужая правка\n\nСохранить",
      "--if-revision",
      state.revision,
    ]);
    current = await get(r.key);
    failed(
      await run([
        "release",
        "update",
        r.key,
        "--title",
        "Старый клиент",
        "--if-revision",
        r.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    assert.deepEqual(await get(r.key), current);
    const badInput = await run(
      [
        "release",
        "update",
        r.key,
        "--description-file",
        "-",
        "--summary-file",
        "-",
        "--if-revision",
        state.revision,
      ],
      { input: "Не записывать" },
    );
    assert.notEqual(badInput.code, 0);
    assert.deepEqual(await get(r.key), current);
    state = await save([
      "release",
      "update",
      r.key,
      "--planned-for",
      "",
      "--summary",
      "",
      "--plans",
      q.key,
      "--if-revision",
      state.revision,
    ]);
    current = await get(r.key);
    assert.equal(current.plannedFor, "");
    assert.equal(current.summary, "");
    assert.deepEqual(current.planIds, [q.id]);
    assert.equal(current.description, "## Чужая правка\n\nСохранить");
    const composed = successful(await run<Composition>(["release", "plans", r.key]));
    assert.deepEqual(
      composed.data.items.map((x) => x.id),
      [q.id],
    );
    human(await invokeRaw(root, ["release", "plans", r.key], narrow), [
      q.key,
      "Второй план",
      "0/1",
    ]);
    human(await invokeRaw(root, ["release", "list"], narrow), [
      r.key,
      "Первый выпуск",
      "1.0-世界",
      "Запланирован",
    ]);
    const absent = successful(
      await run<{ items: unknown[] }>(["release", "list", "--q", "нет выпуска"]),
    );
    assert.deepEqual(absent.data.items, []);
    assert.equal(absent.meta?.page?.total, 0);
  },
);

test(
  "release lifecycle: отмена/перепланирование, условия выпуска, неизменяемый факт и текущий состав",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const get = async (key: string) =>
      successful(await run<ReleaseSummary>(["release", "get", key])).data;
    const task = successful(
      await run<{ key: string; revision: number }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Проверяемый результат",
        "--column",
        "done",
      ]),
    ).data;
    const p = await save(["plan", "create", "--title", "Готовый состав, ещё не завершён"]);
    const s = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "Приёмка",
      "--if-revision",
      p.revision,
    ]);
    assert.ok(s.stageId);
    const included = await save([
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
    const r = await save([
      "release",
      "create",
      "--title",
      "Релиз цикла",
      "--release-version",
      "2.0",
      "--plans",
      p.key,
    ]);
    const planned = await get(r.key);
    for (const args of [
      ["release", "publish", r.key, "--if-revision", r.revision],
      ["release", "update", r.key, "--status", "released", "--if-revision", r.revision],
    ]) {
      const refusal = await invokeRaw(root, args, narrow);
      assert.notEqual(refusal.code, 0);
      assert.equal(refusal.stderr, "");
      assert.match(refusal.stdout, /план|заверш|готов/i);
      assert.deepEqual(await get(r.key), planned);
    }
    let state = await save(["release", "cancel", r.key, "--if-revision", r.revision]);
    assert.equal((await get(r.key)).status, "cancelled");
    state = await save([
      "release",
      "update",
      r.key,
      "--summary",
      "Правка отменённого",
      "--if-revision",
      state.revision,
    ]);
    assert.equal((await get(r.key)).status, "cancelled", "Правка не должна перепланировать релиз");
    assert.equal(successful(await run<PlanSummary>(["plan", "get", p.key])).data.status, "draft");
    state = await save(["release", "plan", r.key, "--if-revision", state.revision]);
    assert.equal((await get(r.key)).status, "planned");
    await save([
      "plan",
      "complete",
      p.key,
      "--result",
      "Проверено",
      "--if-revision",
      included.revision,
    ]);
    assert.equal((await get(r.key)).readiness.canRelease, true);
    const receipt = human(
      await invokeRaw(root, ["release", "publish", r.key, "--if-revision", state.revision], narrow),
      [r.key, "Выпуск", "Ревизия"],
    );
    assert.match(receipt, /зафиксирован/i);
    const published = await get(r.key);
    assert.match(receipt, new RegExp(`Ревизия:\\s*${published.revision}(?:\\s|$)`));
    const readCommand = receipt
      .split("\n")
      .find((line) => line.startsWith("npx @oim-dev/relay-cli "));
    assert.ok(readCommand, "Квитанция выпуска содержит эффективную команду чтения");
    const readArgs = readCommand
      .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
      .slice(2)
      .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg));
    assert.deepEqual(readArgs.slice(-3), ["release", "get", r.key]);
    const other = await fixture(t);
    assert.deepEqual(
      successful(
        await invoke<ReleaseSummary>(other.root, readArgs, { env: { RELAY_CONFIG: undefined } }),
      ).data,
      published,
    );
    assert.equal(published.status, "released");
    assert.equal(published.revision, state.revision + 1);
    assert.ok(published.releasedAt);
    assert.ok(published.releasedBy);
    assert.equal(published.readiness.ready, 1);
    for (const args of [
      ["release", "update", r.key, "--title", "Нельзя"],
      ["release", "cancel", r.key],
      ["release", "plan", r.key],
    ]) {
      assert.notEqual((await run([...args, "--if-revision", published.revision])).code, 0);
      assert.deepEqual(await get(r.key), published);
    }
    successful(
      await run(["task", "move", task.key, "--column", "ready", "--if-revision", task.revision]),
    );
    const current = await get(r.key);
    assert.deepEqual(
      [current.status, current.revision, current.releasedAt, current.releasedBy],
      ["released", published.revision, published.releasedAt, published.releasedBy],
    );
    assert.deepEqual(current.readiness, {
      total: 1,
      ready: 0,
      missing: 0,
      percent: 0,
      canRelease: false,
    });
    const composition = successful(await run<Composition>(["release", "plans", r.key])).data;
    assert.equal(composition.items[0]?.plan?.status, "completed");
    assert.equal(composition.items[0]?.plan?.counts.completed, 0);
    const progress = successful(await run<Progress>(["release", "progress", r.key])).data;
    assert.equal(progress.kind, "release");
    if (progress.kind !== "release") throw new Error("Ожидался релиз");
    assert.equal(progress.status, "released");
    assert.equal(progress.completed, false);
    assert.equal(progress.readiness.ready, 0);
    const historicalText = human(await invokeRaw(root, ["release", "get", r.key], narrow), [
      r.key,
      "Выпущен",
      "0/1",
      published.releasedAt,
    ]);
    assert.match(
      historicalText.replace(/\s+/g, " "),
      /[Фф]акт выпуска сохранён независимо от текущей готовности/,
    );
    human(await invokeRaw(root, ["release", "progress", r.key], narrow), [
      r.key,
      "Выпущен",
      "Не выполнено",
      "0/1",
    ]);
    human(await invokeRaw(root, ["release", "plans", r.key], narrow), [p.key, "Завершён", "0/1"]);
  },
);

test(
  "release list/plans: страницы, исходные фильтры и запрет устаревшего снимка",
  { timeout: 120_000 },
  async (t) => {
    const { run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const plans: PlanningSaved[] = [];
    for (let i = 0; i < 3; i++)
      plans.push(await save(["plan", "create", "--title", `Состав ${i}`]));
    const r = await save([
      "release",
      "create",
      "--title",
      "Выбор один",
      "--release-version",
      "1",
      "--plans",
      ...plans.map((x) => x.key),
    ]);
    await save([
      "release",
      "create",
      "--title",
      "Шум",
      "--release-version",
      "2",
      "--plans",
      plans[0]!.key,
    ]);
    const other = await save([
      "release",
      "create",
      "--title",
      "Выбор два",
      "--release-version",
      "3",
      "--plans",
      plans[1]!.key,
    ]);
    const page = successful(
      await run<{ items: ReleaseSummary[] }>([
        "release",
        "list",
        "--q",
        "Выбор",
        "--status",
        "planned",
        "--limit",
        1,
      ]),
    );
    assert.equal(page.meta?.page?.total, 2);
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await run<{ items: ReleaseSummary[] }>([
        "release",
        "list",
        "--cursor",
        page.meta.page.nextCursor,
      ]),
    );
    assert.deepEqual(
      new Set([...page.data.items, ...next.data.items].map((x) => x.id)),
      new Set([r.id, other.id]),
    );
    assert.equal(next.meta?.page?.nextCursor, null);
    let cursor: string | null = null;
    const ids: string[] = [];
    let oldCursor = "";
    do {
      const part: ReturnType<typeof successful<Composition>> = successful(
        await run<Composition>([
          "release",
          "plans",
          r.key,
          ...(cursor ? ["--cursor", cursor] : ["--limit", 1]),
        ]),
      );
      assert.equal(part.data.readiness.total, 3);
      assert.equal(part.meta?.page?.total, 3);
      assert.equal(part.meta?.page?.count, 1);
      ids.push(...part.data.items.map((x) => x.id));
      cursor = part.meta?.page?.nextCursor ?? null;
      if (!oldCursor && cursor) oldCursor = cursor;
    } while (cursor);
    assert.deepEqual(
      ids,
      plans.map((x) => x.id),
    );
    await save([
      "plan",
      "update",
      plans[0]!.key,
      "--title",
      "Изменён после чтения",
      "--if-revision",
      plans[0]!.revision,
    ]);
    failed(await run(["release", "plans", r.key, "--cursor", oldCursor]), "PLANNING_CHANGED", 4);
    failed(await run(["release", "plans", other.key, "--cursor", oldCursor]), "INVALID_CURSOR");
  },
);
