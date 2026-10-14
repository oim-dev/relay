import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredJobs = {
  preflight: "PR / Предварительные проверки",
  build: "PR / Сборка",
  tooling: "PR / Tooling",
  "lint-types": "PR / Lint и типы",
  libraries: "PR / Библиотеки",
  server: "PR / Server и runtime",
  cli: "PR / CLI",
  mcp: "PR / MCP",
  "web-e2e": "PR / Web E2E",
  "package-smoke": "PR / Установка пакетов",
};
export const gateName = "PR / Все проверки";

const rootScript = (name, ...args) => ["pnpm", "run", name, ...args];
const workspaceScript = (name, script) => ["pnpm", "--filter", name, "run", script];
export const testOwners = {
  tooling: ["@relay/dev-agents", "@relay/relay-skill"],
  libraries: ["@relay/core", "@relay/contracts", "@relay/project-runtime"],
  server: ["@oim-dev/relay-server", "@relay/server-runtime"],
  cli: ["@oim-dev/relay-cli"],
  mcp: ["@oim-dev/relay-mcp"],
};
export const typecheckOwners = [
  "@relay/web",
  "@relay/contracts",
  "@relay/core",
  "@relay/rest-sdk",
  "@relay/project-runtime",
  "@relay/server-runtime",
  "@oim-dev/relay-server",
  "@oim-dev/relay-cli",
  "@oim-dev/relay-mcp",
];

/** Прямые scripts после восстановления сборки: Turbo больше не строит её в каждом job. */
export function commandsFor(phase) {
  if (phase === "preflight")
    return ["release:check", "format:check", "agents:check", "skills:check", "docs:check"].map(
      (name) => rootScript(name),
    );
  if (phase === "build") return [rootScript("build", "--force")];
  if (phase === "lint-types")
    return [
      workspaceScript("@relay/web", "lint"),
      ...typecheckOwners.map((name) => workspaceScript(name, "typecheck")),
    ];
  if (phase === "tooling")
    return ["check:test", "release:test", "agents:test", "skills:test"].map((name) =>
      rootScript(name),
    );
  // Браузерный suite Web не входит в `test`: ему нужен Chrome, установленный шагом workflow.
  if (phase === "web-e2e") return [workspaceScript("@relay/web", "test:e2e")];
  if (Object.hasOwn(testOwners, phase))
    return testOwners[phase].map((name) => workspaceScript(name, "test"));
  if (phase === "pack")
    // Эти три scripts вызывают только scripts/package.mjs, без Turbo/build.
    return ["cli", "server", "mcp"].map((name) =>
      workspaceScript(`@oim-dev/relay-${name}`, "package:check"),
    );
  if (phase === "package-smoke") return [...commandsFor("pack"), rootScript("package:smoke")];
  throw new Error(`Неизвестная фаза CI: ${phase}`);
}

class PhaseExitError extends Error {
  constructor(phase, command, status) {
    super(`Фаза ${phase} остановлена: ${command} (код ${status})`);
    this.exitCode = status;
  }
}

export function runPhase(phase, { root, execute = spawnSync } = {}) {
  for (const [command, ...args] of commandsFor(phase)) {
    console.log(`CI: ${[command, ...args].join(" ")}`);
    const result = execute(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) {
      console.error(`Фаза ${phase} прервана сигналом ${result.signal}`);
      process.kill(process.pid, result.signal);
      throw new Error(`Фаза ${phase} прервана сигналом ${result.signal}`);
    }
    if (result.status !== 0) {
      assert(
        Number.isInteger(result.status) && result.status > 0,
        "Команда не вернула код завершения",
      );
      throw new PhaseExitError(phase, [command, ...args].join(" "), result.status);
    }
  }
}

export function checkGate(needs) {
  assert.deepEqual(
    Object.keys(needs).sort(),
    Object.keys(requiredJobs).sort(),
    "Неполный набор обязательных jobs",
  );
  for (const [id, { result }] of Object.entries(needs))
    assert.equal(result, "success", `Обязательная проверка ${id}: ${result}`);
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const buildOutputs = [
  ...["cli", "server", "mcp", "web"].map((name) => `apps/${name}/dist`),
  ...["contracts", "core", "project-runtime", "server-runtime", "rest-sdk"].map(
    (name) => `packages/${name}/dist`,
  ),
  "skills/relay",
  "apps/playground/.agents/skills/relay",
  ".opencode/agents",
  ".claude/agents",
  ".codex/agents",
  "opencode.json",
  ".claude/settings.json",
  ".codex/config.toml",
  "agents-lock.json",
];

export function gitCommit(root, ref = "HEAD") {
  const [sha, tree, parents] = execFileSync("git", ["show", "-s", "--format=%H%n%T%n%P", ref], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  return { sha, tree, parents: parents ? parents.split(" ") : [] };
}

async function filesIn(root, path = "") {
  const stat = await lstat(join(root, path));
  assert(!stat.isSymbolicLink(), `Симлинк не является выходом CI: ${path}`);
  if (stat.isFile()) return [path];
  assert(stat.isDirectory(), `Необычный файл в выходах CI: ${path}`);
  return (
    await Promise.all(
      (await readdir(join(root, path)))
        .sort()
        .map((entry) => filesIn(root, path ? `${path}/${entry}` : entry)),
    )
  ).flat();
}

export async function buildContext(root, env = process.env) {
  const { sha: commit, tree } = gitCommit(root);
  assert.equal(commit, env.GITHUB_SHA, "Checkout отличается от SHA текущего run");
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9]\d*$/);
  return {
    commit,
    tree,
    run_id: env.GITHUB_RUN_ID,
    repository: env.GITHUB_REPOSITORY,
    node_major: Number(process.versions.node.split(".")[0]),
    package_manager: JSON.parse(await readFile(join(root, "package.json"), "utf8")).packageManager,
    lock_sha256: sha256(await readFile(join(root, "pnpm-lock.yaml"))),
  };
}

/** Один неизменяемый снимок только выходов. Исходники и node_modules не передаются. */
export async function captureBuild(root, directory, context, outputs = buildOutputs) {
  const records = [];
  for (const output of outputs) {
    const paths = await filesIn(root, output);
    assert(paths.length, `Пустой выход сборки: ${output}`);
    for (const path of paths)
      records.push({
        path,
        sha256: sha256(await readFile(join(root, path))),
        mode: (await lstat(join(root, path))).mode & 0o777,
      });
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.equal(new Set(records.map((file) => file.path)).size, records.length);
  // Новый каталог: при ошибке не перезаписываем прежний артефакт.
  await mkdir(directory);
  try {
    for (const { path } of records) {
      await mkdir(dirname(join(directory, "outputs", path)), { recursive: true });
      await copyFile(join(root, path), join(directory, "outputs", path));
    }
    await writeFile(
      join(directory, "build.json"),
      JSON.stringify({ schema: 1, context, files: records }, null, 2) + "\n",
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Сначала проверяем весь снимок и пути, только затем атомарно заменяем отдельные файлы. */
export async function restoreBuild(root, directory, context, outputs = buildOutputs) {
  const manifest = JSON.parse(await readFile(join(directory, "build.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.context, context, "Сборка другого run/SHA/toolchain");
  assert(Array.isArray(manifest.files) && manifest.files.length);
  const paths = manifest.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(
    (await filesIn(directory)).sort(),
    ["build.json", ...paths.map((path) => `outputs/${path}`)].sort(),
  );
  for (const output of outputs)
    assert(
      paths.some((path) => path === output || path.startsWith(`${output}/`)),
      `Нет выхода ${output}`,
    );
  for (const file of manifest.files) {
    const { path } = file;
    assert(
      typeof path === "string" &&
        !path.split("/").some((part) => ["", ".", ".."].includes(part)) &&
        !path.includes("\\"),
    );
    assert(
      outputs.some((output) => path === output || path.startsWith(`${output}/`)),
      `Недопустимый выход: ${path}`,
    );
    assert(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777);
    assert.equal(
      sha256(await readFile(join(directory, "outputs", path))),
      file.sha256,
      `Повреждён выход: ${path}`,
    );
    let target = root;
    for (const part of path.split("/")) {
      target = join(target, part);
      const stat = await lstat(target).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      assert(!stat?.isSymbolicLink(), `Нельзя восстановить поверх симлинка: ${path}`);
    }
  }
  for (const file of manifest.files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    const pending = `${target}.ci-${process.pid}`;
    let ownsPending = false;
    try {
      await copyFile(join(directory, "outputs", file.path), pending, constants.COPYFILE_EXCL);
      ownsPending = true;
      await chmod(pending, file.mode);
      await rename(pending, target);
    } finally {
      if (ownsPending) await rm(pending, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory, ...extra] = process.argv.slice(2);
  assert(!extra.length);
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (action === "capture" || action === "restore") {
    assert(directory, "Нужен каталог артефакта сборки");
    await (action === "capture" ? captureBuild : restoreBuild)(
      root,
      directory,
      await buildContext(root),
    );
  } else {
    assert(!directory);
    if (action === "gate") checkGate(JSON.parse(process.env.CI_NEEDS));
    else if (action === "artifact-id") assert.match(process.env.ARTIFACT_ID ?? "", /^[1-9]\d*$/);
    else {
      try {
        runPhase(action, { root });
      } catch (error) {
        if (!(error instanceof PhaseExitError)) throw error;
        console.error(error.message);
        process.exitCode = error.exitCode;
      }
    }
  }
}
