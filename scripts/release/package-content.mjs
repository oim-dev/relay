import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const cliDocuments = ["docs/CLI.md", "docs/EXTENDING.md", "docs/RELEASING.md", "docs/TERMINAL.md"];

/** Читает только заявленную документацию приложения, до замены прежнего архива. */
export async function readPackageContent(directory, manifest) {
  const isCli = manifest.name === "@oim-dev/relay-cli";
  const declared = manifest.files;
  const supported = ["dist", "README.md", "CHANGELOG.md", "docs"];
  assert(
    Array.isArray(declared) && declared.every((path) => supported.includes(path)),
    `${manifest.name}: files должен содержать конкретные пути: ${supported.join(", ")}`,
  );
  for (const required of ["dist", "README.md", "CHANGELOG.md", ...(isCli ? ["docs"] : [])]) {
    assert(declared.includes(required), `${manifest.name}: добавьте ${required} в files`);
  }
  const content = new Map();
  async function visit(path, directoryExpected) {
    const absolute = join(directory, path);
    const stat = await lstat(absolute).catch((cause) => {
      throw new Error(`Не удалось прочитать ${absolute}; восстановите заявленный файл пакета.`, {
        cause,
      });
    });
    assert(!stat.isSymbolicLink(), `${absolute}: документация пакета не должна быть симлинком`);
    if (directoryExpected !== undefined) {
      assert(
        directoryExpected ? stat.isDirectory() : stat.isFile(),
        `${absolute}: ожидается ${directoryExpected ? "каталог" : "обычный файл"}`,
      );
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`);
    } else {
      assert(stat.isFile(), `${absolute}: ожидается обычный файл документации`);
      const bytes = await readFile(absolute);
      assert(bytes.length > 0, `${absolute}: восстановите непустое содержимое документации`);
      content.set(path, bytes);
    }
  }
  for (const path of [...new Set(declared)].filter((path) => path !== "dist").sort()) {
    const before = content.size;
    await visit(path, path === "docs");
    assert(content.size > before, `${manifest.name}: заявленный каталог ${path} пуст`);
  }
  for (const path of isCli ? cliDocuments : []) {
    assert(
      content.has(path),
      `${manifest.name}: отсутствует обязательный документ ${path}; восстановите его перед упаковкой`,
    );
  }
  return content;
}

/** Переносит снимок документации в staging без подключения корневой библиотеки docs. */
export async function copyPackageContent(directory, content) {
  for (const [path, bytes] of content) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

/** Проверяет реальный список файлов npm pack до замены доступного для публикации архива. */
export function assertPackedContent(archive, manifest, content) {
  assert(Array.isArray(archive.files), "npm pack не вернул список файлов архива");
  const files = new Map(archive.files.map((file) => [file.path, file]));
  const required = ["package.json", ...Object.values(manifest.bin), ...content.keys()];
  if (manifest.name === "@oim-dev/relay-cli") required.push(...cliDocuments);
  if (manifest.name === "@oim-dev/relay-server") required.push("dist/web/index.html");
  for (const path of required) {
    assert(
      files.has(path),
      `${manifest.name}: в npm-архиве отсутствует ${path}; исправьте упаковку и повторите package:check`,
    );
  }
  for (const [path, bytes] of content) {
    assert.equal(files.get(path).size, bytes.length, `${manifest.name}: неверный размер ${path}`);
  }
}

/** Сверяет документацию независимой установки с исходным снимком, включая вложенные файлы. */
export async function assertInstalledContent(directory, manifest, expected) {
  const actual = await readPackageContent(directory, manifest);
  assert.deepEqual(
    [...actual.keys()],
    [...expected.keys()],
    `${manifest.name}: состав установленной документации отличается; повторите package:check`,
  );
  for (const [path, bytes] of expected) {
    assert(
      actual.get(path).equals(bytes),
      `${manifest.name}: содержимое ${path} отличается от исходника; повторите package:check`,
    );
  }
}
