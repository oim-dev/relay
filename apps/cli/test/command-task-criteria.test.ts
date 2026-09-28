import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Criterion = {
  id: string;
  title: string;
  summary: string;
  description: string;
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
};
type View = { revision: number; criterion: Criterion };

test(
  "criterion: семь команд, текстовые источники, сохранение и сброс отметки, guards",
  { timeout: 180_000 },
  async (t) => {
    const app = await fixture(t);
    const task = await app.create("Проверить критерии 界");
    const summary = "Первая строка = да\nВторая строка 🧪";
    const description = "## Приёмка\n\n- x = y\n\n```ts\n  const x = '界';\n```\n";
    const file = join(app.root, "критерий с пробелами.md");
    await writeFile(file, description);
    const added = successful(
      await app.run<{ criterionId: string; revision: number }>([
        "task",
        "criterion",
        "add",
        task,
        "--title",
        "Точный результат = да",
        "--summary",
        summary,
        "--description-file",
        file,
        "--if-revision",
        1,
      ]),
    ).data;
    const id = added.criterionId;
    assert.ok(id);
    const get = async () =>
      successful(await app.run<View>(["task", "criterion", "get", task, id])).data;
    let view = await get();
    assert.deepEqual(view.criterion, {
      id,
      title: "Точный результат = да",
      summary,
      description,
      completed: false,
      completedBy: null,
      completedAt: null,
    });
    assert.equal(view.revision, 2);
    const list = successful(
      await app.run<{ items: Criterion[]; revision: number }>([
        "task",
        "criterion",
        "list",
        task,
        "--limit",
        1,
      ]),
    );
    assert.deepEqual(
      list.data.items.map(({ id, title, summary, completed }) => ({
        id,
        title,
        summary,
        completed,
      })),
      [{ id, title: view.criterion.title, summary, completed: false }],
    );
    assert.deepEqual(list.meta!.page, {
      count: 1,
      total: 1,
      limit: 1,
      nextCursor: null,
      nextCommand: null,
      consistency: "snapshot",
    });
    for (const width of [40, 100]) {
      for (const command of [
        ["task", "criterion", "list", task],
        ["task", "criterion", "get", task, id],
      ]) {
        const human = await invokeRaw(app.root, command, {
          env: { COLUMNS: String(width), FORCE_COLOR: "3" },
        });
        assert.equal(human.code, 0, human.stdout + human.stderr);
        assert.equal(human.stderr, "");
        for (const fragment of [
          id,
          "Точный результат = да",
          "Первая строка = да",
          "Вторая строка 🧪",
          "Ревизия",
        ])
          assert.ok(human.stdout.includes(fragment), human.stdout);
        assert.doesNotMatch(human.stdout, /\u001b/);
        if (command[2] === "get")
          assert.ok(human.stdout.includes("  const x = '界';"), human.stdout);
      }
    }
    const mutate = async (action: string, extra: Array<string | number> = []) => {
      const before = await get();
      const human = await invokeRaw(app.root, [
        "task",
        "criterion",
        action,
        task,
        id,
        "--actor",
        "criterion-worker",
        "--if-revision",
        before.revision,
        ...extra,
      ]);
      assert.equal(human.code, 0, human.stdout + human.stderr);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /Ревизия:/);
      assert.match(human.stdout, /npx @oim-dev\/relay-cli .*task get/);
      assert.doesNotMatch(human.stdout, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{23}/i);
      return get();
    };
    view = await mutate("complete");
    assert.equal(view.criterion.completed, true);
    assert.equal(view.criterion.completedBy, "criterion-worker");
    assert.ok(view.criterion.completedAt);
    const completedAt = view.criterion.completedAt;
    view = await mutate("update", ["--summary", summary]);
    assert.equal(view.criterion.completed, true);
    assert.equal(view.criterion.completedAt, completedAt);
    view = await mutate("reopen");
    assert.deepEqual(
      [view.criterion.completed, view.criterion.completedBy, view.criterion.completedAt],
      [false, null, null],
    );
    view = await mutate("complete");
    successful(
      await app.run(
        [
          "task",
          "criterion",
          "update",
          task,
          id,
          "--if-revision",
          view.revision,
          "--description-file",
          "-",
        ],
        { input: description + "\nКонец = ✓\n" },
      ),
    );
    view = await get();
    assert.equal(view.criterion.description, description + "\nКонец = ✓\n");
    assert.equal(view.criterion.summary, summary);
    assert.equal(view.criterion.completed, false);
    failed(
      await app.run(["task", "criterion", "remove", task, id, "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    assert.deepEqual(await get(), view);
    failed(
      await app.run(["task", "move", task, "--column", "done", "--if-revision", view.revision]),
      "TASK_ACCEPTANCE_INCOMPLETE",
      4,
    );
    assert.deepEqual(await get(), view);
    view = await mutate("complete");
    successful(
      await app.run(["task", "move", task, "--column", "done", "--if-revision", view.revision]),
    );
    view = await get();
    for (const action of ["update", "reopen", "remove"]) {
      const result = await app.run([
        "task",
        "criterion",
        action,
        task,
        id,
        "--if-revision",
        view.revision,
        ...(action === "update" ? ["--title", "Запрещено"] : []),
      ]);
      assert.notEqual(result.code, 0, result.stdout);
      assert.equal(result.body.ok, false);
      assert.deepEqual(await get(), view);
    }
    successful(
      await app.run(["task", "move", task, "--column", "review", "--if-revision", view.revision]),
    );
    view = await get();
    const removed = await invokeRaw(app.root, [
      "task",
      "criterion",
      "remove",
      task,
      id,
      "--if-revision",
      view.revision,
    ]);
    assert.equal(removed.code, 0, removed.stdout);
    assert.match(removed.stdout, /Ревизия:/);
    assert.deepEqual(
      successful(await app.run<{ items: unknown[] }>(["task", "criterion", "list", task])).data
        .items,
      [],
    );
  },
);

test(
  "criterion: конфликт источников не меняет задачу; страницы сохраняют ref и снимок",
  { timeout: 120_000 },
  async (t) => {
    const app = await fixture(t);
    const task = await app.create("Критерии", [
      "--criterion-description",
      "second=## Полное\n\nx=y=z\n",
      "--criterion-title",
      "first=Первый = 界",
      "--criterion-title",
      "second=Второй",
      "--criterion-summary",
      "first=Раз\nДва",
    ]);
    const other = await app.create("Другая задача");
    const before = successful(await app.run(["task", "get", task])).data;
    for (const options of [
      ["--summary", "inline", "--summary-file", "-"],
      ["--summary-file", "-", "--description-file", "-"],
    ]) {
      const result = await app.run(
        [
          "task",
          "criterion",
          "add",
          task,
          "--title",
          "Не сохранить",
          "--if-revision",
          1,
          ...options,
        ],
        { input: "текст" },
      );
      assert.equal(result.body.ok, false, result.stdout);
      assert.notEqual(result.code, 0);
      assert.deepEqual(successful(await app.run(["task", "get", task])).data, before);
    }
    const first = successful(
      await app.run<{ items: Criterion[] }>(["task", "criterion", "list", task, "--limit", 1]),
    );
    assert.equal(first.data.items[0]!.title, "Первый = 界");
    const cursor = first.meta!.page!.nextCursor!;
    const last = successful(
      await app.run<{ items: Criterion[] }>([
        "task",
        "criterion",
        "list",
        task,
        "--cursor",
        cursor,
      ]),
    );
    assert.equal(last.data.items[0]!.title, "Второй");
    assert.equal(last.meta!.page!.nextCursor, null);
    const full = successful(
      await app.run<View>(["task", "criterion", "get", task, last.data.items[0]!.id]),
    ).data;
    assert.equal(full.criterion.description, "## Полное\n\nx=y=z\n");
    failed(
      await app.run(["task", "criterion", "list", other, "--cursor", cursor]),
      "INVALID_CURSOR",
    );
    const added = await invokeRaw(app.root, [
      "task",
      "criterion",
      "add",
      task,
      "--title",
      "Третий",
      "--if-revision",
      1,
    ]);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.equal(added.stderr, "");
    assert.match(added.stdout, /Ревизия:\s+2/);
    assert.match(added.stdout, /npx @oim-dev\/relay-cli .*task get/);
    assert.equal(
      successful(await app.run<{ items: Criterion[] }>(["task", "criterion", "list", task])).data
        .items[2]!.title,
      "Третий",
    );
    const stale = await app.run(["task", "criterion", "list", task, "--cursor", cursor]);
    assert.equal(stale.body.ok, false, stale.stdout);
    assert.notEqual(stale.code, 0);
  },
);
