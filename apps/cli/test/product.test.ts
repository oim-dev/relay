import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "@relay/server-runtime";
import { fixture, successful, failed, invoke, invokeRaw } from "./helpers/cli.js";
import stringWidth from "string-width";

test("продуктовый CLI: Markdown, таблица, узкий терминал, продолжение и JSON", async (t) => {
  const app = await fixture(t);
  const markdown = "## Цель\n\nНайти вещь.\n\n## Критерии приёмки\n\n- Доступная вещь показана.\n";
  for (const name of ["Каталог 🛠", "Каталог второй"])
    successful(
      await app.run([
        "product",
        "feature",
        "create",
        "--name",
        name,
        "--summary",
        "Поиск\nПодбор",
        "--description",
        markdown,
      ]),
    );
  const list = successful(
    await app.run<{ items: { id: string }[]; nextOffset: number }>([
      "product",
      "list",
      "--kind",
      "feature",
      "--q",
      "Каталог",
      "--limit",
      "1",
    ]),
  );
  assert.equal(list.data.nextOffset, 1);
  for (const width of [40, 100]) {
    const output = await invokeRaw(
      app.root,
      [
        "--color",
        "never",
        "product",
        "list",
        "--kind",
        "feature",
        "--q",
        "Каталог",
        "--limit",
        "1",
      ],
      { env: { COLUMNS: String(width), NO_COLOR: "1" } },
    );
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Записи продукта/i);
    assert.match(output.stdout, /Продолжение/);
    assert.match(output.stdout.replaceAll("\n", ""), /--offset 1/);
    assert.doesNotMatch(output.stdout, /\u001b\[/);
    for (const line of output.stdout.split("\n")) assert.ok(stringWidth(line) <= width, line);
  }
  const context = await invokeRaw(app.root, [
    "--color",
    "never",
    "product",
    "context",
    "--id",
    list.data.items[0]!.id,
  ]);
  assert.equal(context.code, 0, context.stderr);
  assert.match(context.stdout, /Почему включено|ПОЧЕМУ ВКЛЮЧЕНО/);
  assert.match(context.stdout, /Найти вещь/);
  assert.doesNotMatch(context.stdout, /fields:|description:|\\n/);
  successful(await app.run(["product", "lint"]));
  assert.equal(
    successful(await app.run<{ migrated: number }>(["--local", "product", "migrate"])).data
      .migrated,
    0,
  );
});

test("CLI продукта принимает многострочный Markdown напрямую; local и HTTP эквивалентны", async (t) => {
  const app = await fixture(t);
  const markdown = "## Назначение\n\n- Фронтенд\n- API\n\nТекст с  пробелами  \n";
  const command = [
    "product",
    "passport",
    "create",
    "--name",
    "Продукт",
    "--summary",
    "Общая память",
    "--description",
    markdown,
    "--request-id",
    "passport",
  ];
  successful(await app.run(command));
  const record = successful(
    await app.run<{ fields: { description: string } }>(["product", "get", "passport"]),
  );
  assert.equal(record.data.fields.description, markdown);
  failed(
    await app.run([
      "product",
      "passport",
      "update",
      "passport",
      "--name",
      "Другое имя",
      "--description",
      markdown,
      "--if-revision",
      "99",
    ]),
    "REVISION_CONFLICT",
    4,
  );
  const server = await startServer({ cwd: app.root, actor: "human", port: 0 });
  t.after(() => server.close());
  for (const args of [
    ["product", "overview"],
    ["product", "list", "--kind", "passport"],
    ["product", "context"],
    ["product", "validate"],
  ]) {
    assert.deepEqual(
      successful(await invoke(app.root, ["--server-url", server.url, ...args])).data,
      successful(await app.run(args)).data,
    );
  }
});
