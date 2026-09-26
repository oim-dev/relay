import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoardsService } from "@relay/core/application/boards/service";
import { ProductService } from "@relay/core/application/product/service";
import { initialize } from "@relay/core/storage/workspace";
import type { ProductMutation } from "@relay/core/domain/product";
import { fixture } from "./helpers/workspace.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { failWal } from "./helpers/wal.js";
import { exists } from "../src/storage/files.js";

const application = (slug: string, requestId = slug) =>
  ({
    action: "create",
    requestId,
    fields: {
      kind: "application",
      slug,
      name: `Приложение ${slug}`,
      summary: "Назначение",
      description: "## Ответственность\n\nРабота приложения.",
      type: "frontend",
    },
  }) satisfies ProductMutation;

test("init создаёт две системные доски и повтор не стирает данные", async (t) => {
  const { root, workspace } = await fixture(t);
  assert.deepEqual(
    (await new BoardsService(workspace).list()).items.map((board) => board.slug),
    ["product", "infrastructure"],
  );
  const task = await new BoardTasksService(workspace).create(
    { board: "product", title: "Сохранить", requestId: "task" },
    "tester",
  );
  const path = join(dirname(workspace.configPath), "entities/tasks", `${task.id}.json`);
  const before = await readFile(path, "utf8");
  await assert.rejects(initialize(root, "tasks"), { code: "ALREADY_INITIALIZED" });
  assert.equal(await readFile(path, "utf8"), before);
});

test("создание приложения создаёт контейнер доски; повтор и переименование сохраняют адрес", async (t) => {
  const { workspace } = await fixture(t);
  const products = new ProductService(workspace);
  const boards = new BoardsService(workspace);
  const command = application("web");
  const created = await products.mutate(command, "tester");
  await assert.rejects(products.mutate(command, "tester"));
  const board = await boards.get("web");
  assert.equal(board.applicationId, created.id);
  assert.equal((await new BoardTasksService(workspace).list({ board: board.id })).total, 0);
  const storedBoard = JSON.parse(
    await readFile(
      join(dirname(workspace.configPath), "entities/boards", `${board.id}.json`),
      "utf8",
    ),
  );
  assert.equal(storedBoard.data.applicationId, created.id);
  assert.deepEqual(
    (await boards.list()).items.map((entry) => entry.slug),
    ["product", "web", "infrastructure"],
  );
  await products.mutate(
    {
      ...command,
      action: "update",
      id: created.id,
      ifRevision: 1,
      requestId: "rename",
      fields: { ...command.fields, name: "Новое название" },
    },
    "tester",
  );
  assert.equal((await boards.get("web")).name, "Новое название");
  assert.equal((await boards.get("web")).id, board.id);
  await assert.rejects(
    products.mutate(
      { ...application("other", "slug-change"), action: "update", id: created.id, ifRevision: 2 },
      "tester",
    ),
    { code: "IMMUTABLE_FIELD" },
  );
  await assert.rejects(boards.get("missing"), { code: "NOT_FOUND" });
});

test("slug проверяется и уникален при конкуренции, но независим между проектами", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const products = new ProductService(first.workspace);
  for (const slug of ["product", "infrastructure", "new", "../escape", "Web", "a/b", "a-", ""]) {
    await assert.rejects(products.mutate(application(slug), "tester"));
  }
  const results = await Promise.allSettled([
    products.mutate(application("web", "one"), "tester"),
    products.mutate(application("web", "two"), "tester"),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal((await new BoardsService(first.workspace).list()).total, 3);
  await new ProductService(second.workspace).mutate(application("web"), "tester");
  assert.equal((await new BoardsService(second.workspace).list()).total, 3);
});

test("прерванное создание восстанавливается перед чтением; повтор отклоняется по занятому slug", async (t) => {
  const { workspace } = await fixture(t);
  const products = new ProductService(workspace);
  failWal(t, (stage, path) => {
    if (stage === "file" && path?.startsWith("entities/boards/"))
      throw new Error("Имитированный сбой");
  });
  await assert.rejects(products.mutate(application("web"), "tester"), /Имитированный сбой/);
  t.mock.restoreAll();
  const pending = join(dirname(workspace.configPath), "transactions/pending.json");
  assert(await exists(pending));
  const board = await new BoardsService(workspace).get("web");
  await assert.rejects(products.mutate(application("web"), "tester"));
  assert(board.applicationId);
  assert.equal(await exists(pending), false);
  assert.equal((await new BoardsService(workspace).list()).total, 3);
});

test("страницы сохраняют порядок и обнаруживают изменение каталога, повреждение slug не скрывается", async (t) => {
  const { workspace } = await fixture(t);
  const boards = new BoardsService(workspace);
  const first = await boards.list({ limit: 1 });
  const last = await boards.list({ offset: first.nextOffset!, limit: 1, version: first.version });
  assert.equal(last.items[0]?.slug, "infrastructure");
  assert.equal(last.nextOffset, null);
  await new ProductService(workspace).mutate(application("web"), "tester");
  await assert.rejects(boards.list({ offset: 1, version: first.version }), {
    code: "BOARD_CHANGED",
  });
  const board = await boards.get("web");
  const path = join(dirname(workspace.configPath), "entities/boards", `${board.id}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...stored, data: { ...stored.data, slug: "other" } }));
  await assert.rejects(boards.list(), { code: "INVALID_DATA" });
});
