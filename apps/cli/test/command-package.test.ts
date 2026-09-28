import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { distributionManifest, releaseMetadata } from "../scripts/release/metadata.mjs";
import { publishedIntegrity, shouldPublish } from "../scripts/release/registry.mjs";
import { pnpmCliPath } from "../scripts/lib/pnpm.mjs";
import { cliEnv, fixture, successful, tempDirectory } from "./helpers/cli.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = (version = "1.2.3") => ({
  name: "@oim-dev/relay-cli",
  version,
  bin: { "relay-cli": "dist/cli/main.js" },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  repository: { type: "git", url: "git+https://github.com/oim-dev/relay.git" },
  engines: { node: ">=22" },
});

test("package: единый тег, каналы и безопасные metadata CLI/Server/MCP без установки", async () => {
  for (const component of ["cli", "server", "mcp"]) {
    const actual = JSON.parse(
      await readFile(join(repo, "apps", component, "package.json"), "utf8"),
    );
    assert.equal(
      releaseMetadata(actual, `v${actual.version}`).archiveName,
      `oim-dev-relay-${component}-${actual.version}.tgz`,
    );
    for (const [version, distTag] of [
      ["1.2.3", "latest"],
      ["1.2.3-rc.1", "next"],
    ]) {
      const source = {
        ...manifest(version),
        name: `@oim-dev/relay-${component}`,
        bin: { [`relay-${component}`]: component === "cli" ? "dist/cli/main.js" : "dist/main.js" },
      };
      assert.deepEqual(releaseMetadata(source, `v${version}`), {
        name: source.name,
        version,
        distTag,
        archiveName: `oim-dev-relay-${component}-${version}.tgz`,
      });
      assert.throws(() => releaseMetadata(source, `${component}-v${version}`));
      assert.throws(() => releaseMetadata(source, "v9.9.9"));
    }
  }
  for (const patch of [
    { private: true },
    { name: "@relay/cli" },
    { name: "@oim-dev/relay-monorepo" },
    { name: "@gromlab/relay-cli" },
    { name: "cli" },
    { bin: { "relay-cli": "dist/main.js" } },
    { engines: { node: ">=18" } },
    { repository: { type: "git", url: "https://example.com" } },
    { repository: { type: "git", url: "git+https://github.com/gromlab-ru/relay.git" } },
    { publishConfig: { access: "public", registry: "https://example.com" } },
  ])
    assert.throws(() => releaseMetadata({ ...manifest(), ...patch }));
  for (const version of ["01.1.0", "0.1", "0.1.0-01", "0.1.0+build.1", "0.1.0\n"])
    assert.throws(() => releaseMetadata(manifest(version)));
});

test("package: distribution manifest не мутирует вход и отклоняет приватные/локальные зависимости", () => {
  const source = {
    ...manifest(),
    dependencies: { "@relay/core": "workspace:*", commander: "^14.0.0" },
    devDependencies: { esbuild: "^0.28.2" },
    scripts: { prepack: "не поставлять" },
  };
  const workspaces = ["contracts", "core", "project-runtime", "rest-sdk", "server-runtime"].map(
    (name) => ({
      name: `@relay/${name}`,
      version: "0.0.0",
      private: true,
      dependencies: name === "core" ? { zod: "^4.1.0", "proper-lockfile": "^4.1.2" } : {},
    }),
  );
  const before = structuredClone(source);
  const distribution = distributionManifest(source, workspaces);
  assert.deepEqual(distribution.dependencies, {
    commander: "^14.0.0",
    "proper-lockfile": "^4.1.2",
    zod: "^4.1.0",
  });
  assert.deepEqual(distribution.bin, source.bin);
  assert.deepEqual(distribution.repository, source.repository);
  assert.deepEqual(distribution.imports, { "#manifest": "./package.json" });
  assert.equal(distribution.scripts, undefined);
  assert.equal(distribution.devDependencies, undefined);
  assert.deepEqual(source, before);
  assert.deepEqual(distributionManifest(source, workspaces), distribution);
  assert.throws(() => distributionManifest(source, workspaces.slice(1)));
  for (const dependencies of [
    { "@relay/missing": "workspace:*" },
    { "@relay/core": "*" },
    { zod: "^3.0.0" },
    { external: "file:../external" },
    { external: "link:../external" },
    { external: "workspace:*" },
  ])
    assert.throws(() => distributionManifest({ ...source, dependencies }, workspaces));
});

test("package: retry только тех же байтов; 404 не смешивается с ошибкой registry", async () => {
  const archive = Buffer.from("Проверенный архив 🔬");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(shouldPublish(archive, null), true);
  assert.equal(shouldPublish(archive, integrity), false);
  assert.throws(() => shouldPublish(Buffer.from("Другие байты"), integrity));
  const name = "@oim-dev/relay-cli",
    version = "1.2.3";
  assert.equal(
    await publishedIntegrity(name, version, async () => new Response(null, { status: 404 })),
    null,
  );
  assert.equal(
    await publishedIntegrity(name, version, async (url) => {
      assert.equal(String(url), "https://registry.npmjs.org/%40oim-dev%2Frelay-cli/1.2.3");
      return Response.json({ name, version, dist: { integrity } });
    }),
    integrity,
  );
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      publishedIntegrity(name, version, async () => new Response(null, { status })),
    );
  for (const record of [
    { name: "other", version, dist: { integrity } },
    { name, version: "9.0.0", dist: { integrity } },
    { name, version },
  ])
    await assert.rejects(publishedIntegrity(name, version, async () => Response.json(record)));
  await assert.rejects(
    publishedIntegrity(name, version, async () => {
      throw new Error("Нет сети");
    }),
    /Нет сети/,
  );
});

test("package: pnpm JS, symlink и action-setup wrappers выбирают реальную JS-точку", async (t) => {
  const root = await tempDirectory(t);
  const packageRoot = join(root, "node_modules/pnpm");
  const binaries = join(root, "node_modules/.bin");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(binaries);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "pnpm",
      exports: { ".": "./package.json" },
      bin: { pnpm: "bin/pnpm.mjs" },
    }),
  );
  const entry = join(packageRoot, "bin/pnpm.mjs");
  await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const link = join(binaries, "pnpm-link"),
    shell = join(binaries, "pnpm"),
    cmd = join(binaries, "pnpm.cmd");
  await symlink(entry, link);
  await writeFile(shell, '#!/bin/sh\nexec node "$basedir/../pnpm/bin/pnpm.mjs" "$@"\n');
  await writeFile(cmd, '@echo off\nnode "%~dp0\\..\\pnpm\\bin\\pnpm.mjs" %*\n');
  for (const path of [entry, link, shell, cmd]) {
    assert.equal(pnpmCliPath(path), entry);
    const output = execFileSync(
      process.execPath,
      [pnpmCliPath(path), "Аргумент с пробелом", "--help"],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.deepEqual(JSON.parse(output), ["Аргумент с пробелом", "--help"]);
  }
});

test("package: source launcher pnpm сохраняет cwd, автора и JSON; повторное чтение независимо", async (t) => {
  const app = await fixture(t);
  // pnpm exec, в отличие от pnpm run, не обязан задавать npm_execpath.
  let executable = process.env.npm_execpath;
  if (!executable)
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {
        /* Следующий каталог PATH. */
      }
    }
  assert.ok(executable, "Для проверки source launcher нужен установленный pnpm");
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      pnpmCliPath(executable),
      "--dir",
      repo,
      "--silent",
      "run",
      "dev:cli",
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Из исходников",
      "--actor",
      "source-human",
      "--format",
      "json",
    ],
    { cwd: app.root, env: cliEnv(), timeout: 30_000 },
  );
  assert.equal(stderr, "");
  const created = JSON.parse(stdout);
  assert.equal(created.ok, true);
  assert.equal(created.data.action, "create");
  const task = successful(
    await app.run<{ title: string; createdBy: string }>(["task", "get", created.data.ref.id]),
  ).data;
  assert.equal(task.title, "Из исходников");
  assert.equal(task.createdBy, "source-human");
});
