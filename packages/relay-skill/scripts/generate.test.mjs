import assert from "node:assert/strict";
import { test } from "node:test";
import { generateReference } from "./generate.mjs";

test("каталог CLI воспроизводим и содержит все 130 команд нового дерева", () => {
  const reference = generateReference("cli");
  assert.equal(generateReference("cli"), reference);
  const commands = [...reference.matchAll(/^## (.+)$/gm)]
    .map((match) => match[1])
    .filter((heading) => heading !== "Общие параметры");
  assert.equal(commands.length, 130);
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
  ])
    assert(commands.includes(command), `Потеряна команда ${command}`);
  assert(!commands.some((command) => /^(boards|projects|entities)\b/.test(command)));
  assert(!commands.includes("product save"));
  assert.equal((reference.match(/\*\*Синтаксис:\*\*/g) ?? []).length, commands.length);
  assert.throws(() => generateReference("unknown"), /Неизвестный генератор/);
});
