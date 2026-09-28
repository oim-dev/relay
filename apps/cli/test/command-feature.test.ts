import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import stringWidth from "string-width";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Detail = {
  ref: { id: string };
  key: string;
  revision: number;
  data: { name: string; summary: string; description: string };
};
const markdown =
  "## Требования\n\nКаталог 🛠 ищет вещи.\n\n- Первый результат\n- Последний результат\n\n```text\n  точные пробелы\n```\n\nФинальный абзац.\n";

test("feature: шесть листьев, текстовый ввод и snapshot каталога", async (t) => {
  const app = await fixture(t);
  const file = join(app.root, "требования с пробелом.md");
  await writeFile(file, markdown);
  let key = "";
  const read = async () => successful(await app.run<Detail>(["feature", "get", key])).data;
  await t.test("create: файл UTF-8", async () => {
    const created = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Каталог 🛠",
        "--summary",
        "Найти\nВыбрать",
        "--description-file",
        file,
      ]),
    ).data;
    key = created.key;
    assert.equal((await read()).data.description, markdown);
  });
  await t.test("get: key и ID эквивалентны, human 40/100", async () => {
    const record = await read();
    assert.deepEqual(
      successful(await app.run<Detail>(["feature", "get", record.ref.id])).data,
      record,
    );
    for (const width of [40, 100]) {
      const out = await invokeRaw(app.root, ["feature", "get", key], {
        env: { COLUMNS: String(width), FORCE_COLOR: "1" },
      });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      for (const text of [
        key,
        "Каталог 🛠",
        "## Требования",
        "Последний результат",
        "  точные пробелы",
        "Финальный абзац.",
      ])
        assert.ok(out.stdout.includes(text), out.stdout);
      assert.match(out.stdout, /ревизия/i);
      assert.match(out.stdout, /npx @oim-dev\/relay-cli/);
      assert.doesNotMatch(out.stdout, /\u001b|"data":|\\n/);
      for (const line of out.stdout.split("\n")) {
        if (line.includes("npx @oim-dev/relay-cli")) continue;
        assert.ok(stringWidth(line) <= width, `Строка шире ${width}: ${line}`);
      }
    }
  });
  await t.test("update: no-op, конфликты источников до мутации, сохранение и очистка", async () => {
    const before = await read();
    for (const args of [
      [],
      ["--description", "inline", "--description-file", file],
      ["--summary-file", "-", "--description-file", "-"],
      ["--clear-summary", "--summary", "конфликт"],
    ]) {
      const result = await app.run(
        ["feature", "update", key, "--if-revision", before.revision, ...args],
        { input: "stdin" },
      );
      assert.equal(result.body.ok, false, result.stdout);
      assert.deepEqual(await read(), before);
    }
    successful(
      await app.run([
        "feature",
        "update",
        key,
        "--name",
        "Каталог уточнён",
        "--if-revision",
        before.revision,
      ]),
    );
    failed(
      await app.run([
        "feature",
        "update",
        key,
        "--name",
        "Потерянная запись",
        "--if-revision",
        before.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    let record = await read();
    assert.equal(record.data.description, markdown);
    assert.equal(record.data.summary, "Найти\nВыбрать");
    successful(
      await app.run(
        [
          "feature",
          "update",
          key,
          "--clear-summary",
          "--description-file",
          "-",
          "--if-revision",
          record.revision,
        ],
        { input: markdown + "Дополнение.\n" },
      ),
    );
    record = await read();
    assert.equal(record.data.summary, "");
    assert.equal(record.data.description, markdown + "Дополнение.\n");
  });
  await t.test("rename: старый ключ — алиас; wrong kind не изменяется", async () => {
    const before = await read();
    const task = await app.create("Чужой вид");
    const taskBefore = successful(await app.run(["task", "get", task])).data;
    const taskKeysBefore = successful(await app.run(["inspect", "keys", task])).data;
    const wrong = await app.run(["feature", "rename", task, "WRONG-1", "--if-revision", 1]);
    assert.equal(wrong.body.ok, false);
    assert.deepEqual(successful(await app.run(["task", "get", task])).data, taskBefore);
    assert.deepEqual(successful(await app.run(["inspect", "keys", task])).data, taskKeysBefore);
    assert.deepEqual(await read(), before);
    successful(
      await app.run(["feature", "rename", key, "CATALOG-1", "--if-revision", before.revision]),
    );
    const alias = await read();
    assert.equal(alias.key, "CATALOG-1");
    assert.equal(alias.ref.id, before.ref.id);
    key = alias.key;
  });
  await t.test("list: фильтрация до страниц, cursor сохраняет фильтры", async () => {
    const other = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Каталог второй",
        "--description",
        "Поиск",
      ]),
    ).data;
    successful(
      await app.run([
        "feature",
        "create",
        "--name",
        "Посторонняя фича",
        "--description",
        "Не входит",
      ]),
    );
    const first = successful(
      await app.run<{ items: { key: string }[]; total: number }>([
        "feature",
        "list",
        "--q",
        "Каталог",
        "--sort",
        "title",
        "--limit",
        1,
      ]),
    );
    assert.equal(first.data.total, 2);
    assert.equal(first.meta?.page?.consistency, "snapshot");
    const cursor = first.meta?.page?.nextCursor;
    assert.ok(cursor);
    const second = successful(
      await app.run<{ items: { key: string }[] }>(["feature", "list", "--cursor", cursor]),
    );
    assert.equal(second.data.items.length, 1);
    assert.deepEqual(
      [...first.data.items, ...second.data.items].map((item) => item.key),
      [other.key, key],
    );
    assert.equal(second.meta?.page?.nextCursor, null);
    for (const [args, expectedKey, title] of [
      [
        ["feature", "list", "--q", "Каталог", "--sort", "title", "--limit", "1"],
        other.key,
        "Каталог второй",
      ],
      [["feature", "list", "--cursor", cursor], key, "Каталог уточнён"],
    ] as const) {
      const human = await invokeRaw(app.root, [...args]);
      assert.equal(human.code, 0, human.stdout);
      const text = human.stdout.replace(/\s+/g, " ");
      for (const value of [expectedKey, title, "Не реализовано"])
        assert.ok(text.includes(value), text);
      assert.match(text, /Поиск:\s*Каталог/);
      assert.match(text, /Сортировка:\s*title/);
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
      assert.match(text, /Показано: 1 из 2/);
      if (expectedKey === other.key)
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*feature list .*--cursor/);
      else assert.match(human.stdout, /Конец списка/);
    }
    failed(await app.run(["feature", "list", "--cursor", cursor, "--q", "иной"]), "INVALID_CURSOR");
    const empty = successful(
      await app.run<{ items: unknown[] }>(["feature", "list", "--q", "неттакойфичи"]),
    );
    assert.deepEqual(empty.data.items, []);
    assert.equal(empty.meta?.page?.count, 0);
  });
  await t.test("progress: адресное чтение не меняет содержание", async () => {
    const before = await read();
    const result = successful(await app.run(["feature", "progress", key, "--limit", 1]));
    assert.ok(result.data);
    assert.ok(result.meta?.page);
    assert.deepEqual(await read(), before);
  });
});
