import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRun, WorkCheckpoint, WorkSession } from "@relay/contracts/work-history";
import { workCheckpointSchema } from "@relay/contracts/work-history";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { EntityStore } from "../src/storage/entity-store/store.js";
import type { EntityRecord } from "../src/storage/entity-store/registry.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { workHistoryCodecs } from "../src/storage/work-history-codecs.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { validateWorkspace } from "../src/application/validate.js";
import { StorageService } from "../src/application/storage/service.js";
import { parseStorageManifest } from "../src/storage/data-model/manifest.js";
import { PROFILE_2, PROFILE_3 } from "../src/storage/data-model/profiles.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import {
  frozenProject,
  readJsonFile,
  treeHashes,
  writeJsonFile,
} from "./helpers/migration-bases.js";

const markdown = "  # Полный материал 🧪\r\n\r\n- **Готово**  \n\tСледующий шаг\n\n";
const at = "2026-10-15T10:00:00.000Z";
const branch: WorkSession = {
  id: "session-1",
  key: "S-aed9728e81464cfeaba8ebc72ad227ff",
  title: "Ветка",
  description: markdown,
  parentSessionId: null,
  originCheckpointId: null,
  createdByRunId: null,
  parentSequence: null,
  status: "open",
  currentRunId: "run-2",
  sequence: 6,
  result: "",
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  revision: 4,
};
const first: AgentRun = {
  id: "run-1",
  key: "RUN-42d3d3c2a7c94e47b738bd3cc7a26ef1",
  sessionId: branch.id,
  actor: "agent-1",
  operator: { name: "Ирина", email: "operator@example.test", source: "git" },
  git: { branch: "feature/history", commit: "a".repeat(40) },
  client: "cli",
  sourceSessionId: "external-1",
  startedAt: at,
  endedAt: at,
  startedSequence: 2,
  endedSequence: 4,
  endReason: "paused",
  predecessorRunId: null,
  reason: markdown,
  endSummary: markdown,
};
const second: AgentRun = {
  ...first,
  id: "run-2",
  key: "RUN-563a9eb1954f4e58926ba66d9d82305d",
  actor: "agent-2",
  operator: null,
  git: null,
  client: null,
  sourceSessionId: null,
  startedSequence: 5,
  endedAt: null,
  endedSequence: null,
  endReason: null,
  predecessorRunId: first.id,
  endSummary: null,
};
const intent: WorkCheckpoint = {
  id: "checkpoint-1",
  key: "CP-e4f575477c3f4698bbc5a24f65fe30b70",
  sessionId: branch.id,
  runId: first.id,
  sequence: 3,
  kind: "intent",
  intentId: null,
  title: "Намерение",
  summary: "Кратко",
  body: markdown,
  done: markdown,
  remaining: markdown,
  nextStep: markdown,
  checks: markdown,
  references: [],
  acceptedSessionIds: [],
  createdAt: at,
  createdBy: first.actor,
};
const progress: WorkCheckpoint = {
  ...intent,
  id: "checkpoint-2",
  key: "CP-f2d383d520c9456086007f80c0c1d26f",
  runId: second.id,
  sequence: 6,
  kind: "progress",
  intentId: intent.id,
  createdBy: second.actor,
};
function record(kind: string, data: WorkSession | AgentRun | WorkCheckpoint): EntityRecord {
  return {
    schemaVersion: 3,
    dataVersion: 1,
    kind,
    id: data.id,
    key: null,
    aliases: [],
    revision: "revision" in data ? data.revision : 1,
    createdAt: at,
    updatedAt: at,
    createdBy: "fixture",
    updatedBy: "fixture",
    data: structuredClone(data),
  };
}
const command = (requestId: string) => ({
  namespace: "work-history-storage-test",
  actor: "fixture",
  requestId,
  request: {},
});
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "relay-work-history-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t: TestContext) {
  const dir = await directory(t);
  const workspace = await initialize(dir, "tasks");
  const root = dirname(workspace.configPath);
  const store = await EntityStore.open(root, workspaceStorageRegistry());
  const rows = [
    record("work-session", branch),
    record("agent-run", first),
    record("agent-run", second),
    record("work-checkpoint", intent),
    record("work-checkpoint", progress),
  ];
  await store.run(command("seed"), async (tx) => {
    for (const row of rows) await tx.importRecord(row);
    return null;
  });
  return { dir, root, workspace, store, rows };
}

test("История: три технических кодека, точный Markdown всех полей и nullable endSummary/operator/git", () => {
  const registry = workspaceStorageRegistry();
  assert.equal(PROFILE_2.owners["work-session"], undefined, "Старый профиль изменён");
  assert.equal(PROFILE_3.owners["work-session"], 1);
  assert.equal(workHistoryCodecs().length, 3);
  for (const [kind, data, fields] of [
    [
      "work-session",
      { ...branch, status: "completed", currentRunId: null, result: markdown, closedAt: at },
      ["description", "result"],
    ],
    ["agent-run", first, ["reason", "endSummary"]],
    ["agent-run", second, ["reason"]],
    ["work-checkpoint", intent, ["body", "done", "remaining", "nextStep", "checks"]],
  ] as const) {
    const row = record(kind, data);
    const encoded = registry.encode(row);
    assert.equal(encoded.key, null);
    assert.equal(registry.definition(kind).addressable, false);
    assert(registry.definition(kind).diskSchema?.safeParse(encoded.data).success);
    for (const field of fields) assert.deepEqual(encoded.data[field], markdown.split("\n"));
    assert.deepEqual(registry.decode(encoded).data, row.data);
    assert.throws(() => registry.card(encoded), { code: "ENTITY_NOT_FOUND" });
    assert.throws(() => registry.encode({ ...row, key: "PUBLIC-1" }), { code: "INVALID_DATA" });
  }
});

test("История: status/doctor и reindex сохраняют данные, компактные индексы, отсутствие общего графа", async (t) => {
  const { root, workspace, store, rows } = await fixture(t);
  const expected = new Map<string, unknown[]>();
  await store.read(async (snapshot) => {
    for (const name of [
      "work-history-sessions",
      "work-history-runs",
      "work-history-checkpoints",
      "work-history-addresses",
    ])
      expected.set(name, await snapshot.indexEntries(name));
    const session = (await snapshot.indexGet("work-history-sessions", branch.id)) as Record<
      string,
      unknown
    >;
    assert.equal("description" in session, false);
    assert.equal("result" in session, false);
    const run = (await snapshot.indexGet("work-history-runs", first.id)) as Record<string, unknown>;
    assert.equal("reason" in run, false);
    assert.equal("endSummary" in run, false);
    assert.deepEqual(run.operator, first.operator);
    assert.deepEqual(run.git, first.git);
    const point = (await snapshot.indexGet("work-history-checkpoints", intent.id)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      Object.keys(point).sort(),
      [
        "id",
        "key",
        "sessionId",
        "runId",
        "sequence",
        "kind",
        "intentId",
        "title",
        "createdAt",
        "createdBy",
        "acceptedSessionIds",
      ].sort(),
    );
    assert.equal(await snapshot.indexGet("addresses", branch.key), undefined);
    assert.equal(await snapshot.indexGet("cards", `work-session:${branch.id}`), undefined);
    assert.equal(
      await snapshot.indexGet("work-history-addresses", `work-session:${branch.key}`),
      branch.id,
    );
  });
  const before = await Promise.all(
    rows.map((row) => readFile(join(root, store.registry.path(row)), "utf8")),
  );
  assert.equal((await inspectStorage({ configPath: workspace.configPath })).status, "current");
  assert.equal((await validateWorkspace(workspace)).valid, true);
  await new StorageService(workspace).reindex();
  for (const [index, entries] of expected)
    await store.read(async (snapshot) =>
      assert.deepEqual(await snapshot.indexEntries(index), entries),
    );
  for (let i = 0; i < rows.length; i++) {
    assert.equal(await readFile(join(root, store.registry.path(rows[i]!)), "utf8"), before[i]);
    assert.deepEqual((await store.get(rows[i]!)).data, rows[i]!.data);
  }
  assert.equal((await validateWorkspace(workspace)).valid, true);
});

test("История: потерянный собственный индекс диагностируется, reindex восстанавливает его", async (t) => {
  const { root, workspace } = await fixture(t);
  const path = join(root, ".indexes/state.json");
  const state = await readJsonFile<{ roots: Record<string, string> }>(path);
  delete state.roots["work-history-checkpoints"];
  await writeJsonFile(path, state);
  const status = await inspectStorage({ configPath: workspace.configPath });
  assert.equal(status.status, "invalid");
  assert(status.blockers.some((blocker) => blocker.code === "STORAGE_INDEX_STALE"));
  await new StorageService(workspace).reindex();
  assert.equal((await inspectStorage({ configPath: workspace.configPath })).status, "current");
});

test("История: duplicate own key после merge — адресная ошибка reindex/status/doctor без перезаписи индексов", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const duplicate = record("work-session", {
    ...branch,
    id: "merged-session",
    status: "pending",
    currentRunId: null,
  });
  const path = store.registry.path(duplicate);
  await writeJsonFile(join(root, path), store.registry.encode(duplicate));
  const before = await treeHashes(root);
  const status = await inspectStorage({ configPath: workspace.configPath });
  assert.equal(status.status, "invalid");
  assert(
    status.blockers.some(
      (blocker) =>
        blocker.code === "STORAGE_ADDRESS_COLLISION" &&
        blocker.path?.startsWith("entities/work-sessions/"),
    ),
  );
  await assert.rejects(store.reindex(), { code: "STORAGE_ADDRESS_COLLISION" });
  await assert.rejects(validateWorkspace(workspace), { code: "VALIDATION_FAILED" });
  assert.deepEqual(await treeHashes(root), before, "Диагностика и отказ reindex изменили базу");
});

test("История: внутренние ссылки требуют живой записи, внешняя подпись сохраняется с надгробием", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const tombstone = {
    schemaVersion: 3,
    dataVersion: 1,
    kind: "document",
    id: "deleted-document",
    key: "DOC-DELETED",
    aliases: [],
    revision: 1,
    deleted: { at, actor: "fixture" },
  };
  await mkdir(join(root, "entities/documents"), { recursive: true });
  await writeJsonFile(join(root, "entities/documents/deleted-document.json"), tombstone);
  const path = store.registry.path({ kind: "work-checkpoint", id: progress.id });
  const point = {
    ...progress,
    references: [
      {
        ref: { kind: "document" as const, id: "deleted-document" },
        key: "DOC-OLD",
        title: "Сохранённое старое имя",
      },
    ],
  };
  await writeJsonFile(join(root, path), store.registry.encode(record("work-checkpoint", point)));
  await new StorageService(workspace).reindex();
  assert.equal((await inspectStorage({ configPath: workspace.configPath })).status, "current");
  assert.deepEqual(
    workCheckpointSchema.parse((await store.get({ kind: "work-checkpoint", id: progress.id })).data)
      .references,
    point.references,
  );
  const broken = store.registry.encode(
    record("work-checkpoint", { ...point, intentId: "missing-intent" }),
  );
  await writeJsonFile(join(root, path), broken);
  const before = await treeHashes(root);
  assert(
    (await inspectStorage({ configPath: workspace.configPath })).blockers.some(
      (blocker) => blocker.code === "STORAGE_REFERENCE_BROKEN" && blocker.path === path,
    ),
  );
  await assert.rejects(store.reindex(), { code: "STORAGE_REFERENCE_BROKEN" });
  await assert.rejects(validateWorkspace(workspace), { code: "VALIDATION_FAILED" });
  assert.deepEqual(await treeHashes(root), before);
});

test("История: реальная база профиля 2 переносится явно в 3, без синтетических материалов", async (t) => {
  const { project, root, configPath } = await frozenProject(t, "profile2-3dc1189");
  const oracle = await readJsonFile<{ description: string; task: { id: string } }>(
    new URL("./fixtures/data-migrations/profile2-3dc1189/oracle.json", import.meta.url).pathname,
  );
  const before = await treeHashes(root);
  assert.equal((await inspectStorage({ configPath })).status, "migration-required");
  const oldWorkspace = await openWorkspace(project, configPath);
  await assert.rejects(new BoardTasksService(oldWorkspace).get(oracle.task.id), {
    code: "STORAGE_MIGRATION_REQUIRED",
  });
  const plan = await planStorageMigration({ configPath });
  assert.equal(plan.applicable, true, JSON.stringify(plan.blockers));
  assert.deepEqual(
    plan.steps.map((step) => [step.id, step.type]),
    [["profile.2-to-3", "profile"]],
  );
  assert.deepEqual(await treeHashes(root), before, "Dry-run изменил исходную базу");
  const result = await migrateStorage(
    { configPath },
    { backupDir: await directory(t), ifPlan: plan.planFingerprint },
  );
  assert.equal(result.migrated, true);
  const workspace = await openWorkspace(project, configPath);
  const task = await new BoardTasksService(workspace).get(oracle.task.id);
  assert.equal(task.description, oracle.description);
  const store = await EntityStore.open(root, workspaceStorageRegistry());
  await store.read(async (tx) => {
    for (const codec of workHistoryCodecs()) assert.deepEqual(await tx.records(codec.kind), []);
  });
  assert.equal((await inspectStorage({ configPath })).status, "current");
  assert.equal((await validateWorkspace(workspace)).valid, true);
  const manifest = await readJsonFile(join(root, "storage.json"));
  assert.equal(manifest.dataModelVersion, 3);
  assert.throws(() => parseStorageManifest(manifest, 2), { code: "STORAGE_VERSION_UNSUPPORTED" });
  const migrated = await treeHashes(root);
  assert.equal((await migrateStorage({ configPath })).migrated, false);
  assert.deepEqual(await treeHashes(root), migrated);
});
