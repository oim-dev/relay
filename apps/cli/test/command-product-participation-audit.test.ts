import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
import type {
  ProductParticipationPage,
  ProductParticipationSaved,
} from "@relay/contracts/product-participation";
import { fixture, successful, invokeRaw } from "./helpers/cli.js";

test("APP-03/07 IMP-04/06/08: compact opt-in, атомарный composition и неизменный legacy JSON", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  const app = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Назначение",
  ]);
  const feature = await create("feature", ["--name", "Поиск", "--description", "Общее требование"]);
  const scenario = await create("scenario", [
    "--name",
    "Найти",
    "--feature",
    feature.key,
    "--description",
    "Шаги",
  ]);
  const read = () =>
    f.run<ProductParticipationPage>([
      "application",
      "participation",
      "list",
      app.key,
      "--projection",
      "compact",
    ]);
  const replace = (page: ProductParticipationPage, composition: unknown, extra: string[] = []) =>
    f.run<ProductParticipationSaved>(
      [
        "application",
        "participation",
        "replace",
        app.key,
        "--if-revision",
        page.revision,
        "--if-version",
        page.version,
        "--composition-file",
        "-",
        ...extra,
      ],
      { input: JSON.stringify(composition) },
    );
  const empty = successful(await read()).data;
  assert.equal(empty.revision, 0);
  assert.equal(empty.scopeId, null);
  assert.equal(empty.total, 0);
  const invalid = await replace(empty, [
    { kind: "target", target: scenario.key, title: "SI", description: "Шаги" },
  ]);
  assert.equal(invalid.body.ok, false);
  assert.deepEqual(successful(await read()).data, empty);
  const markdown = "\n\n## Собственный вклад\n\n```text\n\t  отступы\n```\n\nКОНЕЦ_ВКЛАДА\n\n";
  const saved = successful(
    await replace(empty, [
      {
        kind: "target",
        target: feature.key,
        title: "Общий вклад",
        description: markdown,
        status: "done",
      },
      { kind: "target", target: scenario.key, title: "Сценарный вклад", description: markdown },
    ]),
  ).data;
  assert.equal(saved.selected, 2);
  let page = successful(await read()).data;
  assert.equal(page.revision, 1);
  assert.equal(page.total, 2);
  const fi = page.items.find((item) => item.implementationTarget === "feature")!;
  const si = page.items.find((item) => item.implementationTarget === "scenario")!;
  assert.ok(fi && si);
  assert.equal(fi.savedStatus, "done");
  assert.notEqual(fi.status, "done");
  assert.ok(page.items.every((item) => !("description" in item) && !("basis" in item)));
  const legacy = successful(
    await f.run<{ items: { id: string; description: string; basis: unknown }[] }>([
      "application",
      "participation",
      "list",
      app.key,
    ]),
  ).data;
  assert.equal(legacy.items.length, 2);
  assert.ok(legacy.items.every((item) => item.description === markdown && "basis" in item));
  assert.ok(!("snapshotVersion" in legacy));
  const first = successful(
    await f.run<ProductParticipationPage>([
      "application",
      "participation",
      "list",
      app.key,
      "--projection",
      "compact",
      "--limit",
      1,
    ]),
  );
  assert.ok(first.meta?.page?.nextCursor);
  const next = successful(
    await f.run<ProductParticipationPage>([
      "application",
      "participation",
      "list",
      app.key,
      "--cursor",
      first.meta.page.nextCursor,
    ]),
  );
  assert.equal(next.data.total, 2);
  assert.ok(next.data.snapshotVersion);
  assert.notEqual(next.data.items[0]?.ref.id, first.data.items[0]?.ref.id);
  for (const width of [40, 100]) {
    const human = await invokeRaw(
      f.root,
      ["application", "participation", "list", app.key, "--projection", "compact"],
      { env: { COLUMNS: String(width) } },
    );
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /Совместимая отметка: done/);
    assert.ok(human.stdout.includes(page.version));
    assert.doesNotMatch(human.stdout, /^npx /m);
    assert.doesNotMatch(human.stdout, /КОНЕЦ_ВКЛАДА|\u001b/);
  }
  const detail = successful(await f.run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(detail.savedStatus, "done");
  assert.notEqual(detail.status, "done");
  const humanDetail = await invokeRaw(f.root, ["implementation", "get", fi.key]);
  assert.match(humanDetail.stdout, /Совместимая отметка: done/);
  assert.ok(humanDetail.stdout.includes(markdown));
  // Неправильный новый элемент не оставляет часть состава после первого valid existing.
  const rejected = await replace(page, [
    { kind: "existing", ref: fi.key },
    { kind: "target", target: "MISSING", title: "Нет", description: "Нет" },
  ]);
  assert.equal(rejected.body.ok, false);
  assert.deepEqual(successful(await read()).data, page);
  const conflict = await replace(page, [], ["--composition", "[]"]);
  assert.equal(conflict.body.ok, false);
  assert.deepEqual(successful(await read()).data, page);
  const selected = [
    { kind: "existing", ref: fi.key },
    { kind: "existing", ref: si.key },
  ];
  successful(await replace(page, selected));
  page = successful(await read()).data;
  assert.equal(page.items.find((item) => item.ref.id === fi.ref.id)?.savedStatus, "done");
  successful(await replace(page, []));
  const inactive = successful(await f.run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(inactive.active, false);
  successful(
    await f.run([
      "implementation",
      "update",
      fi.key,
      "--title",
      "Снятый исправлен",
      "--if-revision",
      inactive.revision,
    ]),
  );
  const edited = successful(await f.run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(edited.active, false);
  assert.equal(edited.savedStatus, "done");
  assert.equal(edited.ref.id, fi.ref.id);
  assert.equal(edited.revision, inactive.revision + 1);
  successful(await replace(successful(await read()).data, selected));
  const restored = successful(await f.run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(restored.active, true);
  assert.equal(restored.savedStatus, "done");
  assert.equal(restored.title, "Снятый исправлен");
  assert.ok("description" in restored.data && restored.data.description === markdown);
  // Задача меняет guard чтения, но не версию состава для записи.
  page = successful(await read()).data;
  const beforeTask = successful(
    await f.run<ProductParticipationPage>([
      "application",
      "participation",
      "list",
      app.key,
      "--projection",
      "compact",
      "--limit",
      1,
    ]),
  );
  successful(
    await f.run(["task", "create", "--board", "web", "--title", "Работа", "--targets", fi.key]),
  );
  const afterTask = successful(await read()).data;
  assert.equal(afterTask.version, page.version);
  assert.notEqual(afterTask.snapshotVersion, page.snapshotVersion);
  assert.ok(beforeTask.meta?.page?.nextCursor);
  const stale = await f.run([
    "application",
    "participation",
    "list",
    app.key,
    "--cursor",
    beforeTask.meta.page.nextCursor,
  ]);
  assert.equal(stale.body.ok, false);
});

test("APP-08/IMP-09: прогресс продукта сохраняет причины и страницы без тройных названий", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  const app = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Назначение",
  ]);
  const feature = await create("feature", ["--name", "Поиск", "--description", "Требование"]);
  const scenario = await create("scenario", [
    "--name",
    "Найти",
    "--feature",
    feature.key,
    "--description",
    "Шаги",
  ]);
  const fi = await create("implementation", [
    "--application",
    app.key,
    "--target",
    feature.key,
    "--title",
    "Длинный общий вклад 界",
    "--description",
    "Вклад",
  ]);
  await create("implementation", [
    "--application",
    app.key,
    "--target",
    scenario.key,
    "--title",
    "Длинный конкретный вклад 界",
    "--description",
    "Вклад",
  ]);
  for (const [kind, key] of [
    ["application", app.key],
    ["implementation", fi.key],
  ]) {
    const result = successful(
      await f.run<{
        completed: boolean;
        reasons: { items: { code: string; message: string }[]; total: number };
      }>([kind!, "progress", key!, "--limit", 1]),
    );
    assert.equal(result.data.completed, false);
    assert.ok(result.data.reasons.total > 0);
    for (const width of [40, 100]) {
      const human = await invokeRaw(f.root, [kind!, "progress", key!, "--limit", 1], {
        env: { COLUMNS: String(width) },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.doesNotMatch(human.stdout, /Не выполнена составляющая: Длинный/);
      assert.match(human.stdout, /Причины/);
      assert.match(human.stdout, /npx @oim-dev\/relay-cli/);
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
    }
    if (result.meta?.page?.nextCursor)
      successful(await f.run([kind!, "progress", key!, "--cursor", result.meta.page.nextCursor]));
  }
});
