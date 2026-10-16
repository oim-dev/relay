import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectMarkdown } from "../../../apps/cli/scripts/lib/documentation.mjs";
import { bundleFiles, repoRoot, sourceRoot } from "./lib.mjs";

const references = [
  "APPLICATIONS.md",
  "FEATURES.md",
  "HISTORY.md",
  "KNOWLEDGE.md",
  "PLANNING.md",
  "RELEASES.md",
  "TASKS.md",
].map((name) => `references/${name}`);

test("поставка содержит только основной скилл, семь методик и метаданные", async () => {
  const files = ["SKILL.md", "bundle-info.json", ...references].sort();
  assert.deepEqual(await bundleFiles(join(repoRoot, "skills/relay")), files);
  assert.deepEqual(
    await bundleFiles(join(repoRoot, sourceRoot)),
    ["skill.md", "bundle.json", ...references].sort(),
    "В исходниках остались лишние или экспериментальные материалы",
  );
  const manifest = JSON.parse(await readFile(join(repoRoot, sourceRoot, "bundle.json"), "utf8"));
  assert.deepEqual(
    Object.values(manifest.files).sort(),
    files.filter((file) => file !== "bundle-info.json"),
  );
  assert.equal(manifest.documents, undefined);
  assert.equal(manifest.generated, undefined);
});

test("пять этапов ведут к методикам, полная карта находится в самом конце", async () => {
  const skill = await readFile(join(repoRoot, "skills/relay/SKILL.md"), "utf8");
  assert.deepEqual(
    [...skill.matchAll(/^### ([1-5])\. .+$/gm)].map((stage) => stage[1]),
    ["1", "2", "3", "4", "5"],
  );
  const headings = [...skill.matchAll(/^## .+$/gm)];
  assert.equal(headings.at(-1)?.[0], "## Карта референсов");
  const map = skill.slice(headings.at(-1).index);
  assert.doesNotMatch(map.slice(map.indexOf("\n") + 1), /^#{1,6} /m);
  const links = inspectMarkdown(map).destinations.map((node) => node.url);
  assert.deepEqual(links.sort(), [...references].sort());
  for (const ref of references) {
    const content = await readFile(join(repoRoot, "skills/relay", ref), "utf8");
    assert(content.trim());
    assert(inspectMarkdown(content).destinations.some((node) => node.url === "../SKILL.md"));
  }
  assert.doesNotMatch(skill, /references-2\/|skill-2\.md|CLI-COMMANDS|diagnose\.mjs/);
});
