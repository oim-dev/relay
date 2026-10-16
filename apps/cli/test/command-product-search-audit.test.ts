import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EntitiesPage, EntityDetail, EntitySaved } from "@relay/contracts/entities";
import { entitiesText, entityReadArgs } from "../src/presentation/entities.js";
import { shellCommand } from "../src/command-kit.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  invokeRaw,
  successful,
  failed,
} from "./helpers/cli.js";

test("D-02: короткий body при match.truncated=false всё равно обозначен поисковым фрагментом", async (t) => {
  const f = await fixture(t);
  const body = "\n## Короткий документ\n\nМАРКЕР_ТЕЛА\n\t  Конец.\n\n";
  const summary = "Сохранённая\nаннотация";
  const saved = successful(
    await f.run<EntitySaved>([
      "document",
      "create",
      "--name",
      "Короткий материал",
      "--summary",
      summary,
      "--body",
      body,
    ]),
  ).data;
  for (const args of [
    ["document", "list", "--q", "МАРКЕР_ТЕЛА"],
    ["search", "МАРКЕР_ТЕЛА", "--kind", "document"],
    ["search", "МАРКЕР_ТЕЛА"],
  ]) {
    const before = successful(await f.run<EntitiesPage>(args)).data;
    assert.equal(before.total, 1);
    assert.equal(before.items[0]!.match?.field, "body");
    assert.equal(before.items[0]!.match?.truncated, false);
    assert.equal(before.items[0]!.summary, summary);
    for (const width of [24, 40, 100]) {
      const out = await invokeRaw(f.root, args, { env: { COLUMNS: String(width) } });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      const flat = out.stdout.replace(/\s+/g, " ");
      assert.match(flat, /Совпадение в содержании \(фрагмент\):.*МАРКЕР_ТЕЛА/);
      assert.equal((flat.match(/Совпадение в содержании/g) ?? []).length, 1);
    }
    assert.deepEqual(successful(await f.run<EntitiesPage>(args)).data, before);
  }
  const full = successful(await f.run<EntityDetail>(["document", "get", saved.key])).data;
  assert.equal(full.summary, summary);
  assert.ok(full.data.kind === "document" && full.data.body === body);
  const human = await invokeRaw(f.root, ["document", "get", saved.key], { env: { COLUMNS: "24" } });
  assert.equal(human.code, 0, human.stdout);
  assert.ok(human.stdout.includes(body));
  assert.ok(human.stdout.includes(summary));
});

test("D-02: document excerpt сохранён при очевидном generic match по title или key", async (t) => {
  const f = await fixture(t);
  const needle = "ОБЩЕЕ_СОВПАДЕНИЕ";
  const summary = "Независимая\nсохранённая аннотация";
  const initialBody = `\n## Короткое тело\n\n${needle}\n\nМАРКЕР_ТОЛЬКО_ТЕЛА\n\n`;
  const saved = successful(
    await f.run<EntitySaved>([
      "document",
      "create",
      "--name",
      `${needle} — название`,
      "--summary",
      summary,
      "--body",
      initialBody,
    ]),
  ).data;
  const body = initialBody + `Адрес: ${saved.key}\n`;
  successful(
    await f.run(["document", "update", saved.key, "--body", body, "--if-revision", saved.revision]),
  );
  for (const [field, q] of [
    ["title", needle],
    ["key", saved.key],
  ] as const) {
    for (const args of [
      ["document", "list", "--q", q],
      ["search", q, "--kind", "document"],
      ["search", q],
    ]) {
      const before = successful(await f.run<EntitiesPage>(args)).data;
      assert.equal(before.total, 1);
      assert.equal(before.items[0]!.match?.field, field);
      assert.equal(before.items[0]!.match?.truncated, false);
      assert.ok(before.items[0]!.document?.excerpt?.includes("МАРКЕР_ТОЛЬКО_ТЕЛА"));
      assert.equal(before.items[0]!.summary, summary);
      for (const width of [24, 100]) {
        const out = await invokeRaw(f.root, args, { env: { COLUMNS: String(width) } });
        assert.equal(out.code, 0, out.stdout);
        assert.equal(out.stderr, "");
        const flat = out.stdout.replace(/\s+/g, " ");
        assert.match(flat, /Совпадение в содержании \(фрагмент\):.*МАРКЕР_ТОЛЬКО_ТЕЛА/);
        assert.equal((flat.match(/Совпадение в содержании/g) ?? []).length, 1);
        assert.equal((flat.match(/МАРКЕР_ТОЛЬКО_ТЕЛА/g) ?? []).length, 1);
        assert.doesNotMatch(flat, /Совпадение в (названии|текущем ключе):/);
      }
      assert.deepEqual(successful(await f.run<EntitiesPage>(args)).data, before);
    }
  }
  const full = successful(await f.run<EntityDetail>(["document", "get", saved.key])).data;
  assert.equal(full.summary, summary);
  assert.ok(full.data.kind === "document" && full.data.body === body);
  const human = await invokeRaw(f.root, ["document", "get", saved.key], { env: { COLUMNS: "24" } });
  assert.equal(human.code, 0, human.stdout);
  assert.ok(human.stdout.includes(body));
  assert.ok(human.stdout.includes(summary));
});

test("FTR-06/D-02: совпадение в хвосте summary и прежнем ключе отдельно от сохранённой аннотации", async (t) => {
  const f = await fixture(t);
  const summary = "Первые сведения 🧭 ".repeat(30) + "ИГОЛКА_ХВОСТА исходная аннотация.";
  const created = successful(
    await f.run<EntitySaved>([
      "feature",
      "create",
      "--name",
      "Похожее название",
      "--summary",
      summary,
      "--description",
      "Полный текст",
    ]),
  ).data;
  const page = successful(await f.run<EntitiesPage>(["search", "иголка_хвоста"])).data;
  assert.equal(page.total, 1);
  assert.equal(page.items[0]!.summary, summary);
  assert.equal(page.items[0]!.match?.field, "summary");
  assert.equal(page.items[0]!.match?.truncated, true);
  assert.match(page.items[0]!.match!.text, /ИГОЛКА_ХВОСТА/);
  for (const args of [
    ["feature", "list", "--q", "иголка_хвоста"],
    ["search", "иголка_хвоста"],
  ]) {
    for (const width of [40, 100]) {
      const human = await invokeRaw(f.root, args, { env: { COLUMNS: String(width) } });
      assert.equal(human.code, 0, human.stdout);
      const flat = human.stdout.replace(/\s+/g, " ");
      assert.match(flat, /Аннотация \(фрагмент\):/);
      assert.match(flat, /Совпадение в аннотации \(фрагмент\):.*ИГОЛКА_ХВОСТА/);
      assert.doesNotMatch(human.stdout, /\u001b/);
    }
  }
  successful(
    await f.run([
      "feature",
      "rename",
      created.key,
      "RENAMED-FEATURE",
      "--if-revision",
      created.revision,
    ]),
  );
  const alias = successful(await f.run<EntitiesPage>(["search", created.key])).data;
  assert.equal(alias.items[0]!.key, "RENAMED-FEATURE");
  assert.deepEqual(alias.items[0]!.match, { field: "alias", text: created.key, truncated: false });
  const humanAlias = await invokeRaw(f.root, ["search", created.key]);
  assert.match(humanAlias.stdout, new RegExp(`Совпадение в прежнем ключе: ${created.key}`));
  assert.equal(
    successful(await f.run<EntityDetail>(["feature", "get", created.key])).data.summary,
    summary,
  );
});

test("IMP-02: FI/SI-фильтр привязан к курсору, не к тексту ключа", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  const app = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Назначение",
  ]);
  const keys: string[] = [];
  for (const name of ["Первая", "Вторая"]) {
    const feature = await create("feature", ["--name", name, "--description", "Требование"]);
    keys.push(
      (
        await create("implementation", [
          "--application",
          app.key,
          "--target",
          feature.key,
          "--title",
          "SI в названии не меняет вид FI",
          "--description",
          "Вклад",
        ])
      ).key,
    );
  }
  successful(
    await f.run(["implementation", "rename", keys[0]!, "WEB-SI-NOT-TYPE", "--if-revision", 1]),
  );
  keys[0] = "WEB-SI-NOT-TYPE";
  const first = successful(
    await f.run<EntitiesPage>([
      "implementation",
      "list",
      "--implementation-target",
      "feature",
      "--application",
      app.key,
      "--active",
      "true",
      "--limit",
      1,
    ]),
  );
  assert.equal(first.data.total, 2);
  assert.ok(first.meta?.page?.nextCursor);
  const second = successful(
    await f.run<EntitiesPage>(["implementation", "list", "--cursor", first.meta.page.nextCursor]),
  );
  assert.deepEqual(
    [...first.data.items, ...second.data.items].map((item) => item.key).sort(),
    keys.sort(),
  );
  assert.ok(
    [...first.data.items, ...second.data.items].every((item) => item.implementation?.type === "FI"),
  );
  failed(
    await f.run([
      "implementation",
      "list",
      "--cursor",
      first.meta.page.nextCursor,
      "--implementation-target",
      "scenario",
    ]),
    "INVALID_CURSOR",
  );
});

test("D-03: mixed 11 видов и 20 строк — адреса без команды у каждой записи", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  await create("product", ["--name", "Продукт 界", "--description", "Назначение"]);
  const feature = await create("feature", [
    "--name",
    "Требование с длинным названием 界",
    "--description",
    "Контракт",
  ]);
  await create("scenario", [
    "--name",
    "Сценарий с длинным названием 界",
    "--feature",
    feature.key,
    "--description",
    "Шаги",
  ]);
  const app = await create("application", [
    "--name",
    "Приложение с длинным названием 界",
    "--slug",
    "web",
    "--description",
    "Назначение",
  ]);
  await create("implementation", [
    "--title",
    "Вклад с длинным названием 界",
    "--application",
    app.key,
    "--target",
    feature.key,
    "--description",
    "Реализация",
  ]);
  await create("document", [
    "--name",
    "Материал с длинным названием 界",
    "--summary",
    "Сохранённая аннотация",
    "--body",
    "Материал",
  ]);
  await f.create("Задача с длинным названием 界");
  const plan = successful(
    await f.run<{ key: string }>([
      "plan",
      "create",
      "--title",
      "План с длинным названием 界",
      "--goal",
      "Результат",
    ]),
  ).data;
  successful(
    await f.run([
      "release",
      "create",
      "--title",
      "Релиз с длинным названием 界",
      "--release-version",
      "1.0",
      "--plans",
      plan.key,
    ]),
  );
  const all = successful(await f.run<EntitiesPage>(["search", "--limit", 100])).data;
  const representatives = [...new Map(all.items.map((item) => [item.ref.kind, item])).values()];
  assert.equal(representatives.length, 11);
  const keys = representatives.map((item) => item.key);
  for (let index = 0; index < 9; index++)
    keys.push(
      (
        await create("feature", [
          "--name",
          `Похожее требование номер ${index} 界`,
          "--description",
          "Полный текст",
        ])
      ).key,
    );
  for (const size of [11, 20]) {
    const refs = keys.slice(0, size);
    const page = successful(
      await f.run<EntitiesPage>(["search", "--refs", ...refs, "--limit", 100]),
    ).data;
    assert.equal(page.total, size);
    for (const width of [40, 100]) {
      const human = await invokeRaw(f.root, ["search", "--refs", ...refs, "--limit", 100], {
        env: { COLUMNS: String(width) },
      });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      const commands = human.stdout
        .split("\n")
        .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
      assert.equal(commands.length, 0);
      const reads = page.items.map((item) =>
        shellCommand(["npx", "@oim-dev/relay-cli", ...entityReadArgs(item)]),
      );
      const options = { color: false, width };
      const inline = entitiesText(page, { refs }, options, commands);
      const grouped =
        entitiesText(page, { refs }, options) +
        "\n\nПолное чтение найденных записей:\n" +
        reads.join("\n");
      assert.ok(human.stdout.startsWith(inline), human.stdout);
      assert.ok(Buffer.byteLength(inline) < Buffer.byteLength(grouped));
      for (let index = 0; index < page.items.length; index++) {
        const start = human.stdout.indexOf(`\n${page.items[index]!.key} —`);
        const next = page.items[index + 1]
          ? human.stdout.indexOf(`\n${page.items[index + 1]!.key} —`)
          : human.stdout.length;
        assert.ok(start >= 0 && start < next, human.stdout);
      }
      t.diagnostic(
        `mixed=${size} width=${width}: без меню ${Buffer.byteLength(inline)} Б/${inline.split("\n").length} строк; с командами ${Buffer.byteLength(grouped)} Б/${grouped.split("\n").length} строк (без общего footer обоих вариантов)`,
      );
      if (size === 11 && width === 100) {
        const launcher = `function npx() { test "$1" = '@oim-dev/relay-cli' || return 99; shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
        for (const command of reads) {
          const out = await promisify(execFile)("bash", ["-c", launcher + command], {
            cwd: f.root,
            env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
            maxBuffer: 4 * 1024 * 1024,
          });
          assert.equal(out.stderr, "");
          assert.ok(out.stdout.length > 0);
        }
      }
    }
  }
});
