import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Detail = {
  ref: { id: string };
  key: string;
  revision: number;
  status: string;
  data: {
    title: string;
    description: string;
    active: boolean;
    applicationId: string;
    featureId: string;
  };
};
test("implementation: шесть листьев, FI/SI, собственная ревизия и цели", async (t) => {
  const app = await fixture(t);
  const feature = successful(
    await app.run<{ key: string }>([
      "feature",
      "create",
      "--name",
      "Поиск",
      "--description",
      "Требования",
    ]),
  ).data;
  const scenario = successful(
    await app.run<{ key: string }>([
      "scenario",
      "create",
      "--name",
      "Найти",
      "--feature",
      feature.key,
      "--description",
      "Шаги",
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
  let key = "";
  const read = async () => successful(await app.run<Detail>(["implementation", "get", key])).data;
  const markdown = "## Вклад\n\nПоказать результат 🧭.\n\nПоследний абзац реализации.\n";
  await t.test("create: FI и SI, недопустимый target не создаётся", async () => {
    const invalid = await app.run([
      "implementation",
      "create",
      "--application",
      application.key,
      "--target",
      application.key,
      "--title",
      "Не создавать",
      "--description",
      markdown,
    ]);
    assert.equal(invalid.body.ok, false);
    key = successful(
      await app.run<{ key: string }>([
        "implementation",
        "create",
        "--application",
        application.key,
        "--target",
        feature.key,
        "--title",
        "Поиск в Web",
        "--description",
        markdown,
        "--status",
        "partial",
      ]),
    ).data.key;
    successful(
      await app.run(
        [
          "implementation",
          "create",
          "--application",
          application.key,
          "--target",
          scenario.key,
          "--title",
          "Сценарий в Web",
          "--description-file",
          "-",
        ],
        { input: "## SI\n\nДействия пользователя.\n" },
      ),
    );
    assert.equal((await read()).data.description, markdown);
  });
  await t.test("get: полный вклад и понятные адреса приложения/цели", async () => {
    const out = await invokeRaw(app.root, ["implementation", "get", key]);
    assert.equal(out.code, 0, out.stdout);
    for (const value of [
      key,
      application.key,
      feature.key,
      "Поиск в Web",
      "Последний абзац реализации.",
    ])
      assert.ok(out.stdout.includes(value), out.stdout);
    assert.match(out.stdout, /ревизия/i);
    assert.doesNotMatch(out.stdout, /\u001b|"data":/);
  });
  await t.test("update: title/status не стирают вклад, noop/конфликт безопасны", async () => {
    const before = await read();
    failed(
      await app.run(["implementation", "update", key, "--if-revision", before.revision]),
      "INVALID_ARGUMENT",
    );
    const conflict = await app.run(
      [
        "implementation",
        "update",
        key,
        "--description",
        "Не записать",
        "--description-file",
        "-",
        "--if-revision",
        before.revision,
      ],
      { input: "Не записать" },
    );
    assert.equal(conflict.body.ok, false);
    assert.deepEqual(await read(), before);
    successful(
      await app.run([
        "implementation",
        "update",
        key,
        "--title",
        "Уточнённый вклад",
        "--status",
        "done",
        "--if-revision",
        before.revision,
      ]),
    );
    failed(
      await app.run([
        "implementation",
        "update",
        key,
        "--title",
        "Старая запись",
        "--if-revision",
        before.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    const current = await read();
    assert.equal(current.data.title, "Уточнённый вклад");
    assert.equal(current.data.description, markdown);
    assert.equal(current.data.applicationId, before.data.applicationId);
    assert.equal(current.data.featureId, before.data.featureId);
    assert.equal(current.data.active, true);
    const backend = await createLocalBackend(app.root);
    const state = await backend.product.state();
    const scope = state.records.find(
      (record) =>
        record.fields.kind === "scope" &&
        record.fields.applicationId === current.data.applicationId,
    );
    assert.ok(scope);
    const persisted = await backend.product.entity(scope.id);
    assert.equal(persisted.fields.kind, "scope");
    if (persisted.fields.kind !== "scope") throw new Error("Ожидался исходный состав");
    const contract = persisted.fields.contracts.find((item) => item.id === current.ref.id);
    assert.ok(contract);
    assert.equal(contract.status, "done");
    assert.equal(contract.title, "Уточнённый вклад");
    assert.equal(contract.description, markdown);
    assert.equal(contract.revision, current.revision);
    assert.equal(
      successful(await app.run<{ completed: boolean }>(["implementation", "progress", key])).data
        .completed,
      false,
    );
  });
  await t.test("rename: собственный ID и алиас", async () => {
    const before = await read();
    successful(
      await app.run([
        "implementation",
        "rename",
        key,
        "WEB-SEARCH",
        "--if-revision",
        before.revision,
      ]),
    );
    const current = await read();
    assert.equal(current.key, "WEB-SEARCH");
    assert.equal(current.ref.id, before.ref.id);
    assert.deepEqual(current.data, before.data);
    key = current.key;
  });
  await t.test("list: application/feature/active, страницы и scenario/target", async () => {
    const page = successful(
      await app.run<{ items: unknown[]; total: number }>([
        "implementation",
        "list",
        "--application",
        application.key,
        "--feature",
        feature.key,
        "--active",
        "true",
        "--limit",
        1,
      ]),
    );
    assert.equal(page.data.total, 2);
    assert.equal(page.meta?.page?.consistency, "snapshot");
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: unknown[] }>([
        "implementation",
        "list",
        "--cursor",
        page.meta!.page!.nextCursor!,
      ]),
    );
    assert.notDeepEqual(page.data.items, next.data.items);
    for (const filter of ["--scenario", "--target"]) {
      const selected = successful(
        await app.run<{ total: number }>(["implementation", "list", filter, scenario.key]),
      ).data;
      assert.equal(selected.total, 1);
    }
  });
  await t.test("progress: ручная отметка done не является готовностью", async () => {
    const before = await read();
    const result = successful(
      await app.run<{ completed: boolean; active: boolean }>(["implementation", "progress", key]),
    );
    assert.equal(result.data.completed, false);
    assert.equal(result.data.active, true);
    assert.equal(result.meta?.page?.consistency, "snapshot");
    assert.deepEqual(await read(), before);
  });
  await t.test(
    "P2: снятое участие объяснено человеку, JSON inactive и ручные отметки не локализуются",
    async () => {
      const before = await read();
      const backend = await createLocalBackend(app.root);
      const state = await backend.product.state();
      const scope = state.records.find(
        (record) =>
          record.fields.kind === "scope" &&
          record.fields.applicationId === before.data.applicationId,
      );
      assert.ok(scope);
      const rawContracts = async () => {
        const raw = await backend.product.entity(scope.id);
        assert.equal(raw.fields.kind, "scope");
        if (raw.fields.kind !== "scope") throw new Error("Ожидался исходный состав");
        return raw.fields.contracts;
      };
      const rawBefore = await rawContracts();
      assert.equal(rawBefore.find((item) => item.id === before.ref.id)?.status, "done");
      const participation = successful(
        await app.run<{ revision: number; version: string }>([
          "application",
          "participation",
          "list",
          application.key,
        ]),
      ).data;
      successful(
        await app.run([
          "application",
          "participation",
          "replace",
          application.key,
          "--clear",
          "--if-revision",
          participation.revision,
          "--if-version",
          participation.version,
        ]),
      );
      const after = await read();
      assert.equal(after.status, "inactive");
      assert.equal(after.data.active, false);
      assert.equal(after.ref.id, before.ref.id);
      assert.equal(after.data.description, markdown);
      const rawAfter = await rawContracts();
      assert.equal(rawAfter.length, rawBefore.length);
      for (const previous of rawBefore) {
        const current = rawAfter.find((item) => item.id === previous.id);
        assert.ok(current);
        assert.equal(current.active, false);
        for (const field of ["status", "title", "description", "key"] as const)
          assert.deepEqual(current[field], previous[field]);
      }
      const commands = [
        ["implementation", "get", key],
        ["implementation", "list", "--active", "false"],
        ["search", "--kind", "implementation", "--active", "false"],
      ];
      for (const command of commands) {
        if (command[1] !== "get") {
          const json = successful(
            await app.run<{ items: { key: string; status: string }[] }>(command),
          ).data;
          assert.ok(json.items.some((item) => item.key === key && item.status === "inactive"));
        }
        for (const width of [40, 100]) {
          const human = await invokeRaw(app.root, command, { env: { COLUMNS: String(width) } });
          assert.equal(human.code, 0, human.stdout);
          assert.equal(human.stderr, "");
          assert.ok(human.stdout.includes(key), human.stdout);
          assert.match(
            human.stdout.replace(/\s+/g, " "),
            /участие:? снято|снятое участие|не участвует/i,
          );
          assert.doesNotMatch(human.stdout, /\binactive\b|\u001b/);
        }
      }
      assert.deepEqual(await rawContracts(), rawAfter);
      assert.deepEqual(await read(), after);
    },
  );
});

test("implementation filters: различимые цели, приложения, участие, q и вычисленный status", async (t) => {
  const app = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await app.run<{ key: string }>([kind, "create", ...args])).data.key;
  const web = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Интерфейс",
  ]);
  const api = await create("application", [
    "--name",
    "API",
    "--slug",
    "api",
    "--description",
    "Сервис",
  ]);
  const main = await create("feature", ["--name", "Основная", "--description", "Требования"]);
  const other = await create("feature", ["--name", "Другая", "--description", "Иные требования"]);
  const ready = await create("feature", ["--name", "Готовая", "--description", "Выполнить"]);
  const sa = await create("scenario", [
    "--name",
    "Первый",
    "--feature",
    main,
    "--description",
    "Шаги",
  ]);
  const sb = await create("scenario", [
    "--name",
    "Второй",
    "--feature",
    main,
    "--description",
    "Иные шаги",
  ]);
  const records: { key: string; title: string; status: string }[] = [];
  for (const [application, target, title, status] of [
    [web, main, "A Искомый", "none"],
    [web, sa, "B Искомый", "none"],
    [web, sb, "C Искомый", "none"],
    [web, other, "D Посторонний", "none"],
    [api, main, "E Искомый", "none"],
    [api, other, "F Искомый", "inactive"],
    [web, ready, "G Искомый", "done"],
  ] as const) {
    const key = await create("implementation", [
      "--application",
      application,
      "--target",
      target,
      "--title",
      title,
      "--description",
      "Вклад",
    ]);
    records.push({ key, title, status });
  }
  const [a, b, c, d, e, f, g] = records;
  const scope = successful(
    await app.run<{ revision: number; version: string }>([
      "application",
      "participation",
      "list",
      api,
    ]),
  ).data;
  successful(
    await app.run([
      "application",
      "participation",
      "replace",
      api,
      "--implementations",
      e!.key,
      "--if-revision",
      scope.revision,
      "--if-version",
      scope.version,
    ]),
  );
  successful(
    await app.run([
      "task",
      "create",
      "--board",
      "web",
      "--title",
      "Готовый вклад",
      "--column",
      "done",
      "--targets",
      g!.key,
    ]),
  );
  const cases: { filters: string[]; expected: typeof records; labels: string[] }[] = [
    { filters: ["--application", web], expected: [a!, b!, c!, d!, g!], labels: [web] },
    { filters: ["--feature", main], expected: [a!, b!, c!, e!], labels: [main] },
    { filters: ["--scenario", sa], expected: [b!], labels: [sa] },
    { filters: ["--target", sb], expected: [c!], labels: [sb] },
    {
      filters: ["--active", "true"],
      expected: [a!, b!, c!, d!, e!, g!],
      labels: ["Участие", "true"],
    },
    { filters: ["--active", "false"], expected: [f!], labels: ["Участие", "false"] },
    {
      filters: ["--q", "Искомый"],
      expected: [a!, b!, c!, e!, f!, g!],
      labels: ["Поиск", "Искомый"],
    },
    { filters: ["--status", "none"], expected: [a!, b!, c!, d!, e!], labels: ["Не реализовано"] },
    { filters: ["--status", "done"], expected: [g!], labels: ["Готово"] },
  ];
  for (const { filters, expected, labels } of cases)
    await t.test(filters.join(" "), async () => {
      let args: Array<string | number> = [
        "implementation",
        "list",
        ...filters,
        "--sort",
        "title",
        "--limit",
        2,
      ];
      const keys: string[] = [];
      do {
        const page = successful(
          await app.run<{ total: number; items: { key: string; title: string; status: string }[] }>(
            args,
          ),
        );
        const slice = expected.slice(keys.length, keys.length + 2);
        assert.deepEqual(
          page.data.items.map(({ key, title, status }) => ({ key, title, status })),
          slice,
        );
        assert.equal(page.data.total, expected.length);
        const human = await invokeRaw(app.root, args);
        assert.equal(human.code, 0, human.stdout);
        const text = human.stdout.replace(/\s+/g, " ");
        for (const value of [
          ...labels,
          ...slice.flatMap((item) => [
            item.key,
            item.title,
            item.status === "inactive"
              ? "Участие снято"
              : item.status === "done"
                ? "Готово"
                : "Не реализовано",
          ]),
        ])
          assert.ok(text.includes(value), text);
        const filterLabels: Record<string, string> = {
          "--application": "Приложение",
          "--feature": "Фича",
          "--scenario": "Сценарий",
          "--target": "Цель",
          "--active": "Участие",
          "--q": "Поиск",
          "--status": "Состояние",
        };
        const displayedValue =
          filters[1] === "none" ? "Не реализовано" : filters[1] === "done" ? "Готово" : filters[1];
        assert.match(text, new RegExp(`${filterLabels[filters[0]!]}:\\s*${displayedValue}`));
        assert.match(text, /Сортировка:\s*title/);
        assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
        assert.match(text, new RegExp(`Показано: ${slice.length} из ${expected.length}\\b`));
        keys.push(...page.data.items.map((item) => item.key));
        const cursor = page.meta?.page?.nextCursor;
        if (!cursor) {
          assert.equal(page.meta?.page?.nextCursor, null);
          break;
        }
        assert.ok(keys.length < expected.length);
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*--cursor/);
        args = ["implementation", "list", "--cursor", cursor];
      } while (true);
      assert.deepEqual(
        keys,
        expected.map((item) => item.key),
      );
    });
});
