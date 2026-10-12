import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initialize } from "../src/storage/workspace.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { manifestV4Profile1Schema } from "../src/storage/data-model/history/manifest-v4-profile1.js";
import { intentV1Schema } from "../src/storage/data-model/history/intent-v1.js";

/**
 * A24: прежний клиент Relay 0.9.2 отказывается от базы нового профиля до изменения данных.
 * Исторический parser — замороженные копии строгих схем 0.9.2 (history/*), без установки
 * пакетов. Порядок открытия повторяет 0.9.2 `EntityStore.open/underLock`: recovery WAL,
 * затем разбор manifest.
 */
async function historicalOpen(root: string): Promise<void> {
  const pending = join(root, "transactions/pending.json");
  const exists = (await readdir(join(root, "transactions"))).includes("pending.json");
  if (exists) intentV1Schema.parse(JSON.parse(await readFile(pending, "utf8")));
  manifestV4Profile1Schema.parse(JSON.parse(await readFile(join(root, "storage.json"), "utf8")));
}

async function files(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      for (const [key, value] of await files(root, path)) result.set(key, value);
    else result.set(path, await readFile(join(root, path), "utf8"));
  }
  return result;
}

test("A24: строгий parser 0.9.2 отвергает manifest профиля 2 до изменения данных", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-historical-client-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await initialize(directory, "tasks");
  const root = dirname(workspace.configPath);
  const manifest = JSON.parse(await readFile(join(root, "storage.json"), "utf8"));
  assert.equal(manifest.dataModelVersion, 2);
  const parsed = manifestV4Profile1Schema.safeParse(manifest);
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error?.issues.map((issue) => [
      issue.code,
      issue.code === "unrecognized_keys" && issue.keys,
    ]),
    [["unrecognized_keys", ["dataModelVersion"]]],
  );
  // Без поля (профиль 1) прежний parser принимает manifest — поэтому маркер обязателен.
  const { dataModelVersion: _profile, ...profile1 } = manifest;
  assert.equal(manifestV4Profile1Schema.safeParse(profile1).success, true);
  const before = await files(root);
  await assert.rejects(historicalOpen(root), { name: "ZodError" });
  assert.deepEqual(await files(root), before);
});

test("A24: WAL миграции (intent v2) прежний recovery отвергает и не допубликовывает", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-historical-wal-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await initialize(directory, "tasks");
  const root = dirname(workspace.configPath);
  const target = join(root, "keyspaces/global-feature.json");
  const original = await readFile(target, "utf8");
  const intent = {
    schemaVersion: 2,
    changes: [
      { path: "keyspaces/global-feature.json", before: null, after: { replaced: true } },
      { path: "storage.json", before: null, after: { format: "relay-entities", schemaVersion: 4 } },
    ],
    migration: {
      id: randomUUID(),
      registryDigest: "a".repeat(64),
      planFingerprint: "b".repeat(64),
      source: { layout: "unified-4", physical: 4, profile: 1 },
      target: { profile: 2 },
      transitions: ["profile-marker@1"],
      backup: { path: join(directory, "backup"), manifestSha256: "c".repeat(64) },
    },
  };
  await writeFile(join(root, "transactions/pending.json"), JSON.stringify(intent));
  // Текущий Core распознаёт WAL как миграционный — тот же файл, что увидит прежний клиент.
  assert.equal((await inspectPending(root)).kind, "migration");
  const parsed = intentV1Schema.safeParse(intent);
  assert.equal(parsed.success, false);
  assert(parsed.error?.issues.some((issue) => issue.path[0] === "schemaVersion"));
  const before = await files(root);
  await assert.rejects(historicalOpen(root), { name: "ZodError" });
  assert.deepEqual(await files(root), before);
  assert.equal(await readFile(target, "utf8"), original);
});
