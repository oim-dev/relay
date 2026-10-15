import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { WorkHistoryMutation } from "@relay/contracts/work-history";
import { StorageService } from "../src/application/storage/service.js";
import { WorkHistoryService } from "../src/application/work-history/service.js";
import { stateSchema } from "../src/storage/entity-store/format.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { StorageTransaction } from "../src/storage/entity-store/transaction.js";
import { initialize } from "../src/storage/workspace.js";
import { persistent, treeHashes } from "./helpers/migration-bases.js";

const material = { title: "Материал", body: "\n# Полный Markdown\r\n\n  Без нормализации  \n" };
const owner = (state: WorkHistoryMutation) => ({
  ref: state.session.id,
  ifRevision: state.session.revision,
  runId: state.run!.id,
  requestId: "operation",
});
async function fixture(t: TestContext) {
  const root = await mkdtemp("/tmp/opencode/relay-work-history-index-guards-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const service = new WorkHistoryService(workspace);
  const started = await service.start({ title: "Индексная проверка", requestId: "start" }, "agent");
  const state = await service.openCheckpoint({ ...owner(started), ...material }, "agent");
  const statePath = join(workspace.dataRoot, ".indexes/state.json");
  return { root, workspace, service, state, statePath };
}

for (const index of [
  "work-history-addresses",
  "work-history-checkpoints",
  "work-history-sessions",
  "work-history-runs",
]) {
  test(`История: потеря ${index} не превращает существующую запись в неизвестную`, async (t) => {
    const { workspace, service, state, statePath } = await fixture(t);
    const indexes = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    assert(indexes.roots[index]);
    delete indexes.roots[index];
    await writeFile(statePath, JSON.stringify(indexes));
    const before = await treeHashes(workspace.dataRoot, persistent);
    const get = t.mock.method(StorageSession.prototype, "get");
    if (index === "work-history-addresses" || index === "work-history-checkpoints") {
      for (const ref of [
        state.checkpoint!.id,
        state.checkpoint!.key,
        `work-checkpoint:${state.checkpoint!.id}`,
        "CP-unknown",
      ]) {
        await assert.rejects(service.checkpoint({ ref }), { code: "STORAGE_INDEX_CORRUPT" });
      }
    }
    for (const ref of [state.session.id, state.session.key, `work-session:${state.session.id}`]) {
      await assert.rejects(service.get({ ref }), { code: "STORAGE_INDEX_CORRUPT" });
    }
    assert.equal(get.mock.callCount(), 0, "Нарушение обнаруживается только по компактным индексам");
    get.mock.restore();
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);

    await new StorageService(workspace).reindex();
    for (const ref of [
      state.checkpoint!.id,
      state.checkpoint!.key,
      `work-checkpoint:${state.checkpoint!.id}`,
    ]) {
      assert.deepEqual(await service.checkpoint({ ref }), state.checkpoint);
    }
    for (const ref of [state.session.id, state.session.key, `work-session:${state.session.id}`]) {
      assert.deepEqual((await service.get({ ref })).session, state.session);
    }
    for (const ref of ["CP-unknown", "unknown", "work-checkpoint:unknown"]) {
      await assert.rejects(service.checkpoint({ ref }), { code: "ENTITY_NOT_FOUND" });
    }
    for (const ref of ["S-unknown", "unknown", "work-session:unknown"]) {
      await assert.rejects(service.get({ ref }), { code: "ENTITY_NOT_FOUND" });
    }
  });
}

for (const terminal of ["result", "cancel"] as const) {
  test(`История: непустой индекс до ${terminal} не разрешает запись после закрытия intent`, async (t) => {
    const { root, workspace, service, state: opened, statePath } = await fixture(t);
    const intent = opened.checkpoint!;
    const previous = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    const savedSegments = join(root, "previous-segments");
    await cp(join(workspace.dataRoot, ".indexes/segments"), savedSegments, { recursive: true });
    const command = { ...owner(opened), ref: intent.id, ...material };
    const closed =
      terminal === "result"
        ? await service.completeCheckpoint(command, "agent")
        : await service.cancelCheckpoint(command, "agent");
    const current = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    assert.notEqual(
      current.roots["work-history-checkpoints"],
      previous.roots["work-history-checkpoints"],
    );
    current.roots["work-history-checkpoints"] = previous.roots["work-history-checkpoints"]!;
    await cp(savedSegments, join(workspace.dataRoot, ".indexes/segments"), { recursive: true });
    await writeFile(statePath, JSON.stringify(current));

    // Авторитетный records и ревизия ветки актуальны; отстал только один непустой индекс.
    const fresh = { ...owner(closed), ref: intent.key, ...material };
    const before = await treeHashes(workspace.dataRoot, persistent);
    const publish = t.mock.method(StorageTransaction.prototype, "publish");
    const get = t.mock.method(StorageSession.prototype, "get");
    await assert.rejects(service.saveCheckpoint(fresh, "agent"), { code: "STORAGE_INDEX_CORRUPT" });
    await assert.rejects(service.completeCheckpoint(fresh, "agent"), {
      code: "STORAGE_INDEX_CORRUPT",
    });
    await assert.rejects(service.cancelCheckpoint(fresh, "agent"), {
      code: "STORAGE_INDEX_CORRUPT",
    });
    await assert.rejects(
      service.fork({ ...owner(closed), ref: intent.id, title: "Недопустимый ребёнок" }, "agent"),
      { code: "STORAGE_INDEX_CORRUPT" },
    );
    await assert.rejects(service.openIntents({ ref: closed.session.id }), {
      code: "STORAGE_INDEX_CORRUPT",
    });
    assert.equal(get.mock.callCount(), 0, "Полнота проверяется без открытия материалов");
    assert.equal(publish.mock.callCount(), 0, "Отказ происходит до публикации WAL");
    get.mock.restore();
    publish.mock.restore();
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);

    await new StorageService(workspace).reindex();
    assert.deepEqual((await service.get({ ref: closed.session.key })).session, closed.session);
    assert.deepEqual(await service.checkpoint({ ref: intent.key }), intent);
    assert.deepEqual(await service.checkpoint({ ref: closed.checkpoint!.id }), closed.checkpoint);
    assert.equal((await service.openIntents({ ref: closed.session.id })).total, 0);
    const repaired = await treeHashes(workspace.dataRoot, persistent);
    await assert.rejects(service.saveCheckpoint(fresh, "agent"), { code: "WORK_INTENT_CLOSED" });
    await assert.rejects(service.completeCheckpoint(fresh, "agent"), {
      code: "WORK_INTENT_CLOSED",
    });
    await assert.rejects(service.cancelCheckpoint(fresh, "agent"), { code: "WORK_INTENT_CLOSED" });
    await assert.rejects(
      service.fork({ ...owner(closed), ref: intent.id, title: "Закрытое намерение" }, "agent"),
      { code: "WORK_INTENT_CLOSED" },
    );
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), repaired);
  });
}

for (const damage of ["same-size-card-replacement", "missing-single-address"]) {
  test(`История: проверяется состав, а не только наличие корня и размер (${damage})`, async (t) => {
    const { workspace, service, state } = await fixture(t);
    const checkpoint = state.checkpoint!;
    await workspace.withEntityStorage((store, owned) =>
      store.transaction(owned, async (tx) => {
        if (damage === "same-size-card-replacement") {
          const card = await tx.indexGet("work-history-checkpoints", checkpoint.id);
          assert(card && typeof card === "object" && !Array.isArray(card));
          tx.indexSet("work-history-checkpoints", checkpoint.id, undefined);
          tx.indexSet("work-history-checkpoints", "ghost", {
            ...card,
            id: "ghost",
            key: "CP-ghost",
          });
        } else
          tx.indexSet("work-history-addresses", `work-checkpoint:${checkpoint.key}`, undefined);
      }),
    );
    const before = await treeHashes(workspace.dataRoot, persistent);
    await assert.rejects(service.checkpoint({ ref: checkpoint.key }), {
      code: "STORAGE_INDEX_CORRUPT",
    });
    await assert.rejects(
      service.saveCheckpoint({ ...owner(state), ref: checkpoint.id, ...material }, "agent"),
      { code: "STORAGE_INDEX_CORRUPT" },
    );
    assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), before);
    await new StorageService(workspace).reindex();
    assert.deepEqual(await service.checkpoint({ ref: checkpoint.key }), checkpoint);
  });
}

test("История: пустые целые индексы допускают неизвестный адрес, но не выдумывают запись", async (t) => {
  const root = await mkdtemp("/tmp/opencode/relay-work-history-index-empty-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  const service = new WorkHistoryService(workspace);
  await assert.rejects(service.get({ ref: "S-unknown" }), { code: "ENTITY_NOT_FOUND" });
  await assert.rejects(service.checkpoint({ ref: "CP-unknown" }), { code: "ENTITY_NOT_FOUND" });
  assert.equal((await service.list({})).total, 0);
});
