import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkHistoryService } from "../src/application/work-history/service.js";
import { WorkHistoryRepository } from "../src/storage/work-history.js";
import { ProductQueries } from "../src/application/product/queries.js";
import type { WorkHistoryMutation } from "@relay/contracts/work-history";
import { fixture } from "./helpers/workspace.js";

test("Обзор сессий: последнее событие, старые незавершённые ветки, родитель и общий guard", async (t) => {
  const { workspace } = await fixture(t);
  const product = new ProductQueries(workspace);
  const work = new WorkHistoryService(workspace);
  const empty = await product.overview();
  assert.deepEqual(empty.snapshot.sessions, {
    total: 0,
    latest: null,
    unfinished: { total: 0, shown: 0, hasMore: false, items: [] },
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const start = async (title: string) => {
    t.mock.timers.tick(1000);
    return work.start(
      { title, description: "ПОЛНЫЙ МАТЕРИАЛ НЕ В ОБЗОРЕ", requestId: "start" },
      "agent",
    );
  };
  const owner = (state: WorkHistoryMutation) => ({
    ref: state.session.id,
    ifRevision: state.session.revision,
    runId: state.run!.id,
    requestId: "operation",
  });
  let old = await start("Старая открытая работа");
  const first = await product.overview();
  assert.equal(first.snapshot.sessions.latest?.id, old.session.id);
  assert.equal(first.snapshot.sessions.latest?.lastEvent.kind, "run-started");
  assert.equal(first.snapshot.sessions.unfinished.total, 1);
  assert.equal(first.snapshot.sessions.unfinished.items[0]?.id, old.session.id);
  let paused = await start("Приостановленная работа");
  t.mock.timers.tick(1000);
  paused = await work.pause({ ...owner(paused), reason: "Пауза" }, "agent");
  let parent = await start("Родитель");
  parent = await work.openCheckpoint(
    { ...owner(parent), title: "Делегировать", body: "Полный intent" },
    "agent",
  );
  parent = await work.fork(
    { ...owner(parent), ref: parent.checkpoint!.id, title: "Ожидающий ребёнок" },
    "agent",
  );
  const child = parent.childSession!;
  const withChild = await product.overview();
  assert.deepEqual(
    withChild.snapshot.sessions.unfinished.items.find((s) => s.id === child.id)?.parent,
    {
      id: parent.session.id,
      key: parent.session.key,
    },
  );
  assert.equal(
    withChild.snapshot.sessions.unfinished.items.find((s) => s.id === paused.session.id)?.status,
    "paused",
  );
  assert.equal(
    withChild.snapshot.sessions.unfinished.items.find((s) => s.id === child.id)?.status,
    "pending",
  );
  for (let index = 0; index < 4; index++) await start(`Ещё открытая ${index}`);
  let closed = await start("Последняя завершённая работа");
  t.mock.timers.tick(1000);
  closed = await work.complete({ ...owner(closed), result: "ИТОГ НЕ В ОБЗОРЕ" }, "agent");

  // Обзор читает только индексные карточки истории, не полные Markdown выбранных сессий.
  const materialReads = t.mock.method(WorkHistoryRepository.prototype, "get");
  const overview = await product.overview();
  assert.equal(materialReads.mock.callCount(), 0);
  materialReads.mock.restore();
  const sessions = overview.snapshot.sessions;
  assert.equal(sessions.total, 9);
  assert.equal(sessions.latest?.id, closed.session.id);
  assert.equal(sessions.latest?.status, "completed");
  assert.equal(sessions.latest?.lastEvent.kind, "session-closed");
  assert.equal(sessions.unfinished.total, 8);
  assert.equal(sessions.unfinished.shown, 5);
  assert.equal(sessions.unfinished.hasMore, true);
  assert.equal(sessions.unfinished.items.length, 5);
  assert.ok(!sessions.unfinished.items.some((s) => s.id === old.session.id));
  assert.doesNotMatch(JSON.stringify(sessions), /ПОЛНЫЙ МАТЕРИАЛ|ИТОГ НЕ В ОБЗОРЕ/);
  const allOpen = await work.list({ unfinished: true, limit: 100 });
  assert.equal(allOpen.total, sessions.unfinished.total);
  assert.ok(allOpen.items.some((s) => s.id === old.session.id));
  assert.equal((await product.overview()).snapshotVersion, overview.snapshotVersion);
  assert.equal(overview.version, empty.version, "История не меняет версию продуктового состава");

  // Новый материал старой сессии делает её последней и инвалидирует весь срез.
  t.mock.timers.tick(1000);
  old = await work.openCheckpoint(
    { ...owner(old), title: "Продолжение старой работы", body: "Материал" },
    "agent",
  );
  const continued = await product.overview();
  assert.equal(continued.snapshot.sessions.latest?.id, old.session.id);
  assert.equal(continued.snapshot.sessions.latest?.lastEvent.kind, "checkpoint");
  assert.equal(continued.snapshot.sessions.unfinished.items[0]?.id, old.session.id);
  assert.notEqual(continued.snapshotVersion, overview.snapshotVersion);
  assert.equal(continued.version, overview.version);
  await assert.rejects(product.overviewMap({ version: overview.snapshotVersion }), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(
    product.overviewMetric({ metric: "board-work", version: overview.snapshotVersion }),
    { code: "VERSION_CONFLICT" },
  );

  // При равном времени используется тот же детерминированный порядок, что у history desc.
  t.mock.timers.tick(1000);
  await work.start({ title: "Равное время A", requestId: "a" }, "agent");
  await work.start({ title: "Равное время B", requestId: "b" }, "agent");
  const history = await work.history({ limit: 1 });
  const tied = await product.overview();
  assert.equal(tied.snapshot.sessions.latest?.id, history.items[0]?.sessionId);
  assert.equal(tied.snapshot.sessions.latest?.lastEvent.sequence, history.items[0]?.sequence);
});
