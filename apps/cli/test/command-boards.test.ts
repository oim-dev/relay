import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

test(
  "board list/get: системные доски, доска приложения, страницы и свойства",
  { timeout: 120_000 },
  async (t) => {
    const app = await fixture(t);
    successful(
      await app.run([
        "application",
        "create",
        "--name",
        "Клиент 界",
        "--slug",
        "client",
        "--prefix",
        "CLIENT",
        "--description",
        "Интерфейс",
      ]),
    );
    type Board = {
      id: string;
      key: string;
      name: string;
      slug: string;
      prefix: string;
      revision: number;
    };
    const first = successful(
      await app.run<{ items: Board[]; total: number }>(["board", "list", "--limit", 2]),
    );
    assert.equal(first.data.total, 3);
    assert.equal(first.meta!.page!.count, 2);
    assert.equal(first.meta!.page!.total, 3);
    assert.equal(first.meta!.page!.consistency, "snapshot");
    const last = successful(
      await app.run<{ items: Board[] }>([
        "board",
        "list",
        "--cursor",
        first.meta!.page!.nextCursor!,
      ]),
    );
    assert.equal(last.meta!.page!.limit, 2);
    assert.equal(last.meta!.page!.count, 1);
    assert.equal(last.meta!.page!.nextCursor, null);
    assert.equal(last.meta!.page!.nextCommand, null);
    const boards = [...first.data.items, ...last.data.items];
    assert.deepEqual(boards.map((x) => x.slug).sort(), ["client", "infrastructure", "product"]);
    assert.equal(new Set(boards.map((x) => x.id)).size, 3);
    for (const board of boards) {
      const read = successful(
        await app.run<{
          key: string;
          revision: number;
          ref: { kind: string; id: string };
          data: { slug: string; prefix: string };
        }>(["board", "get", board.key]),
      ).data;
      assert.deepEqual(
        {
          key: read.key,
          revision: read.revision,
          ref: read.ref,
          slug: read.data.slug,
          prefix: read.data.prefix,
        },
        {
          key: board.key,
          revision: board.revision,
          ref: { kind: "board", id: board.id },
          slug: board.slug,
          prefix: board.prefix,
        },
      );
      assert.deepEqual(successful(await app.run(["board", "get", board.id])).data, read);
      for (const width of [40, 100]) {
        const human = await invokeRaw(app.root, ["board", "get", board.key], {
          env: { COLUMNS: String(width), FORCE_COLOR: "3" },
        });
        assert.equal(human.code, 0, human.stdout + human.stderr);
        assert.equal(human.stderr, "");
        for (const fragment of [board.key, board.name, board.slug, board.prefix, "Ревизия:"])
          assert.ok(human.stdout.includes(fragment), human.stdout);
        assert.doesNotMatch(human.stdout, /\u001b|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{23}/i);
      }
    }
    const list = await invokeRaw(app.root, ["board", "list", "--limit", 2]);
    assert.equal(list.code, 0, list.stdout);
    assert.match(list.stdout, /BOARD-/);
    assert.match(list.stdout, /npx @oim-dev\/relay-cli .*board list.*--cursor/);
    failed(await app.run(["board", "get", "BOARD-MISSING"]), "ENTITY_NOT_FOUND", 3);
  },
);
