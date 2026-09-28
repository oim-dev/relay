import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { EntitySaved } from "@relay/contracts/entities";
import { fixture, successful, failed, invoke, invokeRaw } from "./helpers/cli.js";

test("search/inspect: шесть листьев, schemas, aliases и snapshot фильтров", async (t) => {
  const app = await fixture(t);
  const created: EntitySaved[] = [];
  for (const name of ["Каталог O'Brien первый", "Каталог O'Brien второй", "Посторонняя запись"]) {
    created.push(
      successful(
        await app.run<EntitySaved>([
          "feature",
          "create",
          "--name",
          name,
          "--description",
          "## Полные требования\n\nНайти документ.",
        ]),
      ).data,
    );
  }
  successful(
    await app.run([
      "document",
      "create",
      "--name",
      "Каталог O'Brien другого вида",
      "--body",
      "Материал",
    ]),
  );
  const first = created[0]!;
  await t.test("search: аргумент/q, refs, cursor, изменение фильтров и снимка", async () => {
    failed(await app.run(["search", "Каталог", "--q", "Каталог"]), "INVALID_ARGUMENT");
    const page = successful(
      await app.run<{ items: { key: string }[]; total: number }>([
        "search",
        "Каталог O'Brien",
        "--kind",
        "feature",
        "--sort",
        "title",
        "--limit",
        1,
      ]),
    );
    assert.equal(page.data.total, 2);
    assert.equal(page.meta?.page?.consistency, "snapshot");
    const cursor = page.meta?.page?.nextCursor;
    assert.ok(cursor);
    assert.match(page.meta!.page!.nextCommand!, /^npx @oim-dev\/relay-cli /);
    assert.doesNotMatch(page.meta!.page!.nextCommand!, /\n/);
    const next = successful(
      await app.run<{ items: { key: string }[] }>(["search", "--cursor", cursor]),
    );
    assert.deepEqual(
      [...page.data.items, ...next.data.items].map((item) => item.key),
      [created[1]!.key, first.key],
    );
    assert.equal(next.meta?.page?.nextCursor, null);
    failed(await app.run(["search", "--cursor", cursor, "--kind", "document"]), "INVALID_CURSOR");
    failed(await app.run(["feature", "list", "--cursor", cursor]), "INVALID_CURSOR");
    const selected = successful(
      await app.run<{ items: { key: string }[] }>(["search", "--refs", first.key]),
    ).data;
    assert.deepEqual(
      selected.items.map((item) => item.key),
      [first.key],
    );
    successful(
      await app.run([
        "feature",
        "update",
        first.key,
        "--summary",
        "Изменение снимка",
        "--if-revision",
        first.revision,
      ]),
    );
    const conflict = await app.run(["search", "--cursor", cursor]);
    assert.equal(conflict.body.ok, false);
    if (!conflict.body.ok) assert.equal(conflict.body.error.code, "ENTITIES_CHANGED");
    const empty = successful(await app.run<{ items: unknown[] }>(["search", "неттакоготекста"]));
    assert.deepEqual(empty.data.items, []);
    assert.equal(empty.meta?.page?.count, 0);
  });
  await t.test("inspect types: одиннадцать типов, pagination", async () => {
    const page = successful(
      await app.run<{ items: { kind: string }[]; total: number }>([
        "inspect",
        "types",
        "--limit",
        2,
      ]),
    );
    assert.equal(page.data.total, 11);
    assert.equal(page.data.items.length, 2);
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: unknown[] }>([
        "inspect",
        "types",
        "--cursor",
        page.meta!.page!.nextCursor!,
      ]),
    );
    assert.notDeepEqual(next.data.items, page.data.items);
    const all = successful(await app.run<{ items: { kind: string }[] }>(["inspect", "types"])).data;
    assert.ok(all.items.some((item) => item.kind === "document"));
  });
  await t.test("inspect type: документ, поля и допустимые действия", async () => {
    const result = successful(await app.run<{ kind: string }>(["inspect", "type", "document"]));
    assert.equal(result.data.kind, "document");
    const human = await invokeRaw(app.root, ["inspect", "type", "document"]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /body/);
    assert.match(human.stdout, /relations/);
    assert.doesNotMatch(human.stdout, /\u001b/);
  });
  await t.test("inspect resolve: ID, kind:ID, alias и wrong kind", async () => {
    const detail = successful(
      await app.run<{ revision: number }>(["feature", "get", first.key]),
    ).data;
    successful(
      await app.run([
        "feature",
        "rename",
        first.key,
        "SEARCHABLE",
        "--if-revision",
        detail.revision,
      ]),
    );
    for (const ref of [first.key, first.ref.id, `feature:${first.ref.id}`, "SEARCHABLE"]) {
      const result = successful(
        await app.run<{ key: string; ref: { id: string; kind: string } }>([
          "inspect",
          "resolve",
          ref,
          "--kind",
          "feature",
        ]),
      ).data;
      assert.equal(result.key, "SEARCHABLE");
      assert.equal(result.ref.id, first.ref.id);
      assert.equal(result.ref.kind, "feature");
    }
    assert.equal(
      (await app.run(["inspect", "resolve", first.key, "--kind", "document"])).body.ok,
      false,
    );
  });
  await t.test(
    "inspect keys: текущий ключ и сохранённый алиас, не история содержимого",
    async () => {
      const keys = successful(
        await app.run<{ items: { key: string; current: boolean }[] }>([
          "inspect",
          "keys",
          first.key,
        ]),
      ).data.items;
      assert.ok(keys.some((item) => item.key === "SEARCHABLE" && item.current));
      assert.ok(keys.some((item) => item.key === first.key && !item.current));
      const page = successful(await app.run(["inspect", "keys", first.key, "--limit", 1]));
      assert.ok(page.meta?.page?.nextCursor);
      successful(
        await app.run(["inspect", "keys", first.key, "--cursor", page.meta!.page!.nextCursor!]),
      );
    },
  );
  await t.test("inspect key-spaces: шаблон нумерации без записи", async () => {
    const result = successful(
      await app.run<{ items: { pattern: string }[] }>(["inspect", "key-spaces", "feature"]),
    );
    assert.ok(result.data.items.length > 0);
    assert.ok(result.data.items.every((item) => item.pattern.length > 0));
    assert.equal(result.meta?.page?.count, result.data.items.length);
    const human = await invokeRaw(app.root, ["inspect", "key-spaces", "feature"]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /FEATURE/);
  });
  await t.test(
    "human search: default text, Unicode и continuation без ANSI на 40/100",
    async () => {
      const command = ["search", "Каталог", "--kind", "feature", "--sort", "title", "--limit", "1"];
      const page = successful(await app.run(command));
      assert.ok(page.meta?.page?.nextCursor);
      for (const width of [40, 100]) {
        for (const [args, expectedKey, name] of [
          [command, created[1]!.key, "Каталог O'Brien второй"],
          [
            ["search", "--cursor", page.meta!.page!.nextCursor!],
            "SEARCHABLE",
            "Каталог O'Brien первый",
          ],
        ] as const) {
          const out = await invokeRaw(app.root, [...args], {
            env: { COLUMNS: String(width), FORCE_COLOR: "1" },
          });
          assert.equal(out.code, 0, out.stdout);
          assert.equal(out.stderr, "");
          const text = out.stdout.replace(/\s+/g, " ");
          for (const value of [expectedKey, name, "Не реализовано"])
            assert.ok(text.includes(value), text);
          assert.match(text, /Вид:\s*Фича/);
          assert.match(text, /Поиск:\s*Каталог/);
          assert.match(text, /Сортировка:\s*title/);
          assert.equal((out.stdout.match(/Показано:/g) ?? []).length, 1);
          assert.match(text, /Показано: 1 из 2/);
          assert.match(out.stdout, /npx @oim-dev\/relay-cli .*feature get/);
          if (expectedKey === created[1]!.key)
            assert.match(out.stdout, /npx @oim-dev\/relay-cli .*--cursor/);
          else assert.match(out.stdout, /Конец списка/);
          assert.doesNotMatch(out.stdout, /\u001b|"data":/);
        }
      }
    },
  );
});

test("search: nextCommand фиксирует RELAY_CONFIG и копируется shell с пробелами/апострофом", async (t) => {
  const app = await fixture(t);
  const directory = join(app.root, "O'Brien project");
  await mkdir(directory);
  successful(await invoke(directory, ["init"]));
  const config = join(directory, ".relay", "config.json");
  const env = { RELAY_CONFIG: config };
  for (const name of ["O'Brien первый", "O'Brien второй"])
    successful(
      await app.run(["feature", "create", "--name", name, "--description", "Назначение"], { env }),
    );
  const first = successful(
    await app.run<{ items: { key: string }[] }>(
      ["--local", "search", "O'Brien", "--kind", "feature", "--limit", 1],
      { env },
    ),
  );
  const hint = first.meta?.page?.nextCommand;
  assert.ok(hint);
  assert.doesNotMatch(hint, /\n/);
  // Shell только разбирает выданную команду; npx и сеть не запускаются.
  const parsed = await promisify(execFile)("/bin/sh", [
    "-c",
    `set -- ${hint}; printf '%s\\0' "$@"`,
  ]);
  const args = parsed.stdout.split("\0").slice(0, -1);
  assert.deepEqual(args.slice(0, 2), ["npx", "@oim-dev/relay-cli"]);
  assert.equal(args[args.indexOf("--config") + 1], config);
  assert.ok(args.includes("--local"));
  const next = successful(await app.run<{ items: { key: string }[] }>(args.slice(2)));
  assert.equal(next.data.items.length, 1);
  assert.notDeepEqual(next.data.items, first.data.items);
  assert.equal(next.meta?.page?.nextCursor, null);
});

test("P2 search: состояния задач и плана локализуются по виду, JSON сохраняет enum", async (t) => {
  const app = await fixture(t);
  const tasks: { key: string }[] = [];
  for (const [status, label] of [
    ["inbox", "Входящие"],
    ["review", "На проверке"],
  ] as const) {
    const task = successful(
      await app.run<{ key: string }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        `Проверка состояния ${tasks.length + 1}`,
        "--column",
        status,
      ]),
    ).data;
    tasks.push(task);
    await t.test(`task ${status}: ${label}`, async () => {
      const command = ["search", "--kind", "task", "--status", status];
      const json = successful(
        await app.run<{ items: { key: string; status: string }[] }>(command),
      ).data;
      assert.deepEqual(
        json.items.map((item) => [item.key, item.status]),
        [[task.key, status]],
      );
      const owner = await invokeRaw(app.root, ["task", "get", task.key]);
      assert.equal(owner.code, 0, owner.stdout);
      assert.ok(owner.stdout.replace(/\s+/g, " ").includes(label), owner.stdout);
      for (const width of [40, 100]) {
        const human = await invokeRaw(app.root, command, { env: { COLUMNS: String(width) } });
        assert.equal(human.code, 0, human.stdout);
        assert.equal(human.stderr, "");
        assert.ok(human.stdout.includes(task.key), human.stdout);
        assert.ok(human.stdout.replace(/\s+/g, " ").includes(label), human.stdout);
        assert.doesNotMatch(human.stdout, /(?:Состояние|Колонка):\s*(?:inbox|review)\b|\u001b/);
      }
      assert.deepEqual(successful(await app.run(command)).data, json);
    });
  }
  await t.test("work-plan active: В работе, а не состояние документа", async () => {
    const plan = successful(
      await app.run<{ key: string; revision: number }>([
        "plan",
        "create",
        "--title",
        "Проверка локализации",
        "--goal",
        "Согласованные подписи состояний",
      ]),
    ).data;
    const stage = successful(
      await app.run<{ stageId: string; revision: number }>([
        "plan",
        "stage",
        "create",
        plan.key,
        "--title",
        "Проверка",
        "--if-revision",
        plan.revision,
      ]),
    ).data;
    const added = successful(
      await app.run<{ revision: number }>([
        "plan",
        "stage",
        "task",
        "add",
        plan.key,
        stage.stageId,
        "--tasks",
        tasks[0]!.key,
        "--if-revision",
        stage.revision,
      ]),
    ).data;
    successful(await app.run(["plan", "start", plan.key, "--if-revision", added.revision]));
    const command = ["search", "--kind", "work-plan", "--status", "active"];
    const json = successful(
      await app.run<{ items: { key: string; status: string }[] }>(command),
    ).data;
    assert.deepEqual(
      json.items.map((item) => [item.key, item.status]),
      [[plan.key, "active"]],
    );
    const owner = await invokeRaw(app.root, ["plan", "list", "--status", "active"]);
    assert.equal(owner.code, 0, owner.stdout);
    assert.match(owner.stdout.replace(/\s+/g, " "), /В работе/);
    for (const width of [40, 100]) {
      const human = await invokeRaw(app.root, command, { env: { COLUMNS: String(width) } });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.ok(human.stdout.includes(plan.key), human.stdout);
      assert.match(human.stdout.replace(/\s+/g, " "), /В работе/);
      assert.doesNotMatch(human.stdout, /Действующий|Состояние:\s*active\b|\u001b/);
    }
    assert.deepEqual(successful(await app.run(command)).data, json);
  });
});
