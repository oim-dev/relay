import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, rename, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exists } from "@relay/core/storage/files";
import { openWorkspace } from "@relay/core/storage/workspace";
import { gitMetadataDirectory, withWorkspaceMaintenance } from "@relay/core/storage/access";
import { EntityEngine } from "@relay/core/application/entities/service";
import { validateWorkspace } from "@relay/core/application/validate";
import { managedConfiguration } from "../src/git-storage/bootstrap.js";
import { git, gitText } from "../src/git-storage/git.js";
import {
  synchronize,
  checkpointLocal,
  conflicts,
  resolveConflict,
  withDataLock,
} from "../src/git-storage/service.js";
import { synchronizationStatus } from "../src/git-storage/status.js";
import { readState, saveState } from "../src/git-storage/state.js";
import { requestSynchronization } from "../src/git-storage/launcher.js";

async function until(check: () => Promise<boolean>, message: string, milliseconds = 10000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(30);
  }
  assert.fail(message);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "relay-nonblocking-"));
  const code = join(directory, "code"),
    origin = join(directory, "origin.git");
  await mkdir(code);
  await git(code, ["init", "--initial-branch", "main"]);
  await git(code, ["init", "--bare", origin]);
  await git(code, ["remote", "add", "origin", origin]);
  const config = (await managedConfiguration(code, {
    create: true,
    home: join(directory, "home"),
  }))!;
  const root = dirname(config),
    gitDir = await gitMetadataDirectory(root);
  const workspace = await openWorkspace(root, config),
    engine = new EntityEngine(workspace);
  t.after(async () => {
    await rm(join(directory, "network-gate"), { force: true });
    // Все процессы и пути принадлежат только этой fixture.
    await until(
      async () =>
        !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
        !(await exists(join(gitDir, "relay-worker-start.json"))),
      "Worker не завершился",
      15000,
    );
    await rm(directory, { recursive: true, force: true });
  });
  const create = (name: string) =>
    engine.create(
      {
        requestId: name,
        data: {
          kind: "document",
          name,
          summary: "Проверка",
          documentKind: "research",
          body: `# ${name}\r\n  Содержание  \n`,
        },
      },
      "test",
    );
  return { directory, code, origin, config, root, gitDir, workspace, engine, create };
}

test(
  "Фон: ручной запрос выполняется один раз при ошибке, чтения не обходят сетевую паузу",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      offline = `${f.origin}.offline`;
    await rename(f.origin, offline);
    try {
      await f.create("backoff");
      await requestSynchronization(f.root);
      await until(
        async () => (await readState(f.root)).error !== null,
        "Нет результата первой попытки",
      );
      const before = await withDataLock(f.root, async () => {
        const state = await readState(f.root);
        state.retryAt = Date.now() + 60000;
        await saveState(f.root, state);
        return state;
      });
      assert.equal(before.attempted, before.requested);
      for (let index = 0; index < 5; index++) await f.engine.get({ ref: "PROJECT" });
      await delay(750);
      const after = await readState(f.root);
      assert.equal(
        after.failures,
        before.failures,
        "Один ручной запрос не должен обходить backoff бесконечно",
      );
      assert.equal(after.checked, before.checked, "Неуспешная попытка не подтверждает origin");
    } finally {
      await rename(offline, f.origin);
      await requestSynchronization(f.root);
    }
    await until(
      async () => (await synchronizationStatus(f.root)).status === "synced",
      "Ручной запрос не ускорил восстановление",
    );
  },
);

test(
  "Фон: пять записей/чтений и локальный коммит проходят при удерживаемом fetch",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    const path = process.env.PATH!;
    let executable = "";
    for (const directory of path.split(delimiter)) {
      const candidate = join(directory, "git");
      if (await exists(candidate)) {
        executable = await realpath(candidate);
        break;
      }
    }
    assert(executable);
    const bin = join(f.directory, "bin"),
      gate = join(f.directory, "network-gate"),
      entered = join(f.directory, "network-entered");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args.includes('fetch')){fs.writeFileSync(${JSON.stringify(entered)},'entered');while(fs.existsSync(${JSON.stringify(gate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}\nconst result=cp.spawnSync(${JSON.stringify(executable)},args,{stdio:'inherit'});process.exit(result.status??1);\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    await writeFile(gate, "wait");
    process.env.PATH = `${bin}${delimiter}${path}`;
    const before = await gitText(f.root, ["rev-parse", "HEAD"]);
    const delivery = synchronize(f.root);
    try {
      await until(() => exists(entered), "Синхронизация не дошла до fetch");
      const started = performance.now();
      for (let index = 0; index < 5; index++) {
        const saved = await f.create(`document-${index}`);
        assert.equal((await f.engine.get({ ref: saved.key })).title, `document-${index}`);
      }
      assert(
        performance.now() - started < 5000,
        "Локальная серия не должна ждать освобождения сети",
      );
      assert(await exists(gate));
      await until(
        async () => (await gitText(f.root, ["rev-parse", "HEAD"])) !== before,
        "Локальные коммиты остановились вместе с fetch",
      );
      await until(
        async () => !(await synchronizationStatus(f.root)).uncommittedChanges,
        "Поколение локального коммита не подтверждено",
      );
      const status = await synchronizationStatus(f.root);
      assert.equal(status.uncommittedChanges, false);
      assert((status.queuedCommits ?? 0) >= 1);
    } finally {
      await rm(gate, { force: true });
      process.env.PATH = path;
      await delivery;
    }
    await synchronize(f.root);
    assert.equal((await synchronizationStatus(f.root)).queuedCommits, 0);
    assert.equal((await f.engine.list({ kind: "document" })).total, 5);
    await validateWorkspace(f.workspace);
  },
);

test(
  "Фон: выключенный VPN не мешает работе; worker сам отправляет очередь после восстановления",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      offline = `${f.origin}.offline`;
    await rename(f.origin, offline);
    try {
      for (let index = 0; index < 5; index++) await f.create(`offline-${index}`);
      await until(
        async () => (await readState(f.root)).error !== null,
        "Не показана ошибка недоступного origin",
      );
      await until(
        async () => !(await synchronizationStatus(f.root)).uncommittedChanges,
        "Офлайн-изменения не собраны в коммит",
      );
      const status = await synchronizationStatus(f.root);
      assert.equal(status.status, "offline");
      assert((status.queuedCommits ?? 0) >= 1);
      const reopened = new EntityEngine(await openWorkspace(f.root, f.config));
      assert.equal((await reopened.list({ kind: "document" })).total, 5);
      assert.equal((await validateWorkspace(f.workspace)).valid, true);
    } finally {
      await rename(offline, f.origin);
    }
    await until(
      async () => (await synchronizationStatus(f.root)).status === "synced",
      "Очередь не отправилась после восстановления VPN",
      15000,
    );
    assert.equal(
      await gitText(f.origin, ["rev-parse", "relay-data"]),
      await gitText(f.root, ["rev-parse", "HEAD"]),
    );
    assert.equal((await f.engine.list({ kind: "document" })).total, 5);
  },
);

test(
  "Фон: новые локальные данные при конфликте сохраняются, старое решение отклоняется",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    const document = await withWorkspaceMaintenance(() => f.create("shared"));
    await synchronize(f.root);
    const code = join(f.directory, "peer");
    await mkdir(code);
    await git(code, ["init"]);
    await git(code, ["remote", "add", "origin", f.origin]);
    const config = (await managedConfiguration(code, { home: join(f.directory, "peer-home") }))!;
    const peer = new EntityEngine(await openWorkspace(code, config));
    for (const [engine, body] of [
      [f.engine, "Локальное"],
      [peer, "Удалённое"],
    ] as const)
      await withWorkspaceMaintenance(() =>
        engine.update(
          {
            ref: document.key,
            ifRevision: 1,
            requestId: "change",
            changes: { kind: "document", body },
          },
          "test",
        ),
      );
    await synchronize(dirname(config));
    await assert.rejects(synchronize(f.root), { code: "SYNC_CONFLICT" });
    const previous = (await conflicts(f.root))!;
    for (let index = 0; index < 5; index++) await f.create(`after-conflict-${index}`);
    await checkpointLocal(f.root);
    assert.equal((await f.engine.list({ kind: "document" })).total, 6);
    await assert.rejects(resolveConflict(f.root, previous.id, "remote"), {
      code: "SYNC_RESOLUTION_STALE",
    });
    const current = (await conflicts(f.root))!;
    assert.notEqual(previous.id, current.id);
    await resolveConflict(f.root, current.id, "local");
    assert.equal((await f.engine.list({ kind: "document" })).total, 6);
    assert.equal((await validateWorkspace(f.workspace)).valid, true);
    assert.equal((await synchronizationStatus(f.root)).queuedCommits, 0);
    assert(
      (await readFile(join(f.gitDir, "relay-sync.json"), "utf8")).includes('"conflict": null'),
    );
  },
);
