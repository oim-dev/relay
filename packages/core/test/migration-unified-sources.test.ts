import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { digest } from "../src/storage/entity-store/format.js";
import { readUnifiedMigrationSources } from "../src/storage/migration/unified-sources.js";
import type { JsonValue } from "@relay/contracts/storage";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const stream = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const markdown = "# Полный текст\r\n\r\n  отступ  \r\nконец\n";
const indexed = [
  {
    kind: "indexed",
    index: "task-comment",
    key: "task:comment",
    value: { body: markdown },
    groups: [{ index: "task-comments", key: "task", member: "comment" }],
  },
  {
    kind: "indexed",
    index: "planning-receipts",
    key: "plan:request",
    value: { requirements: markdown, revision: 7 },
    groups: [{ index: "planning", key: "plan", member: null }],
  },
];
const entry = {
  at: "2026-09-26T00:00:00.000Z",
  actor: "agent:test",
  namespace: "task.comment.add",
  requestId: "request-1",
  requestHash: "original-request-hash",
  result: {
    id: "deleted-task",
    revision: 4,
    body: markdown,
    nullable: null,
    nested: [false, 0, ""],
  },
  refs: [{ kind: "task", id: "task-id" }],
  events: indexed,
};
const operation = {
  ...entry,
  schemaVersion: 1,
  id,
  changes: [{ path: "entities/tasks/task-id.json", before: null, after: { body: markdown } }],
};
const segment = (first = 1, entries = [entry]) => ({ schemaVersion: 1, first, entries });
const path = (first = 1) => `history/${stream}/${String(first).padStart(16, "0")}.json`;
const noLock = () => {};

async function put(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value, null, 2) + "\n");
}
async function fixture(version: number, sources: Record<string, JsonValue>) {
  const root = await mkdtemp(join(tmpdir(), "relay-migration-sources-"));
  await put(root, "storage.json", { format: "relay-entities", schemaVersion: version });
  const entries = Object.entries(sources).map(([path, value]) => [path, digest(value)]);
  const leaf = { schemaVersion: 1, type: "leaf", entries };
  const hash = digest(leaf);
  if (entries.length) await put(root, `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`, leaf);
  await put(root, ".indexes/state.json", {
    schemaVersion: 1,
    version: "snapshot",
    roots: { "file-hashes": entries.length ? hash : null },
  });
  for (const [path, value] of Object.entries(sources)) await put(root, path, value);
  return root;
}
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === expected;

for (const version of [1, 2] as const)
  test(`v${version}: квитанции, Markdown, comments/planning и группы без потерь`, async (t) => {
    const sourcePath = version === 1 ? `operations/${id}.json` : path();
    const raw = version === 1 ? operation : segment();
    const root = await fixture(version, { [sourcePath]: raw });
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(
      root,
      version === 1 ? "operations/user-notes.json" : `history/${stream}/user-notes.json`,
      { untouched: true },
    );
    const before = await readFile(join(root, sourcePath));
    let checks = 0;
    const result = await readUnifiedMigrationSources(root, () => {
      checks++;
    });
    assert.equal(result.version, version);
    assert.ok(checks > 2);
    assert.equal(result.operations.length, 1);
    const actual = result.operations[0]!;
    for (const key of [
      "namespace",
      "actor",
      "requestId",
      "requestHash",
      "result",
      "refs",
      "events",
    ] as const)
      assert.deepEqual(actual[key], entry[key]);
    assert.equal(actual.id, version === 1 ? id : `${stream}:1`);
    assert.equal(actual.sourcePath, sourcePath);
    assert.deepEqual(actual.indexed, indexed);
    assert.deepEqual(result.sourceFiles, [{ path: sourcePath, hash: digest(raw) }]);
    assert.ok(result.files.every((file) => !file.path.includes("user-notes")));
    assert.deepEqual(await readUnifiedMigrationSources(root, noLock), result);
    assert.deepEqual(await readFile(join(root, sourcePath)), before);
    if (version === 1) assert.deepEqual(actual.changes, operation.changes);
    else assert.deepEqual(result.segments, [{ path: sourcePath, segment: raw }]);
  });

test("v1: неиндексированные события не теряются и не принимаются за индекс", async (t) => {
  const events = [...indexed, { kind: "legacy-audit", text: markdown }];
  const root = await fixture(1, { [`operations/${id}.json`]: { ...operation, events } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await readUnifiedMigrationSources(root, noLock);
  assert.deepEqual(result.operations[0]!.events, events);
  assert.deepEqual(result.operations[0]!.indexed, indexed);
});

for (const version of [1, 2] as const)
  for (const failure of ["missing", "changed", "corrupt"] as const)
    test(`v${version}: отказ при ${failure} source`, async (t) => {
      const sourcePath = version === 1 ? `operations/${id}.json` : path();
      const root = await fixture(version, { [sourcePath]: version === 1 ? operation : segment() });
      t.after(() => rm(root, { recursive: true, force: true }));
      if (failure === "missing") await rm(join(root, sourcePath));
      else if (failure === "corrupt") await writeFile(join(root, sourcePath), "{broken");
      else await put(root, sourcePath, { changed: true });
      await assert.rejects(
        readUnifiedMigrationSources(root, noLock),
        code(
          failure === "missing"
            ? "STORAGE_RECORD_MISSING"
            : failure === "changed"
              ? "STORAGE_INDEX_STALE"
              : "STORAGE_DATA_CORRUPT",
        ),
      );
    });

test("v2: пересечение диапазонов, неверный номер и переполнение запрещены", async (t) => {
  for (const sources of [
    { [path()]: segment(1, [entry, entry]), [path(2)]: segment(2) },
    { [path()]: segment(2) },
    { [path(Number.MAX_SAFE_INTEGER)]: segment(Number.MAX_SAFE_INTEGER, [entry, entry]) },
  ]) {
    const root = await fixture(2, sources);
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(readUnifiedMigrationSources(root, noLock));
  }
});

test("v2: пропуски между непересекающимися диапазонами допустимы", async (t) => {
  const root = await fixture(2, { [path()]: segment(), [path(10)]: segment(10) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await readUnifiedMigrationSources(root, noLock);
  assert.deepEqual(
    result.operations.map((operation) => operation.id),
    [`${stream}:1`, `${stream}:10`],
  );
  assert.deepEqual(
    result.operations.map((operation) => operation.result),
    [entry.result, entry.result],
  );
});

test("Неизвестные версии, пути и ID отклоняются", async (t) => {
  for (const [version, sources] of [
    [3, {}],
    [1, { [`operations/${id}.json`]: { ...operation, schemaVersion: 2 } }],
    [1, { [`operations/${stream}.json`]: operation }],
    [2, { [path()]: { ...segment(), schemaVersion: 2 } }],
    [1, { "operations/../foreign.json": operation }],
  ] as Array<[number, Record<string, JsonValue>]>) {
    const root = await fixture(version, sources);
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(readUnifiedMigrationSources(root, noLock));
  }
});

test("Неиндексированный источник, потерянный индекс и symlink не маскируются пустотой", async (t) => {
  for (const failure of ["unindexed", "index", "symlink"]) {
    const root = await fixture(2, { [path()]: segment() });
    t.after(() => rm(root, { recursive: true, force: true }));
    if (failure === "unindexed") await put(root, path(2), segment(2));
    else if (failure === "index") await rm(join(root, ".indexes/segments"), { recursive: true });
    else {
      await put(root, "foreign.json", segment());
      await rm(join(root, path()));
      await symlink(join(root, "foreign.json"), join(root, path()));
    }
    await assert.rejects(readUnifiedMigrationSources(root, noLock));
  }
});

test("Утрата внешней блокировки немедленно прерывает чтение", async (t) => {
  const root = await fixture(2, {});
  t.after(() => rm(root, { recursive: true, force: true }));
  const lost = new Error("Блокировка потеряна");
  await assert.rejects(
    readUnifiedMigrationSources(root, () => {
      throw lost;
    }),
    (error) => error === lost,
  );
});
