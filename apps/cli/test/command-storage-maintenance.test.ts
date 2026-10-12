import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  storageMigrationPlanSchema,
  storageMigrationResultSchema,
  storageStatusSchema,
} from "@relay/contracts/storage-maintenance";
import { fixture, invoke, invokeRaw, successful, failed, tempDirectory } from "./helpers/cli.js";
import { restoreFixtureTree } from "../../../packages/core/test/fixtures/data-migrations/restore-tree.mjs";

const FIXTURES = fileURLToPath(
  new URL("../../../packages/core/test/fixtures/data-migrations/", import.meta.url),
);

/** Побайтовый снимок дерева: путь → sha256, "dir" или цель symlink. */
async function treeHashes(base: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (path: string) => {
    const absolute = path ? join(base, path) : base;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) result.set(path, `symlink:${await readlink(absolute)}`);
    else if (info.isDirectory()) {
      if (path) result.set(path, "dir");
      for (const name of (await readdir(absolute)).sort())
        await visit(path ? `${path}/${name}` : name);
    } else
      result.set(
        path,
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      );
  };
  await visit("");
  return result;
}

async function frozenBase(t: TestContext, name: string): Promise<string> {
  const project = await tempDirectory(t);
  await restoreFixtureTree(join(FIXTURES, name, "base.json.gz"), project);
  return project;
}

async function editJson(path: string, change: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Server-заглушка: любой запрос считается нарушением «без сетевого запроса». */
async function countingServer(t: TestContext) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

const human = { env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "80" } };

test("storage status/migrate: русская справка без конфигурации и проверка несовместимых параметров", async (t) => {
  const empty = await tempDirectory(t);
  for (const args of [
    ["storage", "--help"],
    ["storage", "status", "--help"],
    ["storage", "migrate", "--help"],
  ]) {
    const help = await invokeRaw(empty, args);
    assert.equal(help.code, 0, help.stdout);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /Примеры:/);
    assert.match(help.stdout, /--local \\\n\s+--config \/project\/\.relay\/config\.json storage/);
  }
  const migrateHelp = await invokeRaw(empty, ["storage", "migrate", "--help"]);
  for (const option of ["--dry-run", "--backup-dir <dir>", "--if-plan <fingerprint>"])
    assert.ok(migrateHelp.stdout.includes(option), option);
  failed(
    await invoke(empty, ["storage", "migrate", "--dry-run", "--if-plan", "a".repeat(64)]),
    "INVALID_ARGUMENT",
  );
  failed(
    await invoke(empty, ["--local", "storage", "migrate", "--if-plan", "не-отпечаток"]),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(await readdir(empty), [], "справка и разбор не создают файлов");
});

test("storage status: текущая база — current, exit 0, JSON по схеме, база не меняется", async (t) => {
  const app = await fixture(t);
  const before = await treeHashes(app.root);
  const json = successful(await app.run<unknown>(["storage", "status"]));
  const status = storageStatusSchema.parse(json.data);
  assert.equal(status.status, "current");
  assert.equal(status.layout, "unified-4");
  assert.equal(status.project.configPath, join(app.root, ".relay/config.json"));
  assert.deepEqual(status.blockers, []);
  const text = await invokeRaw(app.root, ["--local", "storage", "status"], human);
  assert.equal(text.code, 0, text.stdout);
  assert.equal(text.stderr, "");
  assert.doesNotMatch(text.stdout, /\u001b|"ok":/);
  assert.match(text.stdout, /^Хранилище актуально — перенос не требуется/);
  assert.match(text.stdout, /Статус:\s+current/);
  assert.match(text.stdout, /Профиль данных:\s+2 → 2/);
  const hint = text.stdout.split("\n").find((line) => line.startsWith("npx @oim-dev/relay-cli"));
  assert.equal(
    hint,
    `npx @oim-dev/relay-cli --local --config ${join(app.root, ".relay/config.json")} doctor check`,
  );
  assert.deepEqual(await treeHashes(app.root), before, "status не меняет ни одного байта");
});

test("storage status: формат 4 прежней версии Relay — migration-required, exit 0, следующий шаг dry-run", async (t) => {
  const project = await frozenBase(t, "physical4-v0.7.0-52c4609");
  const before = await treeHashes(project);
  const status = storageStatusSchema.parse(
    successful(await invoke(project, ["--local", "storage", "status"])).data,
  );
  assert.equal(status.status, "migration-required");
  assert.equal(status.current.dataModel, null);
  assert.ok(status.project.id);
  const text = await invokeRaw(project, ["--local", "storage", "status"], human);
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, /^Требуется перенос хранилища/);
  const config = join(project, ".relay/config.json");
  const commands = text.stdout.split("\n").filter((line) => line.startsWith("npx "));
  assert.deepEqual(commands, [
    `npx @oim-dev/relay-cli --local --config ${config} storage migrate --dry-run`,
    `npx @oim-dev/relay-cli --local --config ${config} storage migrate --backup-dir DIR --if-plan PLAN_FINGERPRINT`,
  ]);
  assert.deepEqual(await treeHashes(project), before);
});

test("A14: историческая конфигурация с аудитом projectSettings под иным именем и проект реестра", async (t) => {
  const app = await fixture(t);
  const relay = join(app.root, ".relay");
  // Историческая форма (bf95518…1afe138): аудит projectSettings.requests/events в конфигурации.
  await editJson(join(relay, "config.json"), (config) => {
    config.projectSettings = {
      version: 1,
      name: "Исторический проект",
      slug: "historic",
      revision: 2,
      events: [{ revision: 1, actor: "relay", at: "2026-09-20T00:00:00.000Z", action: "create" }],
      requests: {
        "req-1": {
          hash: "a".repeat(64),
          result: { id: config.projectId, key: "PROJECT", revision: 1 },
        },
      },
    };
  });
  await rename(join(relay, "config.json"), join(relay, "project-a.json"));
  const before = await treeHashes(app.root);
  const named = storageStatusSchema.parse(
    successful(
      await invoke(app.root, ["--local", "--config", ".relay/project-a.json", "storage", "status"]),
    ).data,
  );
  assert.equal(named.status, "current");
  assert.equal(named.project.configPath, join(relay, "project-a.json"));
  // Та же конфигурация открывается и обычной командой.
  successful(await invoke(app.root, ["--config", ".relay/project-a.json", "project", "get"]));

  const second = await fixture(t);
  const workspace = await tempDirectory(t);
  await writeFile(
    join(workspace, "relay.workspace.json"),
    JSON.stringify({
      version: 1,
      projects: {
        alpha: { config: join(relay, "project-a.json") },
        beta: { path: second.root },
      },
    }),
  );
  const alpha = successful(
    await invoke(workspace, ["--local", "--project", "alpha", "storage", "status"]),
  );
  assert.equal(storageStatusSchema.parse(alpha.data).project.root, relay);
  assert.equal(alpha.meta?.project, "alpha");
  const beta = successful(
    await invoke(workspace, ["--local", "--project", "beta", "storage", "status"]),
  );
  assert.equal(storageStatusSchema.parse(beta.data).project.root, join(second.root, ".relay"));
  failed(await invoke(workspace, ["--local", "storage", "status"]), "PROJECT_REQUIRED");
  failed(
    await invoke(workspace, ["--local", "--project", "gamma", "storage", "status"]),
    "PROJECT_NOT_FOUND",
    3,
  );
  assert.deepEqual(await treeHashes(app.root), before);
});

test("A14: конфигурация, не проходящая схему, — invalid с путём, база не меняется", async (t) => {
  const app = await fixture(t);
  const relay = join(app.root, ".relay");
  // Поля history не было ни в одной версии: такая конфигурация считается повреждённой.
  await editJson(join(relay, "config.json"), (config) => {
    config.history = { enabled: true };
  });
  await rename(join(relay, "config.json"), join(relay, "project-a.json"));
  const before = await treeHashes(app.root);
  const result = await invoke(app.root, [
    "--local",
    "--config",
    ".relay/project-a.json",
    "storage",
    "status",
  ]);
  failed(result, "STORAGE_DATA_CORRUPT", 5);
  assert.ok(!result.body.ok);
  const report = storageStatusSchema.parse(result.body.error.details);
  assert.equal(report.status, "invalid");
  assert.equal(report.project.configPath, join(relay, "project-a.json"));
  assert.ok(
    report.blockers.some(
      (blocker) => blocker.code === "STORAGE_DATA_CORRUPT" && blocker.path === "project-a.json",
    ),
    JSON.stringify(report.blockers),
  );
  assert.deepEqual(await treeHashes(app.root), before);
});

test("storage status: recovery-required, unsupported и invalid — ненулевой exit, отчёт в details, база не меняется", async (t) => {
  const app = await fixture(t);
  const relay = join(app.root, ".relay");
  await mkdir(join(relay, "transactions"), { recursive: true });
  await writeFile(
    join(relay, "transactions/pending.json"),
    JSON.stringify({ schemaVersion: 1, changes: [] }),
  );
  let before = await treeHashes(app.root);
  const recovery = await app.run(["--local", "storage", "status"]);
  failed(recovery, "STORAGE_RECOVERY_REQUIRED", 4);
  assert.ok(!recovery.body.ok);
  const report = storageStatusSchema.parse(recovery.body.error.details);
  assert.equal(report.status, "recovery-required");
  assert.deepEqual(report.pending, { kind: "operation", path: "transactions/pending.json" });
  const recoveryText = await invokeRaw(app.root, ["--local", "storage", "status"], human);
  assert.equal(recoveryText.code, 4);
  assert.doesNotMatch(recoveryText.stdout, /\u001b/);
  assert.match(recoveryText.stdout, /^Ошибка: STORAGE_RECOVERY_REQUIRED\nТребуется завершить/);
  assert.match(
    recoveryText.stdout,
    /Незавершённая транзакция: обычная операция, transactions\/pending\.json/,
  );
  assert.deepEqual(await treeHashes(app.root), before, "recovery не выполнялся");
  await rm(join(relay, "transactions/pending.json"));

  await editJson(join(relay, "storage.json"), (manifest) => {
    manifest.dataModelVersion = 99;
  });
  before = await treeHashes(app.root);
  const unsupported = await app.run(["--local", "storage", "status"]);
  failed(unsupported, "STORAGE_VERSION_UNSUPPORTED", 4);
  assert.ok(!unsupported.body.ok);
  const unsupportedReport = storageStatusSchema.parse(unsupported.body.error.details);
  assert.equal(unsupportedReport.status, "unsupported");
  assert.equal(unsupportedReport.blockers[0]?.path, "storage.json");
  const unsupportedText = await invokeRaw(app.root, ["--local", "storage", "status"], human);
  assert.match(unsupportedText.stdout, /Блокеры\nSTORAGE_VERSION_UNSUPPORTED — /);
  assert.match(unsupportedText.stdout, /  Действие:\n\S/);
  assert.deepEqual(await treeHashes(app.root), before);
  await editJson(join(relay, "storage.json"), (manifest) => {
    manifest.dataModelVersion = 2;
  });

  const passport = join(relay, "entities/products/passport.json");
  await writeFile(passport, "{секрет-пользователя");
  before = await treeHashes(app.root);
  const invalid = await app.run(["--local", "storage", "status"]);
  assert.ok(!invalid.body.ok);
  assert.equal(invalid.body.error.code, "STORAGE_DATA_CORRUPT");
  assert.equal(invalid.code, 5);
  const invalidReport = storageStatusSchema.parse(invalid.body.error.details);
  assert.equal(invalidReport.status, "invalid");
  assert.ok(
    invalidReport.blockers.some((blocker) => blocker.path === "entities/products/passport.json"),
  );
  assert.doesNotMatch(
    invalid.stdout,
    /секрет-пользователя/,
    "пользовательское содержание не выводится",
  );
  assert.deepEqual(await treeHashes(app.root), before);
});

test("HTTP-режим: storage status/migrate/reindex/reconcile-relations — LOCAL_REQUIRED без запроса к Server", async (t) => {
  const app = await fixture(t);
  const server = await countingServer(t);
  const before = await treeHashes(app.root);
  for (const operation of [
    ["status"],
    ["migrate"],
    ["migrate", "--dry-run"],
    ["reindex"],
    ["reconcile-relations"],
  ]) {
    failed(
      await app.run(["--server-url", server.url, "storage", ...operation]),
      "LOCAL_REQUIRED",
      2,
    );
    failed(
      await app.run(["storage", ...operation], { env: { RELAY_SERVER_URL: server.url } }),
      "LOCAL_REQUIRED",
      2,
    );
  }
  // Адрес из config server.url — тот же отказ без запроса.
  await editJson(join(app.root, ".relay/config.json"), (config) => {
    config.server = { ...(config.server as object), url: server.url };
  });
  const configured = await treeHashes(app.root);
  for (const operation of ["status", "migrate", "reindex", "reconcile-relations"])
    failed(await app.run(["storage", operation]), "LOCAL_REQUIRED", 2);
  const text = await invokeRaw(app.root, ["storage", "status"], human);
  assert.equal(text.code, 2);
  assert.match(text.stdout, /^Ошибка: LOCAL_REQUIRED/);
  assert.match(text.stdout, /Следующий шаг:\nПовторите команду с --local и --config/);
  assert.equal(server.requests(), 0, "ни одного сетевого запроса");
  assert.deepEqual(await treeHashes(app.root), configured);
  assert.notDeepEqual(before, configured);
});

test("A02/A13: dry-run не меняет базу и даёт отпечаток; migrate текущей базы — no-op без backup", async (t) => {
  const project = await frozenBase(t, "physical4-v0.7.0-52c4609");
  const before = await treeHashes(project);
  const plan = storageMigrationPlanSchema.parse(
    successful(await invoke(project, ["--local", "storage", "migrate", "--dry-run"])).data,
  );
  assert.equal(plan.applicable, true);
  const text = await invokeRaw(project, ["--local", "storage", "migrate", "--dry-run"], human);
  assert.equal(text.code, 0, text.stdout);
  assert.doesNotMatch(text.stdout, /\u001b/);
  assert.match(text.stdout, /Резервная копия:\s+при --dry-run не создаётся/);
  assert.ok(
    text.stdout.includes(`storage migrate --backup-dir DIR --if-plan ${plan.planFingerprint}`),
    text.stdout,
  );
  assert.deepEqual(await treeHashes(project), before, "dry-run не меняет ни одного байта");

  const app = await fixture(t);
  const current = await treeHashes(app.root);
  const empty = storageMigrationPlanSchema.parse(
    successful(await app.run(["--local", "storage", "migrate", "--dry-run"])).data,
  );
  assert.deepEqual(empty.steps, []);
  const result = storageMigrationResultSchema.parse(
    successful(await app.run(["--local", "storage", "migrate"])).data,
  );
  assert.equal(result.migrated, false);
  assert.equal(result.backup, null);
  const noop = await invokeRaw(app.root, ["--local", "storage", "migrate"], human);
  assert.equal(noop.code, 0, noop.stdout);
  assert.match(noop.stdout, /^Перенос не требуется — хранилище не изменено/);
  assert.match(noop.stdout, /Резервная копия:\s+не создавалась/);
  assert.deepEqual(await treeHashes(app.root), current, "no-op не меняет файлы");
});

test("профиль 1 → 2: шаг profile в dry-run и результате, подсказка Core с фактическим config, счётчики", async (t) => {
  const project = await frozenBase(t, "physical4-v0.7.0-52c4609");
  const config = join(project, ".relay/config.json");
  const plan = storageMigrationPlanSchema.parse(
    successful(await invoke(project, ["--local", "storage", "migrate", "--dry-run"])).data,
  );
  assert.deepEqual(
    plan.steps.map(({ id, type }) => ({ id, type })),
    [{ id: "profile.1-to-2", type: "profile" }],
  );
  const dry = await invokeRaw(project, ["--local", "storage", "migrate", "--dry-run"], human);
  assert.match(dry.stdout, /1\. Метка профиля данных 1 → 2 \(profile\.1-to-2, версия 1\)/);

  // Изменяющий перенос без backup: JSON сохраняет плейсхолдер Core, text — фактический путь.
  const before = await treeHashes(project);
  const refused = await invoke(project, ["--local", "storage", "migrate"]);
  failed(refused, "STORAGE_BACKUP_REQUIRED", 2);
  assert.ok(!refused.body.ok);
  const next = (refused.body.error.details as { next: string }).next;
  assert.ok(
    next.includes("npx @oim-dev/relay-cli --local --config <config> storage migrate"),
    next,
  );
  const text = await invokeRaw(project, ["--local", "storage", "migrate"], human);
  assert.equal(text.code, 2);
  assert.ok(
    text.stdout
      .split("\n")
      .some((line) =>
        line.startsWith(
          `npx @oim-dev/relay-cli --local --config ${config} storage migrate --backup-dir`,
        ),
      ),
    text.stdout,
  );
  assert.doesNotMatch(text.stdout, /<config>/);
  assert.deepEqual(await treeHashes(project), before);

  const backups = await tempDirectory(t);
  const result = storageMigrationResultSchema.parse(
    successful(
      await invoke(project, [
        "--local",
        "storage",
        "migrate",
        "--backup-dir",
        backups,
        "--if-plan",
        plan.planFingerprint,
      ]),
    ).data,
  );
  assert.equal(result.migrated, true);
  assert.deepEqual(result.profiles, { from: 1, to: 2 });
  assert.equal(result.steps[0]?.type, "profile");
  assert.ok(result.backup?.path.startsWith(`${backups}/`));
  const owners = Object.values(result.counts.owners);
  assert.equal(
    owners.reduce((sum, count) => sum + count.changed, 0),
    result.counts.changed,
    "changed по категориям в сумме равен общему",
  );
  assert.ok(result.counts.changed > 0);
  assert.equal(
    storageStatusSchema.parse(
      successful(await invoke(project, ["--local", "storage", "status"])).data,
    ).status,
    "current",
  );
});

test("обычная local-команда на базе профиля 1: text подставляет фактический config, JSON хранит плейсхолдер", async (t) => {
  const project = await frozenBase(t, "physical4-v0.7.0-52c4609");
  const config = join(project, ".relay/config.json");
  const before = await treeHashes(project);
  const json = await invoke(project, ["--local", "--config", ".relay/config.json", "task", "list"]);
  failed(json, "STORAGE_MIGRATION_REQUIRED", 4);
  assert.ok(!json.body.ok);
  assert.match(
    (json.body.error.details as { next: string }).next,
    /npx @oim-dev\/relay-cli --local --config <config> storage migrate --dry-run/,
  );
  const text = await invokeRaw(
    project,
    ["--local", "--config", ".relay/config.json", "task", "list"],
    human,
  );
  assert.equal(text.code, 4);
  assert.doesNotMatch(text.stdout, /<config>|\u001b/);
  const step = text.stdout.slice(text.stdout.indexOf("Следующий шаг:\n"));
  assert.deepEqual(step.trimEnd().split("\n"), [
    "Следующий шаг:",
    "Остановите процессы Relay и проверьте план:",
    `npx @oim-dev/relay-cli --local --config ${config} storage migrate --dry-run`,
    "Затем выполните:",
    `npx @oim-dev/relay-cli --local --config ${config} storage migrate --backup-dir <каталог вне базы> --if-plan <planFingerprint>`,
  ]);
  assert.match(text.stdout, /Фактически: 1\n/);
  assert.deepEqual(await treeHashes(project), before, "чтение не меняет базу");
});
