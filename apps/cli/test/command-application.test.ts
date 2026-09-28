import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Detail = {
  ref: { id: string };
  key: string;
  revision: number;
  data: {
    name: string;
    summary: string;
    description: string;
    slug: string;
    prefix: string;
    type: string;
  };
};
type Participation = {
  revision: number;
  version: string;
  items: { id: string; active: boolean }[];
  total: number;
};

test("application: шесть листьев, свойства и отдельная ревизия состава", async (t) => {
  const app = await fixture(t);
  let key = "";
  const read = async () => successful(await app.run<Detail>(["application", "get", key])).data;
  await t.test("create: slug, prefix, type, Markdown stdin", async () => {
    key = successful(
      await app.run<{ key: string }>(
        [
          "application",
          "create",
          "--name",
          "Интерфейс 🧭",
          "--slug",
          "web",
          "--prefix",
          "WEB",
          "--type",
          "frontend",
          "--summary",
          "Назначение",
          "--description-file",
          "-",
        ],
        { input: "## Web\n\nПолный интерфейс.\n" },
      ),
    ).data.key;
    const record = await read();
    assert.equal(record.data.slug, "web");
    assert.equal(record.data.prefix, "WEB");
    assert.equal(record.data.description, "## Web\n\nПолный интерфейс.\n");
  });
  await t.test("get: читаемый ключ, содержание и ревизия", async () => {
    const out = await invokeRaw(app.root, ["application", "get", key]);
    assert.equal(out.code, 0, out.stdout);
    for (const value of [key, "Интерфейс 🧭", "Полный интерфейс."])
      assert.ok(out.stdout.includes(value), out.stdout);
    assert.match(out.stdout, /ревизия/i);
    assert.doesNotMatch(out.stdout, /\u001b|"data":/);
  });
  await t.test("update: пропущенные поля и неизменяемые slug/prefix", async () => {
    const before = await read();
    failed(
      await app.run(["application", "update", key, "--if-revision", before.revision]),
      "INVALID_ARGUMENT",
    );
    const inputConflict = await app.run(
      [
        "application",
        "update",
        key,
        "--summary-file",
        "-",
        "--description-file",
        "-",
        "--if-revision",
        before.revision,
      ],
      { input: "Не записывать" },
    );
    assert.equal(inputConflict.body.ok, false);
    const invalid = await app.run([
      "application",
      "update",
      key,
      "--slug",
      "other",
      "--if-revision",
      before.revision,
    ]);
    assert.equal(invalid.body.ok, false);
    assert.deepEqual(await read(), before);
    successful(
      await app.run([
        "application",
        "update",
        key,
        "--type",
        "internal",
        "--name",
        "Внутренний Web",
        "--if-revision",
        before.revision,
      ]),
    );
    failed(
      await app.run([
        "application",
        "update",
        key,
        "--name",
        "Не менять",
        "--if-revision",
        before.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    const record = await read();
    assert.equal(record.data.type, "internal");
    assert.equal(record.data.description, before.data.description);
    assert.equal(record.data.summary, before.data.summary);
    assert.equal(record.data.slug, before.data.slug);
    assert.equal(record.data.prefix, before.data.prefix);
  });
  await t.test("rename: прежний ключ доступен, slug и prefix прежние", async () => {
    const before = await read();
    successful(
      await app.run(["application", "rename", key, "FRONTEND", "--if-revision", before.revision]),
    );
    const record = await read();
    assert.equal(record.key, "FRONTEND");
    assert.equal(record.ref.id, before.ref.id);
    assert.deepEqual(record.data, before.data);
    key = record.key;
  });
  await t.test("list: q/sort и snapshot cursor", async () => {
    const before = await read();
    successful(
      await app.run([
        "application",
        "update",
        key,
        "--name",
        "Web Z",
        "--if-revision",
        before.revision,
      ]),
    );
    const other = successful(
      await app.run<{ key: string }>([
        "application",
        "create",
        "--name",
        "Web A",
        "--slug",
        "second",
        "--description",
        "Назначение",
      ]),
    ).data;
    successful(
      await app.run([
        "application",
        "create",
        "--name",
        "Сервис",
        "--slug",
        "service",
        "--description",
        "Не входит",
      ]),
    );
    const page = successful(
      await app.run<{ items: { key: string }[]; total: number }>([
        "application",
        "list",
        "--q",
        "Web",
        "--sort",
        "title",
        "--limit",
        1,
      ]),
    );
    assert.equal(page.data.total, 2);
    assert.equal(page.meta?.page?.consistency, "snapshot");
    assert.ok(page.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: { key: string }[] }>([
        "application",
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
    for (const [args, expectedKey, name] of [
      [
        ["application", "list", "--q", "Web", "--sort", "title", "--limit", "1"],
        other.key,
        "Web A",
      ],
      [["application", "list", "--cursor", page.meta!.page!.nextCursor!], key, "Web Z"],
    ] as const) {
      const human = await invokeRaw(app.root, [...args]);
      assert.equal(human.code, 0, human.stdout);
      const text = human.stdout.replace(/\s+/g, " ");
      for (const value of [expectedKey, name, "Приложение"]) assert.ok(text.includes(value), text);
      assert.match(text, /Поиск:\s*Web/);
      assert.match(text, /Сортировка:\s*title/);
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
      assert.match(text, /Показано: 1 из 2/);
      if (expectedKey === other.key)
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*application list .*--cursor/);
      else assert.match(human.stdout, /Конец списка/);
    }
  });
  await t.test("progress: чтение сохраняет запись", async () => {
    const before = await read();
    assert.ok(successful(await app.run(["application", "progress", key])).data);
    assert.deepEqual(await read(), before);
  });
});

for (const status of ["none", "partial", "done"] as const)
  test(`participation: persisted ${status}, same/clear/reactivate без потери текста и ID`, async (t) => {
    const app = await fixture(t);
    const backend = await createLocalBackend(app.root);
    const application = successful(
      await app.run<{ key: string; ref: { id: string } }>([
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
    const feature = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Поиск",
        "--description",
        "Найти",
      ]),
    ).data;
    const implementation = successful(
      await app.run<{ key: string; ref: { id: string } }>([
        "implementation",
        "create",
        "--application",
        application.key,
        "--target",
        feature.key,
        "--title",
        "Сохранённый вклад",
        "--description",
        "## Вклад\n\nНе заменять вычисленным состоянием.\n",
        "--status",
        status,
      ]),
    ).data;
    for (const title of ["Уточнённый вклад", "Сохранённый вклад"]) {
      const detail = successful(
        await app.run<{ revision: number }>(["implementation", "get", implementation.key]),
      ).data;
      successful(
        await app.run([
          "implementation",
          "update",
          implementation.key,
          "--title",
          title,
          "--if-revision",
          detail.revision,
        ]),
      );
    }
    const list = async () =>
      successful(
        await app.run<Participation>(["application", "participation", "list", application.key]),
      ).data;
    const raw = async () => {
      const state = await backend.product.state();
      const scope = state.records.find(
        (record) =>
          record.fields.kind === "scope" && record.fields.applicationId === application.ref.id,
      );
      assert.ok(scope);
      const record = await backend.product.entity(scope.id);
      assert.equal(record.fields.kind, "scope");
      if (record.fields.kind !== "scope") throw new Error("Ожидался исходный состав");
      return record.fields.contracts;
    };
    const before = await raw();
    assert.equal(before[0]!.status, status);
    assert.ok((before[0]!.revision ?? 0) > 1);
    assert.equal(before[0]!.id, implementation.ref.id);
    await t.test("list: ревизия состава, версия, snapshot", async () => {
      const result = successful(
        await app.run<Participation>([
          "application",
          "participation",
          "list",
          application.key,
          "--limit",
          1,
        ]),
      );
      assert.equal(result.data.total, 1);
      assert.ok(result.data.version);
      assert.ok(result.data.revision >= 1);
      assert.equal(result.meta?.page?.consistency, "snapshot");
      const human = await invokeRaw(app.root, [
        "application",
        "participation",
        "list",
        application.key,
        "--limit",
        1,
      ]);
      assert.equal(human.code, 0, human.stdout);
      const text = human.stdout.replace(/\s+/g, " ");
      for (const value of [
        application.key,
        "Web",
        implementation.key,
        "Сохранённый вклад",
        "участвует",
      ])
        assert.ok(text.toLowerCase().includes(value.toLowerCase()), text);
      assert.match(text, new RegExp(`Ревизия состава:\\s*${result.data.revision}\\b`));
      assert.ok(text.includes(result.data.version), text);
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
      assert.match(text, /Показано: 1 из 1/);
    });
    await t.test(
      "replace: тот же состав сохраняет persisted поля и индивидуальную ревизию",
      async () => {
        const page = await list();
        for (const selection of [
          [],
          ["--clear", "--implementations", implementation.key],
          ["--implementations", implementation.key, implementation.key],
        ]) {
          failed(
            await app.run([
              "application",
              "participation",
              "replace",
              application.key,
              ...selection,
              "--if-revision",
              page.revision,
              "--if-version",
              page.version,
            ]),
            "INVALID_ARGUMENT",
          );
          assert.deepEqual(await raw(), before);
        }
        const human = await invokeRaw(app.root, [
          "application",
          "participation",
          "replace",
          application.key,
          "--implementations",
          implementation.key,
          "--if-revision",
          page.revision,
          "--if-version",
          page.version,
        ]);
        assert.equal(human.code, 0, human.stdout);
        const current = await list();
        const text = human.stdout.replace(/\s+/g, " ");
        assert.match(text, /состав заменён/i);
        assert.ok(text.includes(application.key), text);
        assert.match(text, /Приложение:\s*Web/);
        assert.match(text, new RegExp(`Ревизия состава:\\s*${current.revision}\\b`));
        assert.match(text, /Выбрано реализаций:\s*1/);
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*application participation list/);
        assert.deepEqual(await raw(), before);
      },
    );
    await t.test(
      "replace: clear сохраняет данные; reactivate возвращает тот же адрес",
      async () => {
        let page = await list();
        successful(
          await app.run([
            "application",
            "participation",
            "replace",
            application.key,
            "--clear",
            "--if-revision",
            page.revision,
            "--if-version",
            page.version,
          ]),
        );
        const inactive = await raw();
        assert.equal(inactive[0]!.active, false);
        for (const field of ["id", "key", "title", "description", "status"] as const)
          assert.deepEqual(inactive[0]![field], before[0]![field]);
        assert.ok((inactive[0]!.revision ?? 0) >= (before[0]!.revision ?? 0));
        const stale = await app.run([
          "application",
          "participation",
          "replace",
          application.key,
          "--implementations",
          implementation.key,
          "--if-revision",
          page.revision,
          "--if-version",
          page.version,
        ]);
        assert.equal(stale.body.ok, false);
        assert.deepEqual(await raw(), inactive);
        page = await list();
        assert.equal(page.items[0]!.active, false);
        const humanInactive = await invokeRaw(app.root, [
          "application",
          "participation",
          "list",
          application.key,
        ]);
        assert.equal(humanInactive.code, 0, humanInactive.stdout);
        const inactiveText = humanInactive.stdout.replace(/\s+/g, " ");
        for (const value of [application.key, implementation.key, "Сохранённый вклад"])
          assert.ok(inactiveText.includes(value), inactiveText);
        assert.match(inactiveText, /участие снято/i);
        assert.match(inactiveText, new RegExp(`Ревизия состава:\\s*${page.revision}\\b`));
        assert.equal((humanInactive.stdout.match(/Показано:/g) ?? []).length, 1);
        successful(
          await app.run([
            "application",
            "participation",
            "replace",
            application.key,
            "--implementations",
            implementation.key,
            "--if-revision",
            page.revision,
            "--if-version",
            page.version,
          ]),
        );
        const active = await raw();
        assert.equal(active[0]!.active, true);
        for (const field of ["id", "key", "title", "description", "status"] as const)
          assert.deepEqual(active[0]![field], before[0]![field]);
        assert.ok((active[0]!.revision ?? 0) >= (inactive[0]!.revision ?? 0));
      },
    );
  });

test("participation: пустой состав и атомарный отказ SI без FI/чужому приложению", async (t) => {
  const app = await fixture(t);
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
  const other = successful(
    await app.run<{ key: string }>([
      "application",
      "create",
      "--name",
      "API",
      "--slug",
      "api",
      "--description",
      "Сервис",
    ]),
  ).data;
  const list = async () =>
    successful(
      await app.run<Participation>(["application", "participation", "list", application.key]),
    ).data;
  let page = await list();
  assert.equal(page.revision, 0);
  assert.deepEqual(page.items, []);
  successful(
    await app.run([
      "application",
      "participation",
      "replace",
      application.key,
      "--clear",
      "--if-revision",
      page.revision,
      "--if-version",
      page.version,
    ]),
  );
  assert.deepEqual((await list()).items, []);
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
  const fi = successful(
    await app.run<{ key: string }>([
      "implementation",
      "create",
      "--application",
      application.key,
      "--target",
      feature.key,
      "--title",
      "FI",
      "--description",
      "Вклад фичи",
    ]),
  ).data;
  const si = successful(
    await app.run<{ key: string }>([
      "implementation",
      "create",
      "--application",
      application.key,
      "--target",
      scenario.key,
      "--title",
      "SI",
      "--description",
      "Вклад сценария",
    ]),
  ).data;
  const foreign = successful(
    await app.run<{ key: string }>([
      "implementation",
      "create",
      "--application",
      other.key,
      "--target",
      feature.key,
      "--title",
      "Другой FI",
      "--description",
      "Не входит в Web",
    ]),
  ).data;
  page = await list();
  for (const selection of [[si.key], [fi.key, foreign.key], [feature.key]]) {
    const invalid = await app.run([
      "application",
      "participation",
      "replace",
      application.key,
      "--implementations",
      ...selection,
      "--if-revision",
      page.revision,
      "--if-version",
      page.version,
    ]);
    assert.equal(invalid.body.ok, false, invalid.stdout);
    assert.deepEqual(await list(), page);
  }
});
