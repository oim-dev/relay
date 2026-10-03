import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createBundle, verifyBundle } from "./bundle.mjs";
import { validateEvent } from "./event.mjs";
import { publishedIntegrity, taggedVersion, compareVersions } from "./registry.mjs";
import { publishPackages } from "./publish.mjs";
import { subprocessEnv } from "./test-env.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relay delivery "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = { tag: "v0.7.0", version: "0.7.0", distTag: "latest", packages: [] };
  for (const component of ["cli", "server", "mcp"]) {
    const metadata = {
      component,
      name: `@oim-dev/relay-${component}`,
      version: release.version,
      distTag: "latest",
      archiveName: `oim-dev-relay-${component}-${release.version}.tgz`,
    };
    release.packages.push(metadata);
    const staging = join(root, component);
    await mkdir(join(staging, "package"), { recursive: true });
    await writeFile(
      join(staging, "package/package.json"),
      JSON.stringify({
        name: metadata.name,
        version: metadata.version,
        engines: { node: ">=22" },
        bin: { [`relay-${component}`]: component === "cli" ? "dist/cli/main.js" : "dist/main.js" },
        repository: { url: "git+https://github.com/oim-dev/relay.git" },
        publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
      }),
    );
    const destination = join(root, "apps", component, ".artifacts/npm");
    await mkdir(destination, { recursive: true });
    await exec("tar", ["-czf", join(destination, metadata.archiveName), "-C", staging, "package"]);
  }
  const context = { release, commit: "a".repeat(40) };
  const directory = join(root, "bundle");
  await createBundle(root, directory, context);
  return { root, directory, context };
}

test("комплект: создание, перенос, проверка и восстановление тех же байтов", async (t) => {
  const { root, directory, context } = await fixture(t);
  const downloaded = join(root, "downloaded");
  await cp(directory, downloaded, { recursive: true });
  await rm(join(root, "apps"), { recursive: true });
  await verifyBundle(root, downloaded, context, true);
  for (const p of context.release.packages)
    assert.deepEqual(
      await readFile(join(downloaded, p.archiveName)),
      await readFile(join(root, "apps", p.component, ".artifacts/npm", p.archiveName)),
    );
  await assert.rejects(
    () => verifyBundle(root, downloaded, { ...context, commit: "b".repeat(40) }),
    /коммита/,
  );
  await assert.rejects(
    () =>
      verifyBundle(root, downloaded, {
        ...context,
        release: { ...context.release, tag: "v0.8.0" },
      }),
    /выпуска/,
  );
  const path = join(downloaded, context.release.packages[0].archiveName);
  await writeFile(path, "повреждённый архив");
  await assert.rejects(() => verifyBundle(root, downloaded, context, true), /Байты/);
});

test("комплект отклоняет лишние файлы и подмену внутренних метаданных даже с новым хешем", async (t) => {
  const { root, directory, context } = await fixture(t);
  await writeFile(join(directory, "extra.tgz"), "лишний файл");
  await assert.rejects(() => verifyBundle(root, directory, context));
  await rm(join(directory, "extra.tgz"));
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const [a, b] = manifest.packages;
  await cp(join(directory, b.file), join(directory, a.file));
  a.integrity = b.integrity;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => verifyBundle(root, directory, context));
});

test("событие: stable/prerelease, запрет draft, другого тега/коммита/репозитория", () => {
  const release = { tag: "v0.7.0", distTag: "latest" };
  const event = {
    action: "published",
    repository: { full_name: "oim-dev/relay" },
    release: { tag_name: release.tag, draft: false, prerelease: false },
  };
  validateEvent(event, release, "sha", "sha");
  validateEvent(
    { ...event, release: { ...event.release, prerelease: true } },
    { ...release, distTag: "next" },
    "sha",
    "sha",
  );
  for (const changed of [
    { ...event, action: "created" },
    { ...event, repository: {} },
    ...[{ draft: true }, { prerelease: true }, { tag_name: "v0.6.1" }].map((patch) => ({
      ...event,
      release: { ...event.release, ...patch },
    })),
  ])
    assert.throws(() => validateEvent(changed, release, "sha", "sha"));
  assert.throws(() => validateEvent(event, release, "sha", "other"));
});

test("registry: только 404 разрешает новую версию; ошибки и неверные ответы закрывают выпуск", async () => {
  const response = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await publishedIntegrity("@oim-dev/relay-cli", "0.7.0", response(404, {})), null);
  for (const status of [401, 403, 429, 500])
    await assert.rejects(() => publishedIntegrity("pkg", "0.7.0", response(status, {})));
  await assert.rejects(() =>
    publishedIntegrity("pkg", "0.7.0", async () => {
      throw new Error("сеть");
    }),
  );
  for (const body of [{}, { name: "other", version: "0.7.0" }, { name: "pkg", version: "0.7.0" }])
    await assert.rejects(() => publishedIntegrity("pkg", "0.7.0", response(200, body)));
  assert.equal(
    await taggedVersion("pkg", "latest", response(200, { name: "pkg", version: "0.8.0" })),
    "0.8.0",
  );
  await assert.rejects(() => taggedVersion("pkg", "latest", response(200, {})));
  assert(compareVersions("0.8.0", "0.7.0") > 0);
  assert(compareVersions("0.7.0-rc.10", "0.7.0-rc.2") > 0);
  assert(compareVersions("0.7.0", "0.7.0-rc.10") > 0);
});

test("старый retry не откатывает канал; postflight не исправляет registry", async (t) => {
  const { root, context, directory } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const hashes = new Map(manifest.packages.map((p) => [p.name, p.integrity]));
  let writes = 0;
  await assert.rejects(
    () =>
      publishPackages(root, context.release.packages, {
        getIntegrity: async () => null,
        getTag: async () => "0.8.0",
        executeNpm: async () => {
          writes++;
        },
      }),
    /новее/,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    () =>
      publishPackages(root, context.release.packages, {
        getIntegrity: async (name) => hashes.get(name),
        getTag: async () => "0.6.1",
        executeNpm: async () => {
          writes++;
        },
      }),
    /канал отличается/,
  );
  assert.equal(writes, 0);
  const published = new Set();
  await assert.rejects(
    () =>
      publishPackages(root, context.release.packages, {
        getIntegrity: async (name) => (published.has(name) ? hashes.get(name) : null),
        getTag: async () => "0.6.1",
        executeNpm: async (args) => {
          published.add(context.release.packages.find((p) => args[1].endsWith(p.archiveName)).name);
          return { stdout: "", stderr: "" };
        },
      }),
    /канал после публикации/,
  );
  assert.equal(published.size, 3);
});

test("npm-обёртка сохраняет аргументы с пробелами и OIDC-окружение дочернего процесса", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay npm wrapper "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "pnpm mock.mjs");
  await writeFile(
    entry,
    'console.log(JSON.stringify({args: process.argv.slice(2), oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "test-only", cwd: process.cwd()}));',
  );
  const module = new URL("./npm.mjs", import.meta.url).href;
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runNpm} from ${JSON.stringify(module)}; const result = await runNpm(["publish", "archive with spaces.tgz", "--provenance"], ${JSON.stringify(root)}); process.stdout.write(result.stdout);`,
    ],
    { env: subprocessEnv({ npm_execpath: entry, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-only" }) },
  );
  assert.deepEqual(JSON.parse(stdout), {
    args: ["exec", "npm", "publish", "archive with spaces.tgz", "--provenance"],
    oidc: true,
    cwd: root,
  });
});

test("настоящий npm доступен через обёртку без установки монорепозитория", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay publisher empty "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  const module = new URL("./npm.mjs", import.meta.url).href;
  const actual = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runNpm} from ${JSON.stringify(module)}; const result = await runNpm(["--version"], ${JSON.stringify(root)}); process.stdout.write(result.stdout);`,
    ],
    { env: subprocessEnv() },
  );
  const expected = await exec("npm", ["--version"], { cwd: root, env: subprocessEnv() });
  assert.equal(actual.stdout.trim(), expected.stdout.trim());
});
