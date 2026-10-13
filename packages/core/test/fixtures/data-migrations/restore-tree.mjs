// Развёртывание замороженной базы из `base.json.gz` во временный каталог теста.
// Формат: { format: "relay-fixture-tree", version: 1, entries: [{ path, type: "dir" }
//   | { path, type: "file", sha256, encoding: "utf8" | "base64", content }] };
// пути относительны корню проекта (каталог с `.relay/`), отсортированы, без symlink.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Восстанавливает дерево побайтно и проверяет sha256 каждого файла.
 * @param {string} bundlePath путь к `base.json.gz`
 * @param {string} destination пустой каталог проекта
 * @returns {Promise<number>} число восстановленных записей дерева
 */
export async function restoreFixtureTree(bundlePath, destination) {
  const tree = JSON.parse(gunzipSync(await readFile(bundlePath)).toString("utf8"));
  if (tree.format !== "relay-fixture-tree" || tree.version !== 1)
    throw new Error(`Неизвестный формат снимка фикстуры: ${bundlePath}`);
  for (const entry of tree.entries) {
    const path = normalize(entry.path);
    if (path.startsWith("..") || path.startsWith(sep))
      throw new Error(`Недопустимый путь: ${entry.path}`);
    const target = join(destination, path);
    if (entry.type === "dir") {
      await mkdir(target, { recursive: true });
      continue;
    }
    const bytes = Buffer.from(entry.content, entry.encoding);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Повреждён файл снимка: ${entry.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return tree.entries.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [bundle = "", destination = ""] = process.argv.slice(2);
  if (!bundle || !destination)
    throw new Error("Использование: restore-tree.mjs <base.json.gz> <каталог>");
  console.log(await restoreFixtureTree(bundle, destination));
}
