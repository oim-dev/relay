import assert from "node:assert/strict";
import { test } from "node:test";
import { generateReference } from "./generate.mjs";

test("каталог CLI воспроизводим и содержит все 165 команд, включая историю работы", () => {
  const reference = generateReference("cli");
  assert.equal(generateReference("cli"), reference);
  const commands = [...reference.matchAll(/^## (.+)$/gm)]
    .map((match) => match[1])
    .filter((heading) => heading !== "Общие параметры");
  assert.equal(commands.length, 165);
  assert.equal(new Set(commands).size, commands.length);
  assert.deepEqual(
    commands.filter((command) => /^(session|checkpoint) /.test(command)).sort(),
    [
      "session intents",
      "session list",
      "session get",
      "session tree",
      "session history",
      "session context",
      "session start",
      "session fork",
      "session attach",
      "session resume",
      "session takeover",
      "session pause",
      "session complete",
      "session cancel",
      "checkpoint get",
      "checkpoint open",
      "checkpoint save",
      "checkpoint complete",
      "checkpoint cancel",
    ].sort(),
    "Каталог должен сохранять все действия веток и checkpoints, не только общее число команд",
  );
  for (const command of [
    "board list",
    "workspace project list",
    "search",
    "product create",
    "product update",
    "plan stage list",
    "plan stage task list",
    "inspect graph context",
    "project rename",
    "board rename",
    "product state",
    "product context",
  ])
    assert(commands.includes(command), `Потеряна команда ${command}`);
  for (const entity of ["feature", "scenario", "application", "implementation", "document", "task"])
    for (const action of ["delete-preview", "delete"])
      assert(commands.includes(`${entity} ${action}`), `Потеряна команда ${entity} ${action}`);
  assert(!commands.some((command) => /^(boards|projects|entities)\b/.test(command)));
  assert(!commands.includes("product save"));
  assert.equal((reference.match(/\*\*Синтаксис:\*\*/g) ?? []).length, commands.length);
  assert.throws(() => generateReference("unknown"), /Неизвестный генератор/);
});
