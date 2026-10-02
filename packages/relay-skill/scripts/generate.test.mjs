import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { createProgram } from "../../../apps/cli/src/program.ts";
import { runtime } from "../../../apps/cli/src/context.ts";
import { generateReference } from "./generate.mjs";

/** Собирает пути всех листовых команд из зарегистрированного дерева CLI. */
function cliLeafCommands() {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const program = createProgram(runtime(Readable.from([]), sink));
  const leaves = [];
  const visit = (command, parents) => {
    const path = [...parents, command.name()];
    if (command.commands.length === 0) leaves.push(path.join(" "));
    else for (const child of command.commands) visit(child, path);
  };
  for (const command of program.commands) visit(command, []);
  sink.destroy();
  return leaves;
}

test("каталог CLI воспроизводим и содержит каждую листовую команду дерева CLI", () => {
  const reference = generateReference("cli");
  assert.equal(generateReference("cli"), reference);
  const commands = [...reference.matchAll(/^## (.+)$/gm)]
    .map((match) => match[1])
    .filter((heading) => heading !== "Общие параметры");
  assert.deepEqual(commands, cliLeafCommands());
  assert.equal(new Set(commands).size, commands.length);
  for (const command of [
    "board list",
    "workspace project list",
    "search",
    "product create",
    "product update",
    "plan stage list",
    "plan stage task list",
    "inspect graph context",
    "document facets",
    "document materials",
    "document bulk move",
    "document bulk add-tags",
    "document bulk remove-tags",
    "document bulk status",
    "document bulk pin",
  ])
    assert(commands.includes(command), `Потеряна команда ${command}`);
  assert(!commands.some((command) => /^(boards|projects|entities)\b/.test(command)));
  assert(!commands.includes("product save"));
  assert.equal((reference.match(/\*\*Синтаксис:\*\*/g) ?? []).length, commands.length);
  assert.throws(() => generateReference("unknown"), /Неизвестный генератор/);
});
