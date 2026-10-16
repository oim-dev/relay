import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  StorageBlocker,
  StorageMigrationPlan,
  StorageStatus,
} from "@relay/contracts/storage-maintenance";
import {
  storageMigrationPlanSchema,
  storageStatusSchema,
} from "@relay/contracts/storage-maintenance";
import { STORAGE_CLI, STORAGE_NEXT } from "@relay/core/storage/data-model/errors";
import { AppError } from "@relay/core/shared/errors";
import { shellCommand } from "../src/command-kit.js";
import { printError } from "../src/output.js";
import { rememberTaskFailure } from "../src/presentation/board-tasks.js";
import {
  localizeStorageCommand,
  storageNextText,
  storageStatusText,
} from "../src/presentation/storage.js";
import { defaultTextOptions } from "../src/presentation/theme.js";
import { helpRuntime } from "./helpers/help.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";

const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli"));

function copiedReadOnly(cwd: string, hint: string) {
  assert.match(hint, /storage (?:status|migrate --dry-run)$/);
  return copiedStorageHint(cwd, hint);
}

/** Исполняем только известные storage-подсказки на собственной fixture, без настоящего npx. */
function copiedStorageHint(cwd: string, hint: string, expectedCode = 0) {
  assert.match(hint, /storage (?:status|reindex|migrate --dry-run)$/);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `npx() { test "$1" = '@oim-dev/relay-cli' || return 98; shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${hint}`,
    ],
    {
      cwd,
      env: cliEnv(),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, expectedCode, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const relative = join(path, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else
        result[relative] = createHash("sha256")
          .update(await readFile(join(root, relative)))
          .digest("hex");
    }
  }
  await walk("");
  return result;
}

test("shellCommand: ANSI-C quoting переносим для Bash 3.2 macOS и ksh93", () => {
  // `\uXXXX` Bash 3.2 оставляет буквально, а `\xHH` ksh93 продолжает следующими hex-цифрами.
  assert.equal(
    shellCommand(["a\tb\nc\r", "\u0001af\u007f", "\u0085 ", "' \\"]),
    "$'a\\tb\\nc\\r' $'\\001af\\177' $'\\302\\205\\342\\200\\250' ''\\'' \\'",
  );
});

test("STR-02: буквальная подстановка и несколько команд до shell quoting, JSON не локализован", async (t) => {
  const app = await fixture(t);
  const root = await tempDirectory(t);
  const cases = [
    "доллар $&",
    "суффикс $'",
    "префикс $`",
    "строка\nкириллица",
    "апостроф ' и пробел 漢字",
    "вместе $& $' $`\nкириллица",
  ];
  for (const [index, name] of cases.entries()) {
    const project = join(root, name);
    await cp(app.root, project, { recursive: true });
    const config = join(project, ".relay/config.json");
    const manifestPath = join(project, ".relay/storage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.dataModelVersion;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const prefix = shellCommand(["npx", "@oim-dev/relay-cli", "--local", "--config", config]);
    const localized = localizeStorageCommand(STORAGE_NEXT.migrate, prefix);
    assert.equal(
      localized,
      `Остановите процессы Relay и проверьте план: ${prefix} storage migrate --dry-run; затем выполните: ${prefix} storage migrate --backup-dir <каталог вне базы> --if-plan <planFingerprint>`,
    );
    const text = storageNextText(STORAGE_NEXT.migrate, 40, prefix);
    assert.deepEqual(hints(text), [
      `${prefix} storage migrate --dry-run`,
      `${prefix} storage migrate --backup-dir <каталог вне базы> --if-plan <planFingerprint>`,
    ]);
    assert.match(text, /Шаблон команды/);
    assert.doesNotMatch(text, /\u001b/);

    const before = await tree(project);
    const human = await invokeRaw(
      root,
      ["--local", ...(index % 2 ? [] : ["--config", config]), "task", "list"],
      {
        env: {
          COLUMNS: "40",
          FORCE_COLOR: "1",
          ...(index % 2 ? { RELAY_CONFIG: config } : {}),
        },
      },
    );
    assert.equal(human.code, 4, human.stdout);
    assert.equal(human.stderr, "");
    assert.deepEqual(hints(human.stdout), hints(text));
    assert.doesNotMatch(human.stdout, /\u001b/);
    assert.match(copiedReadOnly(root, hints(human.stdout)[0]!), /План переноса построен/);
    const error = await invoke(root, ["--local", "--config", config, "task", "list"]);
    assert.ok(!error.body.ok);
    assert.equal(error.body.error.code, "STORAGE_MIGRATION_REQUIRED");
    assert.equal((error.body.error.details as { next: string }).next, STORAGE_NEXT.migrate);
    const backupError = await invokeRaw(root, [
      "--local",
      "--config",
      config,
      "storage",
      "migrate",
    ]);
    assert.equal(backupError.code, 2, backupError.stdout);
    assert.deepEqual(hints(backupError.stdout), [
      `${prefix} storage migrate --backup-dir <каталог вне базы>`,
    ]);
    assert.match(backupError.stdout, /Шаблон команды/);
    assert.deepEqual(await tree(project), before);
  }
});

test("STR-04: ordinary/legacy требуют новый backup, migration использует исходный", async (t) => {
  const app = await fixture(t);
  const status = successful(await app.run<StorageStatus>(["storage", "status"])).data;
  const invocation = (args: readonly string[]) =>
    shellCommand(["npx", "@oim-dev/relay-cli", ...args]);
  for (const kind of ["operation", "legacy", "migration"] as const) {
    const text = storageStatusText(
      {
        ...status,
        status: "recovery-required",
        pending: { kind, path: "transactions/pending.json" },
      },
      invocation,
      { ...defaultTextOptions, width: 40 },
    );
    assert.equal(
      hints(text)[0],
      `npx @oim-dev/relay-cli storage migrate${kind === "migration" ? "" : " --backup-dir DIR"}`,
    );
    assert.doesNotMatch(hints(text)[0]!, /--if-plan/);
    assert.match(
      text,
      kind === "migration" ? /исходной\s+резервной\s+копией/ : /Шаблон:\s+замените DIR/,
    );
  }
  await mkdir(join(app.root, ".relay/transactions"), { recursive: true });
  await writeFile(
    join(app.root, ".relay/transactions/pending.json"),
    JSON.stringify({ schemaVersion: 1, changes: [] }),
  );
  const before = await tree(app.root);
  for (const args of [
    ["storage", "status"],
    ["storage", "migrate", "--dry-run"],
  ]) {
    const human = await invokeRaw(app.root, args);
    assert.equal(human.code, 4, human.stdout);
    assert.equal(human.stderr, "");
    assert.equal(hints(human.stdout)[0], "npx @oim-dev/relay-cli storage migrate --backup-dir DIR");
    assert.match(human.stdout, /Шаблон/);
  }
  const json = await app.run(["storage", "status"]);
  assert.ok(!json.body.ok);
  assert.equal((json.body.error.details as StorageStatus).pending?.kind, "operation");
  assert.deepEqual(await tree(app.root), before);
});

test("STR-06: 55 одинаковых блокеров — все возвращённые адреса, total и одно действие", async (t) => {
  const app = await fixture(t);
  const dir = join(app.root, ".relay/entities/unknown");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 55; i++)
    await writeFile(join(dir, `x${String(i).padStart(2, "0")}.json`), "{}");
  const before = await tree(app.root);
  for (const args of [
    ["storage", "status"],
    ["storage", "migrate", "--dry-run"],
  ]) {
    const json = await app.run(args);
    assert.ok(!json.body.ok);
    const data = json.body.error.details as StorageStatus;
    assert.equal(data.blockers.length, 50);
    assert.equal(data.blockersTotal, 55);
    for (const width of [40, 100]) {
      const human = await invokeRaw(app.root, args, { env: { COLUMNS: String(width) } });
      assert.equal(human.code, 4, human.stdout);
      assert.equal(human.stderr, "");
      assert.equal(hints(human.stdout).length, 1, human.stdout);
      assert.match(human.stdout, /Показано 50 из 55 блокеров/);
      assert.equal(human.stdout.match(/UNKNOWN_ENTITY_KIND/g)?.length, 2); // Код ошибки и заголовок группы.
      for (const blocker of data.blockers)
        assert.ok(human.stdout.includes(`  путь ${blocker.path}\n`), blocker.path);
      assert.ok(Buffer.byteLength(human.stdout) < 10_000);
      assert.doesNotMatch(human.stdout, /\u001b/);
    }
  }
  assert.deepEqual(await tree(app.root), before);
});

test("STR-06: смысловые различия блокеров не сливаются, ID остаются у каждого адреса", async (t) => {
  const app = await fixture(t);
  const status = successful(await app.run<StorageStatus>(["storage", "status"])).data;
  const blocker: StorageBlocker = {
    code: "STORAGE_DATA_CORRUPT",
    message: "Причина",
    owner: "task",
    path: "entities/tasks/a.json",
    id: "a",
    next: STORAGE_NEXT.status,
  };
  const blockers: StorageBlocker[] = [
    blocker,
    { ...blocker, path: "entities/tasks/b.json", id: "b" },
    ...[
      { owner: "document" },
      { step: "profile.1-to-2" },
      { current: 1 },
      { current: "1" },
      { expected: 2 },
      { message: "Другая причина" },
      { next: "Восстановите файл" },
    ].map((change, i) => ({
      ...blocker,
      ...change,
      path: `entities/tasks/other${i}.json`,
      id: `other${i}`,
    })),
  ];
  const text = storageStatusText(
    { ...status, status: "invalid", blockers, blockersTotal: blockers.length },
    (args) => shellCommand(["npx", "@oim-dev/relay-cli", ...args]),
    { ...defaultTextOptions, width: 40 },
  );
  assert.equal(text.match(/STORAGE_DATA_CORRUPT/g)?.length, 8);
  assert.equal(text.match(/Блокеров в группе: 2/g)?.length, 1);
  for (const item of blockers) assert.ok(text.includes(`  путь ${item.path}\n  ID ${item.id}`));
});

test("STR-08: пустой план не выдаёт нули changes за инвентаризацию насыщенного графа", async (t) => {
  const app = await fixture(t);
  await app.create("Родитель");
  await app.create("Ребёнок", ["--parent", "PRODUCT-1"]);
  const graph = successful(
    await app.run<{ totalEdges: number }>(["inspect", "graph", "list"]),
  ).data;
  assert.ok(graph.totalEdges > 0);
  const before = await tree(app.root);
  const plan = successful(
    await app.run<StorageMigrationPlan>(["storage", "migrate", "--dry-run"]),
  ).data;
  assert.equal(plan.status, "current");
  assert.deepEqual(plan.changes.relations, { kept: 0, revoked: 0, created: 0 });
  for (const width of [40, 100]) {
    const human = await invokeRaw(app.root, ["storage", "migrate", "--dry-run"], {
      env: { COLUMNS: String(width) },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /план не затрагивает/);
    assert.doesNotMatch(human.stdout, /сохраняются 0|резервов сохраняется 0/);
  }
  assert.deepEqual(await tree(app.root), before);
});

test("storage help: граница workspace и виды WAL доступны без открытия базы", async (t) => {
  const root = await tempDirectory(t);
  for (const leaf of [[], ["status"], ["migrate"], ["reindex"], ["reconcile-relations"]]) {
    const result = await invokeRaw(root, ["storage", ...leaf, "--help"], {
      env: { RELAY_CONFIG: join(root, "нет-конфига.json"), COLUMNS: "40" },
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /\u001b/);
    if (leaf[0] === "migrate") {
      assert.match(result.stdout, /восстановления обычного или legacy-WAL/);
      assert.match(result.stdout, /исходной проверенной копией/);
    }
    if (leaf[0] === "reindex" || leaf[0] === "reconcile-relations")
      assert.match(result.stdout, /прямым конфигом выбранного проекта, не реестром/);
  }
});

test("STR-05: status и dry-run показывают обязательный total для 0/1/50/55 предупреждений", async (t) => {
  const app = await fixture(t);
  let created = 0;
  for (const total of [0, 1, 50, 55]) {
    for (; created < total; created++)
      await writeFile(
        join(app.root, `.relay/note${String(created).padStart(2, "0")}.txt`),
        `Заметка ${created}\r\n\n`,
      );
    const before = await tree(app.root);
    for (const dryRun of [false, true]) {
      const args = dryRun ? ["storage", "migrate", "--dry-run"] : ["storage", "status"];
      const data = successful(await app.run(args)).data;
      const schema = dryRun ? storageMigrationPlanSchema : storageStatusSchema;
      const parsed = schema.parse(data);
      assert.equal(parsed.status, "current");
      assert.equal(parsed.warningsTotal, total);
      assert.equal(parsed.warnings.length, Math.min(total, 50));
      assert.ok(parsed.warnings.every((warning) => warning.code === "STORAGE_FOREIGN_FILE"));
      assert.equal(schema.safeParse({ ...parsed, warningsTotal: undefined }).success, false);
      for (const width of [40, 100]) {
        const human = await invokeRaw(app.root, args, { env: { COLUMNS: String(width) } });
        assert.equal(human.code, 0, human.stdout);
        assert.equal(human.stderr, "");
        assert.doesNotMatch(human.stdout, /\u001b/);
        if (total === 0) assert.match(human.stdout, /Предупреждений нет\./);
        else
          assert.ok(
            human.stdout.includes(`Показано ${Math.min(total, 50)} из ${total} предупреждений.`),
            human.stdout,
          );
        assert.equal(
          human.stdout.match(/STORAGE_FOREIGN_FILE/g)?.length ?? 0,
          parsed.warnings.length,
        );
        for (const warning of parsed.warnings)
          assert.ok(human.stdout.includes(warning.path!), warning.path);
      }
    }
    assert.deepEqual(await tree(app.root), before);
  }
});

for (const damage of ["marker", "file-hashes"] as const) {
  test(`STR-01: ${damage} блокирует no-op; настоящая миграция сохраняет предупреждение`, async (t) => {
    const app = await fixture(t);
    const config = join(app.root, ".relay/config.json");
    let damagedPath = "runtime/index-stale.json";
    if (damage === "marker") {
      await mkdir(join(app.root, ".relay/runtime"), { recursive: true });
      await writeFile(
        join(app.root, ".relay", damagedPath),
        JSON.stringify({ paths: ["entities/products/passport.json"], total: 1 }),
      );
    } else {
      let changed = false;
      for (const path of Object.keys(await tree(app.root))) {
        if (!path.startsWith(".relay/relations/") || !path.endsWith(".json")) continue;
        const relations = JSON.parse(await readFile(join(app.root, path), "utf8"));
        if (!Array.isArray(relations.entries) || relations.entries.length === 0) continue;
        await writeFile(join(app.root, path), JSON.stringify({ ...relations, entries: [] }));
        damagedPath = path.slice(".relay/".length);
        changed = true;
        break;
      }
      assert.ok(changed, "Для сценария нужно хотя бы одно реальное отношение");
    }
    const selection = ["--local", "--config", config];
    const reindex = shellCommand(["npx", "@oim-dev/relay-cli", ...selection, "storage", "reindex"]);
    const before = await tree(app.root);
    for (const dryRun of [false, true]) {
      const args = [...selection, "storage", ...(dryRun ? ["migrate", "--dry-run"] : ["status"])];
      const result = await app.run(args);
      assert.equal(result.code, 4, result.stdout);
      assert.equal(result.stderr, "");
      assert.ok(!result.body.ok);
      assert.equal(result.body.error.code, "STORAGE_INDEX_STALE");
      const schema = dryRun ? storageMigrationPlanSchema : storageStatusSchema;
      const data = schema.parse(result.body.error.details);
      assert.equal(data.status, "invalid");
      if (dryRun)
        assert.equal(storageMigrationPlanSchema.parse(result.body.error.details).applicable, false);
      assert.equal(data.warningsTotal, 0);
      const blocker = data.blockers.find((item) => item.code === "STORAGE_INDEX_STALE");
      assert.ok(blocker);
      assert.equal(blocker.path, damagedPath);
      assert.match(blocker.next, /storage reindex/);
      const human = await invokeRaw(app.root, args, { env: { COLUMNS: "40" } });
      assert.equal(human.code, 4, human.stdout);
      assert.equal(human.stderr, "");
      assert.ok(hints(human.stdout).includes(reindex), human.stdout);
      assert.doesNotMatch(human.stdout, /Хранилище актуально|Перенос не требуется/);
    }
    const migrate = await app.run([...selection, "storage", "migrate"]);
    assert.equal(migrate.code, 4, migrate.stdout);
    assert.equal(migrate.stderr, "");
    assert.ok(!migrate.body.ok);
    assert.equal(migrate.body.error.code, "STORAGE_INDEX_STALE");
    assert.doesNotMatch(migrate.stdout, /"indexes"\s*:\s*"passed"/);
    assert.deepEqual(await tree(app.root), before);

    const manifestPath = join(app.root, ".relay/storage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.dataModelVersion;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const oldBefore = await tree(app.root);
    for (const args of [
      ["storage", "status"],
      ["storage", "migrate", "--dry-run"],
    ]) {
      const data = successful(await app.run<StorageStatus>(args)).data;
      assert.equal(data.status, "migration-required");
      assert.equal(data.blockersTotal, 0);
      assert.equal(data.warningsTotal, 1);
      assert.equal(data.warnings[0]?.code, "STORAGE_INDEX_STALE");
      const human = await invokeRaw(app.root, args, { env: { COLUMNS: "40" } });
      assert.equal(human.code, 0, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /Показано 1 из 1 предупреждений\./);
    }
    assert.deepEqual(await tree(app.root), oldBefore);
  });
}

for (const damage of ["marker", "file-hashes"] as const) {
  for (const selection of ["config", "env", "workspace"] as const) {
    test(`STR-01 human migrate: ${damage}, ${selection}, адресные status/reindex без скрытого ремонта`, async (t) => {
      const base = await fixture(t);
      const root = await tempDirectory(t);
      const projectName = "проект $& $' $`\n漢字";
      const project = join(root, projectName);
      await cp(base.root, project, { recursive: true });
      const config = join(project, ".relay/config.json");
      let path = "runtime/index-stale.json";
      if (damage === "marker") {
        await mkdir(join(project, ".relay/runtime"), { recursive: true });
        await writeFile(join(project, ".relay", path), JSON.stringify({ paths: [], total: 0 }));
      } else {
        let changed = false;
        for (const entry of Object.keys(await tree(project))) {
          if (!entry.startsWith(".relay/relations/") || !entry.endsWith(".json")) continue;
          const relations = JSON.parse(await readFile(join(project, entry), "utf8"));
          if (!Array.isArray(relations.entries) || !relations.entries.length) continue;
          await writeFile(join(project, entry), JSON.stringify({ ...relations, entries: [] }));
          path = entry.slice(".relay/".length);
          changed = true;
          break;
        }
        assert.ok(changed, "Проверка требует расхождения реального файла отношений с индексом");
      }
      const actor = "проверка '$& 漢字";
      const args = ["--local", "--actor", actor];
      const env: NodeJS.ProcessEnv = { RELAY_SERVER_URL: "http://127.0.0.1:1" };
      if (selection === "env") env.RELAY_CONFIG = config;
      else if (selection === "config") args.push("--config", config);
      else {
        const alpha = join(root, "невыбранный проект");
        await mkdir(alpha);
        successful(await invoke(alpha, ["init"]));
        const registry = join(root, "relay.workspace.json");
        await writeFile(
          registry,
          JSON.stringify({
            version: 1,
            projects: { alpha: { path: alpha }, beta: { config } },
          }),
        );
        args.push("--config", registry, "--project", "beta");
      }
      const before = await tree(root);
      const json = await invoke(root, [...args, "storage", "migrate"], { env });
      assert.equal(json.code, 4, json.stdout);
      assert.equal(json.stderr, "");
      assert.ok(!json.body.ok);
      assert.equal(json.body.error.code, "STORAGE_INDEX_STALE");
      const details = json.body.error.details as { blockers: StorageBlocker[]; next: string };
      assert.ok(details.next.includes(STORAGE_CLI), "JSON сохраняет переносимую подсказку Core");
      assert.ok(details.blockers.some((blocker) => blocker.path === path));
      const invocation = (tokens: readonly string[]) =>
        shellCommand([
          "npx",
          "@oim-dev/relay-cli",
          "--local",
          "--config",
          config,
          "--actor",
          actor,
          "--format",
          "text",
          ...tokens,
        ]);
      const status = invocation(["storage", "status"]);
      const reindex = invocation(["storage", "reindex"]);
      for (const width of [24, 40, 100]) {
        const result = await invokeRaw(root, [...args, "--format", "text", "storage", "migrate"], {
          env: { ...env, COLUMNS: String(width), FORCE_COLOR: "1" },
        });
        assert.equal(result.code, 4, result.stdout);
        assert.equal(result.stderr, "");
        assert.doesNotMatch(
          result.stdout,
          /Подключение не установлено|<config>|"blockers"|"next"|\u001b/,
        );
        assert.ok(result.stdout.includes(path), result.stdout);
        assert.equal(hints(result.stdout).filter((hint) => hint === status).length, 1);
        assert.equal(hints(result.stdout).filter((hint) => hint === reindex).length, 1);
        assert.ok(hints(result.stdout).every((hint) => !hint.includes("--project")));
      }
      const again = await invoke(root, [...args, "storage", "migrate"], { env });
      assert.deepEqual(again.body, json.body, "Human не локализует исходную машинную ошибку");
      assert.deepEqual(
        await tree(root),
        before,
        "Ошибка migrate не чинит базу и не открывает её с recovery",
      );
      const diagnosed = copiedStorageHint(root, status, 4);
      assert.match(diagnosed, /STORAGE_INDEX_STALE/);
      assert.deepEqual(await tree(root), before, "Скопированный status остаётся read-only");

      // Единственная запись — отдельно и явно скопированная команда reindex своей fixture.
      assert.match(copiedStorageHint(root, reindex), /Индексы единого хранилища перестроены/);
      assert.match(copiedStorageHint(root, status), /Хранилище актуально/);
      const after = await tree(root);
      for (const [entry, hash] of Object.entries(before)) {
        const managed = `${projectName}/.relay/`;
        if (
          !entry.startsWith(`${managed}.indexes/`) &&
          entry !== `${managed}runtime/index-stale.json`
        )
          assert.equal(after[entry], hash, entry);
      }
    });
  }
}

test("STR-01 error details: все вложенные причины адресны; JSON не подменяется", () => {
  const details = {
    reason: "invalid",
    blockersTotal: 3,
    blockers: [
      {
        code: "STORAGE_INDEX_STALE",
        message: "Индекс устарел",
        path: "runtime/index-stale.json",
        next: `${STORAGE_CLI} storage reindex`,
      },
      {
        code: "STORAGE_DATA_CORRUPT",
        message: "Запись повреждена",
        owner: "task",
        id: "Task0001",
        path: "entities/tasks/Task0001.json",
        step: "profile.1-to-2",
        current: 1,
        expected: 2,
        next: "Восстановите запись из проверенной копии",
      },
      {
        code: "STORAGE_VERSION_UNSUPPORTED",
        message: "Новая версия данных",
        path: "entities/tasks/Task0002.json",
        next: "Откройте базу совместимой версией Relay",
      },
    ],
  };
  const original = structuredClone(details);
  const error = new AppError("STORAGE_INDEX_STALE", "Миграция неприменима", 4, details);
  const command = (args: readonly string[]) =>
    shellCommand([
      "npx",
      "@oim-dev/relay-cli",
      "--local",
      "--config",
      "/project/config.json",
      ...args,
    ]);
  for (const width of [24, 40, 100]) {
    const output = helpRuntime("/unused");
    printError(output.io.stdout, error, {
      format: "text",
      text: { width, color: false },
      maintenanceCommand: command([]),
      recovery: { command, maintenance: command },
    });
    const text = output.output();
    for (const blocker of details.blockers) assert.ok(text.includes(blocker.path), text);
    assert.match(text, /Task0001/);
    assert.match(text, /profile\.1-to-2/);
    assert.match(text, /Фактически:\s+1/);
    assert.match(text, /Ожидалось:\s+2/);
    assert.match(text, /Всего блокеров:\s+3/);
    assert.match(text, /Сначала восстановите/);
    assert.match(text, /Только после/);
    assert.match(text, /Откройте базу/);
    assert.doesNotMatch(text, /<config>|"blockers"|"next"|Подключение не установлено/);
    assert.equal(hints(text).filter((hint) => hint.endsWith("storage reindex")).length, 1);
  }
  assert.deepEqual(details, original);
  const json = helpRuntime("/unused");
  printError(json.io.stdout, error, { format: "json" });
  assert.deepEqual(JSON.parse(json.output()).error.details, original);
});

test("storage recovery не заменяет taskErrorRecovery в общем printError", () => {
  const details = { current: 3 };
  const error = new AppError("REVISION_CONFLICT", "Исходная ошибка задачи", 4, details);
  const command = (args: readonly string[]) => shellCommand(["npx", "@oim-dev/relay-cli", ...args]);
  rememberTaskFailure(error, {
    reference: "PRODUCT-7",
    group: "criterion",
    action: "complete",
    invoke: command,
  });
  const output = helpRuntime("/unused");
  printError(output.io.stdout, error, { format: "text", text: { width: 24, color: false } });
  assert.ok(hints(output.output()).includes(command(["task", "get", "PRODUCT-7"])));
  assert.deepEqual(error.details, details);
});
