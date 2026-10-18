import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { git, gitText } from "../src/git-storage/git.js";
import {
  managedConfiguration,
  restoreManagedConfiguration,
  migrateToWorktree,
} from "../src/git-storage/bootstrap.js";
import { synchronize } from "../src/git-storage/service.js";
import { readState, initialState, saveState } from "../src/git-storage/state.js";
import { readConfiguration } from "../src/config.js";
import { normalizeOrigin, repositoryDirectory } from "../src/git-storage/identity.js";
import { commitSnapshot, writeSnapshot } from "../src/git-storage/snapshots.js";
import { gitMetadataDirectory, withWorkspaceMaintenance } from "@relay/core/storage/access";
import { openWorkspace, initialize } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { captureSnapshot, readSnapshotFiles } from "@relay/core/application/storage/snapshot";
import { StorageService } from "@relay/core/application/storage/service";
import { exists } from "@relay/core/storage/files";

const internal = withWorkspaceMaintenance;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "relay-worktree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const code = join(directory, "code"),
    home = join(directory, "home");
  await mkdir(code);
  await git(code, ["init", "--initial-branch", "dev"]);
  const remote = async (name: string) => {
    const path = join(directory, `${name}.git`);
    await git(directory, ["init", "--bare", path]);
    return path;
  };
  const open = async (cwd = code) => {
    const config = await managedConfiguration(cwd, { home, create: true });
    assert(config);
    const root = dirname(config),
      workspace = await openWorkspace(root, config);
    return { config, root, workspace, engine: new EntityEngine(workspace) };
  };
  return { directory, code, home, remote, open };
}

test("Worktree: orphan в репозитории с историей не меняет HEAD, индекс и рабочие файлы кода", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.code, "source.bin"), randomBytes(1024 * 1024));
  await git(f.code, ["add", "source.bin"]);
  await git(f.code, ["-c", "commit.gpgsign=false", "commit", "-m", "Код"]);
  for (let i = 0; i < 5; i++)
    await git(f.code, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      `История ${i}`,
    ]);
  await writeFile(join(f.code, "staged.txt"), "Изменение пользователя\n");
  await git(f.code, ["add", "staged.txt"]);
  await writeFile(join(f.code, "untracked.txt"), "Не терять\n");
  const beforeHead = await gitText(f.code, ["rev-parse", "HEAD"]);
  const beforeIndex = await readFile(join(f.code, ".git/index"));
  const beforeStatus = await gitText(f.code, ["status", "--porcelain"]);
  const app = await f.open();
  assert((await lstat(join(app.root, ".git"))).isFile());
  assert.equal(
    await gitText(app.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    join(f.code, ".git"),
  );
  assert.notEqual(await gitMetadataDirectory(app.root), join(f.code, ".git"));
  assert.equal(await gitText(app.root, ["log", "--format=%P"]), "");
  assert.equal(await gitText(app.root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await gitText(app.root, ["symbolic-ref", "--short", "HEAD"]), "relay-data");
  assert.equal(await gitText(app.root, ["status", "--porcelain"]), "");
  assert.equal(
    await readFile(join(app.root, ".gitignore"), "utf8"),
    (await gitText(app.root, ["show", "HEAD:.gitignore"])) + "\n",
  );
  assert.doesNotMatch(
    await gitText(app.root, ["ls-tree", "-r", "--name-only", "HEAD"]),
    /source\.bin|staged\.txt|untracked\.txt/,
  );
  assert.equal(await gitText(f.code, ["rev-parse", "HEAD"]), beforeHead);
  assert.deepEqual(await readFile(join(f.code, ".git/index")), beforeIndex);
  assert.equal(await gitText(f.code, ["status", "--porcelain"]), beforeStatus);
  assert.equal(await gitText(f.code, ["symbolic-ref", "--short", "HEAD"]), "dev");
});

test("Worktree: init без коммитов и origin → локальная запись → origin A → origin B сохраняет ту же базу", async (t) => {
  const f = await fixture(t),
    app = await f.open();
  const task = await internal(() =>
    app.engine.create(
      { requestId: "local", data: { kind: "task", board: "product", title: "До origin" } },
      "test",
    ),
  );
  await synchronize(app.root);
  assert.equal((await readState(app.root)).origin, null);
  const localHead = await gitText(app.root, ["rev-parse", "HEAD"]);
  const a = await f.remote("a");
  await git(f.code, ["remote", "add", "origin", a]);
  assert.equal(await managedConfiguration(f.code, { home: f.home }), app.config);
  await synchronize(app.root);
  assert.equal(await gitText(a, ["rev-parse", "relay-data"]), localHead);
  const b = await f.remote("b");
  await git(f.code, ["remote", "set-url", "origin", "../b.git"]);
  assert.equal(await managedConfiguration(f.code, { home: f.home }), app.config);
  await synchronize(app.root);
  assert.equal(await gitText(b, ["rev-parse", "relay-data"]), localHead);
  assert.equal((await internal(() => app.engine.get({ ref: task.key }))).title, "До origin");
  await git(f.code, ["remote", "remove", "origin"]);
  await synchronize(app.root);
  assert.equal((await readState(app.root)).origin, null);
  assert.equal(await gitText(f.code, ["symbolic-ref", "--short", "HEAD"]), "dev");
  assert.notEqual(
    (await git(f.code, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })).code,
    0,
  );
});

test("Worktree: восстановление получает только relay-data, объект большого файла кода не загружается", async (t) => {
  const f = await fixture(t),
    origin = await f.remote("origin");
  await writeFile(join(f.code, "large.bin"), randomBytes(2 * 1024 * 1024));
  await git(f.code, ["add", "large.bin"]);
  await git(f.code, ["-c", "commit.gpgsign=false", "commit", "-m", "Большой код"]);
  const codeObject = await gitText(f.code, ["rev-parse", "HEAD:large.bin"]);
  await git(f.code, ["remote", "add", "origin", origin]);
  await git(f.code, ["push", "origin", "dev"]);
  const original = await f.open();
  const other = join(f.directory, "other");
  await mkdir(other);
  await git(other, ["init", "--initial-branch", "dev"]);
  await git(other, ["remote", "add", "origin", origin]);
  const restored = await f.open(other);
  assert.notEqual(original.root, restored.root);
  assert.equal(original.workspace.config.projectId, restored.workspace.config.projectId);
  assert.notEqual(
    (await git(other, ["cat-file", "-e", codeObject], { allowFailure: true })).code,
    0,
  );
  assert.equal(
    await gitText(other, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]),
    "",
  );
  assert.equal(await gitText(restored.root, ["status", "--porcelain"]), "");
});

test("Worktree: checkout той же .git разделяет базу; удаление внешних файлов восстанавливает локальный коммит", async (t) => {
  const f = await fixture(t);
  await git(f.code, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Код"]);
  const app = await f.open();
  const linked = join(f.directory, "linked");
  await git(f.code, ["worktree", "add", "--detach", linked, "HEAD"]);
  assert.equal(await managedConfiguration(linked, { home: f.home }), app.config);
  const task = await internal(() =>
    app.engine.create(
      {
        requestId: "unpublished",
        data: { kind: "task", board: "product", title: "Локальный коммит" },
      },
      "test",
    ),
  );
  await synchronize(app.root);
  const head = await gitText(app.root, ["rev-parse", "HEAD"]);
  await rm(app.root, { recursive: true });
  assert.equal(await restoreManagedConfiguration(app.config), true);
  assert.equal(await gitText(app.root, ["rev-parse", "HEAD"]), head);
  const restored = new EntityEngine(await openWorkspace(app.root, app.config));
  assert.equal((await internal(() => restored.get({ ref: task.key }))).title, "Локальный коммит");
});

test("Worktree: чужая база нового origin не заменяет локальные данные и не перезаписывается", async (t) => {
  const f = await fixture(t),
    app = await f.open();
  const other = join(f.directory, "other");
  await mkdir(other);
  await git(other, ["init", "--initial-branch", "dev"]);
  const origin = await f.remote("foreign");
  await git(other, ["remote", "add", "origin", origin]);
  await f.open(other);
  const remoteHead = await gitText(origin, ["rev-parse", "relay-data"]);
  const before = await internal(() => captureSnapshot(app.workspace));
  await git(f.code, ["remote", "add", "origin", origin]);
  const local = await app.engine.create(
    { requestId: "local", data: { kind: "task", board: "product", title: "Локальная работа" } },
    "test",
  );
  await assert.rejects(synchronize(app.root), { code: "SYNC_PROJECT_MISMATCH" });
  assert.notEqual((await internal(() => captureSnapshot(app.workspace))).version, before.version);
  assert.equal((await app.engine.get({ ref: local.key })).title, "Локальная работа");
  assert.equal(await gitText(origin, ["rev-parse", "relay-data"]), remoteHead);
  await git(f.code, ["remote", "remove", "origin"]);
  await synchronize(app.root);
});

test("Worktree: имеющаяся ветка relay-data с кодом не принимается и не очищается", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.code, "keep.txt"), "Не база\n");
  await git(f.code, ["add", "keep.txt"]);
  await git(f.code, ["-c", "commit.gpgsign=false", "commit", "-m", "Код"]);
  await git(f.code, ["branch", "relay-data"]);
  const head = await gitText(f.code, ["rev-parse", "HEAD"]);
  await assert.rejects(f.open(), { code: "SYNC_UNSAFE_PATH" });
  assert.equal(await gitText(f.code, ["rev-parse", "relay-data"]), head);
  assert.equal(await readFile(join(f.code, "keep.txt"), "utf8"), "Не база\n");
});

for (const changed of [false, true]) {
  test(`Установка: сбой после создания worktree, внешние изменения=${changed}`, async (t) => {
    const f = await fixture(t);
    const injected = t.mock.method(StorageService.prototype, "reindex", async () => {
      throw new Error("Сбой индексации");
    });
    await assert.rejects(f.open(), /Сбой индексации/);
    injected.mock.restore();
    const journal = join(f.code, ".git/relay-install/pending.json");
    const pending = JSON.parse(await readFile(journal, "utf8")) as { root: string };
    const config = join(pending.root, "config.json");
    if (changed) {
      const original = JSON.parse(await readFile(config, "utf8"));
      await writeFile(
        config,
        JSON.stringify({ ...original, storageDir: "изменено пользователем" }),
      );
      const before = await readFile(config, "utf8");
      await assert.rejects(f.open(), { code: "SYNC_RECOVERY_CONFLICT" });
      assert.equal(await readFile(config, "utf8"), before);
    } else {
      assert.equal((await f.open()).config, config);
      assert.equal(await gitText(pending.root, ["status", "--porcelain"]), "");
      await assert.rejects(readFile(journal), { code: "ENOENT" });
    }
  });
}

test("Перенос: прежняя файловая .relay сохраняется, обычный CLI выбирает worktree с прежним projectId", async (t) => {
  const f = await fixture(t);
  const source = await initialize(f.code, "tasks");
  const engine = new EntityEngine(source);
  const task = await engine.create(
    { requestId: "before", data: { kind: "task", board: "product", title: "До переноса" } },
    "test",
  );
  const before = await captureSnapshot(source);
  const config = await migrateToWorktree(f.code, source.configPath, f.home);
  assert(config);
  assert.equal((await readConfiguration(f.code)).path, config);
  assert.equal((await captureSnapshot(source)).version, before.version);
  const target = await openWorkspace(dirname(config), config);
  assert.equal(target.config.projectId, source.config.projectId);
  assert.equal(
    (await internal(() => new EntityEngine(target).get({ ref: task.key }))).title,
    "До переноса",
  );
  assert.equal(await migrateToWorktree(f.code, source.configPath, f.home), config);
  const origin = await f.remote("after-migration");
  await git(f.code, ["remote", "add", "origin", origin]);
  await synchronize(dirname(config));
  assert.equal(await gitText(origin, ["rev-list", "--count", "relay-data"]), "1");
});

test("Перенос: standalone Git сохраняет историю и неопубликованную запись; старую базу не заменяет", async (t) => {
  const f = await fixture(t),
    origin = await f.remote("origin");
  await git(f.code, ["remote", "add", "origin", origin]);
  const legacy = repositoryDirectory(normalizeOrigin(origin), f.home);
  await mkdir(legacy, { recursive: true });
  await git(legacy, ["init", "--initial-branch", "relay-data"]);
  await git(legacy, ["remote", "add", "origin", origin]);
  const source = await initialize(legacy, "tasks", join(legacy, "config.json"));
  await writeSnapshot(legacy, await readSnapshotFiles(legacy));
  const first = await commitSnapshot(legacy, await readSnapshotFiles(legacy), []);
  await git(legacy, ["update-ref", "refs/heads/relay-data", first]);
  await git(legacy, ["read-tree", first]);
  await git(legacy, ["push", "origin", "relay-data"]);
  await writeFile(
    join(legacy, ".git/relay.json"),
    JSON.stringify({
      version: 1,
      identity: normalizeOrigin(origin).identity,
      origin,
      branch: "relay-data",
      projectId: source.config.projectId,
    }),
  );
  await saveState(legacy, initialState());
  const task = await internal(() =>
    new EntityEngine(source).create(
      {
        requestId: "unpublished",
        data: { kind: "task", board: "product", title: "Ещё не отправлена" },
      },
      "test",
    ),
  );
  const before = await internal(() => captureSnapshot(source));
  await assert.rejects(f.open(), { code: "SYNC_WORKTREE_MIGRATION_REQUIRED" });
  const config = await migrateToWorktree(f.code, source.configPath, f.home);
  assert(config);
  assert.equal((await internal(() => captureSnapshot(source))).version, before.version);
  assert.equal(await gitText(legacy, ["rev-parse", "HEAD"]), first);
  assert.equal((await git(f.code, ["merge-base", "--is-ancestor", first, "relay-data"])).code, 0);
  const target = new EntityEngine(await openWorkspace(dirname(config), config));
  assert.equal((await internal(() => target.get({ ref: task.key }))).title, "Ещё не отправлена");
  assert.equal(await gitText(origin, ["rev-list", "--count", "relay-data"]), "2");
  assert.equal(await gitText(dirname(config), ["status", "--porcelain"]), "");
  const clone = join(f.directory, "new-clone");
  await mkdir(clone);
  await git(clone, ["init"]);
  await git(clone, ["remote", "add", "origin", origin]);
  const other = await f.open(clone);
  assert.equal(
    (await internal(() => other.engine.get({ ref: task.key }))).title,
    "Ещё не отправлена",
  );
  // Изменившаяся после переноса копия снова требует явного решения, а не игнорируется.
  await internal(() =>
    new EntityEngine(source).update(
      {
        ref: task.key,
        ifRevision: 1,
        requestId: "late",
        changes: { kind: "task", title: "Изменена резервная копия" },
      },
      "test",
    ),
  );
  const another = join(f.directory, "another-clone");
  await mkdir(another);
  await git(another, ["init"]);
  await git(another, ["remote", "add", "origin", origin]);
  await assert.rejects(f.open(another), { code: "SYNC_WORKTREE_MIGRATION_REQUIRED" });
});

test("Перенос: чужая relay-data на origin не заменяет файловую базу и не создаёт локальную ветку", async (t) => {
  const f = await fixture(t),
    source = await initialize(f.code, "tasks");
  const origin = await f.remote("foreign");
  const other = join(f.directory, "other");
  await mkdir(other);
  await git(other, ["init"]);
  await git(other, ["remote", "add", "origin", origin]);
  await f.open(other);
  const before = await captureSnapshot(source),
    remote = await gitText(origin, ["rev-parse", "relay-data"]);
  await git(f.code, ["remote", "add", "origin", origin]);
  await assert.rejects(migrateToWorktree(f.code, source.configPath, f.home), {
    code: "SYNC_PROJECT_MISMATCH",
  });
  assert.equal((await captureSnapshot(source)).version, before.version);
  assert.equal(await gitText(origin, ["rev-parse", "relay-data"]), remote);
  assert.notEqual(
    (await git(f.code, ["rev-parse", "--verify", "relay-data"], { allowFailure: true })).code,
    0,
  );
});

test(
  "Origin меняется во время push: завершение старой отправки не подтверждает новый remote",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      app = await f.open();
    const a = await f.remote("a"),
      b = await f.remote("b");
    await git(f.code, ["remote", "add", "origin", a]);
    await synchronize(app.root);
    const task = await internal(() =>
      app.engine.create(
        {
          requestId: "queued",
          data: { kind: "task", board: "product", title: "В процессе отправки" },
        },
        "test",
      ),
    );
    const entered = join(f.directory, "entered"),
      release = join(f.directory, "release");
    await writeFile(
      join(a, "hooks/pre-receive"),
      `#!/bin/sh\ntouch "${entered}"\nwhile ! test -f "${release}"; do sleep 0.02; done\n`,
      { mode: 0o755 },
    );
    let ended = false;
    const sending = synchronize(app.root)
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        ended = true;
      });
    try {
      const deadline = Date.now() + 8000;
      while (!ended && !(await exists(entered)) && Date.now() < deadline) await delay(20);
      assert(await exists(entered), "Отправка не дошла до тестового origin");
      await git(f.code, ["remote", "set-url", "origin", b]);
    } finally {
      await writeFile(release, "ready");
      const result = await sending;
      assert.equal((result.error as { code?: string } | undefined)?.code, "SYNC_ORIGIN_CHANGED");
    }
    assert.notEqual((await readState(app.root)).firstDirty, null);
    assert.notEqual(
      (await git(b, ["rev-parse", "--verify", "relay-data"], { allowFailure: true })).code,
      0,
    );
    await synchronize(app.root);
    assert.equal(await managedConfiguration(f.code, { home: f.home }), app.config);
    assert.match(
      await gitText(b, ["show", `relay-data:entities/tasks/${task.ref.id}.json`]),
      /В процессе отправки/,
    );
    assert.equal((await readState(app.root)).error, null);
  },
);

test("Новый origin с тем же projectId, но независимой историей, не объединяется автоматически", async (t) => {
  const f = await fixture(t),
    app = await f.open();
  await internal(() =>
    app.engine.create(
      { requestId: "local", data: { kind: "task", board: "product", title: "Локальная запись" } },
      "test",
    ),
  );
  const before = await internal(() => captureSnapshot(app.workspace));
  const foreign = await commitSnapshot(f.code, before.files, []);
  const origin = await f.remote("unrelated");
  await git(f.code, ["push", origin, `${foreign}:refs/heads/relay-data`]);
  await git(f.code, ["remote", "add", "origin", origin]);
  await assert.rejects(synchronize(app.root), { code: "SYNC_UNRELATED_HISTORY" });
  assert.equal((await internal(() => captureSnapshot(app.workspace))).version, before.version);
  assert.equal(await gitText(origin, ["rev-parse", "relay-data"]), foreign);
});

test(
  "Медленная сеть: fetch relay-data дольше 30 секунд завершается успешно",
  { skip: process.platform === "win32", timeout: 75000 },
  async (t) => {
    const f = await fixture(t),
      origin = await f.remote("slow");
    await git(f.code, ["remote", "add", "origin", origin]);
    await f.open();
    const other = join(f.directory, "other"),
      ssh = join(f.directory, "ssh.sh"),
      seen = join(f.directory, "ls-remote-done");
    await mkdir(other);
    await git(other, ["init"]);
    await git(other, ["remote", "add", "origin", "ssh://relay-test.invalid/slow.git"]);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      ssh,
      `#!/bin/sh\nif test -f ${quote(seen)}; then sleep 31; else touch ${quote(seen)}; fi\nexec git-upload-pack ${quote(origin)}\n`,
      { mode: 0o755 },
    );
    const previous = { command: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT };
    process.env.GIT_SSH_COMMAND = quote(ssh);
    process.env.GIT_SSH_VARIANT = "ssh";
    try {
      const started = performance.now();
      const config = await managedConfiguration(other, { home: f.home });
      assert(config);
      assert(performance.now() - started >= 30000);
      assert.equal(await gitText(dirname(config), ["status", "--porcelain"]), "");
    } finally {
      for (const [key, value] of [
        ["GIT_SSH_COMMAND", previous.command],
        ["GIT_SSH_VARIANT", previous.variant],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  },
);
