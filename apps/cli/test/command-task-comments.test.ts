import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Comment = { id: number; title: string; description: string; actor: string; actorRole: string };
type Page = { items: Comment[]; snapshot: number; nextCursor: string | null };

test(
  "comment add/list/get: inline/file/stdin, повтор не дедуплицируется, ревизия задачи неизменна",
  { timeout: 150_000 },
  async (t) => {
    const app = await fixture(t);
    const task = await app.create("Обсуждаем 界");
    successful(await app.run(["task", "move", task, "--column", "done", "--if-revision", 1]));
    const before = successful(await app.run(["task", "get", task])).data;
    const description = "## Проверка 🧪\n\n**Результат** = да\n\n```text\n  отступ = 界\n```\n";
    const file = join(app.root, "сообщение с пробелами.md");
    await writeFile(file, description);
    const ids: string[] = [];
    for (const [index, source] of [
      ["--description", description],
      ["--description-file", file],
      ["--description-file", "-"],
    ].entries()) {
      const args = [
        "task",
        "comment",
        "add",
        task,
        "--title",
        `Отчёт ${index}`,
        "--role",
        "worker",
        "--actor",
        "проверяющий",
        "--request-id",
        "same-request",
        ...source,
      ];
      const saved = successful(
        await app.run<{ commentId: string }>(args, { input: description }),
      ).data;
      ids.push(String(saved.commentId));
      const read = successful(
        await app.run<Comment>(["task", "comment", "get", task, saved.commentId]),
      ).data;
      assert.deepEqual(
        {
          title: read.title,
          description: read.description,
          actor: read.actor,
          role: read.actorRole,
        },
        { title: `Отчёт ${index}`, description, actor: "проверяющий", role: "worker" },
      );
      const human = await invokeRaw(app.root, ["task", "comment", "get", task, saved.commentId], {
        env: { COLUMNS: index === 1 ? "100" : "40", FORCE_COLOR: "3" },
      });
      assert.equal(human.code, 0, human.stdout + human.stderr);
      assert.equal(human.stderr, "");
      for (const fragment of [
        `Отчёт ${index}`,
        "проверяющий",
        "Исполнитель",
        "## Проверка 🧪",
        "**Результат** = да",
        "  отступ = 界",
      ])
        assert.ok(human.stdout.includes(fragment), human.stdout);
      assert.doesNotMatch(human.stdout, /\u001b|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{23}/i);
      assert.deepEqual(successful(await app.run(["task", "get", task])).data, before);
    }
    assert.equal(new Set(ids).size, 3);
    const receipt = await invokeRaw(app.root, [
      "task",
      "comment",
      "add",
      task,
      "--title",
      "Четвёртый",
      "--role",
      "operator",
      "--description",
      description,
    ]);
    assert.equal(receipt.code, 0, receipt.stdout + receipt.stderr);
    assert.equal(receipt.stderr, "");
    assert.match(receipt.stdout, /Комментарий опубликован/);
    assert.match(receipt.stdout, /npx @oim-dev\/relay-cli .*task comment get/);
    assert.doesNotMatch(receipt.stdout, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{23}/i);
    const list = successful(await app.run<Page>(["task", "comment", "list", task]));
    assert.equal(list.data.items.length, 4);
    assert.deepEqual(successful(await app.run(["task", "get", task])).data, before);
    const invalid = await app.run(
      [
        "task",
        "comment",
        "add",
        task,
        "--title",
        "Не записывать",
        "--role",
        "worker",
        "--description",
        "inline",
        "--description-file",
        "-",
      ],
      { input: "stdin" },
    );
    assert.equal(invalid.body.ok, false);
    assert.notEqual(invalid.code, 0);
    assert.deepEqual(
      successful(await app.run<Page>(["task", "comment", "list", task])).data,
      list.data,
    );
  },
);

test(
  "comment list: native snapshot, фильтры by/after/action, cursor-only replay и другой ref",
  { timeout: 180_000 },
  async (t) => {
    const app = await fixture(t);
    const task = await app.create("Лента");
    const other = await app.create("Чужая лента");
    const publish = async (actor: string, title: string) =>
      successful(
        await app.run<{ commentId: string }>([
          "task",
          "comment",
          "add",
          task,
          "--actor",
          actor,
          "--role",
          "worker",
          "--title",
          title,
          "--description",
          `## ${title}\n\nСодержание`,
        ]),
      ).data;
    const expected: string[] = [];
    for (let index = 0; index < 7; index++) {
      const saved = await publish(index % 2 ? "другой" : "автор 界", `Запись ${index}`);
      if (index % 2 === 0 && index > 0) expected.push(String(saved.commentId));
    }
    const args = [
      "task",
      "comment",
      "list",
      task,
      "--by",
      "автор 界",
      "--after",
      1,
      "--action",
      "comment-publish",
      "--limit",
      1,
    ];
    let page = successful(await app.run<Page>(args));
    assert.equal(page.meta!.page!.consistency, "snapshot");
    const snapshot = page.data.snapshot;
    const cursor = page.meta!.page!.nextCursor!;
    assert.ok(cursor);
    assert.notEqual(cursor, page.data.nextCursor);
    failed(await app.run(["task", "comment", "list", other, "--cursor", cursor]), "INVALID_CURSOR");
    failed(
      await app.run(["task", "comment", "list", task, "--cursor", cursor, "--by", "другой"]),
      "INVALID_CURSOR",
    );
    failed(
      await app.run(["task", "comment", "list", task, "--cursor", page.data.nextCursor!]),
      "INVALID_CURSOR",
    );
    await publish("автор 界", "Не входит в исходный снимок");
    const seen: string[] = [];
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 20, "Курсор обязан завершиться");
      assert.equal(page.data.snapshot, snapshot);
      assert.equal(page.meta!.page!.count, page.data.items.length);
      assert.equal(page.meta!.page!.limit, 1);
      for (const item of page.data.items) {
        assert.equal(item.actor, "автор 界");
        seen.push(String(item.id));
      }
      const next = page.meta!.page!.nextCursor;
      if (!next) break;
      page = successful(await app.run<Page>(["task", "comment", "list", task, "--cursor", next]));
    }
    assert.equal(page.meta!.page!.nextCommand, null);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen.sort(), expected.sort());
    const empty = successful(
      await app.run<Page>(["task", "comment", "list", task, "--by", "нет такого автора"]),
    );
    assert.deepEqual(empty.data.items, []);
    assert.equal(empty.meta!.page!.count, 0);
    assert.equal(empty.meta!.page!.nextCursor, null);
    const human = await invokeRaw(app.root, args, { env: { COLUMNS: "40", FORCE_COLOR: "3" } });
    assert.equal(human.code, 0, human.stdout + human.stderr);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /Комментарии/);
    assert.match(human.stdout, /автор 界/);
    assert.match(human.stdout, /npx @oim-dev\/relay-cli .*task comment list.*--cursor/);
    assert.equal(human.stdout.split("Показано:").length - 1, 1, human.stdout);
    assert.equal(human.stdout.split("Есть продолжение").length - 1, 1, human.stdout);
    assert.doesNotMatch(human.stdout, /Граница снимка|Снимок:/);
    assert.doesNotMatch(human.stdout, /\u001b/);
  },
);
