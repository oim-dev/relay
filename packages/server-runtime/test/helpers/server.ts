import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { BoardRepository } from "@relay/core/storage/boards";
import { createServer } from "@relay/server-runtime";

/** Подготовленный существующий проект; infrastructure=false проверяет новый состав init. */
export async function fixture(t: TestContext, web = false, infrastructure = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tasks-api-")));
  const workspace = await initialize(root, "tasks");
  if (infrastructure)
    await workspace.locked((owned) =>
      new BoardRepository(workspace).ensure(
        {
          version: 1,
          id: "Infra001",
          slug: "infrastructure",
          prefix: "INFRA",
          kind: "infrastructure",
          applicationId: null,
          revision: 1,
          createdAt: "2026-09-26T00:00:00.000Z",
          createdBy: "relay",
        },
        owned,
      ),
    );
  const webRoot = join(root, "web");
  if (web) {
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(
      join(webRoot, "index.html"),
      '<!doctype html><html><script src="/assets/app.js"></script></html>',
    );
    await writeFile(join(webRoot, "assets/app.js"), 'console.log("static fixture");');
  }
  const app = await createServer({ cwd: root, actor: "web-human", ...(web ? { webRoot } : {}) });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, app, tasks: new BoardTasksService(workspace) };
}
