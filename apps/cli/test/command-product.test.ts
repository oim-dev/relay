import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "@relay/server-runtime";
import { fixture, successful, failed, invoke, invokeRaw } from "./helpers/cli.js";

type Detail = {
  ref: { id: string };
  key: string;
  revision: number;
  data: { name: string; summary: string; description: string };
};
const markdown =
  "## Назначение\n\nПолная память 🧭.\n\n```text\n  сохранить отступ\n```\n\nКонец паспорта.\n";

test("product: восемь singleton-листьев и сохранение паспорта", async (t) => {
  const app = await fixture(t);
  const read = async () => successful(await app.run<Detail>(["product", "get"])).data;
  let record = await read();
  await t.test("get: незаполненный singleton", () => assert.equal(record.revision, 0));
  await t.test("create: Markdown stdin и последующее чтение", async () => {
    successful(
      await app.run(
        [
          "product",
          "create",
          "--name",
          "Память продукта",
          "--summary",
          "Общее назначение",
          "--description-file",
          "-",
        ],
        { input: markdown },
      ),
    );
    const saved = await read();
    assert.equal(saved.ref.id, record.ref.id);
    assert.equal(saved.data.description, markdown);
    assert.equal(saved.data.summary, "Общее назначение");
    record = saved;
  });
  await t.test("update: только переданные поля, no-op и stale revision", async () => {
    failed(
      await app.run(["product", "update", "--if-revision", record.revision]),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(await read(), record);
    successful(
      await app.run([
        "product",
        "update",
        "--name",
        "Память команды",
        "--if-revision",
        record.revision,
      ]),
    );
    failed(
      await app.run([
        "product",
        "update",
        "--summary",
        "Не записывать",
        "--if-revision",
        record.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    record = await read();
    assert.equal(record.data.name, "Память команды");
    assert.equal(record.data.description, markdown);
    assert.equal(record.data.summary, "Общее назначение");
    successful(
      await app.run(["product", "update", "--clear-summary", "--if-revision", record.revision]),
    );
    record = await read();
    assert.equal(record.data.summary, "");
  });
  await t.test("rename: singleton и прежний адрес сохраняются", async () => {
    const old = record;
    successful(await app.run(["product", "rename", "MEMORY", "--if-revision", old.revision]));
    record = await read();
    assert.equal(record.key, "MEMORY");
    assert.equal(record.ref.id, old.ref.id);
    const resolved = successful(
      await app.run<{ ref: { id: string }; key: string }>(["inspect", "resolve", old.key]),
    ).data;
    assert.equal(resolved.ref.id, old.ref.id);
    assert.equal(resolved.key, record.key);
  });
  await t.test("progress: JSON-страница и human не устанавливают готовность", async () => {
    const result = successful(await app.run(["product", "progress", "--limit", 1]));
    assert.ok(result.data);
    const human = await invokeRaw(app.root, ["product", "progress"]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /продукт|готов|прогресс/i);
    assert.deepEqual(await read(), record);
  });
  await t.test("overview: компактная карта с snapshot guard", async () => {
    for (const name of ["Одна фича", "Другая фича"])
      successful(
        await app.run(["feature", "create", "--name", name, "--description", "Назначение"]),
      );
    const page = successful(
      await app.run<{ items: unknown[] }>(["product", "overview", "--limit", 1]),
    );
    assert.equal(page.data.items.length, 1);
    assert.equal(page.meta?.page?.consistency, "snapshot");
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: unknown[] }>([
        "product",
        "overview",
        "--cursor",
        page.meta!.page!.nextCursor!,
      ]),
    );
    assert.notDeepEqual(next.data.items, page.data.items);
    successful(
      await app.run([
        "feature",
        "create",
        "--name",
        "Изменение карты",
        "--description",
        "Назначение",
      ]),
    );
    const conflict = await app.run([
      "product",
      "overview",
      "--cursor",
      page.meta!.page!.nextCursor!,
    ]);
    assert.equal(conflict.body.ok, false);
    if (!conflict.body.ok) assert.equal(conflict.body.error.code, "VERSION_CONFLICT");
  });
  await t.test("validate: структурная проверка, не запись", async () => {
    const result = successful(
      await app.run<{ valid: boolean; records: number; version: string }>(["product", "validate"]),
    ).data;
    assert.equal(result.valid, true);
    assert.ok(result.records > 0);
    assert.ok(result.version);
    assert.deepEqual(await read(), record);
  });
  await t.test("lint: рекомендации и выбор singleton по новому ключу", async () => {
    const result = successful(
      await app.run<{ warnings: unknown[] }>(["product", "lint", "--id", record.key]),
    );
    assert.ok(Array.isArray(result.data.warnings));
    assert.equal(result.meta?.page?.count, result.data.warnings.length);
    assert.deepEqual(await read(), record);
  });
  for (const width of [40, 100])
    await t.test(`human get: полный Markdown, ключ, ревизия, ширина ${width}`, async () => {
      const human = await invokeRaw(app.root, ["product", "get"], {
        env: { COLUMNS: String(width), FORCE_COLOR: "1" },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /MEMORY/);
      assert.match(human.stdout, /Память команды/);
      assert.match(human.stdout, /ревизия/i);
      assert.match(human.stdout, /## Назначение/);
      assert.match(human.stdout, /  сохранить отступ/);
      assert.match(human.stdout, /Конец паспорта/);
      assert.match(human.stdout, /npx @oim-dev\/relay-cli/);
      assert.doesNotMatch(human.stdout, /\u001b|"ok":|"data":/);
    });
});

test("каталоги create/update: ввод до мутации и human-квитанции всех шести видов", async (t) => {
  const app = await fixture(t);
  const feature = successful(
    await app.run<{ key: string }>([
      "feature",
      "create",
      "--name",
      "Родитель",
      "--description",
      "Требования",
    ]),
  ).data;
  const application = successful(
    await app.run<{ key: string }>([
      "application",
      "create",
      "--name",
      "Web",
      "--slug",
      "web",
      "--description",
      "Интерфейс",
    ]),
  ).data;
  for (const kind of [
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
    "document",
  ])
    await t.test(kind, async () => {
      const field = kind === "document" ? "body" : "description";
      const options =
        kind === "scenario"
          ? ["--feature", feature.key]
          : kind === "application"
            ? ["--slug", "another"]
            : kind === "implementation"
              ? ["--application", application.key, "--target", feature.key]
              : [];
      const before = successful(await app.run(["search"])).data;
      for (const input of [
        [`--${field}`, "Не записывать", `--${field}-file`, "-"],
        [`--${field}-file`, "/несуществующий-файл-relay.md"],
      ]) {
        const result = await app.run(
          [
            kind,
            "create",
            kind === "implementation" ? "--title" : "--name",
            "Не создавать",
            ...options,
            ...input,
          ],
          { input: markdown },
        );
        assert.equal(result.body.ok, false, result.stdout);
        assert.deepEqual(successful(await app.run(["search"])).data, before);
      }
      const titleFlag = kind === "implementation" ? "--title" : "--name";
      const receipt = await invokeRaw(app.root, [
        kind,
        "create",
        titleFlag,
        "Новая запись",
        ...options,
        `--${field}`,
        markdown,
      ]);
      assert.equal(receipt.code, 0, receipt.stdout);
      assert.equal(receipt.stderr, "");
      const selected = successful(
        await app.run<{ items: { key: string }[] }>([
          "search",
          "--kind",
          kind,
          "--q",
          "Новая запись",
        ]),
      ).data.items;
      assert.equal(selected.length, 1);
      const key = selected[0]!.key;
      const address = kind === "product" ? [] : [key];
      const saved = successful(
        await app.run<{ revision: number; data: Record<string, unknown> }>([
          kind,
          "get",
          ...address,
        ]),
      ).data;
      assert.equal(saved.data[field], markdown);
      const updated = await invokeRaw(app.root, [
        kind,
        "update",
        ...address,
        titleFlag,
        "Уточнённая запись",
        "--if-revision",
        saved.revision,
      ]);
      for (const out of [receipt, updated]) {
        assert.equal(out.code, 0, out.stdout);
        assert.equal(out.stderr, "");
        assert.ok(out.stdout.includes(key), out.stdout);
        assert.match(out.stdout, /ревизия/i);
        assert.match(out.stdout, new RegExp(`npx @oim-dev/relay-cli .*${kind} get`));
        assert.doesNotMatch(out.stdout, /\u001b|"data":/);
      }
      const current = successful(
        await app.run<{ revision: number; data: Record<string, unknown> }>([
          kind,
          "get",
          ...address,
        ]),
      ).data;
      assert.equal(current.data[field], markdown);
      assert.equal(current.data[kind === "implementation" ? "title" : "name"], "Уточнённая запись");
      const error = await invokeRaw(app.root, [
        kind,
        "update",
        ...address,
        "--if-revision",
        current.revision,
      ]);
      assert.notEqual(error.code, 0);
      assert.equal(error.stderr, "");
      assert.match(error.stdout, /INVALID_ARGUMENT/);
      assert.match(error.stdout, /поле/i);
      assert.doesNotMatch(error.stdout, /\u001b/);
      assert.deepEqual(successful(await app.run([kind, "get", ...address])).data, current);
    });
});

test("product: HTTP create/update и последующее local/HTTP чтение эквивалентны", async (t) => {
  const app = await fixture(t);
  const server = await startServer({ cwd: app.root, actor: "human", port: 0 });
  t.after(() => server.close());
  const remote = <T = unknown>(args: Array<string | number>) =>
    invoke<T>(app.root, ["--server-url", server.url, ...args]);
  successful(
    await remote([
      "product",
      "create",
      "--name",
      "Общая память",
      "--summary",
      "Назначение",
      "--description",
      markdown,
    ]),
  );
  const before = successful(await remote<Detail>(["product", "get"])).data;
  successful(
    await remote([
      "product",
      "update",
      "--name",
      "Память команды",
      "--if-revision",
      before.revision,
    ]),
  );
  failed(
    await remote([
      "product",
      "update",
      "--name",
      "Старая версия",
      "--if-revision",
      before.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  for (const args of [
    ["product", "get"],
    ["product", "overview"],
    ["product", "validate"],
    ["product", "progress"],
  ]) {
    assert.deepEqual(
      successful(await remote(args)).data,
      successful(await app.run(["--local", ...args])).data,
    );
  }
  const after = successful(await remote<Detail>(["product", "get"])).data;
  assert.equal(after.data.description, markdown);
  assert.equal(after.data.summary, "Назначение");
});
