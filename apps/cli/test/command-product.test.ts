import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startServer } from "@relay/server-runtime";
import { productOverviewMetrics } from "@relay/contracts/entities/product";
import type {
  ProductOverviewMetric,
  ProductOverviewMetricPage,
  ProductOverviewOperator,
} from "@relay/contracts/entities/product";
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
  // Плоские команды и вложенные группы metrics/blockerAffected.
  commands: Record<string, any>;
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

/** Все исполняемые подсказки, включая вложенные группы команд метрик. */
const hintList = (commands: object): string[] =>
  Object.values(commands).flatMap((value: unknown) =>
    typeof value === "string" ? [value] : hintList(value as object),
  );

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
    for (const command of hintList(commands))
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
      for (const command of hintList(remote.data.commands)) {
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

type OverviewWithOperator = Overview & {
  snapshot: Overview["snapshot"] & { operator: ProductOverviewOperator };
};
type MetricView = ProductOverviewMetricPage & {
  commands: { overview: string; blocker?: string; affected?: Record<string, string> };
};
type App = { root: string; run: Awaited<ReturnType<typeof fixture>>["run"] };

/** Проект в каталоге с пробелом и кавычкой: подсказки обязаны экранировать --config. */
async function quotedFixture(t: TestContext): Promise<App> {
  const root = join(await tempDirectory(t), "проект с 'кавычкой'");
  await mkdir(root);
  successful(await invoke(root, ["init"]));
  return { root, run: (args, options) => invoke(root, args, options) };
}

/**
 * Небольшая fixture показателей оператора с заранее выписанными ожиданиями:
 * review: R1, R2 без обязательств; R3 — невыполненный критерий; R4 зависит от A и B.
 * C1 зависит от A; K — подзадача P и одновременно его зависимость (одна задача, две связи).
 * Открытые планы: O1 (draft, D1), O2 (active, D2) выполнены; W (active) включает A и R2.
 * Завершённые F1, F2 вне релизов; L1, L2 в запланированных релизах без даты и с датой.
 */
async function operatorProject(app: App) {
  const data = async <T = { key: string; revision: number }>(args: Array<string | number>) =>
    successful(await app.run<T>(args)).data;
  const task = async (title: string, column: string, extra: string[] = [], board = "product") =>
    (
      await data([
        "task",
        "create",
        "--board",
        board,
        "--title",
        title,
        "--column",
        column,
        ...extra,
      ])
    ).key;
  const A = await task("Блокер А", "in-progress");
  const B = await task("Блокер Б", "ready", [], "infrastructure");
  const R1 = await task("Готово к завершению 1", "review");
  const R2 = await task("Готово к завершению 2", "review");
  const R3 = await task("Критерий не выполнен", "review", ["--criterion-title", "a=Проверить"]);
  const R4 = await task("Ждёт блокеров", "review", ["--dependencies", A, B]);
  const C1 = await task("Ждёт А", "ready", ["--dependencies", A]);
  const P = await task("Родитель", "in-progress");
  const K = await task("Подзадача 世界 🧭", "inbox", ["--parent", P]);
  const parent = await data(["task", "get", P]);
  await data(["task", "dependency", "add", P, K, "--if-revision", parent.revision]);
  const D: string[] = [];
  for (let index = 1; index <= 6; index++) D.push(await task(`Выполнено ${index}`, "done"));
  const plan = async (title: string, status: string, tasks: string[]) => {
    const created = await data(["plan", "create", "--title", title, "--goal", "Цель"]);
    const stage = await data<{ revision: number; stageId: string }>([
      "plan",
      "stage",
      "create",
      created.key,
      "--title",
      "Этап",
      "--if-revision",
      created.revision,
    ]);
    let { revision } = await data([
      "plan",
      "stage",
      "task",
      "add",
      created.key,
      stage.stageId,
      "--tasks",
      ...tasks,
      "--if-revision",
      stage.revision,
    ]);
    if (status === "active")
      ({ revision } = await data(["plan", "start", created.key, "--if-revision", revision]));
    if (status === "completed")
      await data(["plan", "complete", created.key, "--result", "Итог", "--if-revision", revision]);
    return created.key;
  };
  const O1 = await plan("Открытый готовый 1", "draft", [D[0]!]);
  const O2 = await plan("Открытый готовый 2", "active", [D[1]!]);
  await plan("Текущая работа", "active", [A, R2]);
  const F1 = await plan("Завершён вне релизов 1", "completed", [D[2]!]);
  const F2 = await plan("Завершён вне релизов 2", "completed", [D[3]!]);
  const L1 = await plan("Для релиза без даты", "completed", [D[4]!]);
  const L2 = await plan("Для релиза с датой", "completed", [D[5]!]);
  const undated = await data([
    "release",
    "create",
    "--title",
    "Без даты",
    "--release-version",
    "1.0",
    "--plans",
    L1,
  ]);
  const dated = await data([
    "release",
    "create",
    "--title",
    "С датой",
    "--release-version",
    "0.9",
    "--plans",
    L2,
    "--planned-for",
    "2030-02-01",
  ]);
  return { A, B, R1, R2, R3, R4, C1, P, K, O1, O2, F1, F2, undated: undated.key, dated: dated.key };
}

/** Все страницы метрики по nextCursor CLI; каждая страница сообщает тот же total. */
async function allPages(app: App, args: Array<string | number>, limit: number) {
  const pages: MetricView[] = [];
  let page = successful(
    await app.run<MetricView>(["product", "overview", ...args, "--limit", limit]),
  );
  for (;;) {
    pages.push(page.data);
    assert.ok(page.data.items.length <= limit);
    assert.equal(page.meta?.page?.total, page.data.total);
    const cursor = page.meta?.page?.nextCursor;
    if (!cursor) break;
    assert.ok(pages.length < 50, "продолжение не завершается");
    page = successful(await app.run<MetricView>(["product", "overview", "--cursor", cursor]));
  }
  return pages;
}

const metricKey = (item: object) =>
  "key" in item ? String(item.key) : String((item as { prefix: string }).prefix);
const byId = (left: { id: string }, right: { id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

test("product overview: показатели оператора, детализация --metric, продолжение и local/HTTP", async (t) => {
  const app = await quotedFixture(t);
  const keys = await operatorProject(app);
  const full = successful(await app.run<OverviewWithOperator>(["product", "overview"]));
  const operator = full.data.snapshot.operator;
  const preview = (entry: { total: number; items: object[] }) => [
    entry.total,
    entry.items.map(metricKey),
  ];

  await t.test("snapshot.operator: точные числа заранее выписанной fixture", () => {
    assert.equal(operator.review.total, full.data.snapshot.tasks.byColumn.review);
    assert.deepEqual(preview(operator.review.obligationsMet), [2, [keys.R2, keys.R1]]);
    assert.deepEqual(preview(operator.review.obligationsOpen), [2, [keys.R4, keys.R3]]);
    assert.deepEqual(
      operator.review.obligationsOpen.items.map((task) => task.reasons),
      [["DEPENDENCY_INCOMPLETE"], ["CRITERION_INCOMPLETE"]],
    );
    const blockers = operator.blockerImpact;
    assert.equal(blockers.total, 3);
    assert.equal(blockers.items[0]!.key, keys.A);
    assert.deepEqual(
      blockers.items[0]!.affected.items.map((task) => [task.key, task.relations]).sort(),
      [
        [keys.R4, ["dependency"]],
        [keys.C1, ["dependency"]],
      ].sort(),
    );
    // Равное число затронутых задач упорядочено по постоянному ID.
    assert.deepEqual(
      blockers.items.slice(1).map((blocker) => blocker.key),
      [...blockers.items.slice(1)].sort(byId).map((blocker) => blocker.key),
    );
    const child = blockers.items.find((blocker) => blocker.key === keys.K)!;
    assert.deepEqual(
      [child.affected.total, child.affected.items.map((task) => [task.key, task.relations])],
      [1, [[keys.P, ["dependency", "subtask"]]]],
    );
    assert.deepEqual(preview(operator.unplannedWork), [4, [keys.P, keys.R4, keys.R3, keys.R1]]);
    assert.deepEqual(operator.unplannedWork.byColumn, { "in-progress": 1, review: 3 });
    assert.deepEqual([operator.boardWork.remaining, operator.boardWork.blockedRemaining], [9, 3]);
    assert.deepEqual(
      operator.boardWork.boards.items.map((board) => [
        board.prefix,
        board.tasks.total,
        board.tasks.completed,
        board.tasks.remaining,
        board.tasks.blockedRemaining,
        board.tasks.readyToStart,
      ]),
      [
        ["PRODUCT", 14, 6, 8, 3, 0],
        ["INFRA", 1, 0, 1, 0, 1],
      ],
    );
    assert.deepEqual(preview(operator.openPlansComplete), [2, [keys.O2, keys.O1]]);
    assert.deepEqual(preview(operator.releasePreparation.readyReleases), [
      2,
      [keys.dated, keys.undated],
    ]);
    assert.deepEqual(preview(operator.releasePreparation.completedPlansOutsideReleases), [
      2,
      [keys.F2, keys.F1],
    ]);
  });

  await t.test("human: компактные блоки и подписи по смыслу, без ANSI", async () => {
    for (const width of [40, 120]) {
      const human = await invokeRaw(app.root, ["product", "overview"], {
        env: { COLUMNS: String(width), FORCE_COLOR: "1" },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      const out = human.stdout.replace(/\s+/g, " ");
      for (const text of [
        "Показатели работы",
        "на проверке 4 = обязательства выполнены 2 + остались обязательства 2",
        "Обязательства выполнены: можно рассмотреть завершение · все 2",
        "не доказывают внешнюю проверку",
        `Осталось: зависимости: ${keys.A}, ${keys.B}`,
        "Осталось: критерии 0 из 1",
        "Прямые блокеры · все 3",
        "блокирует 2 незавершённые задачи напрямую",
        `${keys.P} (зависимость и подзадача)`,
        "не критический путь",
        "Вне открытых планов (in-progress 1 · review 3) · все 4",
        "а не ошибка",
        "Незавершённая работа: 9 задач, из них с прямыми блокерами 3",
        "PRODUCT — Продукт · незавершено 8",
        "не загрузка людей",
        "Состав выполнен, план открыт · все 2",
        "Запланированные релизы с готовым составом · все 2",
        "Готовые завершённые планы вне релизов · все 2",
        "Подзадача 世界 🧭",
      ])
        assert.ok(out.includes(text), `${text}\n${human.stdout}`);
      assert.doesNotMatch(human.stdout, /\u001b|"data":|проверено|█|▇/);
      const positions = ["Требует внимания", "Показатели работы", "Планы", "Состав выполнен"].map(
        (title) => out.indexOf(title),
      );
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions,
      );
    }
  });

  const metricArgs = (metric: ProductOverviewMetric): string[] =>
    metric === "blocker-affected"
      ? ["--metric", metric, "--blocker", keys.A]
      : ["--metric", metric];
  const expectedTotals: Record<ProductOverviewMetric, number> = {
    "review-obligations-met": 2,
    "review-obligations-open": 2,
    "blocker-impact": 3,
    "blocker-affected": 2,
    "unplanned-work": 4,
    "board-work": 2,
    "open-plans-complete": 2,
    "ready-releases": 2,
    "plans-outside-releases": 2,
  };
  const fullPages = {} as Record<ProductOverviewMetric, MetricView>;

  await t.test(
    "каждая метрика: продолжение без пропусков и дублей, total не зависит от limit",
    async () => {
      for (const metric of productOverviewMetrics) {
        const [single] = await allPages(app, metricArgs(metric), 100);
        fullPages[metric] = single!;
        assert.equal(single!.metric, metric);
        assert.equal(single!.total, expectedTotals[metric], metric);
        assert.equal(single!.items.length, single!.total);
        assert.equal(single!.snapshotVersion, full.data.snapshotVersion);
        const pages = await allPages(app, metricArgs(metric), 1);
        assert.equal(pages.length, single!.total, metric);
        assert.deepEqual(
          pages.flatMap((page) => page.items.map(metricKey)),
          single!.items.map(metricKey),
          metric,
        );
        for (const page of pages) assert.equal(page.total, single!.total);
      }
      const affected = fullPages["blocker-affected"];
      assert.equal(affected.blocker?.key, keys.A);
      assert.deepEqual(affected.items.map(metricKey).sort(), [keys.C1, keys.R4].sort());
      assert.deepEqual(
        fullPages["review-obligations-met"].items.map(metricKey),
        operator.review.obligationsMet.items.map(metricKey),
      );
      assert.deepEqual(
        (
          fullPages["blocker-impact"] as Extract<MetricView, { metric: "blocker-impact" }>
        ).items.map((item) => [item.key, item.affected.total]),
        operator.blockerImpact.items.map((item) => [item.key, item.affected.total]),
      );
    },
  );

  await t.test("JSON-команды исполняемы, сохраняют --config с пробелом и кавычкой", async () => {
    const run = await hintRunner(t);
    const commands = full.data.commands;
    assert.deepEqual(
      Object.keys(commands.metrics).sort(),
      productOverviewMetrics.filter((metric) => metric !== "blocker-affected").sort(),
    );
    assert.deepEqual(
      Object.keys(commands.blockerAffected).sort(),
      operator.blockerImpact.items.map((blocker) => blocker.id).sort(),
    );
    for (const [metric, command] of Object.entries(commands.metrics as Record<string, string>)) {
      assert.match(
        command,
        /^npx @oim-dev\/relay-cli --local --config '.*проект с '\\''кавычкой'\\''.*' --format json product overview --metric [a-z-]+$/,
      );
      const body = JSON.parse(await run(command));
      assert.equal(body.ok, true, command);
      assert.equal(body.data.metric, metric);
      assert.equal(body.data.total, expectedTotals[metric as ProductOverviewMetric]);
    }
    for (const blocker of operator.blockerImpact.items) {
      const command = commands.blockerAffected[blocker.id] as string;
      assert.ok(command.endsWith(`--metric blocker-affected --blocker ${blocker.id}`), command);
      const body = JSON.parse(await run(command));
      assert.equal(body.data.blocker.id, blocker.id);
      assert.equal(body.data.total, blocker.affected.total);
    }
    const impact = fullPages["blocker-impact"];
    for (const blocker of impact.items)
      assert.equal(impact.commands.affected?.[blocker.id], commands.blockerAffected[blocker.id]);
    const affected = fullPages["blocker-affected"];
    assert.equal(JSON.parse(await run(affected.commands.blocker!)).data.key, keys.A);
    assert.equal(JSON.parse(await run(affected.commands.overview)).ok, true);
    const first = successful(
      await app.run<MetricView>([
        "product",
        "overview",
        ...metricArgs("blocker-affected"),
        "--limit",
        1,
      ]),
    );
    const next = JSON.parse(await run(first.meta!.page!.nextCommand!));
    assert.equal(next.data.items.length, 1);
    assert.equal(next.meta.page.nextCursor, null);
  });

  await t.test("human детализации: смысл, список, общее продолжение", async () => {
    const human = await invokeRaw(
      app.root,
      ["product", "overview", "--metric", "blocker-affected", "--blocker", keys.A, "--limit", 1],
      { env: { COLUMNS: "40", FORCE_COLOR: "1" } },
    );
    assert.equal(human.code, 0, human.stdout);
    const out = human.stdout.replace(/\s+/g, " ");
    for (const text of [
      "Задачи, которые блокер задерживает напрямую",
      `Блокер: ${keys.A} — Блокер А`,
      "Всего: 2",
      "связь с блокером: зависимость",
      "Блокер целиком",
      "Есть продолжение",
      "product overview --metric blocker-affected --blocker",
    ])
      assert.ok(out.includes(text), `${text}\n${human.stdout}`);
    assert.doesNotMatch(human.stdout, /\u001b|"data":/);
    const met = await invokeRaw(app.root, [
      "product",
      "overview",
      "--metric",
      "review-obligations-met",
    ]);
    assert.match(
      met.stdout.replace(/\s+/g, " "),
      /Обязательства выполнены: можно рассмотреть завершение .*Это не внешняя проверка результата/,
    );
    assert.match(met.stdout, /Конец списка/);
  });

  await t.test("ошибки: метрика, блокер, курсор чужого контекста, изменение среза", async () => {
    failed(await app.run(["product", "overview", "--metric", "nope"]), "UNKNOWN_METRIC");
    failed(
      await app.run(["product", "overview", "--metric", "blocker-affected"]),
      "INVALID_ARGUMENT",
    );
    failed(
      await app.run(["product", "overview", "--metric", "board-work", "--blocker", keys.A]),
      "INVALID_ARGUMENT",
    );
    failed(await app.run(["product", "overview", "--blocker", keys.A]), "INVALID_ARGUMENT");
    failed(
      await app.run([
        "product",
        "overview",
        "--metric",
        "blocker-affected",
        "--blocker",
        "PRODUCT-999",
      ]),
      "NOT_FOUND",
      3,
    );
    const page = successful(
      await app.run<MetricView>([
        "product",
        "overview",
        "--metric",
        "unplanned-work",
        "--limit",
        1,
      ]),
    );
    const cursor = page.meta!.page!.nextCursor!;
    failed(
      await app.run(["product", "overview", "--metric", "board-work", "--cursor", cursor]),
      "INVALID_CURSOR",
    );
    const map = successful(await app.run<Overview>(["product", "overview", "--limit", 1]));
    if (map.meta?.page?.nextCursor)
      failed(
        await app.run([
          "product",
          "overview",
          "--metric",
          "unplanned-work",
          "--cursor",
          map.meta.page.nextCursor,
        ]),
        "INVALID_CURSOR",
      );
    // Один --cursor восстанавливает метрику, лимит и проект.
    const continued = successful(
      await app.run<MetricView>(["product", "overview", "--cursor", cursor]),
    );
    assert.deepEqual([continued.data.metric, continued.data.items.length], ["unplanned-work", 1]);
    const affected = successful(
      await app.run<MetricView>([
        "product",
        "overview",
        ...metricArgs("blocker-affected"),
        "--limit",
        1,
      ]),
    );
    failed(
      await app.run([
        "product",
        "overview",
        "--metric",
        "blocker-affected",
        "--blocker",
        keys.B,
        "--cursor",
        affected.meta!.page!.nextCursor!,
      ]),
      "INVALID_CURSOR",
    );
    const revision = successful(await app.run<{ revision: number }>(["task", "get", keys.R1])).data
      .revision;
    successful(
      await app.run([
        "task",
        "update",
        keys.R1,
        "--title",
        "Новое название",
        "--if-revision",
        revision,
      ]),
    );
    failed(await app.run(["product", "overview", "--cursor", cursor]), "VERSION_CONFLICT", 4);
  });

  await t.test("HTTP: те же данные всех метрик, команды сохраняют сервер", async () => {
    const server = await startServer({ cwd: app.root, actor: "human", port: 0 });
    t.after(() => server.close());
    const local = successful(
      await app.run<OverviewWithOperator>(["--local", "product", "overview"]),
    );
    const remote = successful(
      await app.run<OverviewWithOperator>(["--server-url", server.url, "product", "overview"]),
    );
    assert.deepEqual(remote.data.snapshot.operator, local.data.snapshot.operator);
    const comparablePage = ({ generatedAt: _g, commands: _c, ...rest }: MetricView) => rest;
    const run = await hintRunner(t);
    for (const metric of productOverviewMetrics) {
      const args = ["product", "overview", ...metricArgs(metric), "--limit", 1];
      const localPage = successful(await app.run<MetricView>(["--local", ...args]));
      const remotePage = successful(
        await app.run<MetricView>(["--server-url", server.url, ...args]),
      );
      assert.deepEqual(comparablePage(remotePage.data), comparablePage(localPage.data), metric);
      assert.equal(remotePage.meta?.page?.total, localPage.meta?.page?.total);
      const nextCommand = remotePage.meta!.page!.nextCommand!;
      assert.match(nextCommand, new RegExp(`^npx @oim-dev/relay-cli --server-url ${server.url} `));
      const next = JSON.parse(await run(nextCommand));
      assert.equal(next.ok, true, nextCommand);
      const localNext = successful(
        await app.run<MetricView>([
          "--local",
          "product",
          "overview",
          "--cursor",
          localPage.meta!.page!.nextCursor!,
        ]),
      );
      assert.deepEqual(comparablePage(next.data), comparablePage(localNext.data), metric);
      failed(
        await app.run([
          "--local",
          "product",
          "overview",
          "--cursor",
          remotePage.meta!.page!.nextCursor!,
        ]),
        "INVALID_CURSOR",
      );
    }
    for (const command of [
      ...Object.values(remote.data.commands.metrics as Record<string, string>),
      ...Object.values(remote.data.commands.blockerAffected as Record<string, string>),
    ]) {
      assert.match(command, new RegExp(`^npx @oim-dev/relay-cli --server-url ${server.url} `));
      assert.equal(JSON.parse(await run(command)).ok, true, command);
    }
    const human = await invokeRaw(
      app.root,
      ["--server-url", server.url, "product", "overview", "--metric", "board-work"],
      { env: { COLUMNS: "60" } },
    );
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /PRODUCT — Продукт · незавершено 8/);
    failed(
      await app.run(["--server-url", server.url, "product", "overview", "--metric", "nope"]),
      "UNKNOWN_METRIC",
    );
    failed(
      await app.run([
        "--server-url",
        server.url,
        "product",
        "overview",
        "--metric",
        "blocker-affected",
        "--blocker",
        "PRODUCT-999",
      ]),
      "NOT_FOUND",
      3,
    );
  });
});
