import assert from "node:assert/strict";
import { graphFixture } from "./helpers/graph-workspace.js";
import { readOwned } from "../src/storage/entity-store/relations.js";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { GraphService } from "../src/application/graph/service.js";
import { join } from "node:path";
import { entityAddress } from "../src/domain/entity-graph.js";
import type { GraphMutation, GraphNode } from "../src/domain/entity-graph.js";
import { fixture } from "./helpers/workspace.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { readEntityCatalog } from "../src/application/entities/catalog.js";
import { AppError } from "../src/shared/errors.js";
import { ProductRepository } from "../src/storage/product.js";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import { persistent, treeHashes } from "./helpers/migration-bases.js";

const nodes: GraphNode[] = [
  "scenario:S",
  "implementation:I",
  "task:T",
  "document:D",
  "application:A",
  "future-kind:F",
].map((address) => {
  const [kind, id] = address.split(":");
  return { ref: { kind: kind!, id: id! }, title: address, key: id!, revision: 1, status: "" };
});
const ref = (index: number) => nodes[index]!.ref;
const add = (from: number, to: number, type = "references", description = "") => ({
  action: "add" as const,
  from: ref(from),
  to: ref(to),
  type,
  description,
});

test("граф: произвольные пары и циклы, пути, пагинация и изолированные сущности", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, async () => ({ nodes }));
  const before = await graph.read();
  assert.equal(before.totalNodes, 6);
  const saved = await graph.mutate(
    {
      ifVersion: before.version,
      requestId: "chain",
      operations: [
        add(1, 0, "implements"),
        add(2, 1, "implements"),
        add(2, 3),
        add(3, 0),
        add(0, 2, "custom.relation"),
      ],
    },
    "agent",
  );
  const all = await graph.read({ root: "scenario:S", depth: 5 });
  assert.equal(all.totalNodes, 4);
  assert.equal(all.depthLimited, false);
  assert.ok(all.paths.some((entry) => entityAddress(entry.target) === "document:D"));
  const shallow = await graph.read({ root: "implementation:I", depth: 0 });
  assert.equal(shallow.totalNodes, 1);
  assert.equal(shallow.depthLimited, true);
  const first = await graph.read({ limit: 1 });
  const second = await graph.read({ limit: 1, offset: first.nextOffset!, version: first.version });
  assert.notDeepEqual(first.nodes, second.nodes);
  assert.equal(second.version, saved.version);
  const incoming = await graph.read({ root: "document:D", direction: "incoming", depth: 1 });
  assert.ok(incoming.nodes.some((node) => node.ref.kind === "task"));
});

test("граф: атомарность, CAS при повторе, Markdown и сохранённый отзыв", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, async () => ({ nodes }));
  const version = (await graph.read()).version;
  const command = {
    ifVersion: version,
    requestId: "write",
    operations: [add(2, 3, "references", "## Пример\n\n  текст\n")],
  };
  const saved = await graph.mutate(command, "agent");
  await assert.rejects(graph.mutate(command, "agent"), { code: "GRAPH_CHANGED" });
  await assert.rejects(graph.mutate({ ...command, actor: "agent" }, "operator"), {
    code: "GRAPH_CHANGED",
  });
  await assert.rejects(graph.mutate({ ...command, requestId: "stale" }, "agent"), {
    code: "GRAPH_CHANGED",
  });
  await assert.rejects(graph.mutate({ ...command, operations: [add(0, 1)] }, "agent"), {
    code: "GRAPH_CHANGED",
  });
  const bad = {
    action: "add" as const,
    type: "references",
    from: ref(0),
    to: { kind: "task", id: "missing" },
  };
  await assert.rejects(
    graph.mutate(
      { ifVersion: saved.version, requestId: "bad", operations: [add(0, 1), bad] },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  assert.equal((await graph.read()).totalEdges, 1);
  const disk = JSON.parse(await readFile(join(workspace.root, "relations/tasks/T.json"), "utf8"));
  assert.deepEqual(
    disk.entries.find((entry: { edge: { id: string } }) => entry.edge.id === saved.ids[0])?.edge
      .description,
    ["## Пример", "", "  текст", ""],
  );
  await graph.mutate(
    {
      ifVersion: saved.version,
      requestId: "remove",
      operations: [{ action: "remove", id: saved.ids[0]! }],
    },
    "operator",
  );
  assert.equal((await graph.read()).totalEdges, 0);
  const stored = await workspace.locked(() => readOwned(workspace.storageSession!, ref(2)));
  const removed = stored.entries.find((entry) => entry.edge.id === saved.ids[0])!;
  assert.equal(removed.edge.active, false);
  assert.equal(removed.edge.revision, 2);
  assert.equal(removed.edge.updatedBy, "operator");
  await assert.rejects(graph.mutate(command, "agent"), { code: "GRAPH_CHANGED" });
});

test("граф: конкуренция, политика приложения, изоляция и повреждение файла", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const catalog = async () => ({ nodes });
  const graph = new GraphService(workspace, catalog);
  const version = (await graph.read()).version;
  const attempts = await Promise.allSettled(
    [1, 2].map((n) =>
      graph.mutate(
        { ifVersion: version, requestId: `concurrent-${n}`, operations: [add(0, n)] },
        "agent",
      ),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const other = await graphFixture(t, nodes);
  assert.equal((await new GraphService(other.workspace, catalog).read()).totalEdges, 0);
  const restricted = new GraphService(workspace, catalog, () => {
    throw new Error("Политика приложения");
  });
  await assert.rejects(
    restricted.mutate(
      { ifVersion: (await graph.read()).version, requestId: "policy", operations: [add(4, 5)] },
      "agent",
    ),
    /Политика/,
  );
  assert.equal((await graph.read()).totalEdges, 1);
  await writeFile(join(workspace.root, "relations/scenarios/S.json"), "{}");
  await assert.rejects(graph.read());
});

test("контекст: сохранённая цепочка проходит через документ и приложение без скрытого отсечения", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  const graph = new GraphService(workspace, async () => ({ nodes }));
  await graph.mutate(
    {
      ifVersion: (await graph.read()).version,
      requestId: "context",
      operations: [add(2, 3), add(3, 4), add(4, 0), add(0, 2)],
    },
    "agent",
  );
  const page = await graph.read({ root: "task:T", profile: "context", depth: 10 });
  assert.deepEqual(page.nodes.map((node) => node.ref.kind).sort(), [
    "application",
    "document",
    "scenario",
    "task",
  ]);
  assert.equal(page.totalEdges, 4);
  assert.equal(page.depthLimited, false);
  assert.deepEqual(await graph.read({ root: "task:T", profile: "all", depth: 10 }), page);
  for (const root of ["document:D", "application:A", "scenario:S"]) {
    const context = await graph.read({ root, depth: 10 });
    assert.equal(context.totalNodes, 4);
    assert.equal(context.totalEdges, 4);
  }
});

test("движок: сценарий документа пишет свои связи, не присваивая независимые рёбра", async (t) => {
  const { workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      data: { kind: "feature", name: "API", summary: "", description: "Контракт API" },
      requestId: "feature",
    },
    "agent",
  );
  const task = await engine.create(
    {
      data: { kind: "task", board: "BOARD-PRODUCT", title: "API-работа", targets: [feature.key] },
      requestId: "task",
    },
    "agent",
  );
  const document = await engine.create(
    {
      data: {
        kind: "document",
        name: "Инструкция",
        summary: "",
        body: "## Материал",
        documentKind: "description",
        targets: [feature.key],
      },
      requestId: "document",
    },
    "agent",
  );
  const graph = new GraphService(workspace);
  const before = await graph.read();
  assert.ok(before.nodes.some((node) => node.ref.id === document.ref.id));
  assert.ok(before.nodes.some((node) => node.ref.kind === "project"));
  assert.ok(before.nodes.some((node) => node.ref.kind === "product"));
  assert.equal(before.totalEdges, 5);
  const attachments = before.edges.filter(
    (edge) =>
      edge.type === "documents" &&
      edge.from.id === document.ref.id &&
      edge.to.id === feature.ref.id,
  );
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.source, "graph");
  const initialContext = await graph.context({ root: task.key });
  assert(
    initialContext.edges.some(
      (edge) => edge.from.id === task.ref.id && edge.to.id === feature.ref.id,
    ),
  );

  const command = {
    ifVersion: before.version,
    requestId: "explicit-attach",
    operations: [
      {
        action: "add" as const,
        from: task.ref,
        to: document.ref,
        type: "references",
        description: "Перед выполнением",
      },
    ],
  };
  const saved = await graph.mutate(command, "agent");
  await assert.rejects(graph.mutate(command, "agent"), { code: "GRAPH_CHANGED" });
  const id = saved.ids[0]!;
  const stored = await workspace.locked(() => readOwned(workspace.storageSession!, task.ref));
  assert.equal(stored.entries.find((entry) => entry.edge.id === id)?.edge.source, "graph");
  const fresh = new GraphService(workspace);
  const outgoing = await fresh.read({ root: task.key, depth: 1, direction: "outgoing" });
  const incoming = await fresh.read({ root: document.key, depth: 1, direction: "incoming" });
  assert(outgoing.edges.some((edge) => edge.id === id));
  assert(incoming.edges.some((edge) => edge.id === id));

  // Сценарий снимает своё прикрепление, но сохраняет независимое ребро задачи.
  const detached = await engine.update(
    {
      ref: document.key,
      ifRevision: document.revision,
      requestId: "product-detach",
      changes: { kind: "document", targets: [] },
    },
    "agent",
  );
  assert((await fresh.read({ root: task.key })).edges.some((edge) => edge.id === id));
  assert.equal(
    (await fresh.read()).edges.some((edge) => edge.type === "documents"),
    false,
  );
  await fresh.mutate(
    {
      ifVersion: (await fresh.read()).version,
      requestId: "explicit-detach",
      operations: [{ action: "remove", id }],
    },
    "agent",
  );
  assert(!(await fresh.read({ root: task.key })).edges.some((edge) => edge.id === id));
  assert.deepEqual(
    new Set((await fresh.read()).edges.map((edge) => edge.id)),
    new Set(before.edges.filter((edge) => edge.type !== "documents").map((edge) => edge.id)),
  );

  // Возврат линка создаёт связь документа, но не воскрешает независимое отозванное ребро.
  await engine.update(
    {
      ref: document.key,
      ifRevision: detached.revision,
      requestId: "product-reattach",
      changes: {
        kind: "document",
        targets: [feature.key],
      },
    },
    "agent",
  );
  await fresh.reindex();
  assert.equal((await fresh.read()).totalEdges, before.totalEdges);
  assert(!(await fresh.read({ root: task.key })).edges.some((edge) => edge.id === id));
  const revoked = await workspace.locked(() => readOwned(workspace.storageSession!, task.ref));
  assert.equal(revoked.entries.find((entry) => entry.edge.id === id)?.edge.active, false);
  await assert.rejects(fresh.mutate(command, "agent"), { code: "GRAPH_CHANGED" });
  const unchanged = await engine.get({ ref: document.key });
  assert.equal(unchanged.data.kind === "document" && unchanged.data.links.length, 1);
});

for (const damage of ["endpoint-task", "unrelated-task", "unrelated-document"] as const)
  test(`INSP-06: строгая мутация графа отвергает schema ${damage} без записи`, async (t) => {
    const { workspace } = await fixture(t);
    const engine = new EntityEngine(workspace);
    const from = await engine.create(
      { requestId: "from", data: { kind: "task", board: "BOARD-PRODUCT", title: "Начало" } },
      "qa",
    );
    const to = await engine.create(
      { requestId: "to", data: { kind: "task", board: "BOARD-PRODUCT", title: "Конец" } },
      "qa",
    );
    const unrelated = await engine.create(
      {
        requestId: "unrelated",
        data: { kind: "task", board: "BOARD-INFRA", title: "Другая компонента" },
      },
      "qa",
    );
    const document = await engine.create(
      {
        requestId: "document",
        data: {
          kind: "document",
          name: "Изолированный документ",
          summary: "",
          body: "Текст\r\n",
          documentKind: "description",
        },
      },
      "qa",
    );
    const graph = new GraphService(workspace);
    const add = {
      action: "add" as const,
      from: from.ref,
      to: to.ref,
      type: "diagnostic",
      description: "Сохранённое пояснение\r\n",
    };
    const seed = await graph.mutate(
      { requestId: "seed", ifVersion: (await graph.read()).version, operations: [add] },
      "qa",
    );
    const before = await graph.read();
    const damaged =
      damage === "endpoint-task" ? from : damage === "unrelated-task" ? unrelated : document;
    if (damage !== "endpoint-task")
      assert.ok(
        !(await graph.context({ root: from.key })).nodes.some(
          (node) => node.ref.id === damaged.ref.id,
        ),
        "Повреждаем запись вне компоненты обоих концов",
      );
    const relativePath = `entities/${damaged.ref.kind}s/${damaged.ref.id}.json`;
    const path = join(workspace.dataRoot, relativePath);
    const original = await readFile(path);
    const record = JSON.parse(original.toString());
    const field = damaged.ref.kind === "document" ? "name" : "title";
    record.data[field] = 17;
    const corruptBytes = Buffer.from(JSON.stringify(record));
    await writeFile(path, corruptBytes);
    const unchanged = await treeHashes(workspace.dataRoot, persistent);
    assert.equal((await inspectPending(workspace.dataRoot)).kind, "none");

    // Именно прежний полный каталог задаёт отказ, а не новая проверка выбранной пары.
    let expectedError: AppError | undefined;
    await assert.rejects(
      workspace.locked((owned) => readEntityCatalog(workspace, owned)),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "INVALID_DATA");
        assert.equal(error.exitCode, 5);
        const details = error.details as {
          path: string;
          ref: unknown;
          issues: { path: unknown[] }[];
        };
        assert.equal(details.path, relativePath);
        assert.deepEqual(details.ref, damaged.ref);
        assert.ok(details.issues.some((issue) => issue.path.includes(field)));
        expectedError = error;
        return true;
      },
    );
    assert.deepEqual(
      await graph.read(),
      before,
      "Индексное чтение не становится полной проверкой тел",
    );
    const operations: GraphMutation["operations"] = [
      { ...add, type: "another-diagnostic" },
      { action: "update", id: seed.ids[0]!, description: "Не сохранять" },
      { action: "remove", id: seed.ids[0]! },
    ];
    for (const operation of operations) {
      await assert.rejects(
        graph.mutate(
          {
            requestId: `denied-${operation.action}`,
            ifVersion: before.version,
            operations: [operation],
          },
          "qa",
        ),
        (error) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, expectedError!.code);
          assert.equal(error.exitCode, expectedError!.exitCode);
          assert.deepEqual(error.details, expectedError!.details);
          return true;
        },
      );
      assert.deepEqual(
        await treeHashes(workspace.dataRoot, persistent),
        unchanged,
        "Побайтно сохранены данные, отношения, индексы и каталог WAL",
      );
      assert.equal((await inspectPending(workspace.dataRoot)).kind, "none");
      assert.deepEqual(await readFile(path), corruptBytes);
    }
    await writeFile(path, original);
    const saved = await graph.mutate(
      {
        requestId: "valid-add",
        ifVersion: before.version,
        operations: [{ ...add, type: "another-diagnostic" }],
      },
      "qa",
    );
    const after = await graph.read();
    assert.equal(after.version, saved.version);
    assert.equal(after.totalEdges, before.totalEdges + 1);
    assert.equal(
      after.edges.find((edge) => edge.id === saved.ids[0])!.description,
      add.description,
    );
    const edited = await graph.mutate(
      {
        requestId: "valid-update",
        ifVersion: saved.version,
        operations: [{ action: "update", id: saved.ids[0]!, description: "Новый Markdown\r\n\n" }],
      },
      "qa",
    );
    assert.equal((await graph.read()).version, edited.version);
    const removed = await graph.mutate(
      {
        requestId: "valid-remove",
        ifVersion: edited.version,
        operations: [{ action: "remove", id: saved.ids[0]! }],
      },
      "qa",
    );
    const final = await graph.read();
    assert.equal(final.version, removed.version);
    assert.deepEqual(final.edges, before.edges);
    assert.equal((await inspectPending(workspace.dataRoot)).kind, "none");
  });

test("INSP-06: мутация сохраняет custom GraphCatalogProvider и его отказ", async (t) => {
  const { workspace } = await graphFixture(t, nodes);
  t.mock.method(ProductRepository.prototype, "snapshot", () =>
    assert.fail("Custom provider нельзя заменять каталогом проекта"),
  );
  const denied = new Error("Отказ пользовательского источника каталога");
  let reject = false;
  const provider = t.mock.fn(async () => {
    assert.ok(workspace.storageSession, "Источник вызывается в общей сессии");
    if (reject) throw denied;
    return { nodes, aliases: { [entityAddress(ref(5))]: ["CUSTOM-ALIAS"] } };
  });
  const validate = t.mock.fn((catalog: { nodes: GraphNode[] }) => {
    assert.deepEqual(
      catalog.nodes,
      [...nodes].sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref))),
    );
  });
  const graph = new GraphService(workspace, provider, validate);
  assert.equal(graph.catalog, provider);
  const before = await graph.read();
  const calls = provider.mock.callCount();
  const saved = await graph.mutate(
    {
      requestId: "custom",
      ifVersion: before.version,
      operations: [{ action: "add", from: "CUSTOM-ALIAS", to: ref(0), type: "custom.relation" }],
    },
    "qa",
  );
  assert.equal(provider.mock.callCount(), calls + 1);
  assert.equal(validate.mock.callCount(), 1);
  const after = await graph.read();
  assert.equal(after.version, saved.version);
  assert.deepEqual(after.edges[0]!.from, ref(5));
  const unchanged = await treeHashes(workspace.dataRoot, persistent);
  reject = true;
  await assert.rejects(
    graph.mutate(
      {
        requestId: "custom-denied",
        ifVersion: saved.version,
        operations: [{ action: "remove", id: saved.ids[0]! }],
      },
      "qa",
    ),
    (error) => error === denied,
  );
  assert.deepEqual(await treeHashes(workspace.dataRoot, persistent), unchanged);
  assert.equal(validate.mock.callCount(), 1);
});
