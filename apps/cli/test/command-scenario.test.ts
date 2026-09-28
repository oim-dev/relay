import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Detail = {
  ref: { id: string };
  key: string;
  revision: number;
  data: { name: string; featureId: string; description: string };
};
test("scenario: шесть листьев и неизменяемая родительская фича", async (t) => {
  const app = await fixture(t);
  const feature = successful(
    await app.run<{ key: string; ref: { id: string } }>([
      "feature",
      "create",
      "--name",
      "Поиск",
      "--description",
      "Требования",
    ]),
  ).data;
  const markdown = "## Шаги\n\n1. Ввести запрос.\n2. Прочитать результат.\n\nКонец сценария.\n";
  let key = "";
  const read = async () => successful(await app.run<Detail>(["scenario", "get", key])).data;
  await t.test("create: inline Markdown, отказ неверному родителю", async () => {
    const task = await app.create("Не фича");
    const invalid = await app.run([
      "scenario",
      "create",
      "--name",
      "Не создавать",
      "--feature",
      task,
      "--description",
      markdown,
    ]);
    assert.equal(invalid.body.ok, false);
    const empty = successful(await app.run<{ items: unknown[] }>(["scenario", "list"])).data;
    assert.deepEqual(empty.items, []);
    key = successful(
      await app.run<{ key: string }>([
        "scenario",
        "create",
        "--name",
        "Найти документ",
        "--feature",
        feature.key,
        "--description",
        markdown,
      ]),
    ).data.key;
    assert.equal((await read()).data.featureId, feature.ref.id);
  });
  await t.test("get: полный текст и осмысленная связь с фичей", async () => {
    assert.equal((await read()).data.description, markdown);
    const human = await invokeRaw(app.root, ["scenario", "get", key]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /Найти документ/);
    assert.match(human.stdout, /Конец сценария/);
    assert.ok(human.stdout.includes(feature.key), human.stdout);
    assert.match(human.stdout, /фича/i);
    assert.doesNotMatch(human.stdout, /\u001b|"data":/);
  });
  await t.test("update: stdin, no-op, wrong kind и stale revision не стирают данные", async () => {
    const before = await read();
    failed(
      await app.run(["scenario", "update", key, "--if-revision", before.revision]),
      "INVALID_ARGUMENT",
    );
    const inputConflict = await app.run(
      [
        "scenario",
        "update",
        key,
        "--description",
        "Не записывать",
        "--description-file",
        "-",
        "--if-revision",
        before.revision,
      ],
      { input: markdown },
    );
    assert.equal(inputConflict.body.ok, false);
    const featureBefore = successful(await app.run(["feature", "get", feature.key])).data;
    const featureKeysBefore = successful(await app.run(["inspect", "keys", feature.key])).data;
    const wrong = await app.run([
      "scenario",
      "update",
      feature.key,
      "--name",
      "Не менять",
      "--if-revision",
      1,
    ]);
    assert.equal(wrong.body.ok, false);
    assert.deepEqual(
      successful(await app.run(["feature", "get", feature.key])).data,
      featureBefore,
    );
    assert.deepEqual(
      successful(await app.run(["inspect", "keys", feature.key])).data,
      featureKeysBefore,
    );
    assert.deepEqual(await read(), before);
    successful(
      await app.run([
        "scenario",
        "update",
        key,
        "--name",
        "Поиск по названию",
        "--if-revision",
        before.revision,
      ]),
    );
    failed(
      await app.run([
        "scenario",
        "update",
        key,
        "--description",
        "Не записывать",
        "--if-revision",
        before.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    let current = await read();
    assert.equal(current.data.description, markdown);
    assert.equal(current.data.featureId, feature.ref.id);
    successful(
      await app.run(
        ["scenario", "update", key, "--description-file", "-", "--if-revision", current.revision],
        { input: markdown + "Уточнение.\n" },
      ),
    );
    current = await read();
    assert.equal(current.data.description, markdown + "Уточнение.\n");
    assert.equal(current.data.featureId, feature.ref.id);
  });
  await t.test("rename: алиас не меняет родителя и ID", async () => {
    const before = await read();
    successful(
      await app.run(["scenario", "rename", key, "FIND-SCENARIO", "--if-revision", before.revision]),
    );
    const current = await read();
    assert.equal(current.key, "FIND-SCENARIO");
    assert.equal(current.ref.id, before.ref.id);
    assert.deepEqual(current.data, before.data);
    key = current.key;
  });
  await t.test("list: feature + q + status и продолжение", async () => {
    const before = await read();
    successful(
      await app.run([
        "scenario",
        "update",
        key,
        "--name",
        "Маркер B",
        "--if-revision",
        before.revision,
      ]),
    );
    const other = successful(
      await app.run<{ key: string }>([
        "scenario",
        "create",
        "--name",
        "Маркер A",
        "--feature",
        feature.key,
        "--description",
        "Проверка",
      ]),
    ).data;
    const foreign = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Другой родитель",
        "--description",
        "Чужая область",
      ]),
    ).data;
    successful(
      await app.run([
        "scenario",
        "create",
        "--name",
        "Маркер чужой",
        "--feature",
        foreign.key,
        "--description",
        "Проверка",
      ]),
    );
    successful(
      await app.run([
        "scenario",
        "create",
        "--name",
        "Иное действие",
        "--feature",
        feature.key,
        "--description",
        "Проверка",
      ]),
    );
    const done = successful(
      await app.run<{ key: string }>([
        "scenario",
        "create",
        "--name",
        "Маркер завершён",
        "--feature",
        feature.key,
        "--description",
        "Проверка",
      ]),
    ).data;
    successful(
      await app.run([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Готовая работа",
        "--column",
        "done",
        "--targets",
        done.key,
      ]),
    );
    assert.equal(
      successful(await app.run<{ status: string }>(["scenario", "get", done.key])).data.status,
      "done",
    );
    const filters = [
      "--feature",
      feature.key,
      "--q",
      "Маркер",
      "--status",
      "none",
      "--sort",
      "title",
      "--limit",
      "1",
    ];
    const page = successful(
      await app.run<{ items: { key: string }[]; total: number }>(["scenario", "list", ...filters]),
    );
    assert.equal(page.data.total, 2, JSON.stringify(page.data));
    assert.equal(page.meta?.page?.consistency, "snapshot");
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: { key: string }[] }>([
        "scenario",
        "list",
        "--cursor",
        page.meta!.page!.nextCursor!,
      ]),
    );
    assert.deepEqual(
      [...page.data.items, ...next.data.items].map((item) => item.key),
      [other.key, key],
    );
    assert.equal(next.meta?.page?.nextCursor, null);
    for (const [args, expectedKey, title] of [
      [["scenario", "list", ...filters], other.key, "Маркер A"],
      [["scenario", "list", "--cursor", page.meta!.page!.nextCursor!], key, "Маркер B"],
    ] as const) {
      const human = await invokeRaw(app.root, [...args]);
      assert.equal(human.code, 0, human.stdout);
      const text = human.stdout.replace(/\s+/g, " ");
      for (const value of [expectedKey, title, feature.key, "Не реализовано"])
        assert.ok(text.includes(value), text);
      assert.match(text, /Поиск:\s*Маркер/);
      assert.match(text, new RegExp(`Фича:\\s*${feature.key}\\b`));
      assert.match(text, /Состояние:\s*Не реализовано/);
      assert.match(text, /Сортировка:\s*title/);
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
      assert.match(text, /Показано: 1 из 2/);
      if (expectedKey === other.key)
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*scenario list .*--cursor/);
      else assert.match(human.stdout, /Конец списка/);
    }
  });
  await t.test("progress: полная предметная сводка без записи", async () => {
    const before = await read();
    const progress = successful(await app.run(["scenario", "progress", key]));
    assert.ok(progress.data);
    assert.ok(progress.meta?.page);
    assert.deepEqual(await read(), before);
  });
});
