import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { packageComponent } from "../package.mjs";
import { runNpm } from "./npm.mjs";
import {
  assertInstalledContent,
  assertPackedContent,
  readPackageContent,
} from "./package-content.mjs";

const filesByComponent = {
  cli: ["dist", "README.md", "CHANGELOG.md", "docs"],
  server: ["dist", "README.md", "CHANGELOG.md"],
  mcp: ["dist", "README.md", "CHANGELOG.md"],
};
const cliDocuments = ["docs/CLI.md", "docs/EXTENDING.md", "docs/RELEASING.md", "docs/TERMINAL.md"];

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function putCliDocuments(app) {
  for (const path of cliDocuments) await put(app, path, `# Документ CLI: ${path}\n`);
  await put(app, "docs/вложенная папка/пример.md", "# Вложенный пример с пробелами\n");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relay package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "package.json", JSON.stringify({ private: true }));
  await mkdir(join(root, "packages"));
  // Корневая библиотека и не объявленные в files материалы не должны попасть в архивы.
  await put(root, "docs/private-guide.md", "Документ вне состава поставки.\n");
  const manifests = {};
  for (const [component, files] of Object.entries(filesByComponent)) {
    const binary = component === "cli" ? "dist/cli/main.js" : "dist/main.js";
    const manifest = {
      name: `@oim-dev/relay-${component}`,
      version: "0.6.1",
      type: "module",
      imports: { "#manifest": "./package.json" },
      bin: { [`relay-${component}`]: binary },
      files,
      engines: { node: ">=22" },
      repository: { type: "git", url: "git+https://github.com/oim-dev/relay.git" },
      publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
      scripts: { prepack: "node -e 'process.exit(1)'" },
      devDependencies: { "@relay/typescript-config": "workspace:*" },
    };
    manifests[component] = manifest;
    const app = join(root, "apps", component);
    await put(app, "package.json", JSON.stringify(manifest));
    await put(app, "README.md", `# Relay ${component}\n\nИнструкция установленного пакета.\n`);
    await put(app, "CHANGELOG.md", "# Изменения\n\n## 0.6.1\n\n- Проверяемая фикстура.\n");
    await put(app, "internal.md", "Этот файл не заявлен для публикации.\n");
    await put(
      app,
      binary,
      '#!/usr/bin/env node\nimport manifest from "#manifest" with { type: "json" };\nconsole.log(manifest.version);\n',
    );
    if (component === "cli") await putCliDocuments(app);
    if (component === "server") await put(app, "dist/web/index.html", "<html>Relay</html>\n");
  }
  // Реальные pack/install работают только с локальными архивами и собственным offline-кешем.
  const executeNpm = (args, cwd) =>
    runNpm([...args, "--offline", "--cache", join(root, "npm cache")], cwd);
  return { root, manifests, executeNpm };
}

test("files публичных приложений сохраняет согласованный состав документации", async () => {
  for (const [component, files] of Object.entries(filesByComponent)) {
    const manifest = JSON.parse(
      await readFile(new URL(`../../apps/${component}/package.json`, import.meta.url), "utf8"),
    );
    assert.deepEqual(
      manifest.files,
      files,
      `${component}: изменение files требует сверки поставки`,
    );
  }
});

test("упаковщик переносит files в реальные архивы и независимые offline-установки", async (t) => {
  const { root, manifests, executeNpm } = await fixture(t);
  for (const component of Object.keys(filesByComponent)) {
    await t.test(component, async () => {
      const manifest = manifests[component];
      const app = join(root, "apps", component);
      const expected = await readPackageContent(app, manifest);
      const binary = Object.values(manifest.bin)[0];
      const compiled = await readFile(join(app, binary));
      const { archive, archivePath } = await packageComponent(component, { root, executeNpm });
      const expectedPaths = ["package.json", ...Object.values(manifest.bin), ...expected.keys()];
      if (component === "server") expectedPaths.push("dist/web/index.html");
      assert.deepEqual(archive.files.map(({ path }) => path).sort(), expectedPaths.sort());
      assert.equal(archive.version, "0.6.1");
      assert.equal(archive.filename, `oim-dev-relay-${component}-0.6.1.tgz`);
      const repeated = await packageComponent(component, { root, executeNpm });
      assert.equal(
        repeated.archive.integrity,
        archive.integrity,
        "Повторная упаковка детерминирована",
      );
      assert.deepEqual(await readFile(join(app, binary)), compiled, "Скомпилированный JS сохранён");
      const installation = join(root, `installed ${component}`);
      await put(installation, "package.json", JSON.stringify({ private: true }));
      await executeNpm(
        [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--workspaces=false",
          archivePath,
        ],
        installation,
      );
      const installed = join(installation, "node_modules", ...manifest.name.split("/"));
      const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
      assert.equal(packed.name, manifest.name);
      assert.deepEqual(packed.files, manifest.files);
      assert.equal(packed.scripts, undefined);
      assert.equal(packed.devDependencies, undefined);
      await assertInstalledContent(installed, manifest, expected);
      const launched = await executeNpm(
        ["exec", "--", `relay-${component}`, "--version"],
        installation,
      );
      assert.equal(launched.stdout.trim(), "0.6.1");

      // Независимая сверка обнаруживает пропажу, правки и лишние вложенные документы.
      for (const path of expected.keys()) {
        await rm(join(installed, path));
        await assert.rejects(() => assertInstalledContent(installed, manifest, expected));
        await put(installed, path, expected.get(path));
      }
      await put(installed, "README.md", "Изменённый текст той же поставки.\n");
      await assert.rejects(
        () => assertInstalledContent(installed, manifest, expected),
        /содержимое README\.md отличается/,
      );
      await put(installed, "README.md", expected.get("README.md"));
      if (component === "cli") {
        await put(installed, "docs/extra.md", "Лишний документ.\n");
        await assert.rejects(
          () => assertInstalledContent(installed, manifest, expected),
          /состав установленной документации отличается/,
        );
      }
    });
  }
});

test("утрата любого обязательного файла в npm pack обнаруживается до выдачи архива", async (t) => {
  const { root, manifests } = await fixture(t);
  for (const [component, manifest] of Object.entries(manifests)) {
    const content = await readPackageContent(join(root, "apps", component), manifest);
    const files = [
      { path: "package.json", size: 1 },
      ...Object.values(manifest.bin).map((path) => ({ path, size: 1 })),
      ...[...content].map(([path, bytes]) => ({ path, size: bytes.length })),
    ];
    if (component === "server") files.push({ path: "dist/web/index.html", size: 1 });
    assertPackedContent({ files }, manifest, content);
    for (const missing of files) {
      assert.throws(
        () =>
          assertPackedContent(
            { files: files.filter((file) => file !== missing) },
            manifest,
            content,
          ),
        /в npm-архиве отсутствует/,
      );
    }
    assert.throws(
      () =>
        assertPackedContent(
          { files: files.map((file) => ({ ...file, size: 0 })) },
          manifest,
          content,
        ),
      /неверный размер/,
    );
  }
});

test("отсутствующая документация и неполный npm pack сохраняют прежний готовый архив", async (t) => {
  const { root, executeNpm } = await fixture(t);
  const app = join(root, "apps/cli");
  const artifacts = join(app, ".artifacts/npm");
  await put(artifacts, "previous.tgz", "Прежний проверенный архив.\n");
  const options = {
    root,
    executeNpm: async () =>
      assert.fail("При отсутствии исходной документации npm запускать нельзя"),
  };
  for (const path of ["README.md", "CHANGELOG.md", "docs"]) {
    const original = path === "docs" ? undefined : await readFile(join(app, path));
    await rm(join(app, path), { recursive: true });
    await assert.rejects(() => packageComponent("cli", options), /восстановите заявленный файл/);
    if (path === "docs") await putCliDocuments(app);
    else await put(app, path, original);
    assert.deepEqual(await readdir(artifacts), ["previous.tgz"]);
  }
  await assert.rejects(
    () =>
      packageComponent("cli", {
        root,
        executeNpm: async (args, cwd) => {
          const result = await executeNpm(args, cwd);
          const [archive] = JSON.parse(result.stdout);
          archive.files = archive.files.filter(({ path }) => path !== "CHANGELOG.md");
          return { ...result, stdout: JSON.stringify([archive]) };
        },
      }),
    /в npm-архиве отсутствует CHANGELOG\.md/,
  );
  assert.deepEqual(await readdir(artifacts), ["previous.tgz"]);
  assert.equal(
    await readFile(join(artifacts, "previous.tgz"), "utf8"),
    "Прежний проверенный архив.\n",
  );
  await assert.rejects(() => readdir(join(app, ".artifacts/package/.npm")), { code: "ENOENT" });
});

test("отказ финального rename сохраняет прежние байты после успешного pack", async (t) => {
  const { root, manifests, executeNpm } = await fixture(t);
  const app = join(root, "apps/cli");
  const { archivePath } = await packageComponent("cli", { root, executeNpm });
  const previous = await readFile(archivePath);
  const artifacts = dirname(archivePath);
  const olderName = "oim-dev-relay-cli-0.6.0.tgz";
  await put(artifacts, olderName, previous);
  await put(artifacts, "foreign.tgz", "Посторонний архив.\n");
  await put(app, "README.md", "# Обновлённое содержимое пакета\n");
  let validated = false;
  await assert.rejects(
    () =>
      packageComponent("cli", {
        root,
        executeNpm: async (args, cwd) => {
          const result = await executeNpm(args, cwd);
          const [archive] = JSON.parse(result.stdout);
          assertPackedContent(archive, manifests.cli, await readPackageContent(app, manifests.cli));
          const pending = join(args[args.indexOf("--pack-destination") + 1], archive.filename);
          assert.notDeepEqual(await readFile(pending), previous);
          validated = true;
          // Реальный npm pack завершён; исчезновение только временного файла вызывает ENOENT у rename.
          await rm(pending);
          return result;
        },
      }),
    { code: "ENOENT", syscall: "rename" },
  );
  assert(validated, "Отказ должен произойти после настоящего pack и проверки его состава");
  assert.deepEqual(await readFile(archivePath), previous);
  assert.deepEqual(await readFile(join(artifacts, olderName)), previous);
  assert.equal(await readFile(join(artifacts, "foreign.tgz"), "utf8"), "Посторонний архив.\n");
  await assert.rejects(() => readdir(join(app, ".artifacts/package/.npm")), { code: "ENOENT" });

  // Успешный повтор заменяет текущий архив, после чего убирает только прежние архивы компонента.
  await packageComponent("cli", { root, executeNpm });
  assert.notDeepEqual(await readFile(archivePath), previous);
  assert.deepEqual((await readdir(artifacts)).sort(), [
    "foreign.tgz",
    "oim-dev-relay-cli-0.6.1.tgz",
  ]);
});

test("удаление обязательной страницы CLI или docs из files останавливает упаковку", async (t) => {
  for (const missing of [...cliDocuments, "files:docs"]) {
    await t.test(missing, async (t) => {
      const { root, manifests, executeNpm } = await fixture(t);
      const app = join(root, "apps/cli");
      const original = manifests.cli;
      const content = await readPackageContent(app, original);
      let manifest = original;
      if (missing === "files:docs") {
        manifest = { ...original, files: original.files.filter((path) => path !== "docs") };
        await put(app, "package.json", JSON.stringify(manifest));
        for (const path of content.keys()) if (path.startsWith("docs/")) content.delete(path);
      } else {
        await rm(join(app, missing));
        content.delete(missing);
      }
      const artifacts = join(app, ".artifacts/npm");
      await put(artifacts, "previous.tgz", "Прежний проверенный архив.\n");
      let packs = 0;
      const message =
        missing === "files:docs"
          ? /добавьте docs в files/
          : /отсутствует обязательный документ docs\//;
      await assert.rejects(
        () =>
          packageComponent("cli", {
            root,
            executeNpm: (...args) => {
              packs++;
              return executeNpm(...args);
            },
          }),
        message,
      );
      assert.equal(packs, 0, "Неполные исходники должны отклоняться до npm pack");
      assert.equal(
        await readFile(join(artifacts, "previous.tgz"), "utf8"),
        "Прежний проверенный архив.\n",
      );
      // Одинаково неполные исходник и установленная копия тоже не считаются корректной поставкой.
      await assert.rejects(() => assertInstalledContent(app, manifest, content), message);
    });
  }
});

test("пустые документы, симлинки и пути вне явного files-контракта отклоняются", async (t) => {
  const { root, manifests } = await fixture(t);
  const app = join(root, "apps/cli");
  const manifest = manifests.cli;
  for (const required of ["dist", "README.md", "CHANGELOG.md", "docs"]) {
    await assert.rejects(
      () =>
        readPackageContent(app, {
          ...manifest,
          files: manifest.files.filter((path) => path !== required),
        }),
      /добавьте .* в files/,
    );
  }
  await put(app, "README.md", "");
  await assert.rejects(() => readPackageContent(app, manifest), /непустое содержимое/);
  await put(app, "README.md", "# Relay CLI\n");
  await rm(join(app, "docs"), { recursive: true });
  await mkdir(join(app, "docs"));
  await assert.rejects(() => readPackageContent(app, manifest), /каталог docs пуст/);
  await symlink(join(root, "docs/private-guide.md"), join(app, "docs/link.md"));
  await assert.rejects(() => readPackageContent(app, manifest), /не должна быть симлинком/);
  for (const path of ["../docs", "/docs", "docs/**", "node_modules", ".npmrc"]) {
    await assert.rejects(
      () => readPackageContent(app, { ...manifest, files: [...manifest.files, path] }),
      /files должен содержать конкретные пути/,
    );
  }
});
