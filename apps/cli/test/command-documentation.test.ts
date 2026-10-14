import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkDocumentation,
  documentationFiles,
  filesBelow,
  inspectMarkdown,
  packageMarkdown,
} from "../scripts/lib/documentation.mjs";
import { commandTree } from "./helpers/help.js";
import { tempDirectory } from "./helpers/cli.js";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));

test("documentation: канонический справочник покрывает 136 регистраций, русские аргументы и параметры", async (t) => {
  const root = await tempDirectory(t);
  const markdown = await readFile(join(cliRoot, "docs/CLI.md"), "utf8");
  const headings = [...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  const tree = commandTree(root);
  const leaves = tree.filter(({ command }) => command.commands.length === 0);
  assert.equal(leaves.length, 136);
  for (const { command, path } of tree) {
    if (path.length) assert.match(command.description(), /[А-Яа-яЁё]/, path.join(" "));
    if (!command.commands.length)
      assert.equal(
        headings.filter((heading) => heading === path.join(" ")).length,
        1,
        `Раздел ${path.join(" ")}`,
      );
    for (const argument of command.registeredArguments)
      assert.match(argument.description, /[А-Яа-яЁё]/, `${path.join(" ")}: ${argument.name()}`);
    for (const option of command.options) {
      assert.match(option.description, /[А-Яа-яЁё]/, option.flags);
      if (option.long) assert.ok(markdown.includes(option.long), option.long);
    }
  }
  // Это проверка синтаксического каталога, не исполнение предметных команд.
  const bashBlocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(bashBlocks.length > 10);
  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
    input: bashBlocks.join("\n"),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("documentation: ссылки/якоря, discovery и архивный Markdown сохраняют проверяемые гарантии", async (t) => {
  const root = await tempDirectory(t);
  const put = async (path: string, content = "# Документ\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const expected = [
    "AGENTS.md",
    "README.md",
    "docs/guide.md",
    "docs/storage/README.md",
    "docs/data/README.md",
    "docs/build/guide.md",
    "docs/user-data/guide.md",
    "docs/tmp-example/guide.md",
    "apps/cli/README.md",
    "apps/cli/docs/CLI.md",
    "apps/cli/AGENTS.md",
    "packages/storage/README.md",
    "packages/storage/docs/storage/FORMAT.md",
    "packages/example/AGENTS.md",
    "packages/dev-agents/src/worker.md",
    "scripts/AGENTS.md",
    "scripts/release/README.md",
    "scripts/release/nested/AGENTS.md",
    "scripts/build/README.md",
    "scripts/tmp-example/README.md",
  ];
  for (const path of expected) await put(path);
  for (const path of [
    "docs/.artifacts/bad.md",
    "docs/node_modules/bad.md",
    "scripts/release/dist/bad.md",
    "apps/cli/src/bad.md",
    "apps/playground/data/bad.md",
    "packages/relay-skill/src/skill.md",
  ])
    await put(path, "[Ошибка](missing.md)");
  await symlink(join(root, "docs"), join(root, "scripts/linked"), "dir");
  assert.deepEqual(await documentationFiles(root), expected.sort());
  assert.deepEqual(await documentationFiles(root), expected);
  await checkDocumentation(root, expected);
  await put(
    "docs/guide.md",
    '# Руководство\n\n## Режим `--local`\n\n## Режим `--local`\n\n<a id="точный-якорь"></a>\n',
  );
  await put("docs/assets/board (dark).png", "image");
  await put(
    "README.md",
    "[Повтор](docs/guide.md#режим---local-1)\n[Якорь](docs/guide.md#точный-якорь)\n![Доска](<docs/assets/board (dark).png>)\n`[Код](missing.md)`\n```md\n[Код](missing.md)\n```",
  );
  assert.deepEqual(await checkDocumentation(root, ["README.md", "docs/guide.md"]), {
    documents: 2,
    links: 3,
  });
  for (const [link, error] of [
    ["docs/guide.md#missing", /Нет якоря/],
    ["missing.md", /missing.md/],
    ["../outside.md", /вне репозитория/],
  ] as const) {
    await put("README.md", `[Ошибка](${link})`);
    await assert.rejects(checkDocumentation(root, ["README.md"]), error);
  }
  await put("README.md");
  for (const path of [
    "scripts/release/nested/AGENTS.md",
    "packages/dev-agents/src/worker.md",
    "packages/storage/docs/storage/FORMAT.md",
  ]) {
    await put(path, "[Ошибка](missing.md)");
    await assert.rejects(
      checkDocumentation(root, await documentationFiles(root)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`${path}:1: missing.md`));
        return true;
      },
    );
    await put(path);
  }
  const files = new Map([
    ["README.md", "README.md"],
    ["docs/guide.md", "docs/guide.md"],
  ]);
  const markdown =
    '[Руководство](docs/guide.md#точный-якорь)\n![Доска](<docs/assets/board (dark).png> "Снимок")\n[Код](apps/cli/)\n[Внешний](https://example.com)\n```md\n[Пример](docs/guide.md)\n```';
  const packaged = await packageMarkdown({
    root,
    files,
    version: "1.2.3-rc.1",
    source: "README.md",
    markdown,
    absolute: true,
  });
  assert.deepEqual(
    inspectMarkdown(packaged).destinations.map((node: { url: string }) => node.url),
    [
      "https://github.com/oim-dev/relay/blob/v1.2.3-rc.1/docs/guide.md#точный-якорь",
      "https://raw.githubusercontent.com/oim-dev/relay/v1.2.3-rc.1/docs/assets/board%20(dark).png",
      "https://github.com/oim-dev/relay/tree/v1.2.3-rc.1/apps/cli/",
      "https://example.com",
    ],
  );
  assert.ok(packaged.includes('"Снимок"'));
  assert.ok(packaged.includes("```md\n[Пример](docs/guide.md)\n```"));
  const referenceImage = await packageMarkdown({
    root,
    files,
    version: "1.2.3-rc.1",
    source: "README.md",
    absolute: true,
    markdown:
      '[![Доска](<docs/assets/board (dark).png> "Снимок")](docs/guide.md "Текст ]( внутри title")\n![Ещё доска][board]\n\n[board]: <docs/assets/board (dark).png> "Снимок"\n',
  });
  const urls = inspectMarkdown(referenceImage).destinations.map(
    (node: { url: string }) => node.url,
  );
  assert.equal(
    urls.filter(
      (url: string) =>
        url ===
        "https://raw.githubusercontent.com/oim-dev/relay/v1.2.3-rc.1/docs/assets/board%20(dark).png",
    ).length,
    2,
  );
  assert.ok(referenceImage.includes('"Текст ]( внутри title"'));
  const local = await packageMarkdown({
    root,
    files,
    version: "1.2.3-rc.1",
    source: "docs/guide.md",
    markdown: "[Главная](../README.md)\n[Код](../apps/cli/)",
  });
  assert.deepEqual(
    inspectMarkdown(local).destinations.map((node: { url: string }) => node.url),
    ["../README.md", "https://github.com/oim-dev/relay/tree/v1.2.3-rc.1/apps/cli/"],
  );
  await rm(join(root, "AGENTS.md"));
  await assert.rejects(checkDocumentation(root, await documentationFiles(root)), /ENOENT/);
  await rm(join(root, "docs"), { recursive: true });
  await assert.rejects(documentationFiles(root), /ENOENT/);
});

test("documentation: установленный комплект skill сохраняет ссылки вне checkout (не runtime загрузка)", async (t) => {
  const root = await tempDirectory(t);
  const installed = join(root, ".agents/skills/relay");
  await cp(join(cliRoot, "../../skills/relay"), installed, { recursive: true });
  const paths = (await filesBelow(installed)).filter((path: string) => path.endsWith(".md"));
  for (const path of [
    "SKILL.md",
    "references/agent/ORCHESTRATOR.md",
    "references/agent/WORKER.md",
    "references/domain/TASKS.md",
    "references/interfaces/CLI.md",
    "references/interfaces/CLI-COMMANDS.md",
    "references/guides/CONTENT.md",
  ])
    assert.ok(paths.includes(path), path);
  await checkDocumentation(installed, paths);
  const skill = await readFile(join(installed, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: relay\ndescription: >-/);
  assert.match(skill, /## Как заполнять содержание сущностей/);
  assert.ok(!paths.some((path: string) => path.startsWith("scenarios/")));
  assert.ok(skill.split("\n").length <= 300);
});
