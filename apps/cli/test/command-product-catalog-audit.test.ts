import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import type {
  EntitiesPage,
  EntityDetail,
  EntityDeletionPreview,
  EntitySaved,
} from "@relay/contracts/entities";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  successful,
  failed,
  invokeRaw,
  tempDirectory,
} from "./helpers/cli.js";

const markdown =
  "\n\n## Полное требование 界 🧭\n\n\n```text\n\t  точные пробелы\n```\n\nПоказано: пользовательский текст\n\nКОНЕЦ_ПОЛНОГО_ОПИСАНИЯ\n\n";
const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
async function follow(root: string, command: string) {
  const launcher = `function npx() { test "$1" = '@oim-dev/relay-cli' || return 99; shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
  return promisify(execFile)("bash", ["-c", launcher + command], {
    cwd: root,
    env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("PROD-04: passport get ведёт к документам по актуальному ключу, сохраняя local/HTTP контекст", async (t) => {
  const f = await fixture(t);
  const passport = successful(
    await f.run<EntitySaved>([
      "product",
      "create",
      "--name",
      "Паспорт 界",
      "--description",
      markdown,
    ]),
  ).data;
  const document = successful(
    await f.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Основание паспорта",
      "--body",
      "Полный материал",
      "--relations",
      JSON.stringify([{ target: passport.ref, type: "documents", description: "Общее основание" }]),
    ]),
  ).data;
  const config = join(f.root, ".relay", "паспорт O'Брайен.json");
  await copyFile(join(f.root, ".relay", "config.json"), config);
  const elsewhere = await tempDirectory(t);
  const check = async (key: string, globals: string[]) => {
    const out = await invokeRaw(elsewhere, [...globals, "product", "get"], {
      env: { COLUMNS: "24", FORCE_COLOR: "3" },
    });
    assert.equal(out.code, 0, out.stdout);
    assert.equal(out.stderr, "");
    assert.ok(out.stdout.includes(markdown));
    assert.doesNotMatch(out.stdout, /\u001b/);
    assert.match(out.stdout.replace(/\s+/g, " "), /Связи графа: вся достижимая компонента/);
    const commands = hints(out.stdout);
    const documents = commands.find((line) => line.includes(`document list --target ${key}`));
    assert.ok(documents, out.stdout);
    const graph = commands.find((line) => line.includes(`inspect graph context ${key}`));
    assert.ok(graph, out.stdout);
    for (const flag of globals.filter((value) => value.startsWith("--"))) {
      assert.ok(documents.includes(flag), documents);
      assert.ok(graph.includes(flag), graph);
    }
    // Выполняется точная shell-строка, заменяется только npx-launcher текущими исходниками.
    const linked = await follow(elsewhere, documents);
    assert.equal(linked.stderr, "");
    assert.ok(linked.stdout.includes(document.key), linked.stdout);
    const context = await follow(elsewhere, graph);
    assert.equal(context.stderr, "");
    assert.ok(context.stdout.includes(document.key), context.stdout);
    return documents;
  };
  await check(passport.key, ["--local", "--config", config]);
  const current = successful(await f.run<EntityDetail>(["product", "get"])).data;
  const renamed = successful(
    await f.run<EntitySaved>([
      "product",
      "rename",
      "PASSPORT-AUDIT",
      "--if-revision",
      current.revision,
    ]),
  ).data;
  assert.notEqual(renamed.key, passport.key);
  assert.deepEqual(renamed.ref, passport.ref);
  const alias = successful(await f.run<{ key: string }>(["inspect", "resolve", passport.key])).data;
  assert.equal(alias.key, renamed.key);
  const byAlias = successful(
    await f.run<EntitiesPage>(["document", "list", "--target", passport.key]),
  ).data;
  assert.deepEqual(
    byAlias.items.map((item) => item.key),
    [document.key],
  );
  const renamedHint = await check(renamed.key, ["--local", "--config", config]);
  assert.ok(!renamedHint.includes(`--target ${passport.key}`), renamedHint);
  const project = successful(await f.run<EntitiesPage>(["search", "--kind", "project"])).data
    .items[0]!;
  const { httpServer } = await import("./helpers/http.js");
  const server = await httpServer(t, f.root);
  const httpHint = await check(renamed.key, [
    "--server-url",
    server.url,
    "--project",
    project.ref.id,
  ]);
  assert.ok(httpHint.includes(server.url), httpHint);
  assert.ok(httpHint.includes(project.ref.id), httpHint);
});

test("FTR/SC/APP/IMP: help удаления и FI/SI доступен без проекта", async (t) => {
  const root = await tempDirectory(t);
  for (const kind of ["feature", "scenario", "application", "implementation"]) {
    for (const action of ["delete-preview", "delete"]) {
      const out = await invokeRaw(root, [kind, action, "--help"]);
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      assert.match(out.stdout, /предпросмотр|каскад/);
      assert.match(out.stdout, /--if-version/);
    }
  }
  const out = await invokeRaw(root, ["implementation", "list", "--help"]);
  assert.match(out.stdout, /--implementation-target/);
});

test("FTR-04/05/06 SC-03/04/05/06 APP-04/05 IMP-02/03: адресные каталоги и полное чтение", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  const feature = await create("feature", [
    "--name",
    "Поиск 界",
    "--summary",
    "СУММАРИ_МАРКЕР " + "🧭".repeat(230),
    "--description",
    markdown,
  ]);
  const scenario = await create("scenario", [
    "--name",
    "Найти",
    "--feature",
    feature.key,
    "--description",
    markdown,
  ]);
  const app = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--summary",
    "НАЗНАЧЕНИЕ_ПРИЛОЖЕНИЯ",
    "--description",
    markdown,
  ]);
  const fi = await create("implementation", [
    "--title",
    "Общий вклад",
    "--application",
    app.key,
    "--target",
    feature.key,
    "--description",
    markdown,
    "--status",
    "done",
  ]);
  const si = await create("implementation", [
    "--title",
    "Конкретный вклад",
    "--application",
    app.key,
    "--target",
    scenario.key,
    "--description",
    markdown,
  ]);
  await create("feature", ["--name", "Другие требования", "--description", "Без совпадений"]);
  await create("scenario", [
    "--name",
    "Другой сценарий",
    "--feature",
    feature.key,
    "--description",
    "Без совпадений",
  ]);
  await create("application", [
    "--name",
    "API",
    "--slug",
    "api",
    "--description",
    "Без совпадений",
  ]);
  successful(
    await f.run([
      "implementation",
      "rename",
      fi.key,
      "WEB-OBLIGATION",
      "--if-revision",
      fi.revision,
    ]),
  );
  fi.key = "WEB-OBLIGATION";

  for (const [kind, record] of [
    ["feature", feature],
    ["scenario", scenario],
    ["application", app],
    ["implementation", fi],
  ] as const) {
    const before = successful(await f.run<EntityDetail>([kind, "get", record.key])).data;
    successful(
      await f.run([
        kind,
        "update",
        record.key,
        kind === "implementation" ? "--title" : "--name",
        `${before.title} (уточнено)`,
        "--if-revision",
        before.revision,
      ]),
    );
    const sorted = successful(
      await f.run<EntitiesPage>([kind, "list", "--sort", "updated", "--limit", 1]),
    ).data;
    assert.equal(sorted.items[0]?.key, record.key);
    const data = successful(await f.run<EntityDetail>([kind, "get", record.key])).data;
    assert.ok(data.metadata?.updatedAt);
    assert.equal(data.metadata?.updatedBy, "test-agent");
    assert.ok("description" in data.data && data.data.description === markdown);
    for (const width of [40, 100]) {
      const out = await invokeRaw(
        f.root,
        [kind, "get", record.key, "--local", "--config", join(f.root, ".relay/config.json")],
        { env: { COLUMNS: String(width), FORCE_COLOR: "3" } },
      );
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      assert.ok(out.stdout.includes(markdown), out.stdout);
      assert.match(out.stdout, /Изменил/);
      assert.match(out.stdout.replace(/\s+/g, " "), /Команды CLI — вне содержания/);
      assert.doesNotMatch(out.stdout, /\u001b/);
      const commands = hints(out.stdout);
      assert.ok(commands.some((line) => line.includes(`${kind} progress ${record.key}`)));
      assert.ok(commands.every((line) => line.includes("--local") && line.includes("--config")));
      if (width === 100) {
        for (const command of commands.filter(
          (line) => !line.includes("delete-preview") && !line.includes("inspect graph"),
        )) {
          const next = await follow(f.root, command);
          assert.equal(next.stderr, "");
          assert.ok(next.stdout.length > 0);
        }
      }
    }
    const list = await invokeRaw(f.root, [kind, "list"]);
    assert.equal(list.code, 0, list.stdout);
    assert.ok(
      hints(list.stdout).some((line) => line.includes(`${kind} get `)),
      list.stdout,
    );
    assert.equal(hints(list.stdout).filter((line) => line.includes(`${kind} get `)).length, 1);
  }
  for (const width of [24, 160]) {
    const out = await invokeRaw(f.root, ["feature", "get", feature.key], {
      env: { COLUMNS: String(width) },
    });
    assert.ok(out.stdout.includes(markdown));
  }
  const featureList = await invokeRaw(f.root, ["feature", "list", "--q", "СУММАРИ_МАРКЕР"]);
  assert.match(featureList.stdout, /Аннотация \(фрагмент\): СУММАРИ_МАРКЕР/);
  const appList = await invokeRaw(f.root, ["application", "list"]);
  assert.match(appList.stdout, /Аннотация: НАЗНАЧЕНИЕ_ПРИЛОЖЕНИЯ/);
  const scenarios = await invokeRaw(f.root, ["scenario", "list", "--feature", feature.key]);
  assert.equal(scenarios.stdout.split(feature.key).length - 1, 1, scenarios.stdout);
  assert.doesNotMatch(scenarios.stdout, /Аннотация:/);
  const implementationList = await invokeRaw(f.root, [
    "implementation",
    "list",
    "--implementation-target",
    "feature",
  ]);
  assert.match(implementationList.stdout, /Вид реализации: FI/);
  assert.ok(implementationList.stdout.includes(`Цель: ${feature.key}`));
  assert.ok(implementationList.stdout.includes(fi.key));
  assert.ok(!implementationList.stdout.includes(si.key));
  for (const [target, expected] of [
    ["feature", fi.key],
    ["scenario", si.key],
  ]) {
    const page = successful(
      await f.run<EntitiesPage>([
        "search",
        "--implementation-target",
        target!,
        "--application",
        app.key,
      ]),
    ).data;
    assert.deepEqual(
      page.items.map((item) => item.key),
      [expected],
    );
  }
});

test("SC-04/APP-05: плотность полных страниц 20 записей при 40/100", async (t) => {
  const f = await fixture(t);
  const feature = successful(
    await f.run<EntitySaved>([
      "feature",
      "create",
      "--name",
      "Общий родитель с длинным названием 界 🧭",
      "--description",
      "Требования",
    ]),
  ).data;
  for (let index = 0; index < 20; index++) {
    successful(
      await f.run([
        "scenario",
        "create",
        "--name",
        `Найти вариант ${index} с длинным названием 界 🧭`,
        "--feature",
        feature.key,
        "--description",
        "Тело не попадает в список",
      ]),
    );
    successful(
      await f.run([
        "application",
        "create",
        "--name",
        `Приложение ${index} с длинным названием 界 🧭`,
        "--slug",
        `app-${index}`,
        "--summary",
        `Назначение ${index}`,
        "--description",
        "Тело не попадает в список",
      ]),
    );
  }
  for (const kind of ["scenario", "application"])
    for (const width of [40, 100]) {
      const out = await invokeRaw(
        f.root,
        [kind, "list", "--limit", 20, ...(kind === "scenario" ? ["--feature", feature.key] : [])],
        { env: { COLUMNS: String(width) } },
      );
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      assert.match(out.stdout, /Показано: 20 из 20/);
      assert.equal(hints(out.stdout).length, 1);
      assert.doesNotMatch(out.stdout, /Тело не попадает/);
      if (kind === "scenario") assert.equal(out.stdout.split(feature.key).length - 1, 1);
      else assert.equal((out.stdout.match(/Аннотация:/g) ?? []).length, 20);
      t.diagnostic(
        `${kind} list width=${width}: ${Buffer.byteLength(out.stdout)} байт UTF-8; ${out.stdout.split("\n").length - 1} физических строк`,
      );
    }
});

test("S-01/02/03: общий поиск, updated и применимость до страницы", async (t) => {
  const f = await fixture(t);
  const first = successful(
    await f.run<EntitySaved>([
      "feature",
      "create",
      "--name",
      "Первое",
      "--description",
      "ТОЛЬКО_В_ОПИСАНИИ",
    ]),
  ).data;
  successful(
    await f.run(["feature", "create", "--name", "Второе", "--description", "ТОЛЬКО_В_ОПИСАНИИ"]),
  );
  successful(
    await f.run([
      "feature",
      "update",
      first.key,
      "--summary",
      "Обновление",
      "--if-revision",
      first.revision,
    ]),
  );
  const page = successful(
    await f.run<EntitiesPage>([
      "search",
      "только_в_описании",
      "--kind",
      "feature",
      "--sort",
      "updated",
      "--limit",
      1,
    ]),
  );
  assert.equal(page.data.total, 2);
  assert.equal(page.data.items[0]?.key, first.key);
  assert.ok(page.data.items[0]?.updatedAt);
  assert.ok(page.meta?.page?.nextCursor);
  const next = successful(
    await f.run<EntitiesPage>(["search", "--cursor", page.meta.page.nextCursor]),
  );
  assert.equal(next.data.total, 2);
  assert.notEqual(next.data.items[0]?.key, first.key);
  const human = await invokeRaw(f.root, ["search", "ТОЛЬКО_В_ОПИСАНИИ", "--sort", "updated"]);
  assert.match(human.stdout, /Изменён:/);
  assert.doesNotMatch(human.stdout, /ТОЛЬКО_В_ОПИСАНИИ.*ТОЛЬКО_В_ОПИСАНИИ/);
  successful(await f.run(["document", "create", "--name", "Материал", "--body", "Текст"]));
  const documents = successful(await f.run<EntitiesPage>(["search", "--section", "none"])).data;
  assert.equal(documents.total, 1);
  assert.ok(documents.items.every((item) => item.ref.kind === "document"));
  const active = successful(await f.run<EntitiesPage>(["search", "--active", "true"])).data;
  assert.equal(active.total, 0);
});

test("FTR-01/SC-01/IMP-01/APP-01: полный preview, CAS и каскад через CLI", async (t) => {
  for (const variant of [
    "feature",
    "scenario",
    "implementation",
    "implementation-si",
    "application",
  ] as const) {
    await t.test(variant, async (t) => {
      const kind = variant === "implementation-si" ? "implementation" : variant;
      const f = await fixture(t);
      const create = async (kind: string, args: string[]) =>
        successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
      const feature = await create("feature", [
        "--name",
        "Удаление",
        "--description",
        "Требование",
      ]);
      const scenario = await create("scenario", [
        "--name",
        "Удаление сценария",
        "--feature",
        feature.key,
        "--description",
        "Шаги",
      ]);
      const application = await create("application", [
        "--name",
        "Web",
        "--slug",
        "web",
        "--description",
        "Приложение",
      ]);
      const implementation = await create("implementation", [
        "--title",
        "FI",
        "--application",
        application.key,
        "--target",
        feature.key,
        "--description",
        "Вклад",
      ]);
      const si = await create("implementation", [
        "--title",
        "SI",
        "--application",
        application.key,
        "--target",
        scenario.key,
        "--description",
        "Вклад",
      ]);
      const records = { feature, scenario, application, implementation };
      const target = variant === "implementation-si" ? si : records[kind];
      const task = await create("task", [
        "--title",
        "Затронутая работа",
        "--board",
        kind === "feature" || kind === "scenario" ? "product" : "web",
        "--targets",
        kind === "application" ? implementation.key : target.key,
      ]);
      const document = await create("document", [
        "--name",
        "Сохраняемый материал",
        "--body",
        "Материал сохраняется",
        "--relations",
        JSON.stringify([{ target: target.ref, type: "documents", description: "Основание" }]),
      ]);
      const preview = successful(
        await f.run<EntityDeletionPreview>([kind, "delete-preview", target.key]),
      ).data;
      assert.ok(preview.deleted.some((item) => item.key === target.key));
      assert.ok(preview.deleted.some((item) => item.key === si.key));
      const expected =
        variant === "feature"
          ? [feature.key, scenario.key, implementation.key, si.key]
          : variant === "scenario"
            ? [scenario.key, si.key]
            : variant === "implementation"
              ? [implementation.key, si.key]
              : variant === "implementation-si"
                ? [si.key]
                : [
                    application.key,
                    implementation.key,
                    si.key,
                    task.key,
                    ...preview.deleted
                      .filter((item) => item.ref.kind === "board")
                      .map((item) => item.key),
                  ];
      assert.deepEqual(preview.deleted.map((item) => item.key).sort(), expected.sort());
      assert.ok(preview.detached.some((item) => item.key === document.key));
      const noActor = await invokeRaw(f.root, [kind, "delete-preview", target.key], {
        env: { RELAY_ACTOR: "", COLUMNS: "40" },
      });
      assert.match(noActor.stdout, /delete --help/);
      for (const item of [...preview.deleted, ...preview.detached])
        assert.ok(noActor.stdout.includes(item.key));
      successful(
        await f.run([
          kind,
          "update",
          target.key,
          kind === "implementation" ? "--title" : "--name",
          "Изменено",
          "--if-revision",
          target.revision,
        ]),
      );
      failed(
        await f.run([kind, "delete", target.key, "--if-version", preview.version]),
        "REVISION_CONFLICT",
        4,
      );
      successful(await f.run([kind, "get", target.key]));
      const current = successful(
        await f.run<EntityDeletionPreview>([kind, "delete-preview", target.key]),
      ).data;
      const deleted = successful(
        await f.run<{ deleted: number }>([
          kind,
          "delete",
          target.key,
          "--if-version",
          current.version,
        ]),
      ).data;
      assert.equal(deleted.deleted, current.deleted.length);
      for (const item of current.deleted.filter((item) => item.ref.kind !== "board")) {
        const gone = await f.run([item.ref.kind, "get", item.key]);
        assert.equal(gone.body.ok, false);
        assert.equal(gone.code, 3);
      }
      if (kind !== "feature") successful(await f.run(["feature", "get", feature.key]));
      if (kind !== "application") successful(await f.run(["application", "get", application.key]));
      if (variant === "implementation-si") {
        successful(await f.run(["implementation", "get", implementation.key]));
        successful(await f.run(["scenario", "get", scenario.key]));
      }
      const retained = successful(
        await f.run<EntityDetail>(["document", "get", document.key]),
      ).data;
      assert.ok(retained.data.kind === "document" && retained.data.body === "Материал сохраняется");
      assert.deepEqual(retained.data.kind === "document" && retained.data.relations, []);
      if (kind !== "application")
        assert.deepEqual(
          successful(await f.run<{ productLinks: unknown[] }>(["task", "get", task.key])).data
            .productLinks,
          [],
        );
    });
  }
});
