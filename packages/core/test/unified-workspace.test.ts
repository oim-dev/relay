import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fixture, legacyFixture } from "./helpers/workspace.js";
import { deleteEntitySchema } from "@relay/contracts/entities";
import { entityDigest } from "../src/application/entities/catalog.js";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "@relay/core/application/storage/service";
import { EntityEngine } from "@relay/core/application/entities/service";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { GraphService } from "@relay/core/application/graph/service";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { ProductQueries } from "@relay/core/application/product/queries";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";

test("новый init: единая база и одна блокировка после изменения прежнего storageDir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-native-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await initialize(root, "../old-anchor/tasks");
  const initialContext = await new GraphService(first).context({ root: "PRODUCT" });
  assert.equal(initialContext.edges.length, 1);
  assert.equal(initialContext.edges[0]!.type, "part-of");
  assert.deepEqual(initialContext.edges[0]!.from, { kind: "product", id: "passport" });
  assert.deepEqual(initialContext.edges[0]!.to, { kind: "project", id: first.config.projectId });
  assert.equal(initialContext.nodes.find((node) => node.ref.kind === "product")!.revision, 0);
  assert.equal(
    JSON.parse(await readFile(join(root, ".relay/storage.json"), "utf8")).format,
    "relay-entities",
  );
  const config = JSON.parse(await readFile(first.configPath, "utf8"));
  await writeFile(
    first.configPath,
    JSON.stringify({ ...config, storageDir: "../other-anchor/tasks" }),
  );
  const second = await openWorkspace(root);
  const created = await Promise.all(
    [first, second].map((workspace, index) =>
      new BoardTasksService(workspace).create(
        { board: "product", requestId: `task-${index}` },
        "agent",
      ),
    ),
  );
  assert.deepEqual(new Set(created.map((task) => task.key)), new Set(["PRODUCT-1", "PRODUCT-2"]));
  assert.equal(first.dataRoot, second.dataRoot);
});

test("потеря заголовка индексов не закрывает доступ к явному reindex", async (t) => {
  const { root, workspace } = await fixture(t);
  await new StorageService(workspace).migrate();
  const task = await new BoardTasksService(workspace).create(
    { board: "product", requestId: "task" },
    "agent",
  );
  const header = join(root, ".relay/.indexes/state.json");
  await rm(header);
  const reopened = await openWorkspace(root);
  await assert.rejects(new GraphService(reopened).context({ root: task.key }), {
    code: "STORAGE_INDEX_CORRUPT",
  });
  await assert.rejects(readFile(header), { code: "ENOENT" });
  await new StorageService(reopened).reindex();
  assert.equal((await new GraphService(reopened).context({ root: task.key })).complete, true);
});

test("первоначальные квитанции предметных операций доступны после удаления сущности", async (t) => {
  const { workspace } = await fixture(t);
  await new StorageService(workspace).migrate();
  const engine = new EntityEngine(workspace);
  const input = {
    requestId: "create",
    data: { kind: "task" as const, board: "BOARD-PRODUCT", title: "Исходная" },
  };
  const task = await engine.create(input, "agent");
  const change = {
    ref: task.key,
    requestId: "change",
    ifRevision: 1,
    changes: { kind: "task" as const, title: "Изменённая" },
  };
  const saved = await engine.update(change, "agent");
  const direct = { requestId: "direct", ifRevision: 2, description: "Описание\n" };
  const directSaved = await new BoardTasksService(workspace).update(task.ref.id, direct, "agent");
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: task.key, kind: "task" });
  await deletion.delete(
    { ref: task.key, kind: "task", ifVersion: preview.version, requestId: "delete" },
    "agent",
  );
  assert.deepEqual(await engine.create(input, "agent"), task);
  assert.deepEqual(await engine.update(change, "agent"), saved);
  assert.deepEqual(
    await new BoardTasksService(workspace).update(task.key, direct, "agent"),
    directSaved,
  );
});

test("legacy: квитанция удаления без сохранившейся сущности повторяется после миграции и reindex", async (t) => {
  const { workspace } = await legacyFixture(t);
  const command = { ref: "PRODUCT-1", kind: "task" as const, ifVersion: "0".repeat(64), requestId: "delete" };
  const saved = { action: "delete", ref: { kind: "task", id: "Deleted1" }, requestId: "delete", deleted: 1, detached: 0, relations: 0 };
  const directory = join(dirname(workspace.configPath), "entity-deletions/receipts");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${entityDigest(["agent", command.requestId])}.json`), JSON.stringify({
    hash: entityDigest({ ...deleteEntitySchema.parse(command), actor: "agent" }), result: saved,
  }));
  await writeFile(join(directory, "../keys.json"), JSON.stringify([command.ref]));
  const deletion = new EntityDeletionService(workspace);
  await new StorageService(workspace).migrate();
  assert.deepEqual(await deletion.delete(command, "agent"), saved);
  await new StorageService(workspace).reindex();
  assert.deepEqual(await deletion.delete(command, "agent"), saved);
  await assert.rejects(deletion.delete({ ...command, ref: "OTHER" }, "agent"), { code: "IDEMPOTENCY_CONFLICT" });
});

test("единая база: явный перенос сохраняет продукт, задачи, прикрепления, обсуждения и повтор", async (t) => {
  const { root, workspace } = await fixture(t);
  const engine = new EntityEngine(workspace);
  const feature = await engine.create(
    {
      requestId: "feature",
      data: {
        kind: "feature",
        name: "Авторизация",
        summary: "Кратко\nв две строки",
        description: "## Требования\n\n  текст  \r\n",
      },
    },
    "agent",
  );
  const scenario = await engine.create(
    {
      requestId: "scenario",
      data: {
        kind: "scenario",
        featureId: feature.key,
        name: "Вход",
        description: "Проверить вход\n",
      },
    },
    "agent",
  );
  const app = await engine.create(
    {
      requestId: "app",
      data: {
        kind: "application",
        name: "Сервис",
        summary: "",
        description: "Сервис\n",
        slug: "api",
        prefix: "API",
        type: "backend",
      },
    },
    "agent",
  );
  await engine.create(
    {
      requestId: "feature-implementation",
      data: {
        kind: "implementation",
        application: app.key,
        target: feature.key,
        title: "Авторизация API",
        description: "Общий вклад\n",
      },
    },
    "agent",
  );
  const implementation = await engine.create(
    {
      requestId: "implementation",
      data: {
        kind: "implementation",
        application: app.key,
        target: scenario.key,
        title: "Вход API",
        description: "Реализация\n",
      },
    },
    "agent",
  );
  const command = {
    requestId: "task",
    data: {
      kind: "task" as const,
      board: "BOARD-API",
      title: "Сделать вход",
      description: "## Работа\n\n  Точно  \r\n",
      targets: [implementation.key],
    },
  };
  const task = await engine.create(command, "agent");
  const taskService = new BoardTasksService(workspace);
  const commentInput = {
    requestId: "comment",
    actor: "worker",
    actorRole: "worker" as const,
    title: "Результат",
    description: "## Проверка\n\nГотово\n",
  };
  const comment = await taskService.publishComment(task.ref.id, commentInput);
  const document = await engine.create(
    {
      requestId: "doc",
      data: {
        kind: "document",
        name: "Материал",
        summary: "",
        body: "## Материал\n\n  строка  \r\n",
        documentKind: "proposal",
        relations: [{ type: "references", target: task.ref, description: "## Читать\n" }],
      },
    },
    "agent",
  );
  const previous = await engine.get({ ref: document.key });
  const oldEdge = (await new GraphService(workspace).read({ root: document.key })).edges.find(
    (edge) => edge.type === "references" && edge.from.id === task.ref.id && edge.to.id === document.ref.id,
  );
  assert(oldEdge, "В исходной фикстуре должно существовать прикрепление документа");
  const oldHistory = await taskService.listComments(task.ref.id);
  await writeLegacyMigrationFixture(workspace);
  const legacy = await openWorkspace(root);
  assert.equal(await legacy.hasUnifiedStorage(), false);
  assert.equal((await new StorageService(legacy).migrate()).migrated, true);
  assert.equal((await new StorageService(legacy).migrate()).migrated, false);
  const reopened = await openWorkspace(root);
  const current = new EntityEngine(reopened);
  assert.deepEqual(await current.get({ ref: document.key }), previous);
  assert.deepEqual(await current.create(command, "agent"), task);
  assert.deepEqual(
    await new BoardTasksService(reopened).publishComment(task.ref.id, commentInput),
    comment,
  );
  assert.equal(
    (await new BoardTasksService(reopened).getComment(task.ref.id, comment.commentId))
      .description,
    commentInput.description,
  );
  assert.deepEqual(await new BoardTasksService(reopened).listComments(task.ref.id), oldHistory);
  const graph = await new GraphService(reopened).read({ root: task.key, depth: 10, limit: 100 });
  const full = await new GraphService(reopened).context({ root: task.key });
  assert.equal(full.complete, true);
  assert.equal(full.version, graph.version);
  assert.equal(full.edges.length, graph.totalEdges);
  assert.ok(graph.edges.some((edge) => edge.id === oldEdge.id));
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from.id === task.ref.id &&
        edge.to.id === implementation.ref.id &&
        edge.type === "implements",
    ),
  );
  const saved = await current.update(
    {
      ref: task.key,
      ifRevision: 1,
      requestId: "edit-task",
      changes: { kind: "task", description: "Новое описание\n" },
    },
    "worker",
  );
  assert.equal(saved.revision, 2);
  assert.equal(
    (await new BoardTasksService(reopened).get(task.ref.id)).description,
    "Новое описание\n",
  );
  const featureUpdate = {
    ref: feature.key,
    ifRevision: 1,
    requestId: "edit-feature",
    changes: { kind: "feature" as const, name: "Новый заголовок" },
  };
  const changed = await current.update(featureUpdate, "agent");
  assert.deepEqual(await current.update(featureUpdate, "agent"), changed);
  assert.equal(
    (await new ProductQueries(reopened).state()).records.find(
      (entry) => entry.id === feature.ref.id,
    )?.fields.kind,
    "feature",
  );
  const stored = JSON.parse(
    await readFile(
      join(dirname(reopened.configPath), "entities/tasks", `${task.ref.id}.json`),
      "utf8",
    ),
  );
  assert.equal(stored.kind, "task");
  assert.deepEqual(stored.data.description, ["Новое описание", ""]);
  assert.equal(stored.requests, undefined);
  assert.equal(stored.events, undefined);
  const config = JSON.parse(await readFile(reopened.configPath, "utf8"));
  assert.equal(config.projectSettings, undefined);
  const beforeReindex = await new GraphService(reopened).context({ root: task.key });
  await new GraphService(reopened).reindex();
  assert.deepEqual(await new GraphService(reopened).context({ root: task.key }), beforeReindex);
});

test("единая база: пустой проект после перехода создаёт все основные виды и сохраняет ID при переносе", async (t) => {
  const { workspace, root } = await fixture(t);
  await new StorageService(workspace).migrate();
  const engine = new EntityEngine(workspace);
  const task = await engine.create(
    { requestId: "create", data: { kind: "task", board: "BOARD-PRODUCT", title: "Работа" } },
    "agent",
  );
  const moved = await engine.moveTask(
    { ref: task.key, board: "BOARD-INFRA", column: "ready", ifRevision: 1, requestId: "move" },
    "agent",
  );
  assert.equal(moved.ref.id, task.ref.id);
  assert.equal(moved.key, "INFRA-1");
  assert.equal((await engine.resolve({ ref: task.key })).ref.id, task.ref.id);
  const path = join(dirname(workspace.configPath), "entities/tasks", `${task.ref.id}.json`);
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).data.boardId,
    (await new BoardTasksService(workspace).get(task.ref.id)).boardId,
  );
  const project = await engine.get({ ref: "PROJECT" });
  await engine.update(
    {
      ref: "PROJECT",
      ifRevision: project.revision,
      requestId: "name",
      changes: { kind: "project", name: "Имя проекта" },
    },
    "agent",
  );
  const reopened = await openWorkspace(root);
  assert.equal((await new EntityEngine(reopened).get({ ref: "PROJECT" })).title, "Имя проекта");
  const passport = await new EntityEngine(reopened).create(
    {
      requestId: "passport",
      data: {
        kind: "product",
        name: "Продукт",
        summary: "",
        description: "Описание продукта\n",
      },
    },
    "agent",
  );
  assert.equal(passport.ref.id, "passport");
});

for (const kind of [
  "feature",
  "scenario",
  "application",
  "implementation",
  "task",
  "document",
] as const)
  test(`единая база: каскад ${kind}, снятие внешних линков, история и повтор`, async (t) => {
    const { workspace } = await fixture(t);
    await new StorageService(workspace).migrate();
    const engine = new EntityEngine(workspace);
    const feature = await engine.create(
      {
        requestId: "feature",
        data: { kind: "feature", name: "Фича", summary: "", description: "Требования" },
      },
      "agent",
    );
    const scenario = await engine.create(
      {
        requestId: "scenario",
        data: {
          kind: "scenario",
          featureId: feature.key,
          name: "Сценарий",
          description: "Поведение",
        },
      },
      "agent",
    );
    const application = await engine.create(
      {
        requestId: "app",
        data: {
          kind: "application",
          name: "API",
          slug: "api",
          type: "backend",
          summary: "",
          description: "Сервис",
        },
      },
      "agent",
    );
    const fi = await engine.create(
      {
        requestId: "fi",
        data: {
          kind: "implementation",
          application: application.key,
          target: feature.key,
          title: "Фича API",
          description: "Вклад",
        },
      },
      "agent",
    );
    const implementation = await engine.create(
      {
        requestId: "si",
        data: {
          kind: "implementation",
          application: application.key,
          target: scenario.key,
          title: "Сценарий API",
          description: "Вклад",
        },
      },
      "agent",
    );
    const task = await engine.create(
      {
        requestId: "task",
        data: { kind: "task", board: "BOARD-API", targets: [implementation.key], title: "Работа" },
      },
      "agent",
    );
    const external = await engine.create(
      {
        requestId: "external",
        data: {
          kind: "task",
          board: "BOARD-INFRA",
          dependencies: [task.key],
          title: "Внешняя работа",
        },
      },
      "agent",
    );
    const document = await engine.create(
      {
        requestId: "doc",
        data: {
          kind: "document",
          name: "Описание",
          summary: "",
          body: "Документ",
          documentKind: "proposal",
          targets: [feature.key, scenario.key, application.key, fi.key, implementation.key],
          relations: [{ type: "references", target: task.ref, description: "" }],
        },
      },
      "agent",
    );
    const target = { feature, scenario, application, implementation, task, document }[kind];
    const graph = new GraphService(workspace);
    const diagnostic = {
      requestId: "diagnostic",
      ifVersion: (await graph.context({ root: task.key })).version,
      operations: [{ action: "add" as const, type: "related", from: external.ref, to: task.ref }],
    };
    const diagnosticSaved = await graph.mutate(diagnostic, "agent");
    assert.deepEqual(await graph.mutate(diagnostic, "agent"), diagnosticSaved);
    const deletion = new EntityDeletionService(workspace);
    const preview = await deletion.preview({ ref: target.key, kind });
    const command = { ref: target.key, kind, ifVersion: preview.version, requestId: "delete" };
    const result = await deletion.delete(command, "agent");
    assert.deepEqual(await deletion.delete(command, "agent"), result);
    const deleted = new Set(preview.deleted.map((entry) => `${entry.ref.kind}:${entry.ref.id}`));
    const current = await graph.read({ limit: 100 });
    assert.ok(
      current.edges.every(
        (edge) =>
          !deleted.has(`${edge.from.kind}:${edge.from.id}`) &&
          !deleted.has(`${edge.to.kind}:${edge.to.id}`),
      ),
    );
    const outside = await engine.get({ ref: external.key });
    assert.equal(outside.data.kind, "task");
    if (outside.data.kind === "task")
      assert.equal(
        outside.data.dependencies.includes(task.ref.id),
        !deleted.has(`task:${task.ref.id}`),
      );
    const path = join(
      dirname(workspace.configPath),
      "entities",
      `${kind}s`,
      `${target.ref.id}.json`,
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).deleted.actor, "agent");
    if (kind !== "document") {
      const remaining = await engine.get({ ref: document.key });
      assert.equal(remaining.data.kind, "document");
      if (remaining.data.kind === "document")
        assert.ok(
          remaining.data.links.every(
            (link) => link.kind === "product" || !deleted.has(`${link.kind}:${link.id}`),
          ),
        );
    }
  });
