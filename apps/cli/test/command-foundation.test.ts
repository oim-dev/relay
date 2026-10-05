import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Command } from "commander";
import { registerCommand } from "../src/command.js";
import {
  offsetQueryFor,
  pageResultFor,
  nativeQuery,
  nativePageResult,
} from "../src/command-kit.js";
import type { PaginationContext } from "../src/command-kit.js";
import type { CommandContext } from "../src/context.js";
import { serializeResult } from "../src/queries/result.js";
import { terminalOptions } from "../src/terminal.js";
import { cardText, listText, receiptText } from "../src/presentation/common.js";
import { renderMarkdown } from "../src/presentation/markdown.js";
import { printError } from "../src/output.js";
import { AppError } from "@relay/core/shared/errors";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixture,
  invokeRaw,
  successful,
  tempDirectory,
  invoke,
} from "./helpers/cli.js";
import { helpRuntime } from "./helpers/help.js";

test("foundation: карточка и квитанция пропускают пустые поля, но сохраняют ноль и копируемые команды", () => {
  const command =
    "npx @oim-dev/relay-cli task get PRODUCT-1 --config '/проект с пробелами/config.json'";
  const input = {
    title: "Сохранено",
    fields: [
      ["Ревизия", 0],
      ["Пусто", ""],
      ["Нет", null],
      ["Не задано", undefined],
    ] as const,
    commands: [{ label: "Прочитайте запись", command }],
  };
  const expected = `Сохранено\n\nРевизия: 0\n\nПрочитайте запись\n${command}`;
  for (const width of [24, 100]) {
    assert.equal(cardText(input, { width, color: true }), expected);
    assert.equal(receiptText(input, { width, color: true }), expected);
  }
  const unsafe = receiptText(
    { title: "Имя\u001b[31m", fields: [["Значение", "\u009b31m"]] },
    { width: 100, color: true },
  );
  assert.doesNotMatch(unsafe, /[\x1b\u009b]/);
  assert.ok(unsafe.includes("Имя\\u001b[31m"));
});

test("foundation: Markdown сохраняет literal строки, пустоты и отступы; section body не экранируется повторно", () => {
  const markdown =
    "\n\n## Заголовок\n\n  отступ  \n\n\n```ts\n\tconst value = 'длинная строка без жёсткого переноса по ширине терминала';\n```\n\n[Ссылка](https://example.com/очень-длинный-путь)\n\n";
  for (const width of [24, 100]) {
    assert.equal(renderMarkdown(markdown, { width, color: true }), markdown);
    assert.equal(
      cardText(
        {
          title: "Карточка",
          sections: [
            { title: "Описание", body: renderMarkdown(markdown, { width, color: false }) },
            { title: "Не показывать", body: " \n\t" },
          ],
        },
        { width, color: false },
      ),
      `Карточка\n\nОписание\n${markdown}`,
    );
  }
  const prepared = renderMarkdown("ANSI: \u001b[31m; literal: \\u001b; путь C:\\tmp", {
    width: 24,
    color: false,
  });
  assert.equal(prepared, "ANSI: \\u001b[31m; literal: \\u001b; путь C:\\tmp");
  assert.equal(
    cardText(
      { title: "Карточка", sections: [{ title: "Описание", body: prepared }] },
      { width: 24, color: false },
    ),
    "Карточка\n\nОписание\nANSI: \\u001b[31m; literal: \\u001b; путь C:\\tmp",
  );
});

test("foundation: список различает пустую выборку и карточки, сохраняет фильтр 0 и полезные детали", () => {
  assert.equal(
    listText(
      {
        title: "Задачи",
        filters: [
          ["Номер", 0],
          ["Пусто", ""],
          ["Нет", null],
        ],
        items: [],
        emptyMessage: "Нет совпадений",
      },
      { width: 100, color: true },
    ),
    "Задачи\n\nНомер: 0\n\nНет совпадений",
  );
  const result = listText(
    {
      title: "Задачи",
      items: [
        { key: "PRODUCT-1", title: "Проверка 🔬", details: ["Готова", "", "  "] },
        { key: "PRODUCT-2", title: "Ожидает" },
      ],
    },
    { width: 100, color: true },
  );
  assert.equal(result, "Задачи\n\nPRODUCT-1 — Проверка 🔬\n  Готова\n\nPRODUCT-2 — Ожидает");
});

test("foundation: общий footer сохраняет total и агрегатный count больше limit, без ложного конца", () => {
  const page = {
    count: 5,
    total: 9,
    limit: 2,
    consistency: "snapshot" as const,
    nextCursor: "opaque",
    nextCommand: "npx @oim-dev/relay-cli progress --cursor opaque",
  };
  const result = { data: { tasks: [1, 2], plans: [3, 4], releases: [5] }, text: "Прогресс", page };
  assert.equal(
    serializeResult(result, "text", { width: 100, color: true }),
    `Прогресс\n\nПоказано: 5 из 9 подходящих записей\nЕсть продолжение\n${page.nextCommand}\n`,
  );
  assert.deepEqual(JSON.parse(serializeResult(result, "json")), {
    ok: true,
    data: result.data,
    meta: { page },
  });
  const empty = {
    ...result,
    data: { items: [] },
    text: "Нет записей",
    page: { ...page, count: 0, total: 0 },
  };
  const output = serializeResult(empty, "text");
  assert.ok(output.includes("Показано: 0 из 0 подходящих записей"));
  assert.ok(output.includes("Есть продолжение"));
  assert.ok(!output.includes("Конец списка"));
  const end = serializeResult(
    { ...empty, page: { ...empty.page, nextCursor: null, nextCommand: null } },
    "text",
  );
  assert.equal(end, "Нет записей\n\nПоказано: 0 из 0 подходящих записей\nКонец списка\n");
});

test("foundation: errors переводят известные details, сохраняют остальные и не ломают hint/JSON", () => {
  const command = "npx @oim-dev/relay-cli task update PRODUCT-1 --help";
  const details = {
    field: "title",
    path: ["data", "items", 0, "title"],
    expectedRevision: 0,
    actualRevision: 2,
    expected: false,
    actual: null,
    custom: { retained: false, attempts: 0, empty: "" },
    hint: `Синтаксис и примеры: ${command}`,
  };
  const error = new AppError("REVISION_CONFLICT", "Запись изменилась", 2, details);
  const text = helpRuntime("/unused");
  printError(text.io.stdout, error, { format: "text", text: { width: 100, color: true } });
  const output = text.output();
  for (const label of [
    "Поле",
    "Путь",
    "Ожидаемая ревизия",
    "Текущая ревизия",
    "Ожидалось",
    "Получено",
  ])
    assert.ok(output.includes(label), label);
  for (const value of [
    "data.items[0].title",
    "custom",
    "retained",
    "false",
    "attempts",
    "empty",
    "null",
  ])
    assert.ok(output.includes(value), value);
  assert.match(output, /Ожидаемая ревизия:\s+0/);
  assert.match(output, /Текущая ревизия:\s+2/);
  assert.equal(output.split("Следующий шаг:").length - 1, 1);
  const narrow = helpRuntime("/unused");
  printError(narrow.io.stdout, error, { format: "text", text: { width: 24, color: true } });
  assert.ok(narrow.output().split("\n").includes(command));
  assert.doesNotMatch(narrow.output(), /\x1b/);
  const json = helpRuntime("/unused");
  printError(json.io.stdout, error, { format: "json" });
  assert.deepEqual(JSON.parse(json.output()), {
    ok: false,
    error: { code: "REVISION_CONFLICT", message: "Запись изменилась", details },
  });
});

function diagnosticOutput(details: unknown, format: "text" | "json" = "text") {
  const capture = helpRuntime("/unused");
  printError(capture.io.stdout, new AppError("INVALID_ARGUMENT", "Неверный ввод", 2, details), {
    format,
    text: { width: 160, color: true },
  });
  return capture.output();
}

test("foundation: diagnostic own constructor/toString/hasOwnProperty и __proto__ не теряются и не падают", () => {
  const details = JSON.parse(
    '{"constructor":"constructor-value","toString":"toString-value","hasOwnProperty":"own-value","__proto__":{"relayDiagnosticMarker":"retained"}}',
  );
  const before = JSON.stringify(details);
  assert.ok(Object.hasOwn(details, "__proto__"));
  const text = diagnosticOutput(details);
  for (const [key, value] of [
    ["constructor", "constructor-value"],
    ["toString", "toString-value"],
    ["hasOwnProperty", "own-value"],
  ]) {
    assert.ok(text.includes(`"${key}": "${value}"`), `Утрачено собственное поле ${key}: ${text}`);
  }
  assert.ok(text.includes('"__proto__": {'));
  assert.ok(text.includes('"relayDiagnosticMarker": "retained"'));
  const response = JSON.parse(diagnosticOutput(details, "json"));
  assert.deepEqual(response, {
    ok: false,
    error: { code: "INVALID_ARGUMENT", message: "Неверный ввод", details },
  });
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"])
    assert.ok(Object.hasOwn(response.error.details, key), key);
  assert.equal(Object.getPrototypeOf(details), Object.prototype);
  assert.equal(Object.getPrototypeOf(response.error.details), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "relayDiagnosticMarker"), false);
  assert.equal(JSON.stringify(details), before);
});

test("foundation: error expected/actual различают null, массив, объект и пустую строку", () => {
  const cases: { value: unknown; literal: string }[] = [
    { value: null, literal: "null" },
    { value: [], literal: "[]" },
    { value: {}, literal: "{}" },
    { value: "", literal: '\"\"' },
  ];
  const rendered = new Set<string>();
  for (const [index, expected] of cases.entries()) {
    const actual = cases[(index + 1) % cases.length]!;
    const details = { expected: expected.value, actual: actual.value };
    const text = diagnosticOutput(details);
    const expectedLine = text.split("\n").find((line) => line.startsWith("Ожидалось:"));
    const actualLine = text.split("\n").find((line) => line.startsWith("Получено:"));
    assert.ok(expectedLine, text);
    assert.ok(actualLine, text);
    // Убираем только выравнивание label/value, не нормализуем само значение.
    assert.equal(expectedLine.slice("Ожидалось:".length).trimStart(), expected.literal);
    assert.equal(actualLine.slice("Получено:".length).trimStart(), actual.literal);
    rendered.add(expectedLine);
    assert.deepEqual(JSON.parse(diagnosticOutput(details, "json")).error.details, details);
    // Те же значения в details целиком тоже не должны превращаться в общую пустоту.
    assert.ok(diagnosticOutput(expected.value).split("\n").includes(expected.literal));
    assert.deepEqual(
      JSON.parse(diagnosticOutput(expected.value, "json")).error.details,
      expected.value,
    );
  }
  assert.equal(rendered.size, 4);
});

test("foundation: diagnostic nested arrays сохраняют типы, порядок и кратность пустых значений", () => {
  const values = [null, [], {}, "", [null, [], {}, ""]];
  const details = { expected: values, actual: { nested: values }, additional: [values, values] };
  const before = JSON.stringify(details);
  const literal = '[null, [], {}, "", [null, [], {}, ""]]';
  const text = diagnosticOutput(details);
  assert.ok(text.includes(`Ожидалось: ${literal}`), text);
  assert.ok(text.includes(`"nested": ${literal}`), text);
  assert.ok(text.includes(`"additional": [${literal}, ${literal}]`), text);
  assert.deepEqual(JSON.parse(diagnosticOutput(details, "json")), {
    ok: false,
    error: { code: "INVALID_ARGUMENT", message: "Неверный ввод", details },
  });
  assert.equal(JSON.stringify(details), before);
});

test("foundation: пустой hint не создаёт пустого шага и не подавляет единственный recovery", () => {
  const text = diagnosticOutput({ hint: "" });
  assert.equal(text.split("Следующий шаг:").length - 1, 1, text);
  const recovery = text.split("Следующий шаг:")[1]!;
  assert.ok(recovery.trim().length > 0);
  assert.match(recovery, /Проверьте/);
  assert.match(recovery, /--help/);
  assert.doesNotMatch(text, /Следующий шаг:\s*\n\s*\n/);
  assert.equal(text, diagnosticOutput({ hint: "", recovery: "", nextCommand: "" }));
  assert.deepEqual(JSON.parse(diagnosticOutput({ hint: "" }, "json")).error.details, { hint: "" });
});

test("foundation: явный config открывает общую базу из независимого worktree", async (t) => {
  const app = await fixture(t);
  const worktree = await tempDirectory(t);
  const id = await app.create("Общая задача");
  successful(
    await invoke(worktree, [
      "task",
      "update",
      id,
      "--title",
      "Из worktree",
      "--if-revision",
      1,
      "--config",
      join(app.root, ".relay/config.json"),
      "--actor",
      "worktree-agent",
    ]),
  );
  const task = successful(
    await app.run<{ title: string; updatedBy: string }>(["task", "get", id]),
  ).data;
  assert.equal(task.title, "Из worktree");
  assert.equal(task.updatedBy, "worktree-agent");
  await assert.rejects(access(join(worktree, ".relay")), { code: "ENOENT" });
});

test("foundation: пустой проект не требует старых каталогов tasks для чтения/первой записи", async (t) => {
  const app = await fixture(t);
  await assert.rejects(access(join(app.root, ".relay/tasks")), { code: "ENOENT" });
  assert.deepEqual(
    successful(await app.run<{ items: unknown[] }>(["task", "list"])).data.items,
    [],
  );
  const id = await app.create("Первая задача");
  assert.equal(successful(await app.run<{ id: string }>(["task", "get", id])).data.id, id);
  successful(await app.run(["doctor", "check"]));
  await assert.rejects(access(join(app.root, ".relay/tasks")), { code: "ENOENT" });
});

test("foundation: registerCommand передаёт аргументы, опции и реальный Backend в адаптер", async (t) => {
  const app = await fixture(t);
  const id = await app.create("Расширение");
  const { io, output } = helpRuntime(app.root);
  io.env = cliEnv();
  const program = new Command("test-cli").option("--format <format>");
  registerCommand<{ titleOnly?: boolean }>(program, io, {
    name: "inspect <ref>",
    description: "Тест адаптера",
    arguments: { ref: "Ключ задачи" },
    configure: (command) => command.option("--title-only", "Только заголовок"),
    async run(context, input) {
      assert.equal(input.argument(), id);
      assert.equal(input.optionalArgument(1), undefined);
      assert.equal(input.options.titleOnly, true);
      const task = await context.backend.boardTasks.get(input.argument());
      return { data: { title: task.title } };
    },
  });
  await program.parseAsync(["inspect", id, "--title-only", "--format", "json"], { from: "user" });
  assert.equal(output(), '{"ok":true,"data":{"title":"Расширение"}}\n');
});

test("foundation: CLI страницы обходятся без потерь; continuation копируется с config, snapshot не обновляется молча", async (t) => {
  const app = await fixture(t);
  const ids = [
    await app.create("Найти: первый"),
    await app.create("Найти: второй"),
    await app.create("Исключён"),
  ];
  const first = successful(
    await app.run<{ items: { id: string }[] }>(["task", "list", "--q", "Найти:", "--limit", 1]),
  );
  assert.equal(first.meta?.page?.count, 1);
  assert.equal(first.meta?.page?.total, 2);
  const cursor = first.meta?.page?.nextCursor;
  assert.ok(cursor);
  const nextCommand = first.meta?.page?.nextCommand;
  assert.ok(nextCommand);
  const argv = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `npx() { printf '%s\\0' "$@"; };\n${nextCommand}`],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.ifError(argv.error);
  assert.equal(argv.status, 0, argv.stderr);
  const args = argv.stdout.split("\0").slice(0, -1);
  assert.equal(args.shift(), "@oim-dev/relay-cli");
  assert.ok(args.includes(join(app.root, ".relay/config.json")));
  assert.ok(args.includes("--local"));
  const second = successful(await app.run<{ items: { id: string }[] }>(args));
  assert.equal(second.meta?.page?.nextCursor, null);
  assert.equal(second.meta?.page?.nextCommand, null);
  assert.deepEqual(
    [...first.data.items, ...second.data.items].map((item) => item.id).sort(),
    ids.slice(0, 2).sort(),
  );
  failed(await app.run(["board", "list", "--cursor", cursor]), "INVALID_CURSOR");
  failed(await app.run(["task", "list", "--cursor", "not-a-cursor"]), "INVALID_CURSOR");
  await app.create("Найти: изменение");
  const conflict = await app.run(["task", "list", "--cursor", cursor]);
  assert.notEqual(conflict.code, 0);
  assert.equal(conflict.stderr, "");
  assert.ok(!conflict.body.ok);
  assert.equal(conflict.body.error.code, "BOARD_CHANGED");
  assert.match(conflict.body.error.message, /без --cursor/);
});

test("foundation: cliEnv изолирует унаследованный цвет и сохраняет явные env, включая undefined", () => {
  const keys = ["FORCE_COLOR", "NO_COLOR"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const inherited of [
      { FORCE_COLOR: "3" },
      { NO_COLOR: "1" },
      { FORCE_COLOR: "3", NO_COLOR: "1" },
    ]) {
      for (const key of keys) {
        delete process.env[key];
        if (inherited[key] !== undefined) process.env[key] = inherited[key];
      }
      for (const overrides of [
        {},
        { FORCE_COLOR: "3" },
        { NO_COLOR: "1" },
        { FORCE_COLOR: "0", NO_COLOR: "" },
        { FORCE_COLOR: "3", NO_COLOR: undefined },
        { FORCE_COLOR: undefined, NO_COLOR: "1" },
        { FORCE_COLOR: undefined, NO_COLOR: undefined },
      ]) {
        const env = cliEnv(overrides);
        for (const key of keys) {
          assert.equal(env[key], overrides[key]);
          assert.equal(Object.hasOwn(env, key), Object.hasOwn(overrides, key));
          assert.equal(process.env[key], inherited[key]);
        }
      }
    }
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test("foundation: config не переключает text; JSON сохраняет Unicode/Markdown без raw ANSI", async (t) => {
  const app = await fixture(t);
  const configPath = join(app.root, ".relay/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.output = { ...config.output, format: "json", maxBytes: 1024 };
  await writeFile(configPath, JSON.stringify(config));
  const description =
    "## Цель 🔬\n\nПервая строка  \nПродолжение\n\n```ts\n  const x = 1;\n```\n\n\u001b[31mопасный цвет\u001b[0m";
  const id = await app.create("Карточка 界", ["--description", description]);
  for (const env of [
    { FORCE_COLOR: "3" },
    { NO_COLOR: "1" },
    { TERM: "xterm-256color", COLUMNS: "40" },
  ]) {
    const text = await invokeRaw(app.root, ["task", "get", id], { env });
    assert.equal(text.code, 0, text.stdout);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /Карточка 界/);
    assert.match(text.stdout, /## Цель 🔬/);
    assert.match(text.stdout, /  const x = 1;/);
    assert.doesNotMatch(text.stdout, /\x1b|^\{"ok":/);
  }
  const json = await app.run<{ description: string; createdBy: string }>(["task", "get", id], {
    env: { FORCE_COLOR: "3" },
  });
  assert.equal(successful(json).data.description, description);
  assert.equal(successful(json).data.createdBy, "test-agent");
  assert.doesNotMatch(json.stdout, /\x1b/);
  assert.deepEqual(Object.keys(json.body).sort(), ["data", "ok"]);
});

test("foundation: конфликты источников, повреждённый UTF-8 и отсутствующий файл не пишут данные", async (t) => {
  const app = await fixture(t);
  const id = await app.create("До ошибки", ["--description", "Сохранить"]);
  const before = successful(await app.run(["task", "get", id])).data;
  const invalid = join(app.root, "invalid.txt");
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  const cases: [string[], string, Buffer?][] = [
    [["--description", "inline", "--description-file", "-"], "CONFLICTING_OPTIONS"],
    [["--description-file", invalid], "INVALID_UTF8"],
    [["--description-file", "-"], "INVALID_UTF8", Buffer.from([0xc3, 0x28])],
    [["--description-file", join(app.root, "missing.txt")], "INPUT_READ_FAILED"],
  ];
  for (const [args, code, input] of cases) {
    failed(
      await app.run(
        ["task", "update", id, "--if-revision", 1, "--title", "Не записывать", ...args],
        input === undefined ? {} : { input },
      ),
      code,
    );
    assert.deepEqual(successful(await app.run(["task", "get", id])).data, before);
  }
  const features = successful(await app.run(["feature", "list"])).data;
  failed(
    await app.run(
      [
        "feature",
        "create",
        "--name",
        "Не создавать",
        "--summary-file",
        "-",
        "--description-file",
        "-",
      ],
      { input: "не писать" },
    ),
    "CONFLICTING_OPTIONS",
  );
  assert.deepEqual(successful(await app.run(["feature", "list"])).data, features);
  const markdown = "\uFEFF## Русский 界\n\n  отступ  \n\n";
  successful(
    await app.run(["task", "update", id, "--if-revision", 1, "--description-file", "-"], {
      input: Buffer.from(markdown),
    }),
  );
  const after = successful(
    await app.run<{ description: string; title: string }>(["task", "get", id]),
  ).data;
  assert.equal(after.description, markdown);
  assert.equal(after.title, "До ошибки");
});

test("foundation: большой text не обрезается старым output.maxBytes", async (t) => {
  const app = await fixture(t);
  const path = join(app.root, ".relay/config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.output.maxBytes = 1024;
  await writeFile(path, JSON.stringify(config));
  const description = Array.from({ length: 2400 }, (_, n) => `Строка-${n}: полный текст 🔬`).join(
    "\n",
  );
  const input = join(app.root, "large.md");
  await writeFile(input, description);
  const id = await app.create("Без бюджета", ["--description-file", input]);
  const text = await invokeRaw(app.root, ["task", "get", id]);
  assert.equal(text.code, 0, text.stdout);
  assert.equal(text.stderr, "");
  for (let n = 0; n < 2400; n++)
    assert.ok(text.stdout.includes(`Строка-${n}: полный текст 🔬`), `Потеряна строка ${n}`);
  assert.ok(Buffer.byteLength(text.stdout) > 65_536);
  assert.equal(
    successful(await app.run<{ description: string }>(["task", "get", id])).data.description,
    description,
  );
});

const pagination: PaginationContext = {
  identity: { project: "alpha", kind: "local", root: "/fixture" },
  defaultLimit: 20,
  invocation: [
    "npx",
    "@oim-dev/relay-cli",
    "--config",
    "/project with ' quote/config.json",
    "--local",
  ],
};

test("foundation: ширина TTY приоритетна, pipe ограничивает COLUMNS; цвет всегда выключен", () => {
  const stream = Object.assign(helpRuntime("/unused").io.stdout, { isTTY: true, columns: 80 });
  for (const env of [{ FORCE_COLOR: "3" }, { NO_COLOR: "1" }, { TERM: "dumb" }, { COLUMNS: "40" }])
    assert.deepEqual(terminalOptions(stream, env), { color: false, width: 80 });
  const pipe = helpRuntime("/unused").io.stdout;
  for (const [columns, width] of [
    ["1", 24],
    ["40", 40],
    ["1000", 160],
    ["-1", 100],
    ["NaN", 100],
    ["2.5", 100],
  ] as const)
    assert.deepEqual(terminalOptions(pipe, { COLUMNS: columns, FORCE_COLOR: "3" }), {
      color: false,
      width,
    });
});

test("foundation: cursor привязан к запросу/подключению и сохраняет исходную версию", () => {
  const command = ["task", "list"];
  const filters = { board: "product", query: "Русский ' текст" };
  const first = pageResultFor(
    pagination,
    command,
    filters,
    { offset: 0, limit: 2 },
    {
      items: [{ id: "a" }],
      total: 3,
      nextOffset: 1,
      version: "version-one",
    },
  );
  assert.ok(first.nextCursor);
  assert.match(first.nextCommand!, /^npx @oim-dev\/relay-cli /);
  assert.doesNotMatch(first.nextCommand!, /\n/);
  const restored = {};
  const query = offsetQueryFor(pagination, { cursor: first.nextCursor }, command, restored);
  assert.deepEqual(query, { offset: 1, limit: 2, version: "version-one" });
  assert.deepEqual(restored, filters);
  for (const cursor of ["", "!!!", "e30", "a".repeat(33_000)]) {
    assert.throws(() => offsetQueryFor(pagination, { cursor }, command, {}), {
      code: "INVALID_CURSOR",
    });
  }
  for (const [context, path, changed] of [
    [{ ...pagination, identity: { ...pagination.identity, project: "beta" } }, command, {}],
    [{ ...pagination, identity: { ...pagination.identity, kind: "http" } }, command, {}],
    [pagination, ["board", "list"], {}],
    [pagination, ["task", "get", "other-ref"], {}],
    [pagination, command, { board: "other" }],
  ] as const) {
    assert.throws(
      () => offsetQueryFor(context, { cursor: first.nextCursor! }, path, { ...changed }),
      { code: "INVALID_CURSOR" },
    );
  }
  assert.throws(
    () => offsetQueryFor(pagination, { cursor: first.nextCursor!, limit: 3 }, command, {}),
    { code: "INVALID_CURSOR" },
  );
  for (const version of [undefined, "version-two"]) {
    assert.throws(
      () =>
        pageResultFor(pagination, command, filters, query, {
          items: [],
          total: 3,
          nextOffset: null,
          ...(version === undefined ? {} : { version }),
        }),
      { code: "VERSION_CONFLICT" },
    );
  }
  for (const nextOffset of [0, 1, -1, 1.5, NaN]) {
    assert.throws(
      () =>
        pageResultFor(pagination, command, filters, query, {
          items: [],
          total: 3,
          nextOffset,
          version: "version-one",
        }),
      { code: "INVALID_PAGE_RESPONSE" },
    );
  }
  assert.throws(
    () =>
      pageResultFor(
        pagination,
        command,
        {},
        { offset: 0, limit: 2 },
        { items: [], total: 3, nextOffset: 2 },
      ),
    { code: "SNAPSHOT_REQUIRED" },
  );
  const end = pageResultFor(pagination, command, filters, query, {
    items: [],
    total: 3,
    nextOffset: null,
    version: "version-one",
  });
  assert.deepEqual(end, {
    count: 0,
    total: 3,
    limit: 2,
    consistency: "snapshot",
    nextCursor: null,
    nextCommand: null,
  });
});

test("foundation: native token не подменяется; пустая live страница продолжима, повтор token запрещён", () => {
  // Минимальный контекст границы адаптера; это не имитация предметной операции Backend.
  const context = {
    backend: { kind: "http" },
    connection: "http://127.0.0.1:4700",
    globals: { project: "alpha" },
    runtime: { cwd: "/fixture", env: {} },
    workspace: {
      root: "/fixture",
      configPath: "config.json",
      config: { projectId: "alpha", output: { defaultLimit: 20 } },
    },
  } as unknown as CommandContext;
  const command = ["task", "comment", "list", "PRODUCT-1"];
  const page = nativePageResult(
    context,
    command,
    { by: "test-agent" },
    { limit: 2 },
    { items: [], nextCursor: "opaque:backend/token==" },
  );
  assert.equal(page.count, 0);
  assert.equal(page.consistency, "live");
  assert.equal(page.total, undefined);
  assert.ok(page.nextCursor);
  assert.notEqual(page.nextCursor, "opaque:backend/token==");
  const filters = {};
  const query = nativeQuery(context, { cursor: page.nextCursor }, command, filters);
  assert.deepEqual(query, { limit: 2, cursor: "opaque:backend/token==" });
  assert.deepEqual(filters, { by: "test-agent" });
  assert.throws(
    () =>
      nativeQuery(
        context,
        { cursor: page.nextCursor! },
        ["task", "comment", "list", "PRODUCT-2"],
        {},
      ),
    { code: "INVALID_CURSOR" },
  );
  for (const nextCursor of ["", query.cursor!])
    assert.throws(
      () => nativePageResult(context, command, filters, query, { items: [], nextCursor }),
      { code: "INVALID_PAGE_RESPONSE" },
    );
  assert.equal(
    nativePageResult(context, command, filters, query, { items: [], nextCursor: null }).nextCursor,
    null,
  );
});

test("foundation: стабильный footer и JSON envelope; ширина не ломает копируемую команду", () => {
  const nextCommand = "npx @oim-dev/relay-cli task list --cursor token";
  const page = {
    count: 0,
    limit: 2,
    nextCursor: "token",
    nextCommand,
    consistency: "live" as const,
  };
  const result = { data: { items: [] }, text: "Нет записей", page };
  assert.equal(
    serializeResult(result, "text", { width: 100, color: true }),
    `Нет записей\n\nПоказано: 0 записей\nЖивая выборка: данные между страницами могут измениться.\nЕсть продолжение\n${nextCommand}\n`,
  );
  assert.ok(
    serializeResult(result, "text", { width: 24, color: true }).split("\n").includes(nextCommand),
  );
  assert.deepEqual(JSON.parse(serializeResult(result, "json")), {
    ok: true,
    data: { items: [] },
    meta: { page },
  });
});

test("foundation: PTY не включает ANSI при FORCE_COLOR", async (t) => {
  if (process.platform !== "linux") {
    t.skip("PTY smoke использует util-linux script");
    return;
  }
  const probe = spawnSync("script", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) {
    t.skip("util-linux script недоступен");
    return;
  }
  const root = await tempDirectory(t);
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, ...cliNodeArgs, binary, "task", "get", "--help"]
    .map(quote)
    .join(" ");
  const result = spawnSync("script", ["-qec", command, "/dev/null"], {
    cwd: root,
    env: cliEnv({ FORCE_COLOR: "3" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Примеры:/);
  assert.doesNotMatch(result.stdout, /\x1b/);
});

test("foundation: helper ограничивает subprocess и переживает EPIPE stdin", async (t) => {
  const root = await tempDirectory(t);
  await assert.rejects(
    invokeRaw(root, ["--help"], {
      nodeArgs: [
        "--import",
        "data:text/javascript,await new Promise(() => setInterval(() => {}, 1000))",
      ],
      timeoutMs: 100,
    }),
    /timeout 100/,
  );
  const result = await invokeRaw(root, ["--version"], { input: Buffer.alloc(2 * 1024 * 1024) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("foundation: helper дожидается SIGKILL при игнорировании SIGTERM, процесс не остаётся", async (t) => {
  if (process.platform === "win32") {
    t.skip("Проверка POSIX сигналов");
    return;
  }
  const root = await tempDirectory(t);
  const pidFile = join(root, "child.pid");
  const signalFile = join(root, "signal.txt");
  const preload = `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => writeFileSync(${JSON.stringify(signalFile)}, 'SIGTERM ignored'));
    await new Promise(() => setInterval(() => {}, 1000));`;
  await assert.rejects(
    invokeRaw(root, ["--version"], {
      nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`],
      timeoutMs: 2_000,
    }),
    /timeout 2000/,
  );
  assert.equal(await readFile(signalFile, "utf8"), "SIGTERM ignored");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("foundation: недоступный tmpdir использует .artifacts, cleanup удаляет только свой каталог", async (t) => {
  const root = await tempDirectory(t);
  const keys = ["TMPDIR", "TMP", "TEMP"];
  const saved = keys.map((key) => process.env[key]);
  let removed = "";
  let preserved = "";
  try {
    for (const key of keys) process.env[key] = join(root, "absent", "tmp");
    preserved = await tempDirectory(t);
    await writeFile(join(preserved, "keep.txt"), "Соседний fixture");
    await t.test("fallback fixture", async (child) => {
      removed = await tempDirectory(child);
      assert.notEqual(removed, preserved);
      assert.equal(
        dirname(removed),
        fileURLToPath(new URL("../../../.artifacts", import.meta.url)),
      );
      await writeFile(join(removed, "own.txt"), "Удаляется только с этим fixture");
    });
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
  await assert.rejects(access(removed), { code: "ENOENT" });
  assert.equal(await readFile(join(preserved, "keep.txt"), "utf8"), "Соседний fixture");
});

test("foundation: helper изолирует родительские config/server/cwd, не меняя process.env", async (t) => {
  const keys = ["RELAY_CONFIG", "RELAY_SERVER_URL", "INIT_CWD", "RELAY_ACTOR"];
  const original = keys.map((key) => process.env[key]);
  try {
    process.env.RELAY_CONFIG = "/несуществующий/рабочий-config.json";
    process.env.RELAY_SERVER_URL = "http://127.0.0.1:1";
    process.env.INIT_CWD = "/несуществующий/каталог";
    process.env.RELAY_ACTOR = "external-agent";
    const env = cliEnv();
    for (const key of keys.slice(0, 3)) assert.equal(env[key], undefined);
    assert.equal(env.RELAY_ACTOR, "test-agent");
    assert.equal(process.env.RELAY_ACTOR, "external-agent");
    assert.equal(
      cliEnv({ RELAY_ACTOR: "explicit", RELAY_CONFIG: "explicit.json" }).RELAY_CONFIG,
      "explicit.json",
    );
    const app = await fixture(t);
    const id = await app.create("Изолированный проект");
    assert.equal(
      successful(await app.run<{ createdBy: string }>(["task", "get", id])).data.createdBy,
      "test-agent",
    );
  } finally {
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  }
});

test("foundation: закрытый stdout pipe завершает CLI штатно", async (t) => {
  const app = await fixture(t);
  const file = join(app.root, "pipe.md");
  await writeFile(file, "Полный большой текст\n".repeat(5_000));
  const id = await app.create("Pipe", ["--description-file", file]);
  const child = spawn(process.execPath, [...cliNodeArgs, binary, "task", "get", id], {
    cwd: app.root,
    env: cliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.once("data", () => child.stdout.destroy());
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
});
