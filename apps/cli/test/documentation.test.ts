import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Command } from "commander";
import {
  checkDocumentation,
  inspectMarkdown,
  packageMarkdown,
  filesBelow,
  documentationFiles,
} from "../scripts/lib/documentation.mjs";
import { repoRoot } from "../scripts/lib/project.mjs";
import { createProgram } from "../src/program.js";
import { runtime } from "../src/context.js";

async function documentationFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tasks-docs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs/assets"), { recursive: true });
  await mkdir(join(root, "apps/cli"), { recursive: true });
  await mkdir(join(root, "packages"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "AGENTS.md"), "# Правила\n");
  await writeFile(join(root, "README.md"), "# Tasks\n");
  await writeFile(join(root, "docs/assets/board (dark).png"), "изображение");
  await writeFile(join(root, "apps/cli/CHANGELOG.md"), "# Изменения\n");
  await writeFile(
    join(root, "docs/guide.md"),
    '# Руководство\n\n## Режим `--local`\n\n## Режим `--local`\n\n<a id="точный-якорь"></a>\n',
  );
  const files = new Map([
    ["README.md", "README.md"],
    ["docs/guide.md", "docs/guide.md"],
    ["docs/assets/board (dark).png", "docs/assets/board (dark).png"],
    ["apps/cli/CHANGELOG.md", "CHANGELOG.md"],
  ]);
  return { root, files, version: "0.4.0-rc.1" };
}

test("документация проверяет якоря GitHub и файлы, исключая примеры кода", async (t) => {
  const app = await documentationFixture(t);
  const markdown = [
    "# Tasks",
    "[Повторный заголовок](docs/guide.md#режим---local-1)",
    "[Явный якорь](docs/guide.md#точный-якорь)",
    "![Доска](<docs/assets/board (dark).png>)",
    "[Исходники](apps/cli/)",
    "`[Пример](missing.md)`",
    "```md",
    "[Пример](missing.md)",
    "```",
  ].join("\n");
  await writeFile(join(app.root, "README.md"), markdown);
  assert.deepEqual(await checkDocumentation(app.root, ["README.md", "docs/guide.md"]), {
    documents: 2,
    links: 4,
  });
  await writeFile(join(app.root, "README.md"), "[Ошибка](docs/guide.md#несуществующий)");
  await assert.rejects(() => checkDocumentation(app.root, ["README.md"]), /Нет якоря/);
  await writeFile(join(app.root, "README.md"), "[Ошибка](missing.md)");
  await assert.rejects(() => checkDocumentation(app.root, ["README.md"]), /missing.md/);
  await writeFile(join(app.root, "README.md"), "[Ошибка](../outside.md)");
  await assert.rejects(() => checkDocumentation(app.root, ["README.md"]), /вне репозитория/);
});

test("обход документации включает полные профили нового пакета, отделяя виртуальные ссылки скилла", async (t) => {
  const app = await documentationFixture(t);
  await mkdir(join(app.root, "packages/dev-agents/src"), { recursive: true });
  await mkdir(join(app.root, "packages/relay-skill/src"), { recursive: true });
  await writeFile(join(app.root, "packages/dev-agents/README.md"), "# Агенты\n");
  await writeFile(join(app.root, "packages/relay-skill/README.md"), "# Скилл\n");
  const profile = "packages/dev-agents/src/worker.md";
  await writeFile(join(app.root, profile), "# Работник\n\n[Документ](../../../docs/guide.md)\n");
  await writeFile(
    join(app.root, "packages/relay-skill/src/skill.md"),
    "[Виртуальный документ](references/API.md)\n",
  );
  const files = await documentationFiles(app.root);
  assert(files.includes(profile));
  assert(files.includes("packages/dev-agents/README.md"));
  assert(files.includes("packages/relay-skill/README.md"));
  assert(!files.includes("packages/relay-skill/src/skill.md"));
  await checkDocumentation(app.root, files);
  await writeFile(join(app.root, profile), "[Ошибка](missing.md)\n");
  await assert.rejects(checkDocumentation(app.root, files), /missing.md/);
});

test("обход включает корневые инструкции и вложенные документы scripts, исключая артефакты и данные", async (t) => {
  const app = await documentationFixture(t);
  const expected = [
    "AGENTS.md",
    "README.md",
    "docs/guide.md",
    "apps/cli/CHANGELOG.md",
    "apps/cli/AGENTS.md",
    "apps/cli/docs/CLI.md",
    "packages/example/AGENTS.md",
    "packages/example/docs/nested/guide.md",
    "scripts/README.md",
    "scripts/AGENTS.md",
    "scripts/release/README.md",
    "scripts/release/nested/AGENTS.md",
    "scripts/release/nested/docs/guide.md",
  ].sort();
  for (const path of expected) {
    await mkdir(join(app.root, path, ".."), { recursive: true });
    await writeFile(join(app.root, path), "# Документ\n");
  }
  const excluded = ["node_modules", ".git", ".artifacts", "dist", "coverage", ".agents/skills"];
  for (const base of ["docs", "scripts/release", "apps/cli/docs", "packages/example/docs"])
    for (const directory of excluded) {
      const path = join(app.root, base, directory);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "AGENTS.md"), "[Ошибка](missing.md)\n");
    }
  for (const path of [
    "unrelated/docs",
    "apps/cli/src",
    "apps/playground/data",
    ".agents/skills/external",
  ]) {
    await mkdir(join(app.root, path), { recursive: true });
    await writeFile(join(app.root, path, "ignored.md"), "[Ошибка](missing.md)\n");
  }
  await symlink(join(app.root, "unrelated"), join(app.root, "scripts/linked"), "dir");
  const files = await documentationFiles(app.root);
  assert.deepEqual(files, expected);
  assert.deepEqual(await documentationFiles(app.root), files);
  await checkDocumentation(app.root, files);
  // Ошибка в новом источнике должна доходить до checker, а не исчезать при discovery.
  for (const path of ["AGENTS.md", "scripts/release/nested/docs/guide.md"]) {
    await writeFile(join(app.root, path), "[Ошибка](missing.md)\n");
    await assert.rejects(
      checkDocumentation(app.root, await documentationFiles(app.root)),
      /missing.md/,
    );
    await writeFile(join(app.root, path), "# Документ\n");
  }
  await rm(join(app.root, "AGENTS.md"));
  await assert.rejects(checkDocumentation(app.root, await documentationFiles(app.root)), /ENOENT/);
  await rm(join(app.root, "docs"), { recursive: true });
  await assert.rejects(documentationFiles(app.root), /ENOENT/);
});

test("тематические каталоги документации и имя пакета storage не скрывают ошибки ссылок", async (t) => {
  const app = await documentationFixture(t);
  const paths = [
    "docs/storage/README.md",
    "docs/data/README.md",
    "docs/build/guide.md",
    "docs/user-data/guide.md",
    "docs/tmp-example/guide.md",
    "packages/core/docs/storage/FORMAT.md",
    "packages/storage/README.md",
    "packages/storage/docs/storage/FORMAT.md",
    "scripts/build/README.md",
    "scripts/tmp-example/README.md",
  ];
  for (const path of paths) {
    await mkdir(join(app.root, path, ".."), { recursive: true });
    await writeFile(join(app.root, path), "# Документ\n");
  }
  const files = await documentationFiles(app.root);
  for (const path of paths) assert(files.includes(path), `Не обнаружен документ ${path}`);
  await checkDocumentation(app.root, files);
  for (const path of paths) {
    await writeFile(join(app.root, path), "[Ошибка](missing.md)\n");
    await assert.rejects(
      checkDocumentation(app.root, await documentationFiles(app.root)),
      (error) => {
        assert(error instanceof Error);
        assert(error.message.includes(`${path}:1: missing.md`));
        return true;
      },
    );
    await writeFile(join(app.root, path), "# Документ\n");
  }
});

test("README npm получает версионные ссылки и raw-изображения с сохранением Markdown", async (t) => {
  const app = await documentationFixture(t);
  const markdown = [
    "# Tasks",
    "[Руководство](docs/guide.md#режим---local)",
    '[![Доска](<docs/assets/board (dark).png> "Снимок")](docs/guide.md "Текст ]( внутри title")',
    "![Доска по ссылке][board]",
    "",
    '[board]: <docs/assets/board (dark).png> "Снимок"',
    "",
    "[Исходники](apps/cli/)",
    "[Локальный якорь](#tasks)",
    "[npm](https://www.npmjs.com/package/@oim-dev/relay-cli)",
    "[Генератор](https://github.com/gromlab-ru/rest-api-codegen)",
    "```md",
    "[Пример](docs/guide.md)",
    "```",
  ].join("\n");
  const result = await packageMarkdown({ ...app, source: "README.md", markdown, absolute: true });
  const urls = inspectMarkdown(result).destinations.map((node) => node.url);
  assert(
    urls.includes("https://github.com/oim-dev/relay/blob/v0.4.0-rc.1/docs/guide.md#режим---local"),
  );
  assert.equal(
    urls.filter(
      (url) =>
        url ===
        "https://raw.githubusercontent.com/oim-dev/relay/v0.4.0-rc.1/docs/assets/board%20(dark).png",
    ).length,
    2,
  );
  assert(urls.includes("https://github.com/oim-dev/relay/tree/v0.4.0-rc.1/apps/cli/"));
  assert(urls.includes("#tasks"));
  assert(urls.includes("https://www.npmjs.com/package/@oim-dev/relay-cli"));
  assert(urls.includes("https://github.com/gromlab-ru/rest-api-codegen"));
  assert(result.includes('"Текст ]( внутри title"'));
  assert(result.includes("```md\n[Пример](docs/guide.md)\n```"));
});

test("документы архива сохраняют локальные переходы и ссылаются на исходники по тегу", async (t) => {
  const app = await documentationFixture(t);
  const result = await packageMarkdown({
    ...app,
    source: "docs/guide.md",
    markdown: "[Главная](../README.md)\n[Изменения](../apps/cli/CHANGELOG.md)\n[Код](../apps/cli/)",
  });
  assert.deepEqual(
    inspectMarkdown(result).destinations.map((node) => node.url),
    [
      "../README.md",
      "../CHANGELOG.md",
      "https://github.com/oim-dev/relay/tree/v0.4.0-rc.1/apps/cli/",
    ],
  );
});

test("справочник включает все зарегистрированные команды и параметры CLI", async () => {
  const markdown = await readFile(join(repoRoot, "apps/cli/docs/CLI.md"), "utf8");
  const headings = new Set([...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1]));
  const program = createProgram(
    runtime(
      Readable.from([]),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    ),
  );
  const violations: string[] = [];
  const check = (command: Command, path: string[]) => {
    if (path.length && !/[А-Яа-яЁё]/.test(command.description()))
      violations.push(`Команда ${path.join(" ")}`);
    for (const argument of command.registeredArguments)
      if (!/[А-Яа-яЁё]/.test(argument.description))
        violations.push(`Аргумент ${path.join(" ")}.${argument.name()}`);
    if (path.length && command.commands.length === 0)
      assert(headings.has(path.join(" ")), `Нет раздела команды ${path.join(" ")}`);
    for (const option of command.options) {
      if (!/[А-Яа-яЁё]/.test(option.description))
        violations.push(`Параметр ${path.join(" ")}.${option.long}`);
      if (option.long) assert(markdown.includes(option.long), `Нет параметра ${option.long}`);
    }
    for (const child of command.commands) check(child, [...path, child.name()]);
  };
  check(program, []);
  assert.deepEqual(violations, [], "Нарушение протокола: отсутствуют русские описания");
});

test("скилл relay сохраняет все локальные ссылки после установки без монорепозитория", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasks-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, ".agents/skills/relay");
  await cp(join(repoRoot, "skills/relay"), installed, { recursive: true });
  const paths = (await filesBelow(installed)).filter((path) => path.endsWith(".md"));
  assert(paths.includes("SKILL.md"));
  assert(paths.includes("references/agent/ORCHESTRATOR.md"));
  assert(paths.includes("references/agent/WORKER.md"));
  assert(paths.includes("references/domain/TASKS.md"));
  assert(paths.includes("references/interfaces/CLI.md"));
  assert(paths.includes("references/interfaces/CLI-COMMANDS.md"));
  assert(paths.includes("scenarios/NEW_PROJECT.md"));
  await checkDocumentation(installed, paths);
  const markdown = await readFile(join(installed, "SKILL.md"), "utf8");
  assert.match(markdown, /^---\nname: relay\ndescription: >-/);
  assert(markdown.split("\n").length <= 300, "Основной файл скилла перестал быть компактным");
});
