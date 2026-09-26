import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { Command } from "commander";
import { createProgram } from "../src/program.js";
import { registerCommand } from "../src/command.js";
import { runtime } from "../src/context.js";
import { failed, fixture, invokeRaw } from "./helpers/cli.js";

test("справка каждой команды содержит объяснение, примеры и общие параметры без конфига", async (t) => {
  const app = await fixture(t);
  await rm(join(app.root, ".relay/config.json"));
  const program = createProgram(
    runtime(
      Readable.from([]),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      app.root,
    ),
  );
  const paths: string[][] = [[]];
  const collect = (command: Command, path: string[]) => {
    for (const child of command.commands) {
      const next = [...path, child.name()];
      paths.push(next);
      collect(child, next);
    }
  };
  collect(program, []);
  for (const path of paths) {
    const result = await invokeRaw(app.root, [...path, "--help"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Примеры:/, path.join(" "));
    assert.match(result.stdout, /relay-cli /, path.join(" "));
    assert.match(result.stdout, /--actor/);
    assert.match(result.stdout, /--format/);
    assert.doesNotMatch(result.stdout, /Ключ (?:безопасного )?повтора|первоначальную квитанцию/i);
    if (result.stdout.includes("--request-id")) assert.match(result.stdout, /корреляции/);
  }
  for (const args of [[], ["task"], ["product"], ["entities"], ["config"], ["graph"]]) {
    const result = await invokeRaw(app.root, args);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Примеры:/);
  }
});

test("ошибка синтаксиса указывает справку именно той команды, где ошиблись", async (t) => {
  const app = await fixture(t);
  const result = await app.run(["task", "get"]);
  failed(result, "INVALID_ARGUMENT");
  assert.ok(!result.body.ok);
  assert.match(JSON.stringify(result.body.error.details), /relay-cli task get --help/);
  const unknown = await app.run(["task", "creat"]);
  failed(unknown, "INVALID_ARGUMENT");
  assert.match(unknown.stdout, /create/);
});

test("новая команда получает аргументы, типизированные опции, проект и вывод через общий адаптер", async (t) => {
  const app = await fixture(t);
  const id = await app.create("Расширение");
  let output = "";
  const io = runtime(
    Readable.from([]),
    new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    }),
    app.root,
  );
  const program = new Command("tasks-cli").option("--format <format>");
  registerCommand<{ titleOnly?: boolean }>(program, io, {
    name: "inspect <id>",
    description: "Дополнительная команда",
    details: "Читает задачу через общий контекст.",
    examples: [["tasks-cli inspect 1 --title-only", "Выбрать название"]],
    configure: (command) => command.option("--title-only", "Выбрать название"),
    async run(context, input) {
      const task = await context.backend.boardTasks.get(input.argument());
      return { data: input.options.titleOnly ? { title: task.title } : task };
    },
  });
  await program.parseAsync(["inspect", id, "--title-only", "--format", "json"], { from: "user" });
  assert.deepEqual(JSON.parse(output), { ok: true, data: { title: "Расширение" } });
});
