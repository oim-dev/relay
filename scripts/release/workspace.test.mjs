import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { publishPackages } from "./publish.mjs";
import { readManifests, setWorkspaceVersion, workspaceRelease } from "./workspace.mjs";

async function fixture(t, version = "0.6.0") {
  const root = await mkdtemp(join(tmpdir(), "relay-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = [
    {
      path: "package.json",
      manifest: { name: "@oim-dev/relay-monorepo", version: "0.0.0", private: true },
    },
    {
      path: "apps/web/package.json",
      manifest: { name: "@relay/web", version: "0.0.0", private: true },
    },
    {
      path: "packages/core/package.json",
      manifest: { name: "@relay/core", version: "0.0.0", private: true },
    },
    ...["dev-agents", "relay-skill"].map((name) => ({
      path: `packages/${name}/package.json`,
      manifest: { name: `@relay/${name}`, version: "0.0.0", private: true, type: "module" },
    })),
    ...["cli", "server", "mcp"].map((component) => ({
      path: `apps/${component}/package.json`,
      manifest: {
        name: `@oim-dev/relay-${component}`,
        version,
        bin: { [`relay-${component}`]: component === "cli" ? "dist/cli/main.js" : "dist/main.js" },
        publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
        repository: { type: "git", url: "git+https://github.com/oim-dev/relay.git" },
        engines: { node: ">=22" },
        dependencies: { "@relay/core": "workspace:*" },
      },
    })),
  ];
  for (const { path, manifest } of manifests) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(manifest, null, 2) + "\n");
  }
  const release = workspaceRelease(manifests);
  const archives = new Map();
  for (const metadata of release.packages) {
    const path = join(root, "apps", metadata.component, ".artifacts/npm", metadata.archiveName);
    const staging = join(root, "staging", metadata.component);
    await mkdir(join(staging, "package"), { recursive: true });
    await writeFile(
      join(staging, "package/package.json"),
      JSON.stringify({
        ...manifests.find((entry) => entry.manifest.name === metadata.name).manifest,
        dependencies: {},
      }),
    );
    await mkdir(dirname(path), { recursive: true });
    await promisify(execFile)("tar", ["-czf", path, "-C", staging, "package"]);
    const content = await readFile(path);
    archives.set(metadata.name, {
      path,
      integrity: `sha512-${createHash("sha512").update(content).digest("base64")}`,
    });
  }
  return { root, manifests, release, archives };
}

test("общая версия обновляет все npm-пакеты и сохраняет приватные манифесты и зависимости", async (t) => {
  const { root, manifests } = await fixture(t);
  // Переход с прежних независимых версий выполняется одной командой.
  const server = manifests.find(({ path }) => path === "apps/server/package.json");
  await writeFile(
    join(root, server.path),
    JSON.stringify({ ...server.manifest, version: "0.2.0" }),
  );
  const release = await setWorkspaceVersion(root, "0.7.0-rc.1");
  assert.equal(release.tag, "v0.7.0-rc.1");
  assert.equal(release.distTag, "next");
  const updated = await readManifests(root);
  for (const before of manifests) {
    const after = updated.find(({ path }) => path === before.path);
    assert.deepEqual(
      after.manifest,
      before.manifest.private ? before.manifest : { ...before.manifest, version: "0.7.0-rc.1" },
    );
  }
  const snapshot = await Promise.all(
    manifests.map(({ path }) => readFile(join(root, path), "utf8")),
  );
  await assert.rejects(() => setWorkspaceVersion(root, "0.7.0-01"));
  assert.deepEqual(
    await Promise.all(manifests.map(({ path }) => readFile(join(root, path), "utf8"))),
    snapshot,
  );
});

test("проверка отклоняет рассинхронизацию версий, неполный состав и компонентные теги", async (t) => {
  const { manifests } = await fixture(t);
  for (const component of ["cli", "server", "mcp"]) {
    const path = `apps/${component}/package.json`;
    assert.throws(
      () => workspaceRelease(manifests.filter((entry) => entry.path !== path)),
      /отсутствует/,
    );
    assert.throws(
      () =>
        workspaceRelease(
          manifests.map((entry) =>
            entry.path === path
              ? { ...entry, manifest: { ...entry.manifest, version: "0.6.1" } }
              : entry,
          ),
        ),
      /версия отличается/,
    );
    assert.throws(() => workspaceRelease(manifests, `${component}-v0.6.0`), /Единый тег/);
  }
  assert.throws(() => workspaceRelease(manifests, "v0.6.1"), /Единый тег/);
  assert.throws(
    () =>
      workspaceRelease([
        ...manifests,
        { path: "packages/new/package.json", manifest: { name: "@oim-dev/new", version: "0.6.0" } },
      ]),
    /не включён/,
  );
});

test("notes описывает согласованный комплект, не утверждая, что публикация состоялась", async (t) => {
  const { root, release } = await fixture(t, "0.6.1");
  await cp(new URL("./", import.meta.url), join(root, "scripts/release"), { recursive: true });
  for (const { component } of release.packages) {
    // Формирование notes не требует готовых архивов, Git-тега или обращения к npm.
    await rm(join(root, "apps", component, ".artifacts"), { recursive: true });
    await writeFile(
      join(root, "apps", component, "CHANGELOG.md"),
      `# Изменения\n\n## ${release.version}\n\n- Подготовка ${component}.\n`,
    );
  }
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [join(root, "scripts/release/relay.mjs"), "notes", release.tag],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(stderr, "");
  assert.deepEqual(stdout.split("\n\n").slice(0, 2), [
    `# Relay ${release.version}`,
    "CLI, Server и MCP входят в согласованный комплект с единой версией.",
  ]);
  assert.doesNotMatch(stdout, /Все пакеты выпущены с общей версией/);
  for (const { name, component, version } of release.packages) {
    assert(stdout.includes(`## ${name}\n\n- Подготовка ${component}.`));
    assert(stdout.includes(`npx ${name}@${version} --help`));
  }
});

test("каждый выпуск публикует все три архива после общей предварительной проверки", async (t) => {
  const { root, release, archives } = await fixture(t, "0.7.0-rc.1");
  const events = [];
  const published = new Set();
  await publishPackages(root, release.packages, {
    getIntegrity: async (name, version) => {
      assert.equal(version, release.version);
      if (published.has(name)) return archives.get(name).integrity;
      events.push(`check ${name}`);
      return null;
    },
    getTag: async (name) => (published.has(name) ? release.version : null),
    executeNpm: async (args, cwd) => {
      assert.equal(cwd, root);
      const metadata = release.packages.find(({ name }) => archives.get(name).path === args[1]);
      assert(metadata);
      assert.deepEqual(args.slice(0, 9), [
        "publish",
        archives.get(metadata.name).path,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        "https://registry.npmjs.org",
        "--tag",
        "next",
      ]);
      events.push(`publish ${metadata.name}`);
      published.add(metadata.name);
      return { stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(events, [
    ...release.packages.map(({ name }) => `check ${name}`),
    ...release.packages.map(({ name }) => `publish ${name}`),
  ]);
});

test("повтор после сбоя допубликовывает комплект, сверяя уже выпущенные архивы", async (t) => {
  const { root, release, archives } = await fixture(t);
  const published = new Map();
  const attempts = [];
  let fail = true;
  const options = {
    getIntegrity: async (name) => published.get(name) ?? null,
    getTag: async (name) => (published.has(name) ? release.version : null),
    executeNpm: async (args) => {
      const { name } = release.packages.find(({ name }) => archives.get(name).path === args[1]);
      attempts.push(name);
      if (name === "@oim-dev/relay-server" && fail) {
        fail = false;
        throw new Error("Сбой registry");
      }
      published.set(name, archives.get(name).integrity);
      return { stdout: "", stderr: "" };
    },
  };
  await assert.rejects(() => publishPackages(root, release.packages, options), /Сбой registry/);
  assert.equal(published.size, 1);
  await publishPackages(root, release.packages, options);
  await publishPackages(root, release.packages, options);
  assert.deepEqual(attempts, [
    "@oim-dev/relay-cli",
    "@oim-dev/relay-server",
    "@oim-dev/relay-server",
    "@oim-dev/relay-mcp",
  ]);
  assert.equal(published.size, 3);
});

test("ошибка любого архива или registry останавливает весь выпуск до первой записи", async (t) => {
  for (const failure of ["missing", "integrity", "registry"]) {
    await t.test(failure, async (t) => {
      const { root, release, archives } = await fixture(t);
      if (failure === "missing") await rm(archives.get("@oim-dev/relay-mcp").path);
      let publications = 0;
      await assert.rejects(() =>
        publishPackages(root, release.packages, {
          getTag: async () => release.version,
          getIntegrity: async (name) => {
            if (name !== "@oim-dev/relay-mcp") return null;
            if (failure === "registry") throw new Error("Ошибка доступа к npm");
            return "sha512-другой-архив";
          },
          executeNpm: async () => {
            publications++;
            return { stdout: "", stderr: "" };
          },
        }),
      );
      assert.equal(publications, 0);
    });
  }
});

test("CI не публикует; release.published публикует с минимальными правами и точным artifact ID", async () => {
  const root = new URL("../../", import.meta.url);
  const release = await readFile(new URL(".github/workflows/release.yml", root), "utf8");
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.doesNotMatch(ci, /id-token:|release:publish|npm publish/);
  assert.doesNotMatch(
    release,
    /contents: write|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|workflow_dispatch:|\n  push:|\n  pull_request:/,
  );
  assert.match(release, /types: \[published\]/);
  assert.match(release, /environment: npm/);
  assert.equal((release.match(/id-token: write/g) ?? []).length, 1);
  assert.match(release, /artifact-ids: \$\{\{ needs.ci.outputs.artifact_id \}\}/);
  assert.match(ci, /artifact-ids: \$\{\{ needs.package.outputs.artifact_id \}\}/);
  assert.match(ci, /pnpm run package:smoke/);
  assert.match(release, /node scripts\/release\/event.mjs/);
  assert.match(release, /!github.event.release.draft/);
  assert.match(release, /group: relay-npm-publish\n      cancel-in-progress: false/);
  const publisher = release.split(/^  publish:\s*$/m)[1];
  assert.match(publisher, /needs: \[metadata, ci\]/);
  assert.match(publisher, /id-token: write/);
  assert.doesNotMatch(publisher, /pnpm (?:install|run build|run package:check)/);
  assert.match(publisher, /npm@11\.16\.0/);
  assert.match(publisher, /bundle\.mjs verify/);
  assert.match(publisher, /\[\[ "\$ARTIFACT_ID" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
  const installed = ci.split(/^  installed-node22:\s*$/m)[1];
  assert.match(installed, /needs: package/);
  assert.match(installed, /bundle\.mjs restore/);
  assert.doesNotMatch(installed, /pnpm (?:install|run build|run package:check)/);
  assert.match(ci, /if: matrix.node == 24/);
  assert.match(ci, /if: matrix.node == 22/);
  assert.match(ci, /pnpm run release:test && pnpm exec turbo run test/);
  const jobs = release.split(/^jobs:\s*$/m)[1];
  assert(jobs, "В workflow выпуска отсутствуют задания");
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]),
    ["metadata", "ci", "publish"],
  );
  assert.match(jobs, /^ {4}needs: metadata$/m);
  assert.match(jobs, /^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/m);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.scripts["release:publish"], "node scripts/release/relay.mjs publish");
});
