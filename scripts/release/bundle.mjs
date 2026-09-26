import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifests, workspaceRelease } from "./workspace.mjs";
import { releaseMetadata } from "./metadata.mjs";

export const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** Проверяет метаданные внутри архива без распаковки файлов на диск. */
export function inspectArchive(path, metadata) {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", path, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(manifest.name, metadata.name);
  assert.equal(manifest.version, metadata.version);
  releaseMetadata(manifest, `v${metadata.version}`);
  assert.equal(manifest.repository?.url, "git+https://github.com/oim-dev/relay.git");
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org");
  assert.equal(manifest.publishConfig?.access, "public");
  assert(!manifest.private && !manifest.scripts && !manifest.devDependencies);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(!name.startsWith("@relay/") && !/^(workspace:|file:|link:)/.test(version));
  }
}

/** Ведомость связана с checkout, а не с текущим именем ветки. */
export async function bundleContext(root) {
  const release = workspaceRelease(await readManifests(root), process.env.RELEASE_TAG || undefined);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { release, commit };
}

/** Подготавливает отдельный каталог только из трёх проверенных архивов. */
export async function createBundle(root, directory, context) {
  const { release, commit } = context;
  await mkdir(directory, { recursive: true });
  assert.equal((await readdir(directory)).length, 0, "Каталог комплекта должен быть пустым");
  const packages = [];
  for (const metadata of release.packages) {
    const source = join(root, "apps", metadata.component, ".artifacts/npm", metadata.archiveName);
    inspectArchive(source, metadata);
    const hash = integrity(await readFile(source));
    await copyFile(source, join(directory, metadata.archiveName));
    packages.push({
      name: metadata.name,
      version: metadata.version,
      file: metadata.archiveName,
      integrity: hash,
    });
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ schema: 1, commit, tag: release.tag, packages }, null, 2) + "\n",
  );
}

/** Проверяет весь комплект до восстановления путей, используемых smoke и publisher. */
export async function verifyBundle(root, directory, { release, commit }, restore = false) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.commit, commit, "Комплект собран из другого коммита");
  assert.equal(manifest.tag, release.tag, "Комплект другого выпуска");
  assert.equal(manifest.packages?.length, 3);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["manifest.json", ...release.packages.map((p) => p.archiveName)].sort(),
  );
  for (const [index, metadata] of release.packages.entries()) {
    const record = manifest.packages[index];
    assert.equal(record.name, metadata.name);
    assert.equal(record.version, metadata.version);
    assert.equal(record.file, metadata.archiveName);
    const path = join(directory, metadata.archiveName);
    assert.equal(
      integrity(await readFile(path)),
      record.integrity,
      "Байты архива не совпадают с ведомостью",
    );
    inspectArchive(path, metadata);
  }
  if (restore)
    for (const metadata of release.packages) {
      const destination = join(root, "apps", metadata.component, ".artifacts/npm");
      await mkdir(destination, { recursive: true });
      await copyFile(
        join(directory, metadata.archiveName),
        join(destination, metadata.archiveName),
      );
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory, ...extra] = process.argv.slice(2);
  assert(
    ["create", "verify", "restore"].includes(action) && directory && !extra.length,
    "Укажите create|verify|restore и каталог комплекта",
  );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const context = await bundleContext(root);
  if (action === "create") await createBundle(root, directory, context);
  else await verifyBundle(root, directory, context, action === "restore");
  console.log(`Комплект ${context.release.tag}: ${action} завершён`);
}
