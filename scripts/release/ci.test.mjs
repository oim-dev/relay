import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildContext,
  buildOutputs,
  captureBuild,
  checkGate,
  commandsFor,
  gitCommit,
  requiredJobs,
  restoreBuild,
  runPhase,
  testOwners,
  typecheckOwners,
} from "../ci.mjs";
import { readManifests } from "./workspace.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("план CI покрывает все фактические workspace test/lint/typecheck scripts ровно один раз", async () => {
  const manifests = await readManifests(root);
  const namesWith = (script) =>
    manifests
      .filter(({ path, manifest }) => path !== "package.json" && manifest.scripts?.[script])
      .map(({ manifest }) => manifest.name)
      .sort();
  const tests = Object.values(testOwners).flat();
  assert.deepEqual(tests.toSorted(), namesWith("test"));
  assert.equal(new Set(tests).size, tests.length);
  assert.deepEqual(typecheckOwners.toSorted(), namesWith("typecheck"));
  const lint = commandsFor("lint-types")
    .filter((command) => command.at(-1) === "lint")
    .map((command) => command[2]);
  assert.deepEqual(lint.sort(), namesWith("lint"));
  const rootScripts = manifests.find(({ path }) => path === "package.json").manifest.scripts;
  assert.equal(rootScripts.build, "pnpm run release:check && turbo run build");
  assert.match(rootScripts["package:check"], /&& node scripts\/smoke-relay\.mjs$/);
  assert.equal(rootScripts["release:publish"], "node scripts/release/relay.mjs publish");
  assert.equal(
    rootScripts.check,
    "pnpm run release:check && pnpm run release:test && pnpm run format:check && pnpm run agents:check && pnpm run skills:check && pnpm run docs:check && turbo run lint typecheck test",
  );
  assert.deepEqual(
    commandsFor("preflight").map((command) => command[2]),
    ["release:check", "format:check", "agents:check", "skills:check", "docs:check"],
  );
  assert.deepEqual(
    commandsFor("tooling").map((command) => command[2]),
    ["release:test", "agents:test", "skills:test"],
  );
  for (const [alias, owner] of [
    ["agents:test", "@relay/dev-agents"],
    ["skills:test", "@relay/relay-skill"],
  ])
    assert.equal(rootScripts[alias], `pnpm --silent --filter ${owner} run test`);
  // Браузерный suite запускается отдельной фазой после restore, а локально — с нужной сборкой.
  const web = manifests.find(({ manifest }) => manifest.name === "@relay/web").manifest;
  assert.match(web.scripts["test:e2e"], /^node --test --test-concurrency=1 /);
  assert.doesNotMatch(web.scripts["test:e2e"], /\b(?:turbo|build|agent-browser install)\b/);
  assert.doesNotMatch(web.scripts.test ?? "", /test:e2e|test\/e2e/);
  assert.deepEqual(commandsFor("web-e2e"), [["pnpm", "--filter", "@relay/web", "run", "test:e2e"]]);
  assert.equal(
    rootScripts["test:web:e2e"],
    "turbo run build --filter=@oim-dev/relay-server --filter=@oim-dev/relay-cli && pnpm --filter @relay/web run test:e2e",
  );
  for (const [phase, owners] of Object.entries(testOwners)) {
    if (phase === "tooling") continue;
    assert.deepEqual(
      commandsFor(phase),
      owners.map((owner) => ["pnpm", "--filter", owner, "run", "test"]),
    );
  }
  for (const { manifest } of manifests) {
    for (const script of ["test", "typecheck", "lint"]) {
      if (!manifest.scripts?.[script] || manifest.name === "@oim-dev/relay-monorepo") continue;
      assert.doesNotMatch(
        manifest.scripts[script],
        /\b(?:turbo|build)\b/,
        `${manifest.name}:${script} не должен пересобирать выходы`,
      );
      assert(
        !manifest.scripts[`pre${script}`] && !manifest.scripts[`post${script}`],
        `Новый lifecycle hook требует пересмотра CI: ${manifest.name}:${script}`,
      );
    }
  }
  const distOwners = manifests.filter(
    ({ manifest }) =>
      manifest.scripts?.build &&
      !["@relay/dev-agents", "@relay/relay-skill", "@oim-dev/relay-monorepo"].includes(
        manifest.name,
      ),
  );
  assert.deepEqual(
    buildOutputs.filter((path) => path.endsWith("/dist")).sort(),
    distOwners.map(({ path }) => path.replace(/package.json$/, "dist")).sort(),
  );
  for (const owner of ["dev-agents", "relay-skill"]) {
    const turbo = JSON.parse(await readFile(join(root, "packages", owner, "turbo.json"), "utf8"));
    for (const output of turbo.tasks.build.outputs) {
      const path = output.replace("$TURBO_ROOT$/", "").replace(/\/\*.*$/, "");
      assert(buildOutputs.includes(path), `Потерян generated output ${output}`);
    }
  }
});

test("pack вызывает только штатные упаковщики, smoke отдельно; команды проверены без их запуска", async () => {
  assert.deepEqual(commandsFor("build"), [["pnpm", "run", "build", "--force"]]);
  const actual = [];
  runPhase("package-smoke", {
    root,
    execute: (command, args, options) => {
      actual.push([command, ...args]);
      assert.equal(options.cwd, root);
      return { status: 0 };
    },
  });
  assert.deepEqual(actual, [
    ...["cli", "server", "mcp"].map((component) => [
      "pnpm",
      "--filter",
      `@oim-dev/relay-${component}`,
      "run",
      "package:check",
    ]),
    ["pnpm", "run", "package:smoke"],
  ]);
  for (const component of ["cli", "server", "mcp"]) {
    const manifest = JSON.parse(
      await readFile(join(root, "apps", component, "package.json"), "utf8"),
    );
    assert.equal(manifest.scripts["package:check"], `node ../../scripts/package.mjs ${component}`);
    assert(!manifest.scripts["prepackage:check"] && !manifest.scripts["postpackage:check"]);
  }
  let calls = 0;
  assert.throws(
    () =>
      runPhase("pack", {
        execute: () => {
          calls++;
          return { status: 1 };
        },
      }),
    /остановлена/,
  );
  assert.equal(calls, 1, "Ошибка не должна запускать следующую команду/повтор");
  assert.throws(() => commandsFor("unknown"));
});

test("always gate принимает только полный набор success, не skipped/neutral/cancelled", () => {
  const needs = Object.fromEntries(
    Object.keys(requiredJobs).map((name) => [name, { result: "success" }]),
  );
  checkGate(needs);
  for (const name of Object.keys(requiredJobs)) {
    for (const result of ["failure", "cancelled", "skipped", "neutral", "", undefined])
      assert.throws(() => checkGate({ ...needs, [name]: { result } }));
    const incomplete = { ...needs };
    delete incomplete[name];
    assert.throws(() => checkGate(incomplete));
  }
  assert.throws(() => checkGate({ ...needs, unexpected: { result: "success" } }));
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "relay-ci-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const target = join(directory, "target");
  const outputs = ["apps/cli/dist", "skills/relay", ".claude/settings.json"];
  const files = ["apps/cli/dist/main.js", "skills/relay/SKILL.md", ".claude/settings.json"];
  for (const root of [source, target]) {
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), root === source ? file : "прежний результат");
    }
  }
  await chmod(join(source, files[0]), 0o755);
  await writeFile(join(target, "user.txt"), "не менять");
  const context = {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    run_id: "12",
    node_major: 24,
    package_manager: "pnpm@11.18.0",
  };
  const artifact = join(directory, "artifact");
  await captureBuild(source, artifact, context, outputs);
  return { directory, source, target, outputs, files, context, artifact };
}

test("build artifact детерминирован, восстанавливается без генерации и сохраняет чужие файлы", async (t) => {
  const f = await fixture(t);
  const second = join(f.directory, "second");
  await captureBuild(f.source, second, f.context, f.outputs);
  assert.deepEqual(
    await readFile(join(f.artifact, "build.json")),
    await readFile(join(second, "build.json")),
  );
  await restoreBuild(f.target, f.artifact, f.context, f.outputs);
  for (const file of f.files)
    assert.deepEqual(await readFile(join(f.source, file)), await readFile(join(f.target, file)));
  assert.equal((await lstat(join(f.target, f.files[0]))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(f.target, "user.txt"), "utf8"), "не менять");
  const before = await readFile(join(f.artifact, "build.json"));
  await assert.rejects(() => captureBuild(f.source, f.artifact, f.context, f.outputs));
  assert.deepEqual(await readFile(join(f.artifact, "build.json")), before);
});

test("чужой run/SHA/toolchain и повреждённый снимок отвергаются до замены прежних результатов", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { run_id: "13" },
    { commit: "c".repeat(40) },
    { node_major: 22 },
    { package_manager: "other" },
  ])
    await assert.rejects(() =>
      restoreBuild(f.target, f.artifact, { ...f.context, ...patch }, f.outputs),
    );
  await writeFile(join(f.artifact, "outputs", f.files.at(-1)), "порча последнего файла");
  await assert.rejects(() => restoreBuild(f.target, f.artifact, f.context, f.outputs));
  for (const file of f.files)
    assert.equal(await readFile(join(f.target, file), "utf8"), "прежний результат");
});

test("симлинки, посторонние файлы и неподготовленные выходы не становятся артефактом", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.artifact, "extra.txt"), "лишнее");
  await assert.rejects(() => restoreBuild(f.target, f.artifact, f.context, f.outputs));
  await rm(join(f.artifact, "extra.txt"));
  await rm(join(f.target, f.files[0]));
  await symlink(join(f.target, "user.txt"), join(f.target, f.files[0]));
  await assert.rejects(() => restoreBuild(f.target, f.artifact, f.context, f.outputs), /симлинк/);
  await symlink(join(f.source, f.files[0]), join(f.source, "apps/cli/dist/link"));
  await assert.rejects(
    () => captureBuild(f.source, join(f.directory, "invalid"), f.context, f.outputs),
    /Симлинк/,
  );
  assert.equal(await readFile(join(f.target, "user.txt"), "utf8"), "не менять");
});

test("ошибка создания временного файла restore не удаляет чужой прежний файл", async (t) => {
  const f = await fixture(t);
  const pending = join(f.target, `.claude/settings.json.ci-${process.pid}`);
  await writeFile(pending, "чужой временный файл");
  await assert.rejects(() => restoreBuild(f.target, f.artifact, f.context, f.outputs));
  assert.equal(await readFile(pending, "utf8"), "чужой временный файл");
  for (const file of f.files)
    assert.equal(await readFile(join(f.target, file), "utf8"), "прежний результат");
});

test("Re-run failed jobs восстанавливает прежний build того же run/SHA без новой сборки", async (t) => {
  const f = await fixture(t);
  const env = {
    GITHUB_SHA: gitCommit(root).sha,
    GITHUB_REPOSITORY: "oim-dev/relay",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const producer = await buildContext(root, env);
  const consumer = await buildContext(root, { ...env, GITHUB_RUN_ATTEMPT: "2" });
  assert.deepEqual(consumer, producer, "Попытка потребителя не меняет provenance успешного build");
  const producerArtifact = join(f.directory, "build-from-attempt-1");
  await captureBuild(f.source, producerArtifact, producer, f.outputs);
  const originalManifest = await readFile(join(producerArtifact, "build.json"));
  await restoreBuild(f.target, producerArtifact, consumer, f.outputs);
  assert.deepEqual(await readFile(join(producerArtifact, "build.json")), originalManifest);
  for (const file of f.files)
    assert.deepEqual(await readFile(join(f.target, file)), await readFile(join(f.source, file)));
  await assert.rejects(
    () => restoreBuild(f.target, producerArtifact, { ...consumer, run_id: "5678" }, f.outputs),
    /другого run/,
  );
});

test("cold consumer получает весь dist/generated manifest, hidden и exec bits без компенсирующего build", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-ci-cold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "producer");
  const target = join(directory, "cold-consumer");
  const artifact = join(directory, "build-artifact");
  const expected = new Map();
  for (const output of buildOutputs) {
    const paths = /\.(?:json|toml)$/.test(output)
      ? [output]
      : [`${output}/entry.txt`, `${output}/nested/.hidden`];
    for (const path of paths) expected.set(path, Buffer.from(`Выход ${path}\n`));
  }
  const executable = "apps/cli/dist/cli/main.js";
  expected.set(
    executable,
    Buffer.from('#!/usr/bin/env node\nconsole.log("из готового артефакта");\n'),
  );
  for (const [path, bytes] of expected) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), bytes);
  }
  await chmod(join(source, executable), 0o755);
  await mkdir(target);
  const context = { commit: "a".repeat(40), tree: "b".repeat(40), run_id: "42", node_major: 24 };
  await captureBuild(source, artifact, context);
  const manifest = JSON.parse(await readFile(join(artifact, "build.json"), "utf8"));
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), [...expected.keys()].sort());
  // download-artifact не сохраняет executable bits: восстановление должно взять их из manifest.
  for (const file of manifest.files) await chmod(join(artifact, "outputs", file.path), 0o644);
  await restoreBuild(target, artifact, context);
  for (const [path, bytes] of expected) assert.deepEqual(await readFile(join(target, path)), bytes);
  assert.equal((await lstat(join(target, executable))).mode & 0o777, 0o755);
  const { stdout } = await promisify(execFile)(join(target, executable), [], { cwd: target });
  assert.equal(stdout.trim(), "из готового артефакта");
  // В cold consumer даже нет package.json/node_modules: ни генерация, ни сборка не требовались.
  await assert.rejects(() => lstat(join(target, "package.json")), { code: "ENOENT" });
  await assert.rejects(() => lstat(join(target, "node_modules")), { code: "ENOENT" });
});
