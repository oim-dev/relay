import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "@relay/server-runtime";
import { fixture, successful, invokeRaw } from "./helpers/cli.js";

test("CLI обсуждений: публикация, повтор, Markdown и страницы для человека и JSON", async (t) => {
  const app = await fixture(t);
  const task = successful(
    await app.run<{ id: string }>(["task", "create", "--board", "product"]),
  ).data;
  const command = [
    "task",
    "comment",
    "publish",
    task.id,
    "--role",
    "worker",
    "--title",
    "Проверка",
    "--description",
    "## Результат\n\n**Проверено**\n",
    "--request-id",
    "comment",
  ];
  const saved = successful(await app.run<{ commentId: string }>(command)).data;
  const server = await startServer({ cwd: app.root, actor: "server", port: 0 });
  t.after(() => server.close());
  const repeated = successful(
    await app.run<{ commentId: string }>(["--server-url", server.url, ...command]),
  ).data;
  assert.notEqual(repeated.commentId, saved.commentId);
  const list = await invokeRaw(app.root, ["task", "comment", "list", task.id, "--limit", "1"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /Обсуждения/);
  assert.match(list.stdout, /Проверка/);
  assert.match(list.stdout, /task comment get/);
  const detail = await invokeRaw(app.root, ["task", "comment", "get", task.id, saved.commentId]);
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, /Проверено/);
  assert.doesNotMatch(detail.stdout, /"description":/);
  const json = successful(
    await app.run<{ description: string }>(["task", "comment", "get", task.id, saved.commentId]),
  ).data;
  assert.equal(json.description, "## Результат\n\n**Проверено**\n");
  const page = successful(
    await app.run<{ items: { id: string }[]; nextCursor: string | null }>([
      "task",
      "comment",
      "list",
      task.id,
      "--limit",
      "1",
    ]),
  ).data;
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = successful(
    await app.run<{ items: { id: string }[]; nextCursor: string | null }>([
      "task",
      "comment",
      "list",
      task.id,
      "--limit",
      "1",
      "--cursor",
      page.nextCursor,
    ]),
  ).data;
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, page.items[0]!.id);
  if (next.nextCursor) {
    const end = successful(
      await app.run<{ items: unknown[]; nextCursor: string | null }>([
        "task",
        "comment",
        "list",
        task.id,
        "--limit",
        "1",
        "--cursor",
        next.nextCursor,
      ]),
    ).data;
    assert.deepEqual(end.items, []);
    assert.equal(end.nextCursor, null);
  }
  const human = await invokeRaw(app.root, ["task", "comment", "list", task.id, "--limit", "1"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /task comment list.*--cursor/);
});
