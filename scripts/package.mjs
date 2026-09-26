import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runNpm } from "./release/npm.mjs";
import {
  assertPackedContent,
  copyPackageContent,
  readPackageContent,
} from "./release/package-content.mjs";
import { components, readManifests, workspaceRelease } from "./release/workspace.mjs";

/** Собирает компонент из dist и заменяет прежние архивы только после проверки нового. */
export async function packageComponent(
  component,
  { root = fileURLToPath(new URL("../", import.meta.url)), executeNpm = runNpm } = {},
) {
  assert(components.includes(component), "Укажите cli, server или mcp");
  const app = join(root, "apps", component);
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  const metadata = workspaceRelease(
    await readManifests(root),
    process.env.RELEASE_TAG,
  ).packages.find((entry) => entry.component === component);
  const content = await readPackageContent(app, manifest);
  const dependencies = {};
  const visited = new Set();
  async function collect(current) {
    for (const [name, version] of Object.entries(current.dependencies ?? {})) {
      if (!String(version).startsWith("workspace:")) {
        assert(
          !dependencies[name] || dependencies[name] === version,
          `Конфликт зависимости ${name}`,
        );
        dependencies[name] = version;
        continue;
      }
      if (visited.has(name)) continue;
      visited.add(name);
      const path = join(root, "packages", name.split("/")[1], "package.json");
      await collect(JSON.parse(await readFile(path, "utf8")));
    }
  }
  await collect(manifest);
  const stage = join(app, ".artifacts/package");
  const artifacts = join(app, ".artifacts/npm");
  const pending = join(stage, ".npm");
  await rm(stage, { recursive: true, force: true });
  await mkdir(pending, { recursive: true });
  const entry = component === "cli" ? "cli/main" : "main";
  await build({
    absWorkingDir: root,
    entryPoints: { [entry]: join(app, "dist", `${entry}.js`) },
    outdir: join(stage, "dist"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    splitting: true,
    external: ["#manifest", ...Object.keys(dependencies)],
  });
  if (component === "server") {
    await cp(join(app, "dist/web"), join(stage, "dist/web"), { recursive: true });
    assert((await readFile(join(stage, "dist/web/index.html"), "utf8")).includes("<html"));
  } else
    assert(
      !("@nestjs/core" in dependencies),
      "Клиентский пакет не должен включать серверный runtime",
    );
  const { devDependencies, scripts, private: isPrivate, ...published } = manifest;
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ ...published, dependencies }, null, 2) + "\n",
  );
  await copyPackageContent(stage, content);
  try {
    const result = await executeNpm(
      ["pack", "--json", "--ignore-scripts", "--workspaces=false", "--pack-destination", pending],
      stage,
    );
    const [archive] = JSON.parse(result.stdout);
    assert.equal(archive.name, manifest.name);
    assert.equal(archive.version, manifest.version);
    assert.equal(archive.filename, metadata.archiveName);
    assertPackedContent(archive, manifest, content);
    await mkdir(artifacts, { recursive: true });
    const archivePath = join(artifacts, archive.filename);
    // На одной файловой системе rename атомарно заменяет файл, не оставляя пустого результата.
    await rename(join(pending, archive.filename), archivePath);
    const managedArchive = new RegExp(
      `^oim-dev-relay-${component}-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?\\.tgz$`,
    );
    // Прежние версии убираются только после успешной установки нового архива; чужие файлы сохраняются.
    for (const entry of await readdir(artifacts, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== archive.filename && managedArchive.test(entry.name)) {
        await rm(join(artifacts, entry.name), { force: true });
      }
    }
    return { archive, archivePath };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Укажите ровно один компонент: cli, server или mcp");
  const { archivePath } = await packageComponent(process.argv[2]);
  console.log(`Пакет Relay: ${archivePath}`);
}
