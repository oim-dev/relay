import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { StorageService } from "../src/application/storage/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { defaultConfig } from "../src/domain/config.js";
import { AppError } from "../src/shared/errors.js";
import { relativePathSchema } from "../src/storage/entity-store/format.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { initialize, openWorkspace, Workspace } from "../src/storage/workspace.js";

/** Состав каталогов, symlink и точные байты: отказ не должен оставлять даже .gitignore. */
async function snapshot(root: string): Promise<Record<string, Buffer | string>> {
  const result: Record<string, Buffer | string> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) {
        result[path] = "directory";
        await visit(path);
      } else if (entry.isSymbolicLink())
        result[path] = `symlink:${await readlink(join(root, path))}`;
      else result[path] = await readFile(join(root, path));
    }
  };
  await visit("");
  return result;
}

function service(configPath: string) {
  return new StorageService(
    new Workspace(configPath, dirname(configPath), structuredClone(defaultConfig)),
  );
}

test("init: ASCII basename открывается в ASCII, Unicode, пробельном и quoted каталоге", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["ascii", "каталог", "with spaces", "кавычки ' и \""])
    for (const name of ["config.json", "custom-v1_2.json", "local"])
      await t.test(`${directory}/${name}`, async () => {
        const configPath = join(root, directory, name, name);
        const created = await initialize(root, "tasks", configPath);
        const before = await snapshot(root);
        const reopened = await openWorkspace(root, configPath);
        assert.equal(reopened.configPath, created.configPath);
        assert.equal(reopened.config.projectId, created.config.projectId);
        assert.deepEqual(reopened.config.projectSettings, created.config.projectSettings);
        const context = await new GraphService(reopened).context({ root: "PRODUCT" });
        assert.equal(context.nodes.length, 2);
        assert.equal(context.edges.length, 1);
        assert.equal(context.edges[0]!.type, "part-of");
        assert.deepEqual(await snapshot(root), before);
      });
});

test("init: неподдерживаемые и зарезервированные basenames отклоняются до mkdir на обоих входах Core", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    "нестандартный.json",
    "my config.json",
    "quote'.json",
    'quote".json',
    "bad\\name.json",
    "storage.json",
    "relay.workspace.json",
    "entities",
    "relations",
    "keyspaces",
    ".indexes",
    "transactions",
    "runtime",
    "operations",
    "history",
    "product",
    "boards",
    "tasks",
    "task-activity",
    "entity-deletions",
    "relations.json",
    "kanban-pending.json",
    ".gitignore",
    ".gitkeep",
  ])
    await t.test(name, async () => {
      const configPath = join(root, "ещё нет ' каталога", name);
      for (const attempt of [
        () => initialize(root, "tasks", configPath),
        () => service(configPath).initialize(),
      ]) {
        await assert.rejects(attempt(), (error: unknown) => {
          assert(error instanceof AppError);
          assert.equal(error.code, "INVALID_ARGUMENT");
          assert.equal(error.exitCode, 2);
          assert.deepEqual(error.details, { configPath, basename: name });
          assert.match(error.message, /config\.json/);
          return true;
        });
        assert.deepEqual(await snapshot(root), {});
      }
    });
  // Публичный preflight не расширяет разрешённые пути обычного WAL.
  for (const path of [
    "../config.json",
    "/config.json",
    "a/../config.json",
    "./config.json",
    "a//b",
    "my config.json",
  ])
    assert.equal(relativePathSchema.safeParse(path).success, false, path);
});

test("init: чужие файлы сохраняются, повтор после предметной записи не меняет ни одного байта", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-repeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "custom.json");
  await writeFile(join(root, "README.txt"), "  чужое содержание\r\n");
  const workspace = await initialize(root, "tasks", configPath);
  await new BoardTasksService(workspace).create(
    {
      board: "product",
      title: "Работа",
      description: "## Текст\r\n\n  точно  \n",
      requestId: "init-test",
    },
    "tester",
  );
  const before = await snapshot(root);
  for (const attempt of [
    () => initialize(root, "other-storage", configPath),
    () => new StorageService(workspace).initialize(),
  ]) {
    await assert.rejects(attempt(), {
      code: "ALREADY_INITIALIZED",
      details: { configPath, dataRoot: root, reason: "config", paths: ["custom.json"] },
    });
    assert.deepEqual(await snapshot(root), before);
  }
});

test("ограничение нового basename не запрещает чтение существующей Unicode-конфигурации и не меняет её", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-existing-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await initialize(root, "tasks");
  const configPath = join(created.dataRoot, "старый config.json");
  await rename(created.configPath, configPath);
  const before = await snapshot(root);
  const reopened = await openWorkspace(root, configPath);
  assert.equal(reopened.config.projectId, created.config.projectId);
  await assert.rejects(initialize(root, "tasks", configPath), { code: "INVALID_ARGUMENT" });
  await assert.rejects(new StorageService(reopened).initialize(), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(await snapshot(root), before);
});

test("init: отдельные маркеры, записи, индексы и symlink не принимаются за пустую базу", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, reason, detected] of [
    ["custom.json", "config", "custom.json"],
    ["storage.json", "storage", "storage.json"],
    ["transactions/pending.json", "pending", "transactions/pending.json"],
    ["entities/projects/Existing.json", "incomplete", "entities"],
    ["relations/products/passport.json", "incomplete", "relations"],
    ["keyspaces/global-task.json", "incomplete", "keyspaces"],
    [".indexes/state.json", "incomplete", ".indexes"],
    ["product/product.json", "incomplete", "product"],
  ] as const)
    await t.test(path, async () => {
      const directory = join(root, detected);
      const configPath = join(directory, "custom.json");
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), "  существующие байты, даже не JSON\r\n");
      const before = await snapshot(root);
      for (const attempt of [
        () => initialize(root, "tasks", configPath),
        () => service(configPath).initialize(),
      ]) {
        await assert.rejects(attempt(), {
          code: "ALREADY_INITIALIZED",
          details: { configPath, dataRoot: directory, reason, paths: [detected] },
        });
        assert.deepEqual(await snapshot(root), before);
      }
    });
  const link = join(root, "dangling.json");
  await symlink(join(root, "absent"), link);
  const before = await snapshot(root);
  await assert.rejects(initialize(root, "tasks", link), { code: "ALREADY_INITIALIZED" });
  assert.deepEqual(await snapshot(root), before);
});

test("init: потеря config/manifest заполненной базы сохраняет данные и даёт адресный отказ, не migration conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-lost-markers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  await new BoardTasksService(workspace).create(
    { board: "product", description: "  Исходные данные\r\n", requestId: "existing" },
    "tester",
  );
  await rm(workspace.configPath);
  let before = await snapshot(root);
  await assert.rejects(initialize(root, "tasks"), {
    code: "ALREADY_INITIALIZED",
    details: {
      configPath: workspace.configPath,
      dataRoot: workspace.dataRoot,
      reason: "storage",
      paths: ["storage.json"],
    },
  });
  assert.deepEqual(await snapshot(root), before);
  await rm(join(workspace.dataRoot, "storage.json"));
  before = await snapshot(root);
  for (const attempt of [
    () => initialize(root, "tasks"),
    () => new StorageService(workspace).initialize(),
  ]) {
    await assert.rejects(attempt(), {
      code: "ALREADY_INITIALIZED",
      details: {
        configPath: workspace.configPath,
        dataRoot: workspace.dataRoot,
        reason: "incomplete",
        paths: [".indexes", "entities", "keyspaces", "relations", "transactions"],
      },
    });
    assert.deepEqual(await snapshot(root), before);
  }
});

test("конкурентный init публикует только один проект", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-init-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.allSettled([initialize(root, "tasks"), initialize(root, "tasks")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert.equal(rejected.reason.code, "ALREADY_INITIALIZED");
  const reopened = await openWorkspace(root);
  assert.deepEqual(await readdir(join(reopened.dataRoot, "entities/projects")), [
    `${reopened.config.projectId}.json`,
  ]);
});

for (const stage of ["intent", "file"])
  test(`init WAL: сбой на ${stage}, повтор без изменений, обычное открытие завершает исходный проект`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relay-init-wal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "custom.json");
    const publish = StorageTransaction.prototype.publish;
    const mocked = t.mock.method(
      StorageTransaction.prototype,
      "publish",
      function (this: StorageTransaction, ...args: Parameters<StorageTransaction["publish"]>) {
        return publish.apply(
          new StorageTransaction(this.root, (current) => {
            if (current === stage) throw new Error("init crash");
          }),
          args,
        );
      },
    );
    await assert.rejects(initialize(root, "tasks", configPath), /init crash/);
    mocked.mock.restore();
    const before = await snapshot(root);
    const pending = JSON.parse(await readFile(join(root, "transactions/pending.json"), "utf8"));
    const expected = pending.changes.find(
      (change: { path: string }) => change.path === basename(configPath),
    ).after;
    await assert.rejects(initialize(root, "tasks", configPath), { code: "ALREADY_INITIALIZED" });
    await assert.rejects(service(configPath).initialize(), { code: "ALREADY_INITIALIZED" });
    assert.deepEqual(await snapshot(root), before);
    const reopened = await openWorkspace(root, configPath);
    assert.equal(reopened.config.projectId, expected.projectId);
    assert.equal((await new GraphService(reopened).context({ root: "PRODUCT" })).edges.length, 1);
    await assert.rejects(readFile(join(root, "transactions/pending.json")), { code: "ENOENT" });
    const recovered = await snapshot(root);
    await openWorkspace(root, configPath);
    assert.deepEqual(await snapshot(root), recovered);
  });
