import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startServer } from "@relay/server-runtime";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  successful,
  failed,
  invoke,
  invokeRaw,
  tempDirectory,
} from "./helpers/cli.js";

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
    const normalize = (data: unknown) =>
      args[1] === "overview" ? comparable(data as Overview) : data;
    assert.deepEqual(
      normalize(successful(await remote(args)).data),
      normalize(successful(await app.run(["--local", ...args])).data),
    );
  }
  const after = successful(await remote<Detail>(["product", "get"])).data;
  assert.equal(after.data.description, markdown);
  assert.equal(after.data.summary, "Назначение");
});

type Preview = { total: number; shown: number; hasMore: boolean; items: { key: string }[] };
type Overview = {
  productId: string;
  version: string;
  snapshotVersion: string;
  generatedAt: string;
  items: { id: string }[];
  total: number;
  nextOffset: number | null;
  commands: Record<string, string>;
  snapshot: {
    project: { id: string | null; name: string; slug: string };
    passport: { state: string };
    boards: { total: number; byKind: Record<string, number>; catalog: Preview };
    tasks: {
      total: number;
      byColumn: Record<string, number>;
      completed: number;
      readyToStart: number;
      blocked: number;
      criteria: { total: number; completed: number; pending: number };
    };
    attention: Record<
      "inProgress" | "review" | "blocked",
      Preview & {
        items: {
          key: string;
          blockers: { total: number; items: { key: string; relation: string }[] };
        }[];
      }
    >;
    documents: { total: number; byStatus: Record<string, number>; pinnedActive: Preview };
    plans: {
      total: number;
      byStatus: Record<string, number>;
      active: Preview & { items: { ready: boolean; status: string }[] };
    };
    releases: {
      total: number;
      byStatus: Record<string, number>;
      upcoming: Preview & {
        items: { status: string; readiness: { ready: number; total: number } }[];
      };
      recent: Preview & {
        items: { status: string; readiness: { ready: number; total: number } }[];
      };
    };
  };
};

/** Сравнение транспортов: время среза и команды подключения различаются законно. */
const comparable = (data: Overview) => {
  const { generatedAt: _generatedAt, commands: _commands, ...rest } = data;
  return rest;
};

/** npx-шим исполняет подсказку как пользователь: строка shell целиком, без разбора в тесте. */
async function hintRunner(t: TestContext) {
  const directory = await tempDirectory(t);
  const shim = join(directory, "npx");
  const node = [process.execPath, ...cliNodeArgs, binary].map((part) => `'${part}'`).join(" ");
  await writeFile(
    shim,
    `#!/bin/sh\n[ "$1" = "@oim-dev/relay-cli" ] || exit 97\nshift\nexec ${node} "$@"\n`,
  );
  await chmod(shim, 0o755);
  // Асинхронный запуск: HTTP-сервер теста работает в этом же процессе.
  return (command: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          env: cliEnv({ PATH: `${directory}:${process.env.PATH}` }),
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${command}\n${stdout}${stderr}\n${error}`)) : resolve(stdout),
      );
    });
}

async function filledProject(app: Awaited<ReturnType<typeof fixture>>) {
  const data = async <T = { key: string; revision: number }>(args: Array<string | number>) =>
    successful(await app.run<T>(args)).data;
  const revision = async (kind: string, key: string) => (await data([kind, "get", key])).revision;
  const task = async (title: string, column: string, extra: string[] = []) => {
    const { key } = await data([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      title,
      ...extra,
    ]);
    if (column !== "inbox")
      await data([
        "task",
        "move",
        key,
        "--column",
        column,
        "--if-revision",
        await revision("task", key),
      ]);
    return key;
  };
  await data([
    "product",
    "create",
    "--name",
    "Память 🧭 世界",
    "--summary",
    "Краткое назначение",
    "--description",
    markdown,
  ]);
  const feature = (
    await data(["feature", "create", "--name", "Поиск", "--description", "Требования"])
  ).key;
  await data([
    "scenario",
    "create",
    "--feature",
    feature,
    "--name",
    "Найти",
    "--description",
    "Шаги",
  ]);
  await data([
    "application",
    "create",
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Интерфейс",
  ]);
  const design = await task("Спроектировать поиск", "in-progress", [
    "--criterion-title",
    "a=Макет",
    "--criterion-title",
    "b=API",
  ]);
  const [criterion] = (
    await data<{ items: { id: string }[] }>(["task", "criterion", "list", design])
  ).items;
  await data([
    "task",
    "criterion",
    "complete",
    design,
    criterion!.id,
    "--if-revision",
    await revision("task", design),
  ]);
  const review = await task("Проверить ширину 世界 🧭", "review");
  const blocked = await task("Реализовать индекс", "ready", ["--dependencies", design]);
  const docs = await task("Написать документацию", "ready");
  const build = await task("Настроить сборку", "done");
  await task("Старый прототип", "cancelled");
  for (let index = 1; index <= 6; index++)
    await task(`Параллельная работа ${index}`, "in-progress");
  for (const [name, status] of [
    ["Решение", "active"],
    ["Глоссарий", "active"],
    ["Идеи", "draft"],
    ["Регламент", "archived"],
  ])
    await data([
      "document",
      "create",
      "--name",
      name!,
      "--body",
      "Текст",
      "--document-status",
      status!,
      "--pinned",
      String(status !== "draft"),
    ]);
  const active = (await data(["plan", "create", "--title", "Поиск", "--goal", "Проверенный поиск"]))
    .key;
  await data([
    "plan",
    "stage",
    "create",
    active,
    "--title",
    "Проектирование",
    "--if-revision",
    await revision("plan", active),
  ]);
  const [stage] = (await data<{ items: { id: string }[] }>(["plan", "stage", "list", active]))
    .items;
  await data([
    "plan",
    "stage",
    "task",
    "add",
    active,
    stage!.id,
    "--tasks",
    design,
    blocked,
    "--if-revision",
    await revision("plan", active),
  ]);
  await data(["plan", "start", active, "--if-revision", await revision("plan", active)]);
  const done = (await data(["plan", "create", "--title", "Сборка", "--goal", "Сборка"])).key;
  await data([
    "plan",
    "stage",
    "create",
    done,
    "--title",
    "CI",
    "--if-revision",
    await revision("plan", done),
  ]);
  const [ci] = (await data<{ items: { id: string }[] }>(["plan", "stage", "list", done])).items;
  await data([
    "plan",
    "stage",
    "task",
    "add",
    done,
    ci!.id,
    "--tasks",
    build,
    "--if-revision",
    await revision("plan", done),
  ]);
  await data([
    "plan",
    "complete",
    done,
    "--result",
    "Проверено",
    "--if-revision",
    await revision("plan", done),
  ]);
  await data([
    "release",
    "create",
    "--title",
    "Поиск",
    "--release-version",
    "0.2",
    "--plans",
    active,
    "--planned-for",
    "2030-01-15",
  ]);
  const shipped = (
    await data([
      "release",
      "create",
      "--title",
      "Сборка",
      "--release-version",
      "0.1",
      "--plans",
      done,
    ])
  ).key;
  await data(["release", "publish", shipped, "--if-revision", await revision("release", shipped)]);
  return { design, review, blocked, docs, active };
}

test("product overview: пустой проект — нули, состояния и выполнимые подсказки", async (t) => {
  const app = await fixture(t);
  const result = successful(await app.run<Overview>(["product", "overview"]));
  const { snapshot } = result.data;
  assert.match(result.data.snapshotVersion, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.passport.state, "missing");
  assert.equal(snapshot.tasks.total, 0);
  assert.deepEqual(snapshot.tasks.byColumn, {
    inbox: 0,
    ready: 0,
    "in-progress": 0,
    review: 0,
    done: 0,
    cancelled: 0,
  });
  assert.deepEqual(snapshot.boards.byKind, { product: 1, application: 0, infrastructure: 1 });
  for (const preview of Object.values(snapshot.attention))
    assert.deepEqual(preview, { total: 0, shown: 0, hasMore: false, items: [] });
  assert.equal(result.data.total, 0);
  assert.equal(result.meta?.page?.nextCursor, null);
  const human = await invokeRaw(app.root, ["product", "overview"], {
    env: { COLUMNS: "40", FORCE_COLOR: "1" },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  for (const text of [
    /Продукт без паспорта/,
    /Задачи? всего:\s+0/,
    /inbox 0/,
    /cancelled 0/,
    /Задач в работе нет/,
    /Заблокированных задач нет/,
    /Планов пока нет/,
    /Запланированных релизов нет/,
    /Записей продукта пока нет/,
    /Конец списка/,
  ])
    assert.match(human.stdout, text);
  assert.doesNotMatch(human.stdout, /\u001b|"ok":/);
  const run = await hintRunner(t);
  assert.match(await run(result.data.commands.passportHelp!), /product create/);
  assert.equal(JSON.parse(await run(result.data.commands.passport!)).ok, true);
});

test("product overview: срез проекта, подборки, страницы карты, подсказки local/HTTP", async (t) => {
  const app = await fixture(t);
  const keys = await filledProject(app);
  const full = successful(await app.run<Overview>(["product", "overview"]));
  const { snapshot } = full.data;

  await t.test("totals и колонки не зависят от --limit", async () => {
    const small = successful(await app.run<Overview>(["product", "overview", "--limit", 1]));
    assert.deepEqual(small.data.snapshot, snapshot);
    assert.equal(small.data.snapshotVersion, full.data.snapshotVersion);
    assert.equal(small.data.version, full.data.version);
    assert.equal(small.data.items.length, 1);
    assert.equal(small.data.total, full.data.total);
    assert.equal(small.meta?.page?.total, full.data.total);
    assert.equal(snapshot.tasks.total, 12);
    assert.deepEqual(snapshot.tasks.byColumn, {
      inbox: 0,
      ready: 2,
      "in-progress": 7,
      review: 1,
      done: 1,
      cancelled: 1,
    });
    assert.equal(snapshot.tasks.completed, 1);
    assert.equal(snapshot.tasks.readyToStart, 1);
    assert.equal(snapshot.tasks.blocked, 1);
    assert.deepEqual(snapshot.tasks.criteria, {
      total: 2,
      completed: 1,
      pending: 1,
      tasksWithPending: 1,
    });
  });

  await t.test("подборки: >5 даёт hasMore, блокер с причиной, планы и релизы", () => {
    const inProgress = snapshot.attention.inProgress;
    assert.deepEqual(
      [inProgress.total, inProgress.shown, inProgress.hasMore, inProgress.items.length],
      [7, 5, true, 5],
    );
    const [blocked] = snapshot.attention.blocked.items;
    assert.equal(blocked!.key, keys.blocked);
    assert.deepEqual(
      blocked!.blockers.items.map((entry) => [entry.key, entry.relation]),
      [[keys.design, "dependency"]],
    );
    assert.deepEqual(snapshot.plans.byStatus, { draft: 0, active: 1, completed: 1, cancelled: 0 });
    assert.equal(snapshot.plans.active.items[0]!.ready, false);
    assert.deepEqual(snapshot.releases.byStatus, { planned: 1, released: 1, cancelled: 0 });
    assert.equal(snapshot.releases.upcoming.items[0]!.readiness.ready, 0);
    assert.equal(snapshot.releases.recent.items[0]!.readiness.ready, 1);
    assert.deepEqual(snapshot.documents.byStatus, { draft: 1, active: 2, archived: 1 });
    assert.equal(snapshot.documents.pinnedActive.total, 2);
  });

  await t.test("human: порядок разделов, причины, «показано N из M», без ANSI", async () => {
    for (const width of [40, 120]) {
      const human = await invokeRaw(app.root, ["product", "overview", "--limit", 2], {
        env: { COLUMNS: String(width), FORCE_COLOR: "1" },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      const out = human.stdout;
      assert.doesNotMatch(out, /\u001b|"data":/);
      const order = [
        "Продукт · Память 🧭 世界",
        "Сводка",
        "Требует внимания",
        "Планы",
        "Релизы",
        "Продуктовые знания",
        "Документы",
        "Карта продукта",
        "Дальнейшее чтение",
        "Есть продолжение",
      ];
      const positions = order.map((title) => out.indexOf(title));
      assert.ok(
        positions.every((position) => position >= 0),
        `${positions}\n${out}`,
      );
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions,
      );
      assert.match(out, /В работе · показано 5 из 7/);
      assert.match(
        out,
        /Полный список \(ещё 2\):\nnpx @oim-dev\/relay-cli .* task list --column in-progress\n/,
      );
      assert.match(
        out,
        new RegExp(`Ждёт выполнения:\\s+${keys.design}\\s+\\(зависит\\s+от,\\s+in-progress\\)`),
      );
      assert.doesNotMatch(out, /Блокирует/);
      assert.match(out, /не выполнено 1 в\s+1 задаче\n/);
      assert.match(out, /1 из 1\s+плана/);
      assert.match(out, /0 из 2 задач \(/);
      assert.match(out, /Проверить ширину 世界 🧭/);
      assert.match(out, /состав фактически готов/);
      assert.match(out, /не складываются/);
      assert.doesNotMatch(out, /task (move|update|create)|plan (start|complete)|Начните работу/);
      // Команды не переносятся по ширине: каждая строка npx заканчивается полным адресом.
      for (const line of out.split("\n").filter((line) => line.startsWith("npx ")))
        assert.match(
          line,
          /(product|task|plan|release|document|board) [a-z-]+( --[a-z-]+ [^ ]+)*$|--cursor [A-Za-z0-9_-]+$/,
        );
    }
  });

  await t.test("все подсказки выполнимы на временной базе и совпадают с totals", async () => {
    const run = await hintRunner(t);
    const total = async (command: string) => {
      const body = JSON.parse(await run(command));
      assert.equal(body.ok, true, command);
      return body.meta?.page?.total as number | undefined;
    };
    const commands = full.data.commands;
    for (const command of Object.values(commands))
      assert.match(command, /^npx @oim-dev\/relay-cli --local --config /);
    assert.equal(await total(commands.inProgress!), snapshot.attention.inProgress.total);
    assert.equal(await total(commands.review!), snapshot.attention.review.total);
    assert.equal(await total(commands.blocked!), snapshot.attention.blocked.total);
    assert.equal(await total(commands.readyToStart!), snapshot.tasks.readyToStart);
    assert.equal(await total(commands.activePlans!), snapshot.plans.active.total);
    assert.equal(await total(commands.plannedReleases!), snapshot.releases.upcoming.total);
    assert.equal(await total(commands.releasedReleases!), snapshot.releases.recent.total);
    assert.equal(await total(commands.boards!), snapshot.boards.total);
    for (const name of [
      "passport",
      "progress",
      "features",
      "applications",
      "implementations",
      "tasks",
      "plans",
      "releases",
      "documents",
      "pinnedDocuments",
      "sections",
    ])
      await total(commands[name]!);
    const page = successful(await app.run<Overview>(["product", "overview", "--limit", 3]));
    const next = JSON.parse(await run(page.meta!.page!.nextCommand!));
    assert.equal(next.ok, true);
    assert.equal(next.data.items.length, 3);
  });

  await t.test("cursor защищён snapshotVersion: изменение только задачи", async () => {
    const page = successful(await app.run<Overview>(["product", "overview", "--limit", 2]));
    const cursor = page.meta!.page!.nextCursor!;
    const next = successful(await app.run<Overview>(["product", "overview", "--cursor", cursor]));
    assert.equal(next.data.items.length, 2);
    const revision = successful(await app.run<{ revision: number }>(["task", "get", keys.docs]))
      .data.revision;
    successful(
      await app.run([
        "task",
        "update",
        keys.docs,
        "--title",
        "Другая формулировка",
        "--if-revision",
        revision,
      ]),
    );
    const after = successful(await app.run<Overview>(["product", "overview", "--limit", 2]));
    assert.equal(
      after.data.version,
      page.data.version,
      "старая версия состава не меняется от задачи",
    );
    assert.notEqual(after.data.snapshotVersion, page.data.snapshotVersion);
    failed(await app.run(["product", "overview", "--cursor", cursor]), "VERSION_CONFLICT");
  });

  await t.test(
    "HTTP: те же предметные данные, подсказки сохраняют сервер и выполнимы",
    async () => {
      const server = await startServer({ cwd: app.root, actor: "human", port: 0 });
      t.after(() => server.close());
      const local = successful(
        await app.run<Overview>(["--local", "product", "overview", "--limit", 4]),
      );
      const remote = successful(
        await app.run<Overview>(["--server-url", server.url, "product", "overview", "--limit", 4]),
      );
      assert.deepEqual(comparable(remote.data), comparable(local.data));
      assert.equal(remote.meta?.page?.total, local.meta?.page?.total);
      const run = await hintRunner(t);
      for (const command of Object.values(remote.data.commands)) {
        assert.match(command, new RegExp(`^npx @oim-dev/relay-cli --server-url ${server.url} `));
        if (!command.endsWith("--help"))
          assert.equal(JSON.parse(await run(command)).ok, true, command);
      }
      const human = await invokeRaw(app.root, ["--server-url", server.url, "product", "overview"], {
        env: { COLUMNS: "60" },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.match(human.stdout, /В работе · показано 5 из 7/);
      assert.doesNotMatch(human.stdout, /\u001b/);
      const cursor = remote.meta!.page!.nextCursor!;
      failed(
        await app.run(["--local", "product", "overview", "--cursor", cursor]),
        "INVALID_CURSOR",
      );
    },
  );
});
