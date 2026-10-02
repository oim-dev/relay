import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { formatHelpExample } from "../src/help-example.js";
import { commandTree, renderHelp } from "./helpers/help.js";
import { failed, invoke, invokeRaw, tempDirectory } from "./helpers/cli.js";

test("help: все 136 листьев и группы работают без config и не создают базу", async (t) => {
  const root = await tempDirectory(t);
  const tree = commandTree(root);
  assert.equal(tree.filter(({ command }) => !command.commands.length).length, 136);
  const examples: string[] = [];
  for (const { command, path } of tree) {
    const result = await renderHelp(root, [...path, "--help"]);
    assert.equal(result.code, 0, path.join(" ") + result.stdout);
    assert.match(result.stdout, /Примеры:/);
    assert.match(result.stdout, /npx @oim-dev\/relay-cli/);
    assert.match(result.stdout, /--format/);
    assert.match(result.stdout, /--actor/);
    assert.doesNotMatch(result.stdout, /\x1b|--color|--max-bytes/);
    assert.doesNotMatch(result.stdout, /\bhistory\b/);
    if (command.commands.length) {
      assert.deepEqual(await renderHelp(root, path), result, path.join(" "));
    }
    const section = result.stdout.split("Примеры:").at(-1)!;
    // Убираем только пояснения help, не строки внутри quoted multiline значения.
    examples.push(section.replace(/^  [А-Яа-яЁё].*$/gm, ""));
  }
  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
    input: examples.join("\n"),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.deepEqual(await readdir(root), []);
  const child = await invokeRaw(root, ["task", "get", "--help"], { env: { FORCE_COLOR: "3" } });
  assert.equal(child.code, 0);
  assert.equal(child.stderr, "");
  assert.doesNotMatch(child.stdout, /\x1b/);
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

test("help: ошибки адресуют нужный уровень; удалённые флаги и история не принимаются", async (t) => {
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

test("help: product overview объясняет срез, подборки, --limit и версии", async (t) => {
  const root = await tempDirectory(t);
  const result = await renderHelp(root, ["product", "overview", "--help"]);
  assert.equal(result.code, 0, result.stdout);
  const text = result.stdout.replace(/\s+/g, " ");
  for (const expected of [
    /шести колонкам/,
    /блокеры с причинами/,
    /не более 5/,
    /--limit и --cursor листают только карту/,
    /snapshotVersion/,
    /Поле version — версия продуктового состава/,
    /не решает, какую задачу начинать или завершать/,
    /product overview \\ --limit 20 \\ --format json/,
    // Детализация показателей оператора.
    /--metric <metric>/,
    /--blocker <task>/,
    /review-obligations-met, review-obligations-open, blocker-impact, blocker-affected, unplanned-work, board-work, open-plans-complete, ready-releases, plans-outside-releases/,
    /Для blocker-affected обязателен --blocker/,
    /не является внешней проверкой/,
    /работа вне открытых планов — сигнал, а не ошибка/,
    /total от размера страницы не зависит/,
    /достаточно передать только --cursor/,
    /VERSION_CONFLICT/,
    /product overview \\ --metric review-obligations-met/,
    /--metric blocker-affected \\ --blocker PRODUCT-1/,
  ])
    assert.match(text, expected);
  assert.doesNotMatch(result.stdout, /\x1b/);
  assert.deepEqual(await readdir(root), []);
});
