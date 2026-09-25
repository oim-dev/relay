import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseMetadata, versionMetadata } from "./metadata.mjs";

export const components = ["cli", "server", "mcp"];

/** Читает корень и все пакеты из apps/* и packages/*, как в pnpm-workspace.yaml. */
export async function readManifests(root) {
  const paths = ["package.json"];
  for (const directory of ["apps", "packages"]) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) paths.push(`${directory}/${entry.name}/package.json`);
    }
  }
  const manifests = [];
  for (const path of paths) {
    let text;
    try {
      text = await readFile(join(root, path), "utf8");
    } catch (error) {
      if (path !== "package.json" && error.code === "ENOENT") continue;
      throw error;
    }
    manifests.push({ path, manifest: JSON.parse(text) });
  }
  return manifests;
}

/** Проверяет весь состав выпуска до сборки и обращения на запись к npm. */
export function workspaceRelease(manifests, explicitTag) {
  const root = manifests.find(({ path }) => path === "package.json");
  assert(root?.manifest.private === true, "Корневой пакет должен быть приватным");
  const publicPaths = components.map((component) => `apps/${component}/package.json`);
  for (const { path, manifest } of manifests) {
    assert(
      manifest.private === true || publicPaths.includes(path),
      `${path}: публичный пакет не включён в общий выпуск`,
    );
  }
  const cli = manifests.find(({ path }) => path === publicPaths[0]);
  assert(cli, `В выпуске отсутствует ${publicPaths[0]}`);
  const metadata = versionMetadata(cli.manifest.version);
  const tag = explicitTag ?? `v${metadata.version}`;
  const packages = components.map((component) => {
    const path = `apps/${component}/package.json`;
    const entry = manifests.find((candidate) => candidate.path === path);
    assert(entry, `В выпуске отсутствует ${path}`);
    assert.equal(entry.manifest.name, `@oim-dev/relay-${component}`);
    assert.equal(
      entry.manifest.version,
      metadata.version,
      `${path}: версия отличается от общей версии Relay`,
    );
    return { component, ...releaseMetadata(entry.manifest, tag) };
  });
  return { ...metadata, tag, packages };
}

/** Обновляет весь совместимый комплект npm-пакетов; Git-команды выполняются отдельно. */
export async function setWorkspaceVersion(root, version) {
  versionMetadata(version);
  const manifests = (await readManifests(root)).map(({ path, manifest }) => ({
    path,
    manifest: components.some((component) => path === `apps/${component}/package.json`)
      ? { ...manifest, version }
      : manifest,
  }));
  const release = workspaceRelease(manifests);
  for (const { path, manifest } of manifests) {
    if (manifest.private === true) continue;
    await writeFile(join(root, path), JSON.stringify(manifest, null, 2) + "\n");
  }
  return release;
}
