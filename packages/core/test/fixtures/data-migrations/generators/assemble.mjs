// @ts-nocheck — исторический генератор-документация; тесты и typecheck его не исполняют.
// Сборка каталогов фикстур из результатов генерации (документация происхождения).
// Использование: node assemble.mjs <work-dir> <fixtures-dir>
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [work, target] = process.argv.slice(2);
const here = new URL(".", import.meta.url).pathname;
const git = (...args) =>
  execFileSync("git", args, { cwd: join(work, "wt-4321233"), encoding: "utf8" }).trim();

const FIXTURES = [
  {
    name: "legacy-c1c353f",
    sha: "c1c353f",
    out: "out-c1c353f",
    profile: "legacy-early",
    layout: "legacy (до единого хранения)",
    physical: null,
  },
  {
    name: "legacy-5c7265b",
    sha: "5c7265b",
    out: "out-5c7265b",
    profile: "legacy",
    layout: "legacy (до единого хранения), последний коммит перед 90d7b26",
    physical: null,
  },
  {
    name: "physical1-90d7b26",
    sha: "90d7b26",
    out: "out-90d7b26",
    profile: "f1",
    layout: "единое хранение, operations/",
    physical: 1,
  },
  {
    name: "physical2-plan-v1-43d683b",
    sha: "43d683b",
    out: "out-43d683b",
    profile: "f2-stages",
    layout: "единое хранение, history/, отдельные plan-stage",
    physical: 2,
  },
  {
    name: "physical2-plan-v1-equal-rank-43d683b",
    sha: "43d683b",
    out: "out43eq",
    profile: "equal-rank",
    layout:
      "единое хранение, history/, отдельные plan-stage с равным rank (ручная правка + reindex той же версии)",
    physical: 2,
  },
  {
    name: "physical2-v0.6.1-ec4a2cc",
    sha: "ec4a2cc",
    out: "out-ec4a2cc",
    profile: "nested",
    layout: "единое хранение, history/, вложенные stages (work-plan/release dataVersion 2)",
    physical: 2,
  },
  {
    name: "physical3-3875aee",
    sha: "3875aee",
    out: "out-3875aee",
    profile: "nested",
    layout: "единое хранение, оболочка 2, квитанции/события внутри записей",
    physical: 3,
  },
  {
    name: "physical4-v0.7.0-52c4609",
    sha: "52c4609",
    out: "out-52c4609",
    profile: "nested",
    layout: "единое хранение, оболочка 3 (текущий физический формат)",
    physical: 4,
  },
];

const index = [];
for (const fixture of FIXTURES) {
  const dir = join(target, fixture.name);
  mkdirSync(dir, { recursive: true });
  const source = join(work, fixture.out);
  const stats = join(work, `${fixture.name}.stats.json`);
  execFileSync("node", [
    join(here, "pack-tree.mjs"),
    join(source, "relay-fixture"),
    join(dir, "base.json.gz"),
    stats,
  ]);
  copyFileSync(join(source, "oracle.json"), join(dir, "oracle.json"));
  copyFileSync(join(source, "oracle.steps.jsonl"), join(dir, "steps.jsonl"));
  const full = git("rev-parse", fixture.sha);
  const kindsPath = join(work, `out-${fixture.sha}`, "kinds.json");
  const provenance = {
    fixture: fixture.name,
    commit: full,
    commitShort: fixture.sha,
    commitDate: git("log", "-1", "--format=%aI", fixture.sha),
    commitSubject: git("log", "-1", "--format=%s", fixture.sha),
    exactTag: (() => {
      try {
        return git("describe", "--tags", "--exact-match", fixture.sha);
      } catch {
        return null;
      }
    })(),
    firstContainingTag: git("tag", "--contains", fixture.sha).split("\n")[0] || null,
    layout: fixture.layout,
    physicalFormat: fixture.physical,
    generator: {
      profile: fixture.profile,
      script:
        fixture.profile === "equal-rank"
          ? "generators/generate-equal-rank.mjs"
          : "generators/generate-unified.mjs",
      cli: "node --conditions=tasks-source apps/cli/scripts/dev.mjs --local --format json (исходники того же SHA, pnpm install --frozen-lockfile)",
      deletion:
        "generators/fixture-delete.mts — EntityDeletionService того же SHA (в CLI версии нет команды удаления)",
      node: process.version,
      actorDefault: "fixture-author",
    },
    entityKindsOfVersion: existsSync(kindsPath)
      ? JSON.parse(readFileSync(kindsPath, "utf8"))
      : null,
    tree: JSON.parse(readFileSync(stats, "utf8")),
  };
  writeFileSync(join(dir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  index.push({
    name: fixture.name,
    sha: fixture.sha,
    physical: fixture.physical,
    bytes: provenance.tree.bundle.bytes,
    files: provenance.tree.files,
  });
}
writeFileSync(join(work, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(index);
