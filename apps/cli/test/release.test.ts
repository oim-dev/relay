import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { distributionManifest, releaseMetadata } from "../scripts/release/metadata.mjs";
import { publishedIntegrity, shouldPublish } from "../scripts/release/registry.mjs";

function manifest(version = "0.2.0") {
  return {
    name: "@oim-dev/relay-cli",
    version,
    bin: { "relay-cli": "dist/cli/main.js" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    repository: { type: "git", url: "git+https://github.com/oim-dev/relay.git" },
    engines: { node: ">=22" },
  };
}

test("релиз сверяет общий тег с манифестом CLI и определяет канал предварительной версии", () => {
  for (const [version, channel] of [
    ["0.2.0", "latest"],
    ["0.2.0-rc.1", "next"],
  ]) {
    const metadata = releaseMetadata(manifest(version), `v${version}`);
    assert.equal(metadata.distTag, channel);
    assert.equal(metadata.archiveName, `oim-dev-relay-cli-${version}.tgz`);
  }
  const candidate = manifest();
  assert.throws(() => releaseMetadata(candidate, "v0.2.1"));
  assert.throws(() => releaseMetadata(candidate, "cli-v0.2.0"));
  assert.throws(() => releaseMetadata({ ...candidate, private: true }));
  for (const name of ["@oim-dev/relay-monorepo", "@gromlab/relay-cli", "@relay/cli", "cli"])
    assert.throws(() => releaseMetadata({ ...candidate, name }), /Неверное имя/);
  assert.throws(() => releaseMetadata({ ...candidate, bin: { "relay-cli": "dist/main.js" } }));
  assert.throws(() => releaseMetadata({ ...candidate, engines: { node: ">=18" } }));
  assert.throws(() =>
    releaseMetadata({ ...candidate, repository: { type: "git", url: "https://example.com" } }),
  );
  assert.throws(
    () =>
      releaseMetadata({
        ...candidate,
        repository: { type: "git", url: "git+https://github.com/gromlab-ru/relay.git" },
      }),
    /repository.url/,
  );
  for (const version of ["01.1.0", "0.1", "0.1.0-01", "0.1.0+build.1", "0.1.0\n"]) {
    assert.throws(() => releaseMetadata(manifest(version), `v${version}`));
  }
});

test("дистрибутив содержит внешние зависимости без приватных workspace-ссылок и инструментов", () => {
  const source = {
    ...manifest(),
    dependencies: {
      "@relay/core": "workspace:*",
      "@relay/rest-sdk": "workspace:*",
      "@relay/server-runtime": "workspace:*",
      commander: "^14.0.0",
    },
    devDependencies: { esbuild: "^0.28.2", "@relay/typescript-config": "workspace:*" },
    scripts: { prepack: "node scripts/release/assemble-package.mjs" },
    imports: { "#manifest": "./package.json" },
  };
  const workspaces = [
    { name: "@relay/project-runtime", version: "0.0.0", private: true, dependencies: {} },
    { name: "@relay/contracts", version: "0.0.0", private: true, dependencies: {} },
    { name: "@relay/rest-sdk", version: "0.0.0", private: true, dependencies: {} },
    {
      name: "@relay/core",
      version: "0.0.0",
      private: true,
      dependencies: { zod: "^4.1.0", "proper-lockfile": "^4.1.2" },
    },
    {
      name: "@relay/server-runtime",
      version: "0.0.0",
      private: true,
      dependencies: {
        "@relay/core": "workspace:*",
        "@relay/contracts": "workspace:*",
        "@nestjs/core": "^12.0.1",
        zod: "^4.1.0",
      },
    },
  ];
  const staged = distributionManifest(source, workspaces);
  assert.equal(staged.name, source.name);
  assert.equal(staged.version, source.version);
  assert.deepEqual(staged.bin, source.bin);
  assert.deepEqual(staged.repository, source.repository);
  assert.deepEqual(staged.imports, { "#manifest": "./package.json" });
  assert.deepEqual(staged.dependencies, {
    "@nestjs/core": "^12.0.1",
    commander: "^14.0.0",
    "proper-lockfile": "^4.1.2",
    zod: "^4.1.0",
  });
  assert.equal(staged.scripts, undefined);
  assert.equal(staged.devDependencies, undefined);
  assert(source.scripts.prepack, "Исходный манифест не должен изменяться");
  assert.throws(() => distributionManifest(source, workspaces.slice(1)));
  for (const dependencies of [
    { "@relay/missing": "workspace:*" },
    { "@relay/core": "*" },
    { zod: "^3.0.0" },
    { external: "file:../external" },
    { external: "workspace:*" },
  ]) {
    assert.throws(() => distributionManifest({ ...source, dependencies }, workspaces));
  }
});

test("MCP использует общий тег и собственный архив", () => {
  const source = {
    ...manifest("0.1.0"),
    name: "@oim-dev/relay-mcp",
    bin: { "relay-mcp": "dist/main.js" },
  };
  assert.equal(releaseMetadata(source, "v0.1.0").archiveName, "oim-dev-relay-mcp-0.1.0.tgz");
  assert.throws(() => releaseMetadata(source, "mcp-v0.1.0"));
  assert.throws(() => releaseMetadata(source, "v0.2.0"));
});

test("Relay Server использует общий тег и собственный архив", () => {
  const source = {
    ...manifest("0.1.0"),
    name: "@oim-dev/relay-server",
    bin: { "relay-server": "dist/main.js" },
  };
  assert.equal(releaseMetadata(source, "v0.1.0").archiveName, "oim-dev-relay-server-0.1.0.tgz");
  assert.throws(() => releaseMetadata(source, "server-v0.1.0"));
});

test("повторный релиз пропускается только при полном совпадении integrity архива", () => {
  const archive = Buffer.from("Проверенный архив 🔬");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(shouldPublish(archive, null), true);
  assert.equal(shouldPublish(archive, integrity), false);
  assert.throws(() => shouldPublish(Buffer.from("Другой архив"), integrity));
});

test("проверка npm отличает отсутствие версии от ошибок доступа и сервера", async () => {
  const name = "@oim-dev/relay-cli";
  const version = "0.1.0";
  assert.equal(
    await publishedIntegrity(name, version, async () => new Response(null, { status: 404 })),
    null,
  );
  const record = { name, version, dist: { integrity: "sha512-test" } };
  assert.equal(
    await publishedIntegrity(name, version, async () => Response.json(record)),
    "sha512-test",
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(() =>
      publishedIntegrity(name, version, async () => new Response(null, { status })),
    );
  }
  await assert.rejects(() =>
    publishedIntegrity(name, version, async () => Response.json({ ...record, version: "9.0.0" })),
  );
  await assert.rejects(() =>
    publishedIntegrity(name, version, async () => {
      throw new Error("Нет сети");
    }),
  );
});
