// @ts-nocheck — исторический генератор-документация; тесты и typecheck его не исполняют.
// Упаковка сгенерированной базы в переносимый снимок дерева `base.json.gz`.
// Каталоги базы содержат `.gitignore` со строкой `*` (runtime, transactions, .indexes) и пустые
// каталоги; в Git как обычные файлы они были бы потеряны. Снимок хранит все файлы побайтно.
// Использование: node pack-tree.mjs <root> <out.json.gz> <provenance-stats.json>
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const [root, out, statsPath] = process.argv.slice(2);
const entries = [];
const walk = (path) => {
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name);
    const rel = relative(root, full).split("\\").join("/");
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new Error(`symlink in fixture: ${rel}`);
    if (info.isDirectory()) {
      entries.push({ path: rel, type: "dir" });
      walk(full);
    } else {
      const bytes = readFileSync(full);
      const text = bytes.toString("utf8");
      const utf8 = Buffer.from(text, "utf8").equals(bytes);
      entries.push({
        path: rel,
        type: "file",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        encoding: utf8 ? "utf8" : "base64",
        content: utf8 ? text : bytes.toString("base64"),
      });
    }
  }
};
walk(root);
const tree = { format: "relay-fixture-tree", version: 1, entries };
const gz = gzipSync(Buffer.from(JSON.stringify(tree) + "\n", "utf8"), { level: 9 });
writeFileSync(out, gz);

// Сводка для provenance: состав коллекций, версии оболочек и данных, надгробия.
const collections = {};
for (const entry of entries) {
  const match = /^\.relay\/entities\/([^/]+)\/[^/]+\.json$/.exec(entry.path);
  if (!match || entry.type !== "file") continue;
  const record = JSON.parse(entry.content);
  const item = (collections[match[1]] ??= {
    records: 0,
    tombstones: 0,
    kinds: {},
    schemaVersions: {},
    dataVersions: {},
  });
  item.records++;
  if ("deleted" in record) item.tombstones++;
  item.kinds[record.kind] = (item.kinds[record.kind] ?? 0) + 1;
  item.schemaVersions[record.schemaVersion] = (item.schemaVersions[record.schemaVersion] ?? 0) + 1;
  if (record.dataVersion !== undefined)
    item.dataVersions[record.dataVersion] = (item.dataVersions[record.dataVersion] ?? 0) + 1;
}
const files = entries.filter((entry) => entry.type === "file");
const topLevel = {};
for (const file of files) {
  const top = file.path.split("/").slice(0, 2).join("/");
  topLevel[top] = (topLevel[top] ?? 0) + 1;
}
writeFileSync(
  statsPath,
  JSON.stringify(
    {
      bundle: { sha256: createHash("sha256").update(gz).digest("hex"), bytes: gz.length },
      files: files.length,
      directories: entries.length - files.length,
      emptyDirectories: entries
        .filter(
          (entry) =>
            entry.type === "dir" &&
            !entries.some((other) => other.path.startsWith(entry.path + "/")),
        )
        .map((entry) => entry.path),
      totalBytes: files.reduce(
        (sum, file) => sum + Buffer.byteLength(file.content, file.encoding),
        0,
      ),
      filesByTopLevel: topLevel,
      entityCollections: collections,
      manifest: files.find((file) => file.path === ".relay/storage.json")?.content
        ? JSON.parse(files.find((file) => file.path === ".relay/storage.json").content)
        : null,
    },
    null,
    2,
  ) + "\n",
);
console.log(out, gz.length);
