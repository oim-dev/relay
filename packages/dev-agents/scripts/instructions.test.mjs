import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBundle, repoRoot } from "./lib.mjs";
import { readAgentMarkdown, readTomlString } from "./testing.mjs";

/** Конкретные inline-маршруты от корня, не шаблоны, команды или примеры блоков кода. */
function instructionRoutes(markdown) {
  const prose = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
  return new Set(
    [...prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)]
      .map((match) => match[1])
      .filter((path) => /^(?:[\w.-]+\/)*AGENTS\.md$/.test(path))
      .filter((path) => !path.split("/").some((part) => part === "." || part === ".."))
      // Установленные навыки не входят в checkout и не являются локальными правилами проекта.
      .filter((path) => !path.startsWith(".agents/skills/")),
  );
}

test("маршруты не включают glob, команды, установленные навыки и примеры кода", () => {
  const text = [
    "`AGENTS.md` и `apps/web/AGENTS.md`",
    "`apps/*/AGENTS.md` `cat AGENTS.md` `.agents/skills/example/AGENTS.md`",
    "```sh\n`missing/AGENTS.md`\n```",
  ].join("\n");
  assert.deepEqual([...instructionRoutes(text)], ["AGENTS.md", "apps/web/AGENTS.md"]);
});

test("конкретные inline-маршруты реальных ролей ведут к существующим инструкциям", async () => {
  const { agents } = await prepareBundle();
  const pending = new Set(["AGENTS.md"]);
  for (const agent of agents) {
    const routes = instructionRoutes(agent.body);
    assert(routes.has("AGENTS.md"), `${agent.name}: нет маршрута к корневому AGENTS.md`);
    assert.doesNotMatch(agent.body, /OLD_docs|docs\/reference/, agent.name);
    for (const path of routes) pending.add(path);
  }
  // Проверяем только достигнутые инструкции, без отдельного реестра владельцев.
  for (const path of pending) {
    assert((await stat(join(repoRoot, path))).isFile(), `Ожидается файл инструкций: ${path}`);
    const text = await readFile(join(repoRoot, path), "utf8");
    for (const next of instructionRoutes(text)) pending.add(next);
  }
});

test("полные нормализованные реальные профили одинаковы в трёх адаптерах", async () => {
  const { agents, output } = await prepareBundle();
  for (const agent of agents) {
    for (const directory of [".opencode", ".claude"]) {
      const path = `${directory}/agents/${agent.name}.md`;
      assert.equal(readAgentMarkdown(output.get(path)).body, agent.body, path);
    }
    const path =
      agent.kind === "orchestrator" ? ".codex/config.toml" : `.codex/agents/${agent.name}.toml`;
    assert.equal(readTomlString(output.get(path), "developer_instructions"), agent.body, path);
  }
});
