import assert from "node:assert/strict";

/**
 * @typedef {{name: string, version: string, private?: boolean,
 *   bin: Record<string, string>, publishConfig: {access: string, registry: string},
 *   repository: {type: string, url: string, directory?: string},
 *   engines: {node: string}, dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>, scripts?: Record<string, string>,
 *   imports?: Record<string, string>, files?: string[]}} PackageManifest
 * @typedef {{name: string, version: string, private: boolean,
 *   dependencies?: Record<string, string>}} WorkspaceManifest
 */

const number = "(?:0|[1-9]\\d*)";
const identifier = `(?:${number}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const versionPattern = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-(?<prerelease>${identifier}(?:\\.${identifier})*))?$`,
);

/** @param {string} version */
export function versionMetadata(version) {
  const parsed = versionPattern.exec(version);
  assert(
    parsed && parsed[0] === version,
    "Ожидается SemVer без build metadata: 0.1.0 или 0.2.0-rc.1",
  );
  return { version, distTag: parsed.groups?.prerelease ? "next" : "latest" };
}

/**
 * Версия и канал вычисляются до установки зависимостей и любых обращений на запись к npm.
 * @param {PackageManifest} manifest Манифест публикуемого пакета.
 * @param {string} [tag] Git-тег, если проверяется релиз.
 */
export function releaseMetadata(manifest, tag) {
  const component = manifest.name.replace("@oim-dev/relay-", "");
  assert(
    ["cli", "server", "mcp"].includes(component) && manifest.name === `@oim-dev/relay-${component}`,
    "Неверное имя публикуемого пакета",
  );
  assert(!manifest.private, "Приватный манифест нельзя публиковать");
  assert.equal(manifest.publishConfig.access, "public", "Ожидается публичный пакет");
  assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org");
  assert.equal(manifest.engines.node, ">=22", "Пакеты Relay требуют Node.js 22+");
  assert.equal(
    manifest.bin[`relay-${component}`],
    component === "cli" ? "dist/cli/main.js" : "dist/main.js",
    "Неожиданная точка входа пакета",
  );
  assert.equal(
    manifest.repository.url,
    "git+https://github.com/oim-dev/relay.git",
    "Неверный repository.url для npm provenance",
  );
  const version = versionMetadata(manifest.version);
  if (tag !== undefined)
    assert.equal(
      tag,
      `v${manifest.version}`,
      "Единый тег должен совпадать с версией всех пакетов: v<version>",
    );
  return {
    name: manifest.name,
    ...version,
    archiveName: `oim-dev-relay-${component}-${manifest.version}.tgz`,
  };
}

/**
 * Код приватных пакетов включается в сборку; устанавливаются только внешние зависимости.
 * @param {PackageManifest} manifest
 * @param {WorkspaceManifest[]} workspaces
 */
export function distributionManifest(manifest, workspaces) {
  const internal = new Set(workspaces.map((workspace) => workspace.name));
  assert.deepEqual(
    [...internal].sort(),
    [
      "@relay/contracts",
      "@relay/core",
      "@relay/project-runtime",
      "@relay/rest-sdk",
      "@relay/server-runtime",
    ],
    "Expected all private runtime workspaces",
  );
  for (const workspace of workspaces) {
    assert.equal(workspace.private, true, `${workspace.name} must remain private`);
    assert.equal(workspace.version, "0.0.0", `${workspace.name} must not carry the CLI version`);
  }
  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const candidate of [manifest, ...workspaces]) {
    for (const [name, version] of Object.entries(candidate.dependencies ?? {})) {
      if (internal.has(name)) {
        assert.equal(version, "workspace:*", `${name} должен использовать зависимость workspace:*`);
        continue;
      }
      assert(!name.startsWith("@relay/"), `Unbundled private dependency: ${name}`);
      assert(!/^(?:workspace:|file:|link:)/.test(version), `Non-registry dependency: ${name}`);
      assert(
        dependencies[name] === undefined || dependencies[name] === version,
        `Conflicting runtime versions for ${name}`,
      );
      dependencies[name] = version;
    }
  }
  const staged = {
    ...manifest,
    imports: { "#manifest": "./package.json" },
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  delete staged.devDependencies;
  delete staged.scripts;
  return staged;
}
