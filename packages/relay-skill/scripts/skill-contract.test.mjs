import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectMarkdown } from "../../../apps/cli/scripts/lib/documentation.mjs";
import { repoRoot } from "./lib.mjs";

test("поставка требует только AGENT_GUIDE до диагностики, остальные руководства адресные", async () => {
  const skill = await readFile(join(repoRoot, "skills/relay/SKILL.md"), "utf8");
  const training = /^## Обязательное обучение CLI при загрузке\n([\s\S]*?)(?=\n## )/m.exec(skill);
  assert(training, "Потерян раздел обязательного обучения");
  assert.match(training[1], /до диагностики[\s\S]*полностью прочитай только/);
  const required = /полностью прочитай только\s*\n?\[([^\]]+)\]\(([^)]+)\)/.exec(training[1]);
  assert(required, "Обязательное чтение должно явно выделять единственный справочник");
  assert.equal(required[2], "references/interfaces/AGENT_GUIDE.md");
  assert.match(training[1], /Не загружай заранее CLI\.md, CLI-COMMANDS\.md,/);
  assert.match(training[1], /открывай нужный раздел по текущей задаче/);
  assert(skill.indexOf(training[0]) < skill.indexOf("scripts/diagnose.mjs"));
  const links = new Set(inspectMarkdown(skill).destinations.map((node) => node.url));
  for (const name of ["AGENT_GUIDE", "COMMAND_STYLE", "CLI", "CLI-COMMANDS", "TERMINAL"]) {
    const path = `references/interfaces/${name}.md`;
    assert(links.has(path), `Потеряна карта справочника ${path}`);
    assert((await readFile(join(repoRoot, "skills/relay", path), "utf8")).trim());
  }
});
