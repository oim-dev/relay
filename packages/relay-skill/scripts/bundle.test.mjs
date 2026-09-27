import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkDocumentation } from "../../../apps/cli/scripts/lib/documentation.mjs";
import {
  bundleFiles,
  checkSkillSet,
  playgroundPath,
  prepareBundle,
  processBundle,
  repoRoot,
  sourceRoot,
} from "./lib.mjs";

const ENTRY =
  "---\nname: relay\ndescription: >-\n  Руководство по Relay.\n---\n\n# Relay\n\n[Работник](references/WORKER.md#поручение)\n";

/** Изолирует операции сборщика от рабочего пакета и пользовательских данных. */
async function fixture(t) {
  const artifacts = join(repoRoot, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "skill builder test "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, sourceRoot);
  await mkdir(join(source, "references"), { recursive: true });
  await mkdir(join(root, "docs"));
  await writeFile(join(source, "skill.md"), ENTRY);
  await writeFile(
    join(source, "references/WORKER.md"),
    "# Работник\n\n[Начало](../skill.md)\n\n## Поручение\n\n[Контракт](../../../../docs/API.md#поля)\n",
  );
  await writeFile(
    join(root, "docs/API.md"),
    "# API\n\n[Начало](README.md)\n\n## Поля\n\n```text\n[Пример](missing.md)\n```\n",
  );
  const manifest = {
    version: 1,
    name: "relay",
    files: { "skill.md": "SKILL.md", "references/WORKER.md": "references/WORKER.md" },
    documents: { "docs/API.md": "references/API.md" },
    aliases: { "docs/README.md": "SKILL.md" },
  };
  const saveManifest = () => writeFile(join(source, "bundle.json"), JSON.stringify(manifest));
  await saveManifest();
  return { root, source, manifest, saveManifest };
}

test("сборка переписывает ссылки и якоря, переносится отдельно и воспроизводится побайтно", async (t) => {
  const app = await fixture(t);
  const first = await prepareBundle(app.root, "relay");
  assert.deepEqual([...(await prepareBundle(app.root, "relay"))], [...first]);
  await processBundle({ root: app.root, name: "relay" });
  await processBundle({ root: app.root, name: "relay", check: true });
  assert.match(first.get("references/WORKER.md"), /\(API\.md#поля\)/);
  assert.match(first.get("references/API.md"), /\(\.\.\/SKILL\.md\)/);
  assert.match(first.get("references/API.md"), /\[Пример\]\(missing.md\)/);
  const installed = join(app.root, "installed/relay");
  await cp(join(app.root, "skills/relay"), installed, { recursive: true });
  await checkDocumentation(
    installed,
    (await bundleFiles(installed)).filter((path) => path.endsWith(".md")),
  );
  await checkSkillSet(app.root, ["relay"]);
});

test("check обнаруживает устаревшие источники, ручные правки и лишние файлы, не исправляя результат", async (t) => {
  const app = await fixture(t);
  await processBundle({ root: app.root, name: "relay" });
  const output = join(app.root, "skills/relay/SKILL.md");
  const initial = await readFile(output, "utf8");
  await writeFile(join(app.source, "skill.md"), `${ENTRY}\nНовый раздел.\n`);
  await assert.rejects(processBundle({ root: app.root, name: "relay", check: true }), /Устарел/);
  assert.equal(await readFile(output, "utf8"), initial);
  await processBundle({ root: app.root, name: "relay" });
  await writeFile(output, "Ручная правка");
  await assert.rejects(processBundle({ root: app.root, name: "relay", check: true }), /Устарел/);
  assert.equal(await readFile(output, "utf8"), "Ручная правка");
  await processBundle({ root: app.root, name: "relay" });
  await writeFile(join(app.root, "skills/relay/extra.md"), "Лишний файл");
  await assert.rejects(processBundle({ root: app.root, name: "relay", check: true }), /Состав/);
});

test("неизвестная ссылка или якорь останавливают публикацию, сохраняя предыдущий пакет", async (t) => {
  const app = await fixture(t);
  await processBundle({ root: app.root, name: "relay" });
  const output = join(app.root, "skills/relay/SKILL.md");
  const before = await readFile(output, "utf8");
  await writeFile(join(app.source, "skill.md"), `${ENTRY}\n[Нет файла](references/MISSING.md)\n`);
  await assert.rejects(processBundle({ root: app.root, name: "relay" }), /не включён/);
  assert.equal(await readFile(output, "utf8"), before);
  await writeFile(join(app.source, "skill.md"), ENTRY.replace("#поручение", "#нет-якоря"));
  await assert.rejects(processBundle({ root: app.root, name: "relay" }), /Нет якоря/);
  assert.equal(await readFile(output, "utf8"), before);
});

test("сборщик отклоняет выход за каталог, конфликты имён и лишний обнаруживаемый скилл", async (t) => {
  const app = await fixture(t);
  app.manifest.files["skill.md"] = "../SKILL.md";
  await app.saveManifest();
  await assert.rejects(prepareBundle(app.root, "relay"), /Недопустимый путь/);
  app.manifest.files["skill.md"] = "SKILL.md";
  app.manifest.documents["docs/API.md"] = "references/worker.md";
  await app.saveManifest();
  await assert.rejects(prepareBundle(app.root, "relay"), /Повтор пути/);
  app.manifest.documents["docs/API.md"] = "references/API.md";
  await app.saveManifest();
  await processBundle({ root: app.root, name: "relay" });
  await mkdir(join(app.root, "skills/relay-cli"));
  await writeFile(join(app.root, "skills/relay-cli/SKILL.md"), ENTRY);
  await assert.rejects(checkSkillSet(app.root, ["relay"]), /лишний/);
  await rm(join(app.root, "skills/relay-cli"), { recursive: true });
  // На файловой системе без учёта регистра простая запись сохранила бы имя skill.md.
  await rm(join(app.source, "skill.md"));
  await writeFile(join(app.source, "SKILL.md"), ENTRY);
  await assert.rejects(checkSkillSet(app.root, ["relay"]), /только в skills/);
});

test("чужие символьные ссылки не используются как вход и выход сборки", async (t) => {
  const app = await fixture(t);
  const outside = await mkdtemp(join(repoRoot, ".artifacts/skill-outside-test-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "external.md"), ENTRY);
  await rm(join(app.source, "skill.md"));
  await symlink(join(outside, "external.md"), join(app.source, "skill.md"));
  await assert.rejects(prepareBundle(app.root, "relay"), /вне репозитория/);
  await rm(join(app.source, "skill.md"));
  await writeFile(join(app.source, "skill.md"), ENTRY);
  await symlink(outside, join(app.root, "skills"), "dir");
  await assert.rejects(processBundle({ root: app.root, name: "relay" }), /символьной ссылкой/);
});

/** Учитывает и каталоги: staging с последующим удалением тоже меняет mtime родителя. */
async function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(join(root, path));
    result[path] = { mtime: info.mtimeMs, size: info.size };
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else result[path].content = (await readFile(join(root, path))).toString("base64");
  }
  return result;
}

test("check полностью read-only при успехе, drift источников и отсутствии результата", async (t) => {
  const app = await fixture(t);
  let before = await snapshot(app.root);
  await assert.rejects(processBundle({ root: app.root, check: true }), /Нет skills\/relay/);
  assert.deepEqual(await snapshot(app.root), before);
  await processBundle({ root: app.root });
  await rm(join(app.root, ".artifacts"), { recursive: true });
  before = await snapshot(app.root);
  await processBundle({ root: app.root, check: true });
  assert.deepEqual(await snapshot(app.root), before);
  await assert.rejects(lstat(join(app.root, ".artifacts")), { code: "ENOENT" });
  await writeFile(join(app.source, "skill.md"), `${ENTRY}\nНовая инструкция.\n`);
  before = await snapshot(app.root);
  await assert.rejects(processBundle({ root: app.root, check: true }), /Устарел/);
  assert.deepEqual(await snapshot(app.root), before);
});

test("build восстанавливает Playground при неизменном пакете, check замечает drift установленной копии", async (t) => {
  const app = await fixture(t);
  await processBundle({ root: app.root });
  const original = await readFile(join(app.root, "skills/relay/SKILL.md"), "utf8");
  const installed = join(app.root, playgroundPath);
  await writeFile(join(installed, "SKILL.md"), "Устаревшая копия\n");
  let before = await snapshot(app.root);
  await assert.rejects(processBundle({ root: app.root, check: true }), /Устарел apps\/playground/);
  assert.deepEqual(await snapshot(app.root), before);
  await writeFile(join(installed, "obsolete.md"), "Лишний файл\n");
  await processBundle({ root: app.root });
  assert.equal(await readFile(join(installed, "SKILL.md"), "utf8"), original);
  await assert.rejects(lstat(join(installed, "obsolete.md")), { code: "ENOENT" });
  await rm(installed, { recursive: true });
  before = await snapshot(app.root);
  await processBundle({ root: app.root, check: true });
  assert.deepEqual(await snapshot(app.root), before);
  await processBundle({ root: app.root });
  assert.equal(await readFile(join(installed, "SKILL.md"), "utf8"), original);
});

test("metadata v1 содержит новые пути и watch обнаруживает изменение метаданных пакета", async (t) => {
  const app = await fixture(t);
  const metadata = "packages/relay-skill/package.json";
  await writeFile(join(app.root, metadata), '{"private":true}\n');
  app.manifest.watch = [metadata];
  await app.saveManifest();
  await processBundle({ root: app.root });
  const info = JSON.parse(await readFile(join(app.root, "skills/relay/bundle-info.json"), "utf8"));
  assert.equal(info.version, 1);
  assert.equal(info.name, "relay");
  assert(info.inputs[`${sourceRoot}/bundle.json`]);
  assert(info.inputs[metadata]);
  assert(Object.keys(info.inputs).every((path) => !path.startsWith("src-skills/")));
  await writeFile(join(app.root, metadata), '{"private":true,"version":"0.0.0"}\n');
  await assert.rejects(processBundle({ root: app.root, check: true }), /bundle-info/);
});

test("пакет переносит диагностический скрипт побайтно и замыкает HTTPS-ссылки", async (t) => {
  const app = await fixture(t);
  await mkdir(join(app.source, "scripts"));
  const script = 'console.log("[это код](missing.md)");\n';
  await writeFile(join(app.source, "scripts/diagnose.mjs"), script);
  app.manifest.files["scripts/diagnose.mjs"] = "scripts/diagnose.mjs";
  app.manifest.externalRoots = ["packages/"];
  await app.saveManifest();
  await writeFile(
    join(app.source, "skill.md"),
    ENTRY +
      "\n[API](https://github.com/oim-dev/relay/blob/main/docs/API.md#поля)\n[Код](../../core/src/index.ts)\n[Скрипт](scripts/diagnose.mjs)\n",
  );
  const output = await prepareBundle(app.root, "relay");
  assert.equal(output.get("scripts/diagnose.mjs"), script);
  assert.match(output.get("SKILL.md"), /\(references\/API\.md#поля\)/);
  assert.match(
    output.get("SKILL.md"),
    /https:\/\/github.com\/oim-dev\/relay\/blob\/main\/packages\/core\/src\/index.ts/,
  );
  await processBundle({ root: app.root });
  await processBundle({ root: app.root, check: true });
});

test("полный пакет требует каждую справочную страницу в карте главного файла", async (t) => {
  const app = await fixture(t);
  await writeFile(join(app.root, "docs/CAPABILITIES.md"), "# Возможности\n");
  app.manifest.documents["docs/CAPABILITIES.md"] = "references/CAPABILITIES.md";
  await app.saveManifest();
  await assert.rejects(prepareBundle(app.root, "relay"), /отсутствует в карте/);
  await writeFile(
    join(app.source, "skill.md"),
    ENTRY +
      "\n[Работник](references/WORKER.md)\n[API](references/API.md)\n[Покрытие](references/CAPABILITIES.md)\n",
  );
  await prepareBundle(app.root, "relay");
  await mkdir(join(app.source, "scenarios"));
  await writeFile(
    join(app.source, "scenarios/NEW_PROJECT.md"),
    "# Новый проект\n\n[Справочник](../references/API.md)\n",
  );
  app.manifest.files["scenarios/NEW_PROJECT.md"] = "scenarios/NEW_PROJECT.md";
  await app.saveManifest();
  await assert.rejects(prepareBundle(app.root, "relay"), /отсутствует в карте/);
  const entry = await readFile(join(app.source, "skill.md"), "utf8");
  await writeFile(
    join(app.source, "skill.md"),
    entry + "\n[Новый проект](scenarios/NEW_PROJECT.md)\n",
  );
  await processBundle({ root: app.root });
  await processBundle({ root: app.root, check: true });
});
