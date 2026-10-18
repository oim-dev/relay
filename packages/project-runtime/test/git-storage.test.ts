import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, rename, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { exists } from "@relay/core/storage/files";
import { saveProjectSettings } from "@relay/core/application/project-settings/service";
import { openWorkspace } from "@relay/core/storage/workspace";
import {
  withWorkspaceMaintenance,
  assertWorkspaceAvailable,
  gitMetadataDirectory,
} from "@relay/core/storage/access";
import { AppError } from "@relay/core/shared/errors";
import { withStorageLock } from "@relay/core/storage/lock";
import { EntityEngine } from "@relay/core/application/entities/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { captureSnapshot } from "@relay/core/application/storage/snapshot";
import { managedConfiguration, restoreManagedConfiguration } from "../src/git-storage/bootstrap.js";
import {
  normalizeOrigin,
  discoverRepository,
  repositoryDirectory,
} from "../src/git-storage/identity.js";
import {
  synchronize,
  conflicts,
  resolveConflict,
  withDataLock,
} from "../src/git-storage/service.js";
import { readState, pushDeadline, initialState, saveState } from "../src/git-storage/state.js";
import { runWorker, requestSynchronization } from "../src/git-storage/launcher.js";
import { git, gitText } from "../src/git-storage/git.js";
import { mergeSnapshots } from "../src/git-storage/snapshots.js";
import { prepareSnapshot } from "../src/git-storage/snapshots.js";
import { applySnapshot } from "@relay/core/application/storage/snapshot";
import { StorageTransaction } from "@relay/core/storage/entity-store/transaction";

const internal = withWorkspaceMaintenance;

test("Lifecycle: файловое подключение вне Git не требует установленного git", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-without-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = join(directory, "missing-bin");
  try {
    assert.equal(await discoverRepository(directory), undefined);
    assert.equal(
      await managedConfiguration(directory, { create: true, home: join(directory, "home") }),
      undefined,
    );
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(git(directory, ["--version"]), { code: "SYNC_GIT_UNAVAILABLE" });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("Lifecycle: Git различает отказ, разрешённый exit и превышение бюджета", async (t) => {
  const f = await fixture(t);
  assert.equal(await gitText(f.root, ["config", "--get", "core.fsync"]), "all");
  assert.equal(await gitText(f.root, ["config", "--get", "core.fsyncMethod"]), "fsync");
  for (const maxBytes of [0, -1, NaN, Infinity, 128 * 1024 * 1024 + 1])
    await assert.rejects(git(f.root, ["--version"], { maxBytes }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(git(f.root, ["--version"], { timeout: 0 }), { code: "INVALID_ARGUMENT" });
  const args = ["rev-parse", "--verify", "refs/heads/missing"];
  await assert.rejects(git(f.root, args), { code: "SYNC_GIT_FAILED" });
  assert.notEqual((await git(f.root, args, { allowFailure: true })).code, 0);
  const text = "Данные 🧪\n".repeat(1000);
  const blob = await gitText(f.root, ["hash-object", "-w", "--stdin"], { input: text });
  await assert.rejects(git(f.root, ["cat-file", "blob", blob], { maxBytes: 64 }), {
    code: "SYNC_TOO_LARGE",
  });
  assert.equal((await git(f.root, ["cat-file", "blob", blob])).stdout.toString("utf8"), text);
});

test(
  "Lifecycle: timeout завершает группу Git вместе с дочерним процессом",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const started = performance.now();
    await assert.rejects(git(f.root, ["-c", "alias.pause=!sleep 5", "pause"], { timeout: 100 }), {
      code: "SYNC_NETWORK_UNAVAILABLE",
    });
    assert(
      performance.now() - started < 3000,
      "Дочерний процесс не должен удерживать stdout после timeout",
    );
  },
);

test("Lifecycle: повреждённое или отсутствующее состояние блокирует базу без ремонта", async (t) => {
  const f = await fixture(t);
  const path = join(f.gitDir, "relay-sync.json");
  for (const value of ["{broken", JSON.stringify({ version: 999 })]) {
    await writeFile(path, value);
    await assert.rejects(readState(f.root), { code: "SYNC_STATE_INVALID" });
    await assert.rejects(f.engine.get({ ref: "PROJECT" }), { code: "SYNC_STATE_INVALID" });
    assert.equal(await readFile(path, "utf8"), value);
  }
  await rm(path);
  await assert.rejects(readState(f.root), { code: "SYNC_STATE_INVALID" });
  await assert.rejects(f.engine.get({ ref: "PROJECT" }), { code: "SYNC_STATE_INVALID" });
  assert.equal(await exists(path), false);
});

test("Lifecycle: прямой Core не обходит runtime управляемой базы", async (t) => {
  const f = await fixture(t);
  const copied = join(f.directory, "unregistered");
  await cp(f.root, copied, { recursive: true });
  const engine = new EntityEngine(await openWorkspace(copied, join(copied, "config.json")));
  await assert.rejects(engine.get({ ref: "PROJECT" }), { code: "SYNC_RUNTIME_REQUIRED" });
});

test("Lifecycle: второй worker не выполняет синхронизацию под чужой lease", async (t) => {
  const f = await fixture(t);
  const directory = join(f.gitDir, "relay-worker");
  await mkdir(directory, { recursive: true });
  const before = await readState(f.root);
  await withStorageLock(directory, () => runWorker(f.root), directory);
  assert.deepEqual(await readState(f.root), before);
  assert.equal(await exists(join(f.gitDir, "relay-worker-pid.json")), false);
});

test("Lifecycle: потеря сети сохраняет очередь; следующий worker публикует её после восстановления", async (t) => {
  const f = await fixture(t);
  await internal(() =>
    f.engine.create(
      { requestId: "pending", data: { kind: "task", board: "product", title: "Ожидает отправки" } },
      "agent",
    ),
  );
  await withDataLock(f.root, async () => {
    const state = await readState(f.root);
    state.firstDirty = state.lastDirty = Date.now() - 16000;
    state.requested++;
    state.generation++;
    await saveState(f.root, state);
  });
  const snapshot = await internal(() => captureSnapshot(f.workspace));
  const offline = join(f.directory, "offline.git");
  await rename(f.origin, offline);
  const worker = runWorker(f.root);
  const deadline = Date.now() + 10000;
  while (!(await readState(f.root)).error && Date.now() < deadline) await delay(30);
  const failed = await readState(f.root);
  assert.equal(failed.error?.code, "SYNC_NETWORK_UNAVAILABLE");
  assert.notEqual(failed.firstDirty, null);
  assert.equal((await internal(() => captureSnapshot(f.workspace))).version, snapshot.version);
  await rename(offline, f.origin);
  await worker;
  const restored = await readState(f.root);
  assert.equal(restored.error, null);
  assert.equal(restored.firstDirty, null);
  assert.equal(
    await gitText(f.root, ["rev-parse", "HEAD"]),
    await gitText(f.origin, ["rev-parse", "refs/heads/relay-data"]),
  );
});

test("Lifecycle: устаревшая reservation после сбоя запуска заменяется новым worker", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.gitDir, "relay-worker-start.json"),
    JSON.stringify({ at: Date.now() - 10000 }),
  );
  await requestSynchronization(f.root);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (
      (await exists(join(f.gitDir, "relay-worker-pid.json"))) &&
      !(await exists(join(f.gitDir, "relay-worker/write.lock"))) &&
      !(await exists(join(f.gitDir, "relay-worker-start.json")))
    )
      break;
    await delay(30);
  }
  const worker = JSON.parse(await readFile(join(f.gitDir, "relay-worker-pid.json"), "utf8")) as {
    pid: number;
  };
  assert.notEqual(worker.pid, process.pid);
  assert.equal(await exists(join(f.gitDir, "relay-worker/write.lock")), false);
  assert.equal(await exists(join(f.gitDir, "relay-worker-start.json")), false);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "relay-git-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin.git"),
    code = join(directory, "code");
  await mkdir(code);
  await git(directory, ["init", "--bare", origin]);
  await git(code, ["init", "--initial-branch", "dev"]);
  await git(code, ["remote", "add", "origin", origin]);
  const home = join(directory, "home");
  const config = await managedConfiguration(code, { home, create: true });
  assert(config);
  const root = dirname(config);
  const workspace = await openWorkspace(root, config);
  const engine = new EntityEngine(workspace);
  const peer = async () => {
    const peerCode = join(directory, randomUUID());
    await mkdir(peerCode);
    await git(peerCode, ["init", "--initial-branch", "dev"]);
    await git(peerCode, ["remote", "add", "origin", origin]);
    const config = await managedConfiguration(peerCode, { home });
    assert(config);
    const workspace = await openWorkspace(dirname(config), config);
    return { root: dirname(config), workspace, engine: new EntityEngine(workspace) };
  };
  return {
    directory,
    origin,
    code,
    home,
    root,
    gitDir: await gitMetadataDirectory(root),
    config,
    workspace,
    engine,
    peer,
  };
}

test("Git identity: отсутствие origin и повреждение Git-конфига различаются", async (t) => {
  const f = await fixture(t);
  await git(f.code, ["remote", "remove", "origin"]);
  assert.equal((await discoverRepository(f.code))?.origin, undefined);
  assert.equal(await managedConfiguration(f.code, { home: f.home }), f.config);
  await writeFile(join(f.code, ".git/config"), "[broken");
  await assert.rejects(
    managedConfiguration(f.code, { home: join(f.directory, "another-home"), create: true }),
    { code: "SYNC_GIT_FAILED" },
  );
  assert.equal(await exists(join(f.directory, "another-home")), false);
  assert.equal(await exists(join(f.code, ".relay")), false);
});

test("Git identity: известные SSH/HTTPS совпадают; namespace, path case и host различаются", () => {
  const addresses = [
    "git@github.com:oim-dev/relay.git",
    "ssh://git@github.com/oim-dev/relay.git",
    "https://github.com/oim-dev/relay.git",
  ];
  const values = addresses.map((value) => normalizeOrigin(value));
  assert(
    values.every(
      (value) => value.identity === "github.com/oim-dev/relay" && value.hash === values[0]!.hash,
    ),
  );
  assert.equal(values[0]!.hash.length, 32);
  for (const value of [
    "https://github.com/other/relay.git",
    "https://github.com/oim-dev/Relay.git",
    "https://gitlab.com/oim-dev/relay.git",
    "ssh://git@github.com:2222/oim-dev/relay.git",
  ])
    assert.notEqual(normalizeOrigin(value).hash, values[0]!.hash);
  assert.equal(
    normalizeOrigin("https://name:secret@github.com/oim-dev/relay.git").identity,
    values[0]!.identity,
  );
  assert(
    !normalizeOrigin("https://name:secret@github.com/oim-dev/relay.git").origin.includes("secret"),
  );
});

test("Git identity: вложенные группы, локальные пути, опасные протоколы и пустые адреса", () => {
  assert.equal(
    normalizeOrigin("https://gitlab.com/team/sub/repo.git").identity,
    "gitlab.com/team/sub/repo",
  );
  assert.equal(
    normalizeOrigin("../remote.git", "/work/project").identity,
    "file:///work/remote.git",
  );
  for (const value of [
    "",
    "-evil",
    "ext::command",
    "ftp://server/repo",
    "https://server/repo?token=secret",
    "ssh://git@server/",
  ])
    assert.throws(() => normalizeOrigin(value));
});

test("Git identity: стандартный SSH port, Unicode и кодированные компоненты", () => {
  assert.equal(
    normalizeOrigin("ssh://git@github.com:22/team/repo.git").hash,
    normalizeOrigin("https://github.com/team/repo.git").hash,
  );
  assert.equal(
    normalizeOrigin("https://github.com/team/%D0%BC%D0%B8%D1%80.git").hash,
    normalizeOrigin("git@github.com:team/мир.git").hash,
  );
  for (const url of [
    "https://github.com/team/../repo.git",
    "https://github.com/team/%2e%2e/repo.git",
    "https://github.com/team/a%2fb.git",
    "https://github.com/team/%00.git",
  ])
    assert.throws(() => normalizeOrigin(url), { code: "SYNC_ORIGIN_INVALID" });
  assert.equal(normalizeOrigin("/a path/repo.git").name, "repo");
});

test("Debounce: тишина, maxWait, пустая очередь и независимость от запросов чтения", () => {
  assert.equal(pushDeadline(initialState()), null);
  assert.equal(pushDeadline({ firstDirty: 1000, lastDirty: 1500 }), 3500);
  assert.equal(pushDeadline({ firstDirty: 1000, lastDirty: 15999 }), 16000);
  assert.equal(pushDeadline({ ...initialState(), firstDirty: 1000, lastDirty: 1500 }), 3500);
});

test("Merge: односторонние/одинаковые изменения, независимые файлы и delete/update", () => {
  const base = { "entities/documents/a.json": { id: "a", body: ["строка", ""] } };
  const local = { ...base, "entities/documents/b.json": { id: "b" } };
  assert.deepEqual(mergeSnapshots(base, local, base), { files: local, conflicts: [] });
  assert.deepEqual(mergeSnapshots(base, local, local), { files: local, conflicts: [] });
  assert.deepEqual(mergeSnapshots(base, {}, local).conflicts, ["entities/documents/a.json"]);
  const changed = { "entities/documents/a.json": { id: "a", body: ["новое"] } };
  assert.deepEqual(
    mergeSnapshots(base, changed, { "entities/documents/a.json": { id: "a", body: ["иное"] } })
      .conflicts,
    Object.keys(base),
  );
});

test("Bootstrap: новая база, чистая рабочая копия, восстановление после удаления", async (t) => {
  const f = await fixture(t);
  assert.equal(f.workspace.config.projectSettings?.name, "origin");
  assert.deepEqual((await readdir(f.code)).sort(), [".git"]);
  assert.equal(await gitText(f.code, ["symbolic-ref", "--short", "HEAD"]), "dev");
  await internal(() => validateWorkspace(f.workspace));
  const projectId = f.workspace.config.projectId;
  const remote = await gitText(f.origin, ["rev-parse", "refs/heads/relay-data"]);
  await rm(f.root, { recursive: true });
  assert.equal(await managedConfiguration(f.code, { home: f.home }), f.config);
  assert.equal((await openWorkspace(f.root, f.config)).config.projectId, projectId);
  assert.equal(await gitText(f.root, ["rev-parse", "HEAD"]), remote);
  assert.deepEqual((await gitText(f.root, ["ls-tree", "--name-only", "HEAD"])).split("\n").sort(), [
    ".gitignore",
    "config.json",
    "entities",
    "keyspaces",
    "relations",
    "storage.json",
  ]);
});

test("Адресное решение сохраняет независимые изменения и допускает объединённый текст", async (t) => {
  const f = await fixture(t);
  const docs: Array<Awaited<ReturnType<EntityEngine["create"]>>> = [];
  for (let i = 0; i < 3; i++)
    docs.push(
      await internal(() =>
        f.engine.create(
          {
            requestId: `d${i}`,
            data: {
              kind: "document",
              name: `D${i}`,
              summary: "",
              documentKind: "rules",
              body: "Основа",
            },
          },
          "agent",
        ),
      ),
    );
  await synchronize(f.root);
  const peer = await f.peer();
  for (const [engine, index, body] of [
    [f.engine, 0, "A"],
    [peer.engine, 0, "B"],
    [f.engine, 1, "Только локально"],
    [peer.engine, 2, "Только удалённо"],
  ] as const)
    await internal(() =>
      engine.update(
        {
          ref: docs[index]!.key,
          ifRevision: 1,
          requestId: randomUUID(),
          changes: { kind: "document", body },
        },
        "agent",
      ),
    );
  await synchronize(peer.root);
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  const materials = (await conflicts(f.root))!;
  await assert.rejects(resolveConflict(f.root, materials.id, {}), {
    code: "SYNC_RESOLUTION_INCOMPLETE",
  });
  const path = materials.paths[0]!;
  const value = structuredClone(materials.localFiles[path]) as { data: { body: string[] } };
  value.data.body = ["A и B", ""];
  await assert.rejects(resolveConflict(f.root, materials.id, { [path]: { value: null } }), {
    code: "SYNC_RESOLUTION_INVALID",
  });
  await resolveConflict(f.root, materials.id, { [path]: { value } });
  for (const [i, body] of ["A и B\n", "Только локально", "Только удалённо"].entries()) {
    const detail = await internal(() => f.engine.get({ ref: docs[i]!.key }));
    assert.equal(detail.data.kind === "document" && detail.data.body, body);
  }
  await internal(() => validateWorkspace(f.workspace));
});

test("Настройки проекта записываются локально; удалённый конфликт обнаруживается в фоне", async (t) => {
  const f = await fixture(t),
    peer = await f.peer();
  const initial = f.workspace.config.projectSettings!;
  await internal(() =>
    saveProjectSettings(peer.workspace, {
      name: "Удалённое имя",
      slug: initial.slug,
      ifRevision: initial.revision,
    }),
  );
  await synchronize(peer.root);
  await saveProjectSettings(f.workspace, {
    name: "Локальное имя",
    slug: initial.slug,
    ifRevision: initial.revision,
  });
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  const detail = await internal(() => f.engine.get({ ref: "PROJECT" }));
  assert.equal(detail.title, "Локальное имя");
  const deadline = Date.now() + 10000;
  while (
    Date.now() < deadline &&
    ((await exists(join(f.gitDir, "relay-worker/write.lock"))) ||
      (await exists(join(f.gitDir, "relay-worker-start.json"))))
  )
    await delay(30);
});

test(
  "Новая запись проходит во время медленного push и остаётся в следующем пакете",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const doc = await internal(() =>
      f.engine.create(
        {
          requestId: "doc",
          data: {
            kind: "document",
            name: "D",
            summary: "",
            documentKind: "rules",
            body: "Первый пакет",
          },
        },
        "agent",
      ),
    );
    const entered = join(f.directory, "push-entered"),
      release = join(f.directory, "push-release");
    await writeFile(
      join(f.origin, "hooks/pre-receive"),
      `#!/bin/sh\ntouch "${entered}"\nwhile ! test -f "${release}"; do sleep 0.02; done\n`,
      { mode: 0o755 },
    );
    let ended = false;
    const sending = synchronize(f.root).finally(() => {
      ended = true;
    });
    try {
      const deadline = Date.now() + 8000;
      while (!ended && !(await exists(entered)) && Date.now() < deadline) await delay(20);
      assert(await exists(entered), "Тестовый receive hook не запущен");
      await f.engine.update(
        {
          ref: doc.key,
          ifRevision: 1,
          requestId: "next",
          changes: { kind: "document", body: "Следующий пакет" },
        },
        "agent",
      );
      assert.equal(ended, false, "Мутация должна завершиться до окончания медленной отправки");
    } finally {
      await writeFile(release, "release");
      await sending;
    }
    assert.notEqual((await readState(f.root)).firstDirty, null);
    await synchronize(f.root);
    const peer = await f.peer();
    const detail = await internal(() => peer.engine.get({ ref: doc.key }));
    assert.equal(detail.data.kind === "document" && detail.data.body, "Следующий пакет");
    const deadline = Date.now() + 10000;
    while (
      Date.now() < deadline &&
      ((await exists(join(f.gitDir, "relay-worker/write.lock"))) ||
        (await exists(join(f.gitDir, "relay-worker-start.json"))))
    )
      await delay(30);
  },
);

test("Bootstrap: одновременные подключения получают одну базу и стабильный projectId", async (t) => {
  const f = await fixture(t);
  await rm(f.root, { recursive: true });
  const paths = await Promise.all(
    Array.from({ length: 5 }, () => managedConfiguration(f.code, { home: f.home })),
  );
  assert(paths.every((path) => path === f.config));
  assert.equal(
    (await openWorkspace(f.root, f.config)).config.projectId,
    f.workspace.config.projectId,
  );
  assert.deepEqual(
    (await readdir(f.home)).filter((name) => name.startsWith(".install-")),
    [],
  );
});

test("Worktree сохраняет файлы при утрате владельца и запрещает обход общего Git-хранилища", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.config, "utf8");
  await rm(f.code, { recursive: true });
  await assert.rejects(synchronize(f.root), { code: "SYNC_GIT_OWNER_MISSING" });
  await assert.rejects(f.engine.get({ ref: "PROJECT" }), { code: "SYNC_GIT_OWNER_MISSING" });
  assert.equal(await readFile(f.config, "utf8"), before);
});

test("Worktree с другим именем и каталогом разделяет идентичность относительного origin", async (t) => {
  const f = await fixture(t);
  await git(f.code, ["remote", "set-url", "origin", "../origin.git"]);
  await git(f.code, ["commit", "--allow-empty", "-m", "fixture"]);
  const worktree = join(f.directory, "other", "feature-name");
  await git(f.code, ["worktree", "add", "--detach", worktree, "HEAD"]);
  assert.deepEqual(await discoverRepository(worktree), await discoverRepository(f.code));
  assert.equal(await managedConfiguration(worktree, { home: f.home }), f.config);
});

test("Потеря config в существующей внешней базе не вызывает рекурсивную установку или замену", async (t) => {
  const f = await fixture(t);
  const record = await readFile(join(f.root, "storage.json"), "utf8");
  await rm(f.config);
  await assert.rejects(restoreManagedConfiguration(f.config), { code: "SYNC_INVALID_DATABASE" });
  assert.equal(await readFile(join(f.root, "storage.json"), "utf8"), record);
});

test("Bootstrap: отсутствие ветки отличается от недоступного origin; существующая неполная база сохранена", async (t) => {
  const f = await fixture(t);
  const otherOrigin = join(f.directory, "empty.git");
  await git(f.directory, ["init", "--bare", otherOrigin]);
  const otherCode = join(f.directory, "empty-code");
  await mkdir(otherCode);
  await git(otherCode, ["init"]);
  await git(otherCode, ["remote", "add", "origin", otherOrigin]);
  await assert.rejects(managedConfiguration(otherCode, { home: f.home }), {
    code: "RELAY_NOT_INITIALIZED",
  });
  const identity = await discoverRepository(otherCode);
  assert(identity);
  const occupied = repositoryDirectory(identity, f.home);
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "не удалять");
  await assert.rejects(managedConfiguration(otherCode, { home: f.home }), {
    code: "SYNC_IDENTITY_MISMATCH",
  });
  assert.equal(await readFile(join(occupied, "keep.txt"), "utf8"), "не удалять");
  await rm(occupied, { recursive: true });
  await git(otherCode, ["remote", "set-url", "origin", join(f.directory, "missing.git")]);
  await assert.rejects(managedConfiguration(otherCode, { home: f.home }), {
    code: "SYNC_NETWORK_UNAVAILABLE",
  });
});

test("Синхронизация: точный Markdown, две копии, повторная отправка без лишнего коммита", async (t) => {
  const f = await fixture(t);
  const peer = await f.peer();
  const body = "\n# Проверка 🧪\r\n\n  отступ\t  \n```ts\nconst x = 1\n```\n\n";
  const doc = await internal(() =>
    f.engine.create(
      {
        requestId: "create",
        data: { kind: "document", name: "Материал", summary: "", documentKind: "rules", body },
      },
      "author",
    ),
  );
  await synchronize(f.root);
  const published = await gitText(f.origin, ["rev-parse", "refs/heads/relay-data"]);
  await synchronize(peer.root, { publish: false });
  const detail = await internal(() => peer.engine.get({ ref: doc.key }));
  assert.equal(detail.data.kind, "document");
  if (detail.data.kind === "document") assert.equal(detail.data.body, body);
  await synchronize(f.root);
  assert.equal(await gitText(f.origin, ["rev-parse", "refs/heads/relay-data"]), published);
  await internal(() => validateWorkspace(peer.workspace));
});

test("Конфликт: локальные чтение/запись доступны, решение защищено от новых изменений", async (t) => {
  const f = await fixture(t);
  const doc = await internal(() =>
    f.engine.create(
      {
        requestId: "create",
        data: {
          kind: "document",
          name: "Материал",
          summary: "",
          documentKind: "rules",
          body: "Основа",
        },
      },
      "author",
    ),
  );
  await synchronize(f.root);
  const peer = await f.peer();
  await internal(() =>
    f.engine.update(
      {
        ref: doc.key,
        ifRevision: 1,
        requestId: "left",
        changes: { kind: "document", body: "Локальная версия\n" },
      },
      "left",
    ),
  );
  await internal(() =>
    peer.engine.update(
      {
        ref: doc.key,
        ifRevision: 1,
        requestId: "right",
        changes: { kind: "document", body: "Удалённая версия\n" },
      },
      "right",
    ),
  );
  await synchronize(peer.root);
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  const state = await readState(f.root);
  assert(state.conflict);
  assert.equal((await f.engine.get({ ref: doc.key })).revision, 2);
  await f.engine.update(
    {
      ref: doc.key,
      ifRevision: 2,
      requestId: "blocked",
      changes: { kind: "document", body: "Продолжили локальную работу\n" },
    },
    "agent",
  );
  const materials = await conflicts(f.root);
  assert(materials);
  assert.notEqual(materials.id, state.conflict.id);
  await assert.rejects(resolveConflict(f.root, state.conflict.id, "remote"), {
    code: "SYNC_RESOLUTION_STALE",
  });
  await assert.rejects(resolveConflict(f.root, "old-id", "local"), {
    code: "SYNC_RESOLUTION_STALE",
  });
  await resolveConflict(f.root, materials.id, "local");
  assert.equal((await readState(f.root)).conflict, null);
  const detail = await internal(() => f.engine.get({ ref: doc.key }));
  assert.equal(
    detail.data.kind === "document" && detail.data.body,
    "Продолжили локальную работу\n",
  );
  await synchronize(peer.root);
  await internal(() => validateWorkspace(f.workspace));
});

test("Коллизия числовых ключей обнаруживается до публикации; обе базы сохранены", async (t) => {
  const f = await fixture(t),
    peer = await f.peer();
  const create = (engine: EntityEngine, name: string) =>
    internal(() =>
      engine.create(
        {
          requestId: name,
          data: { kind: "document", name, summary: "", documentKind: "rules", body: name },
        },
        name,
      ),
    );
  const left = await create(f.engine, "left"),
    right = await create(peer.engine, "right");
  assert.equal(left.key, right.key);
  assert.notEqual(left.ref.id, right.ref.id);
  const before = await internal(() => captureSnapshot(f.workspace));
  await synchronize(peer.root);
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  assert.equal((await internal(() => captureSnapshot(f.workspace))).version, before.version);
  assert((await conflicts(f.root))!.reason.includes("VALIDATION_FAILED"));
});

test("Независимые поля одного документа объединяются новой ревизией", async (t) => {
  const f = await fixture(t);
  const doc = await internal(() =>
    f.engine.create(
      {
        requestId: "create",
        data: {
          kind: "document",
          name: "Начало",
          summary: "",
          documentKind: "rules",
          body: "Текст\r\n",
        },
      },
      "agent",
    ),
  );
  await synchronize(f.root);
  const peer = await f.peer();
  await internal(() =>
    f.engine.update(
      {
        ref: doc.key,
        ifRevision: 1,
        requestId: "rename",
        changes: { kind: "document", name: "Новое имя" },
      },
      "left",
    ),
  );
  await internal(() =>
    peer.engine.update(
      {
        ref: doc.key,
        ifRevision: 1,
        requestId: "body",
        changes: { kind: "document", body: "Новый текст\r\n\n" },
      },
      "right",
    ),
  );
  await synchronize(peer.root);
  await synchronize(f.root);
  const detail = await internal(() => f.engine.get({ ref: doc.key }));
  assert.equal(detail.revision, 3);
  assert.equal(detail.data.kind === "document" && detail.data.name, "Новое имя");
  assert.equal(detail.data.kind === "document" && detail.data.body, "Новый текст\r\n\n");
  await internal(() => validateWorkspace(f.workspace));
});

test("Снимок отвергает устаревший отпечаток, включая изменения после подготовки", async (t) => {
  const f = await fixture(t);
  const source = await internal(() => captureSnapshot(f.workspace));
  const prepared = await internal(() =>
    prepareSnapshot(f.root, source.files, f.workspace.config.projectId!),
  );
  await internal(() =>
    f.engine.create(
      { requestId: "new", data: { kind: "task", board: "product", title: "Новая" } },
      "agent",
    ),
  );
  const current = await internal(() => captureSnapshot(f.workspace));
  await assert.rejects(
    internal(() => applySnapshot(f.workspace, prepared, source.version)),
    { code: "SYNC_SNAPSHOT_CHANGED" },
  );
  assert.equal((await internal(() => captureSnapshot(f.workspace))).version, current.version);
});

test("Отказ снимка до WAL не оставляет блокирующего Git-намерения", async (t) => {
  const f = await fixture(t),
    peer = await f.peer();
  const doc = await internal(() =>
    peer.engine.create(
      {
        requestId: "doc",
        data: {
          kind: "document",
          name: "D",
          summary: "",
          documentKind: "rules",
          body: "Сохранённый текст",
        },
      },
      "agent",
    ),
  );
  await synchronize(peer.root);
  const before = await internal(() => captureSnapshot(f.workspace));
  const original = StorageTransaction.prototype.publish;
  const injected = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (this: StorageTransaction, ...args: Parameters<typeof original>) {
      if (this.root === f.root)
        throw new AppError("STORAGE_LIMIT_EXCEEDED", "Бюджет публикации", 4);
      return original.apply(this, args);
    },
  );
  await assert.rejects(synchronize(f.root), { code: "STORAGE_LIMIT_EXCEEDED" });
  injected.mock.restore();
  assert.equal((await internal(() => captureSnapshot(f.workspace))).version, before.version);
  assert.equal(await exists(join(f.gitDir, "relay-publication.json")), false);
  await withDataLock(f.root, () => assertWorkspaceAvailable(f.root));
  await synchronize(f.root);
  const saved = await internal(() => f.engine.get({ ref: doc.key }));
  assert.equal(saved.data.kind === "document" && saved.data.body, "Сохранённый текст");
});

for (const failure of ["intent", "file", "published", "removed"] as const) {
  test(`Восстановление Git-публикации после сбоя WAL: ${failure}`, async (t) => {
    const f = await fixture(t),
      peer = await f.peer();
    const doc = await internal(() =>
      peer.engine.create(
        {
          requestId: "create",
          data: {
            kind: "document",
            name: "После сбоя",
            summary: "",
            documentKind: "rules",
            body: "Без потерь\n",
          },
        },
        "agent",
      ),
    );
    await synchronize(peer.root);
    const original = StorageTransaction.prototype.publish;
    let fired = false;
    const injected = t.mock.method(
      StorageTransaction.prototype,
      "publish",
      async function (this: StorageTransaction, ...args: Parameters<typeof original>) {
        const transaction =
          this.root === f.root
            ? new StorageTransaction(this.root, (stage) => {
                if (stage === failure && !fired) {
                  fired = true;
                  throw new Error("Сбой публикации");
                }
              })
            : this;
        return original.apply(transaction, args);
      },
    );
    await assert.rejects(synchronize(f.root));
    assert(fired);
    injected.mock.restore();
    await synchronize(f.root);
    assert.equal((await internal(() => f.engine.get({ ref: doc.key }))).data.kind, "document");
    await internal(() => validateWorkspace(f.workspace));
    assert.equal(
      await gitText(f.root, ["rev-parse", "HEAD"]),
      await gitText(f.origin, ["rev-parse", "refs/heads/relay-data"]),
    );
    await assert.rejects(readFile(join(f.gitDir, "relay-publication.json")), { code: "ENOENT" });
  });
}

test("Две одновременные публикации независимых записей сходятся без потери изменений", async (t) => {
  const f = await fixture(t);
  const docs: Array<Awaited<ReturnType<EntityEngine["create"]>>> = [];
  for (let i = 0; i < 2; i++)
    docs.push(
      await internal(() =>
        f.engine.create(
          {
            requestId: `doc-${i}`,
            data: {
              kind: "document",
              name: `D${i}`,
              summary: "",
              documentKind: "rules",
              body: "Основа",
            },
          },
          "agent",
        ),
      ),
    );
  await synchronize(f.root);
  const peer = await f.peer();
  await internal(() =>
    f.engine.update(
      {
        ref: docs[0]!.key,
        ifRevision: 1,
        requestId: "a",
        changes: { kind: "document", body: "A" },
      },
      "a",
    ),
  );
  await internal(() =>
    peer.engine.update(
      {
        ref: docs[1]!.key,
        ifRevision: 1,
        requestId: "b",
        changes: { kind: "document", body: "B" },
      },
      "b",
    ),
  );
  await Promise.all([synchronize(f.root), synchronize(peer.root)]);
  const final = await f.peer();
  for (const [index, value] of ["A", "B"].entries()) {
    const doc = await internal(() => final.engine.get({ ref: docs[index]!.key }));
    assert.equal(doc.data.kind === "document" && doc.data.body, value);
  }
  await internal(() => validateWorkspace(final.workspace));
});

test("Origin изменился после просмотра конфликта: прежнее решение отклоняется, новый ID разрешим", async (t) => {
  const f = await fixture(t);
  const doc = await internal(() =>
    f.engine.create(
      {
        requestId: "doc",
        data: { kind: "document", name: "D", summary: "", documentKind: "rules", body: "Основа" },
      },
      "agent",
    ),
  );
  await synchronize(f.root);
  const peer = await f.peer();
  await internal(() =>
    f.engine.update(
      { ref: doc.key, ifRevision: 1, requestId: "a", changes: { kind: "document", body: "A" } },
      "a",
    ),
  );
  await internal(() =>
    peer.engine.update(
      { ref: doc.key, ifRevision: 1, requestId: "b", changes: { kind: "document", body: "B" } },
      "b",
    ),
  );
  await synchronize(peer.root);
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  const first = (await readState(f.root)).conflict!;
  await internal(() =>
    peer.engine.update(
      { ref: doc.key, ifRevision: 2, requestId: "c", changes: { kind: "document", body: "C" } },
      "c",
    ),
  );
  await synchronize(peer.root);
  await assert.rejects(resolveConflict(f.root, first.id, "remote"), {
    code: "SYNC_RESOLUTION_STALE",
  });
  const next = (await readState(f.root)).conflict!;
  assert.notEqual(next.id, first.id);
  await resolveConflict(f.root, next.id, "remote");
  const detail = await internal(() => f.engine.get({ ref: doc.key }));
  assert.equal(detail.data.kind === "document" && detail.data.body, "C");
  assert(detail.revision > 3);
});

test("Решение конфликта восстанавливается после публикации данных до обновления Git HEAD", async (t) => {
  const f = await fixture(t);
  const doc = await internal(() =>
    f.engine.create(
      {
        requestId: "doc",
        data: { kind: "document", name: "D", summary: "", documentKind: "rules", body: "Основа" },
      },
      "agent",
    ),
  );
  await synchronize(f.root);
  const peer = await f.peer();
  for (const [engine, body] of [
    [f.engine, "A"],
    [peer.engine, "B"],
  ] as const)
    await internal(() =>
      engine.update(
        { ref: doc.key, ifRevision: 1, requestId: body, changes: { kind: "document", body } },
        body,
      ),
    );
  await synchronize(peer.root);
  await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
  const conflict = (await readState(f.root)).conflict!;
  const original = StorageTransaction.prototype.publish;
  let fired = false;
  const injected = t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (this: StorageTransaction, ...args: Parameters<typeof original>) {
      return original.apply(
        this.root === f.root
          ? new StorageTransaction(this.root, (stage) => {
              if (stage === "published" && !fired) {
                fired = true;
                throw new Error("Сбой решения");
              }
            })
          : this,
        args,
      );
    },
  );
  await assert.rejects(resolveConflict(f.root, conflict.id, "local"));
  injected.mock.restore();
  assert(fired);
  await synchronize(f.root);
  assert.equal((await readState(f.root)).conflict, null);
  const detail = await internal(() => f.engine.get({ ref: doc.key }));
  assert.equal(detail.data.kind === "document" && detail.data.body, "A");
});
