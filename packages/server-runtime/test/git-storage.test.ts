import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { managedConfiguration } from "@relay/project-runtime/git-storage/bootstrap";
import {
  synchronize,
  resolveConflict,
  conflicts,
} from "@relay/project-runtime/git-storage/service";
import { readState } from "@relay/project-runtime/git-storage/state";
import { git } from "@relay/project-runtime/git-storage/git";
import { openWorkspace } from "@relay/core/storage/workspace";
import { withWorkspaceMaintenance, gitMetadataDirectory } from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { EntityEngine } from "@relay/core/application/entities/service";
import { createServer } from "../src/bootstrap.js";

test(
  "Git-база: HTTP/scoped продолжают работу при конфликте, статус доставки доступен отдельно",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relay-git-server-"));
    const code = join(directory, "code"),
      origin = join(directory, "origin.git");
    await mkdir(code);
    await git(directory, ["init", "--bare", origin]);
    await git(code, ["init"]);
    await git(code, ["remote", "add", "origin", origin]);
    const config = await managedConfiguration(code, {
      home: join(directory, "home"),
      create: true,
    });
    assert(config);
    const root = dirname(config),
      gitDir = await gitMetadataDirectory(root),
      workspace = await openWorkspace(root, config),
      engine = new EntityEngine(workspace);
    const doc = await withWorkspaceMaintenance(() =>
      engine.create(
        {
          requestId: "create",
          data: {
            kind: "document",
            name: "Документ",
            summary: "",
            documentKind: "rules",
            body: "Общее",
          },
        },
        "agent",
      ),
    );
    await synchronize(root);
    const otherCode = join(directory, "other-code");
    await mkdir(otherCode);
    await git(otherCode, ["init"]);
    await git(otherCode, ["remote", "add", "origin", origin]);
    const otherConfig = await managedConfiguration(otherCode, { home: join(directory, "other") });
    assert(otherConfig);
    const otherRoot = dirname(otherConfig),
      other = new EntityEngine(await openWorkspace(otherRoot, otherConfig));
    const app = await createServer({ cwd: code, config, actor: "test" });
    const abort = new AbortController();
    t.after(async () => {
      abort.abort();
      await app.close();
      const deadline = Date.now() + 15000;
      while (
        Date.now() < deadline &&
        ((await exists(join(gitDir, "relay-worker/write.lock"))) ||
          (await exists(join(gitDir, "relay-worker-start.json"))))
      )
        await delay(50);
      await rm(directory, { recursive: true, force: true });
    });
    await app.listen(0, "127.0.0.1");
    await delay(500);
    const idle = (await readState(root)).requested;
    await delay(500);
    assert(
      (await readState(root)).requested - idle <= 2,
      "Наблюдатель не должен зацикливать синхронизацию на служебных Git-файлах",
    );
    const response = await fetch(`${await app.getUrl()}/api/v1/events`, { signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let received = "";
    const pump = (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          received += new TextDecoder().decode(next.value);
        }
      } catch {
        if (!abort.signal.aborted) throw new Error("Поток SSE прерван");
      }
    })();
    await withWorkspaceMaintenance(() =>
      engine.update(
        {
          ref: doc.key,
          ifRevision: 1,
          requestId: "left",
          changes: { kind: "document", body: "Локальное" },
        },
        "left",
      ),
    );
    await withWorkspaceMaintenance(() =>
      other.update(
        {
          ref: doc.key,
          ifRevision: 1,
          requestId: "right",
          changes: { kind: "document", body: "Удалённое" },
        },
        "right",
      ),
    );
    await synchronize(otherRoot);
    await assert.rejects(synchronize(root), { code: "SYNC_CONFLICT" });
    for (const prefix of ["/api/v1", `/api/v1/projects/${workspace.config.projectId}`]) {
      const result = await app.inject(`${prefix}/boards`);
      assert.equal(result.statusCode, 200, result.body);
      const status = await app.inject(`${prefix}/context/sync`);
      assert.equal(status.json().data.status, "conflict", status.body);
      const write = await app.inject({
        method: "POST",
        url: `${prefix}/entities`,
        payload: {
          requestId: "local",
          data: { kind: "task", board: "product", title: "Локальная работа" },
        },
      });
      assert.equal(write.statusCode, 200, write.body);
    }
    assert(!received.includes('"code":"SYNC_CONFLICT"'), received);
    const conflict = (await conflicts(root))!;
    await resolveConflict(root, conflict.id, "local");
    assert.equal((await app.inject("/api/v1/boards")).statusCode, 200);
    abort.abort();
    await pump;
  },
);
