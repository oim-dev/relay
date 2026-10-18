import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { captureSnapshot, readSnapshotFiles } from "@relay/core/application/storage/snapshot";
import { StorageService } from "@relay/core/application/storage/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { withWorkspaceMaintenance } from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { initializeFromTemplate, managedConfiguration } from "../src/git-storage/bootstrap.js";
import { commitSnapshot, snapshotAt } from "../src/git-storage/snapshots.js";
import { git, gitText } from "../src/git-storage/git.js";
import { synchronize } from "../src/git-storage/service.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "relay-git-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"),
    home = join(directory, "home");
  await mkdir(source);
  await git(source, ["init", "--initial-branch", "main"]);
  const workspace = await initialize(directory, "tasks", join(directory, "data/config.json"));
  const document = await new EntityEngine(workspace).create(
    {
      requestId: "document",
      data: {
        kind: "document",
        name: "Полный документ",
        summary: "Шаблон",
        documentKind: "specification",
        body: "# Знания\r\n\n  Полный текст  \n",
        relations: [
          {
            target: { kind: "project", id: workspace.config.projectId! },
            type: "documents",
            description: "Проект шаблона",
          },
        ],
      },
    },
    "author",
  );
  const files = (await captureSnapshot(workspace)).files;
  const sha = await commitSnapshot(source, files, []);
  await git(source, ["update-ref", "refs/heads/relay-data", sha]);
  const target = async (name = "target") => {
    const path = join(directory, name);
    await mkdir(path);
    await git(path, ["init", "--initial-branch", "dev"]);
    return path;
  };
  const setup = (
    cwd: string,
    options: Partial<Parameters<typeof initializeFromTemplate>[1]> = {},
  ) => initializeFromTemplate(cwd, { repository: source, home, ...options });
  return { directory, source, home, workspace, document, files, sha, target, setup };
}

test("Шаблон: две независимые базы, unborn HEAD/индекс, общий worktree и поздний origin", async (t) => {
  const f = await fixture(t),
    a = await f.target("alpha"),
    b = await f.target("beta");
  await writeFile(join(a, "staged.txt"), "Индекс пользователя\n");
  await git(a, ["add", "staged.txt"]);
  await writeFile(join(a, "staged.txt"), "Незакоммиченная версия\n");
  const index = await readFile(join(a, ".git/index"));
  const status = await gitText(a, ["status", "--porcelain"]);
  const first = await f.setup(a, { name: "Альфа", slug: "alpha" });
  const second = await f.setup(b);
  assert.notEqual(first.projectId, second.projectId);
  assert.notEqual(first.projectId, f.workspace.config.projectId);
  assert.notEqual(second.slug, f.workspace.config.projectSettings?.slug);
  assert.equal(second.name, "beta");
  assert.equal(first.template.commit, f.sha);
  assert.equal(first.validation.valid, true);
  assert.equal(first.synchronization.status, "local");
  assert.equal(await gitText(a, ["symbolic-ref", "--short", "HEAD"]), "dev");
  assert.notEqual(
    (await git(a, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })).code,
    0,
  );
  assert.deepEqual(await readFile(join(a, ".git/index")), index);
  assert.equal(await gitText(a, ["status", "--porcelain"]), status);
  assert.equal(await gitText(first.storageDir, ["log", "--format=%P"]), "");
  assert.equal(await gitText(first.storageDir, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await gitText(a, ["remote"]), "");
  assert.notEqual((await git(a, ["cat-file", "-e", f.sha], { allowFailure: true })).code, 0);
  assert.doesNotMatch(
    await gitText(first.storageDir, ["ls-tree", "-r", "--name-only", "HEAD"]),
    /\.indexes|transactions|runtime|staged\.txt/,
  );
  await withWorkspaceMaintenance(async () => {
    const workspace = await openWorkspace(a, first.configPath);
    assert.equal((await validateWorkspace(workspace)).valid, true);
    const engine = new EntityEngine(workspace);
    const doc = await engine.get({ ref: f.document.key });
    assert.equal(doc.references[0]?.ref.id, first.projectId);
    await engine.update(
      {
        ref: doc.key,
        ifRevision: doc.revision,
        requestId: "independent",
        changes: { kind: "document", body: "Изменение только Альфы" },
      },
      "author",
    );
    const other = new EntityEngine(await openWorkspace(b, second.configPath));
    assert.equal((await other.get({ ref: f.document.key })).data.kind === "document", true);
    assert.deepEqual(
      (await readSnapshotFiles(second.storageDir))[`entities/documents/${f.document.ref.id}.json`],
      (await snapshotAt(b, await gitText(b, ["rev-parse", "relay-data"])))[
        `entities/documents/${f.document.ref.id}.json`
      ],
    );
  });
  assert.deepEqual((await captureSnapshot(f.workspace)).files, f.files);
  assert.deepEqual(await snapshotAt(f.source, f.sha), f.files);
  assert.equal(await gitText(f.source, ["rev-parse", "relay-data"]), f.sha);
  await git(a, ["-c", "commit.gpgsign=false", "commit", "-m", "Первый коммит кода"]);
  const linked = join(f.directory, "linked");
  await git(a, ["worktree", "add", "--detach", linked, "HEAD"]);
  assert.equal(await managedConfiguration(linked, { home: f.home }), first.configPath);
  const origin = join(f.directory, "origin.git");
  await git(a, ["init", "--bare", origin]);
  await git(a, ["remote", "add", "origin", origin]);
  await synchronize(first.storageDir);
  assert.equal(
    await gitText(origin, ["rev-parse", "relay-data"]),
    await gitText(first.storageDir, ["rev-parse", "HEAD"]),
  );
  assert.equal(await gitText(f.source, ["rev-parse", "relay-data"]), f.sha);
  const before = await readSnapshotFiles(first.storageDir);
  await assert.rejects(f.setup(a), { code: "ALREADY_INITIALIZED" });
  assert.deepEqual(await readSnapshotFiles(first.storageDir), before);
});

test("Шаблон: ветка, аннотированный тег и SHA выбирают точный снимок", async (t) => {
  const f = await fixture(t);
  await git(f.source, [
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "database-v1",
    f.sha,
    "-m",
    "Снимок",
  ]);
  await git(f.source, ["update-ref", "refs/heads/database-v1", f.sha]);
  for (const ref of [f.sha, "refs/tags/database-v1", "refs/heads/relay-data"]) {
    const target = await f.target(`copy-${ref.replaceAll("/", "-")}`);
    assert.equal((await f.setup(target, { ref })).template.commit, f.sha);
  }
  for (const [ref, code] of [
    ["database-v1", "TEMPLATE_REF_AMBIGUOUS"],
    ["absent", "TEMPLATE_REF_NOT_FOUND"],
    ["HEAD~1", "INVALID_ARGUMENT"],
    ["refs/other/main", "INVALID_ARGUMENT"],
    ["bad..name", "INVALID_ARGUMENT"],
  ]) {
    const target = await f.target(`invalid-${ref!.replaceAll("/", "-")}`);
    await assert.rejects(f.setup(target, { ref: ref! }), { code });
    assert.notEqual(
      (await git(target, ["rev-parse", "--verify", "relay-data"], { allowFailure: true })).code,
      0,
    );
  }
});

test("Шаблон: отказ при существующей ветке origin, локальной базе и остатках данных", async (t) => {
  const f = await fixture(t);
  const remote = await f.target("remote");
  await git(remote, ["remote", "add", "origin", f.source]);
  await assert.rejects(f.setup(remote), { code: "ALREADY_INITIALIZED" });
  assert.equal(await gitText(remote, ["for-each-ref", "--format=%(refname)"]), "");
  const local = await f.target("local");
  await git(local, ["fetch", f.source, "relay-data:relay-data"]);
  const refs = await gitText(local, ["show-ref"]);
  await assert.rejects(f.setup(local), { code: "ALREADY_INITIALIZED" });
  assert.equal(await gitText(local, ["show-ref"]), refs);
  const legacy = await f.target("legacy");
  await mkdir(join(legacy, ".relay/entities"), { recursive: true });
  await assert.rejects(f.setup(legacy), { code: "ALREADY_INITIALIZED" });
  await initialize(legacy, "tasks", join(legacy, "other/config.json"));
  await writeFile(
    join(legacy, "relay.workspace.json"),
    JSON.stringify({ version: 1, projects: {} }),
  );
  await assert.rejects(f.setup(legacy), { code: "ALREADY_INITIALIZED" });
});

test("Шаблон: конкурирующие установки создают ровно одну базу", async (t) => {
  const f = await fixture(t),
    target = await f.target();
  const results = await Promise.allSettled([f.setup(target), f.setup(target)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status === "rejected" && rejected.reason.code, "ALREADY_INITIALIZED");
  assert.equal(await gitText(target, ["rev-list", "--count", "relay-data"]), "1");
});

for (const changed of [false, true]) {
  test(`Шаблон: восстановление использует сохранённый SHA и ID, внешняя правка=${changed}`, async (t) => {
    const f = await fixture(t),
      target = await f.target();
    const original = StorageService.prototype.reindex;
    let calls = 0;
    const injected = t.mock.method(
      StorageService.prototype,
      "reindex",
      async function (this: StorageService) {
        if (++calls === 3) throw new Error("Прервано после создания worktree");
        return original.call(this);
      },
    );
    await assert.rejects(f.setup(target), /Прервано/);
    injected.mock.restore();
    const journal = join(target, ".git/relay-install/pending.json");
    const intent = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(intent.template.commit, f.sha);
    await assert.rejects(f.setup(target, { name: "Другое поручение" }), {
      code: "TEMPLATE_INSTALL_MISMATCH",
    });
    await rename(f.source, `${f.source}-unavailable`);
    if (changed) {
      await writeFile(join(intent.root, "config.json"), "{}\n");
      await assert.rejects(f.setup(target), { code: "SYNC_RECOVERY_CONFLICT" });
      assert.equal(await readFile(join(intent.root, "config.json"), "utf8"), "{}\n");
    } else {
      const result = await f.setup(target);
      assert.equal(result.projectId, intent.template.projectId);
      assert.equal(result.template.commit, f.sha);
      assert.equal(await gitText(target, ["rev-parse", "relay-data"]), intent.commit);
      assert.equal(await exists(journal), false);
    }
  });
}

test("Шаблон: ошибка подготовки не публикует ветку или регистрацию", async (t) => {
  const f = await fixture(t),
    target = await f.target();
  const injected = t.mock.method(StorageService.prototype, "reindex", async () => {
    throw new Error("Ошибка проверки");
  });
  await assert.rejects(f.setup(target), /Ошибка проверки/);
  injected.mock.restore();
  assert.equal(await gitText(target, ["for-each-ref", "--format=%(refname)"]), "");
  assert.equal(await exists(join(target, ".git/relay-worktree.json")), false);
  assert.equal(await exists(join(target, ".git/relay-install/pending.json")), false);
  assert.deepEqual(await readdir(f.home), []);
  assert.equal((await f.setup(target)).validation.valid, true);
});

test("Шаблон: намерение до создания ref восстанавливается обычным подключением", async (t) => {
  const f = await fixture(t),
    target = await f.target();
  const original = StorageService.prototype.reindex;
  let calls = 0;
  const injected = t.mock.method(
    StorageService.prototype,
    "reindex",
    async function (this: StorageService) {
      if (++calls === 3) throw new Error("Прервано");
      return original.call(this);
    },
  );
  await assert.rejects(f.setup(target), /Прервано/);
  injected.mock.restore();
  const journal = join(target, ".git/relay-install/pending.json");
  const intent = JSON.parse(await readFile(journal, "utf8"));
  // Состояние durable-намерения до создания ref/worktree; подготовленный объект уже существует.
  await git(target, ["worktree", "remove", "--force", "--force", intent.root]);
  await git(target, ["update-ref", "-d", "refs/heads/relay-data", intent.commit]);
  await rename(f.source, `${f.source}-offline`);
  assert.equal(
    await managedConfiguration(target, { home: f.home }),
    join(intent.root, "config.json"),
  );
  assert.equal(await gitText(target, ["rev-parse", "relay-data"]), intent.commit);
  assert.equal(await exists(journal), false);
  const workspace = await openWorkspace(target, join(intent.root, "config.json"));
  assert.equal(workspace.config.projectId, intent.template.projectId);
});

test("Шаблон: unborn ветка кода relay-data не превращается в ветку базы", async (t) => {
  const f = await fixture(t),
    target = await f.target();
  await git(target, ["symbolic-ref", "HEAD", "refs/heads/relay-data"]);
  const head = await readFile(join(target, ".git/HEAD"));
  await assert.rejects(f.setup(target), { code: "TEMPLATE_BRANCH_IN_USE" });
  assert.deepEqual(await readFile(join(target, ".git/HEAD")), head);
  assert.equal(await gitText(target, ["for-each-ref", "--format=%(refname)"]), "");
  assert.equal(await exists(join(target, ".git/relay-install/pending.json")), false);
});

test("Шаблон: готовая база сохраняется при ошибке публикации и синхронизируется позже", async (t) => {
  const f = await fixture(t),
    target = await f.target();
  const origin = join(f.directory, "origin.git");
  await git(target, ["init", "--bare", origin]);
  await git(target, ["remote", "add", "origin", origin]);
  const original = StorageService.prototype.reindex;
  let calls = 0;
  const injected = t.mock.method(
    StorageService.prototype,
    "reindex",
    async function (this: StorageService) {
      if (++calls === 3) await rename(origin, `${origin}-offline`);
      return original.call(this);
    },
  );
  const result = await f.setup(target);
  injected.mock.restore();
  assert.equal(result.synchronization.status, "pending");
  assert(result.synchronization.error);
  assert.equal(result.validation.valid, true);
  assert.equal(await exists(join(target, ".git/relay-install/pending.json")), false);
  await assert.rejects(f.setup(target), { code: "ALREADY_INITIALIZED" });
  await rename(`${origin}-offline`, origin);
  await synchronize(result.storageDir);
  assert.equal(
    await gitText(origin, ["rev-parse", "relay-data"]),
    await gitText(result.storageDir, ["rev-parse", "HEAD"]),
  );
  assert.equal(dirname(result.configPath), result.storageDir);
});
