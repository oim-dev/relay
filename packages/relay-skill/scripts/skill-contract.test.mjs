import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectMarkdown } from "../../../apps/cli/scripts/lib/documentation.mjs";
import { repoRoot } from "./lib.mjs";

test("поставка объясняет единый цикл до подключения и сохраняет адресные справочники", async () => {
  const skill = await readFile(join(repoRoot, "skills/relay/SKILL.md"), "utf8");
  const stages = [...skill.matchAll(/^### ([1-4])\. .+$/gm)];
  assert.deepEqual(
    stages.map((stage) => stage[1]),
    ["1", "2", "3", "4"],
  );
  assert(stages[3].index < skill.indexOf("scripts/diagnose.mjs"));
  assert.doesNotMatch(skill, /Обязательное обучение CLI при загрузке/);
  const links = new Set(inspectMarkdown(skill).destinations.map((node) => node.url));
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "packages/relay-skill/src/bundle.json"), "utf8"),
  );
  const referenceMap = skill.split("## Полная карта справочных материалов\n")[1];
  assert(referenceMap, "Потеряна полная карта справочных материалов");
  const referenceLinks = new Set(
    inspectMarkdown(referenceMap).destinations.map((node) => node.url),
  );
  for (const path of [
    ...Object.values(manifest.files),
    ...Object.values(manifest.documents),
    ...Object.keys(manifest.generated),
  ].filter((path) => path.startsWith("references/") && path.endsWith(".md"))) {
    assert(referenceLinks.has(path), `Материал отсутствует в полной карте: ${path}`);
  }
  for (const path of [
    "references/README.md",
    "references/CAPABILITIES.md",
    "references/domain/PRODUCT.md",
    "references/domain/TASKS.md",
    "references/domain/PLANNING.md",
    "references/domain/RELEASES.md",
    "references/interfaces/AGENT_GUIDE.md",
    "references/interfaces/CLI-COMMANDS.md",
  ]) {
    assert(links.has(path), `Потеряна карта справочника ${path}`);
    assert((await readFile(join(repoRoot, "skills/relay", path), "utf8")).trim());
  }
});
