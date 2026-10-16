import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { CommanderError } from "commander";
import { commandPath } from "../src/command.js";
import { formatHelpExample } from "../src/help-example.js";
import { createProgram } from "../src/program.js";
import { commandTree, helpRuntime, renderHelp } from "./helpers/help.js";
import { failed, invoke, invokeRaw, tempDirectory } from "./helpers/cli.js";

test("help: все 165 листов и группы работают без config и не создают базу", async (t) => {
  const root = await tempDirectory(t);
  const tree = commandTree(root);
  assert.equal(tree.filter(({ command }) => !command.commands.length).length, 165);
  const examples: string[] = [];
  for (const { command, path } of tree) {
    const result = await renderHelp(root, [...path, "--help"]);
    assert.equal(result.code, 0, path.join(" ") + result.stdout);
    assert.deepEqual(await renderHelp(root, [...path, "-h"]), result, path.join(" "));
    assert.match(result.stdout, /Примеры:/);
    assert.match(result.stdout, /[А-Яа-яЁё]/);
    assert.match(result.stdout, /npx @oim-dev\/relay-cli/);
    if (path.length === 0) {
      assert.equal(result.stdout.match(/--format json/g)?.length, 1);
      assert.match(result.stdout, /только читаемый текст по умолчанию/);
      assert.match(result.stdout, /исключительно для отладки CLI или передачи данных в скрипты/);
      assert.match(result.stdout, /Агенту запрещено переключаться на JSON при обычной работе/);
    } else {
      assert.doesNotMatch(result.stdout, /--format|машинный (ответ|срез)|JSON.*(ответ|DTO)/);
    }
    for (const option of command.options.filter((option) => option.mandatory)) {
      assert.match(command.createHelp().optionDescription(option), /\(обязательно\)/);
    }
    assert.match(result.stdout, /--actor/);
    assert.doesNotMatch(result.stdout, /\x1b|--color|--max-bytes|--offset|--snapshot-version/);
    if (command.commands.length) {
      assert.deepEqual(await renderHelp(root, path), result, path.join(" "));
    }
    const section = result.stdout.split("Примеры:").at(-1)!;
    // Убираем только пояснения help, не строки внутри quoted multiline значения.
    const script = section.replace(/^  [А-Яа-яЁё].*$/gm, "");
    assert.doesNotMatch(script, /--format/);
    examples.push(script);
    const calls = exampleArguments(script);
    let ownExample = false;
    for (const call of calls) {
      const program = createProgram(helpRuntime(root).io);
      const stop = new Error("Остановить пример до открытия проекта");
      let selected: string | undefined;
      program.hook("preAction", (_parent, action) => {
        selected = commandPath(action).replace("npx @oim-dev/relay-cli ", "");
        throw stop;
      });
      // Префикс проекта разбирает runCli; здесь проверяем грамматику Commander без действий.
      const args =
        call[0] && !call[0].startsWith("-") && !program.commands.some((c) => c.name() === call[0])
          ? ["--project", call[0], ...call.slice(1)]
          : call;
      try {
        await program.parseAsync(args, { from: "user" });
        assert.fail(`Пример не достиг команды: ${call.join(" ")}`);
      } catch (error) {
        if (error !== stop) {
          assert.ok(
            error instanceof CommanderError && error.code === "commander.helpDisplayed",
            `${path.join(" ")}: ${call.join(" ")}\n${String(error)}`,
          );
        }
      }
      if (selected === path.join(" ")) ownExample = true;
    }
    if (!command.commands.length)
      assert.ok(ownExample, `${path.join(" ")}: нужен пример действия, а не повторный --help`);
  }
  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
    input: examples.join("\n"),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.deepEqual(await readdir(root), []);
  const child = await invokeRaw(root, ["task", "get", "--help"], {
    subprocess: true,
    env: { FORCE_COLOR: "3" },
  });
  assert.equal(child.code, 0);
  assert.equal(child.stderr, "");
  assert.doesNotMatch(child.stdout, /\x1b/);
});

/** Bash разбирает только примеры; заглушка npx возвращает argv, не запускает пакет. */
function exampleArguments(script: string): string[][] {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `PATH=; npx() { printf '%s\\0' "$#" "$@"; };\n${script}`],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const tokens = result.stdout.split("\0");
  assert.equal(tokens.pop(), "");
  const calls: string[][] = [];
  while (tokens.length) {
    const count = Number(tokens.shift());
    assert.ok(Number.isInteger(count) && count > 0 && count <= tokens.length);
    const args = tokens.splice(0, count);
    assert.equal(args.shift(), "@oim-dev/relay-cli");
    calls.push(args);
  }
  assert.ok(calls.length);
  return calls;
}

test("help: навигация доступна по запросу без проекта и не путает предметные виды", async (t) => {
  const root = await tempDirectory(t);
  for (const [path, routes] of [
    [
      ["task", "get"],
      [
        "task criterion list",
        "task comment list",
        "task progress",
        "plan task memberships",
        "task delete-preview",
      ],
    ],
    [
      ["document", "get"],
      ["document links", "document section list", "document delete-preview"],
    ],
    [
      ["session", "get"],
      ["session intents", "session context", "session tree", "session history"],
    ],
    [
      ["checkpoint", "get"],
      ["session get", "session history", "nextStep"],
    ],
    [
      ["plan", "stage", "get"],
      ["plan stage task list", "plan progress"],
    ],
    [
      ["inspect", "graph", "context"],
      ["--depth 1 --direction outgoing", "ID отношения"],
    ],
  ] as const) {
    const result = await renderHelp(root, [...path, "--help"]);
    assert.equal(result.code, 0, result.stdout);
    for (const route of routes)
      assert.ok(result.stdout.includes(route), `${path.join(" ")}: ${route}`);
    if (path[0] === "document") assert.doesNotMatch(result.stdout, /Незаполненный паспорт/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("help: запись объясняет содержание своего вида и показывает развёрнутый Markdown", async (t) => {
  const root = await tempDirectory(t);
  for (const [kind, expected] of [
    ["feature", /правила, границы/],
    ["scenario", /альтернативы, ошибки/],
    ["implementation", /вкладу именно этого приложения/],
    ["task", /конкретная работа, границы/],
  ] as const) {
    for (const action of ["create", "update"]) {
      const result = await renderHelp(root, [kind, action, "--help"]);
      assert.equal(result.code, 0);
      const text = result.stdout.replace(/\s+/g, " ");
      assert.match(text, expected, `${kind} ${action}`);
      assert.match(text, /Markdown/);
      assert.match(text, /не краткая аннотация/);
      if (action === "create") {
        const example = result.stdout.split("Примеры:").at(-1)!;
        assert(
          (example.match(/## /g) ?? []).length >= 3,
          `${kind}: пример раскрывает несколько аспектов`,
        );
        assert.doesNotMatch(example, /Полное описание требований и результата/);
      }
    }
  }
  assert.deepEqual(await readdir(root), []);
});

test("help: multiline форматирование сохраняет Bash argv, не вызывая npx или CLI", () => {
  const prefix = "npx @oim-dev/relay-cli document create";
  const cases: [string, string[]][] = [
    [
      `${prefix} --name 'Имя с пробелом' --body '## Цель\n\n  код  \n--не-флаг' --actor agent`,
      [
        "@oim-dev/relay-cli",
        "document",
        "create",
        "--name",
        "Имя с пробелом",
        "--body",
        "## Цель\n\n  код  \n--не-флаг",
        "--actor",
        "agent",
      ],
    ],
    [
      `${prefix} --name 'O'\\''Brien' --body '' --if-revision -1 --description-file -`,
      [
        "@oim-dev/relay-cli",
        "document",
        "create",
        "--name",
        "O'Brien",
        "--body",
        "",
        "--if-revision",
        "-1",
        "--description-file",
        "-",
      ],
    ],
    [
      `${prefix} --name="a b" -- '--looks-like-an-option'`,
      ["@oim-dev/relay-cli", "document", "create", "--name=a b", "--", "--looks-like-an-option"],
    ],
  ];
  for (const [source, expected] of cases) {
    const formatted = formatHelpExample(source, "  ");
    assert.match(formatted, / \\\n    --/);
    // Выполняется только builtin printf в функции-заглушке, не настоящая команда.
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", `npx() { printf '%s\\0' "$@"; };\n${formatted}`],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\0").slice(0, -1), expected);
  }
  assert.equal(
    formatHelpExample("npx @oim-dev/relay-cli task --help"),
    "npx @oim-dev/relay-cli task --help",
  );
});

test("help: ошибки адресуют нужный уровень; удалённые флаги и история других сущностей не принимаются", async (t) => {
  const root = await tempDirectory(t);
  for (const args of [
    ["task", "get"],
    ["task", "create", "--color", "always"],
    ["task", "list", "--max-bytes", "100"],
  ]) {
    const response = await invoke(root, args);
    failed(response, "INVALID_ARGUMENT");
    assert.ok(!response.body.ok);
    assert.match(
      JSON.stringify(response.body.error.details),
      new RegExp(`npx @oim-dev/relay-cli ${args.slice(0, 2).join(" ")} --help`),
    );
    assert.doesNotMatch(response.stdout, /\x1b/);
  }
  const typo = await invoke(root, ["task", "creat"]);
  failed(typo, "INVALID_ARGUMENT");
  assert.match(typo.stdout, /create/);
  const text = await invokeRaw(root, ["task", "get"], { env: { FORCE_COLOR: "3", COLUMNS: "24" } });
  assert.equal(text.code, 2);
  assert.equal(text.stderr, "");
  assert.ok(
    text.stdout.split("\n").some((line) => line.includes("npx @oim-dev/relay-cli task get --help")),
  );
  assert.doesNotMatch(text.stdout, /\x1b/);
  for (const path of [
    ["history"],
    ["task", "history"],
    ["project", "history"],
    ["entities", "history", "PRODUCT-1"],
    ["graph", "history"],
    ["task", "history", "list", "PRODUCT-1"],
    ["task", "history", "get", "PRODUCT-1", "1"],
  ]) {
    failed(await invoke(root, path), "INVALID_ARGUMENT");
  }
});

test("help: overview объясняет compact/full/map, метрики, totals и версии", async (t) => {
  const root = await tempDirectory(t);
  const tree = commandTree(root);
  assert.ok(tree.some(({ path }) => path.join(" ") === "overview"));
  assert.ok(!tree.some(({ path }) => path.join(" ") === "product overview"));
  failed(await invoke(root, ["product", "overview"]), "INVALID_ARGUMENT");
  const result = await renderHelp(root, ["overview", "--help"]);
  assert.equal(result.code, 0, result.stdout);
  const text = result.stdout.replace(/\s+/g, " ");
  for (const expected of [
    /В workspace выберите --project <имя>/,
    /frontend overview/,
    /шести колонкам/,
    /блокеры с причинами/,
    /По умолчанию text — компактная сводка без повторных карточек/,
    /--view full возвращает прежнее полное представление с подборками/,
    /--view map явно выбирает самостоятельную серверную страницу карты без сводки/,
    /--limit и --cursor листают карту; итоги обзора от них не зависят/,
    /Подборки полного режима — до 5 элементов с точными totals/,
    /Компактная сводка text не является страницей списка/,
    /snapshotVersion/,
    /версия продуктового состава не заменяет snapshotVersion/,
    /Глобальный --version по-прежнему показывает версию CLI/,
    /не решает, какую задачу начинать или завершать/,
    /overview \\ --view map \\ --snapshot SNAPSHOT \\ --limit 20/,
    // Детализация показателей оператора.
    /--metric <metric>/,
    /--blocker <task>/,
    /--snapshot <snapshot>/,
    /--view <mode>/,
    /--snapshot <snapshotVersion> привязывает первое чтение метрики или карты к срезу обзора/,
    /Без --snapshot первая страница читает актуальное состояние/,
    /--view вместе с --metric не применяется/,
    /review-obligations-met, review-obligations-open, blocker-impact, blocker-affected, unplanned-work, board-work, open-plans-complete, ready-releases, plans-outside-releases/,
    /Для blocker-affected обязателен --blocker/,
    /не является внешней проверкой/,
    /работа вне открытых планов — сигнал, а не ошибка/,
    /total от размера страницы не зависит/,
    /достаточно передать только --cursor/,
    /VERSION_CONFLICT \(exit 4\)/,
    /перечитайте overview без --cursor и --snapshot/,
    /overview \\ --metric review-obligations-met/,
    /--metric blocker-affected \\ --blocker PRODUCT-1/,
  ])
    assert.match(text, expected);
  assert.doesNotMatch(result.stdout, /\x1b/);
  assert.deepEqual(await readdir(root), []);
});
