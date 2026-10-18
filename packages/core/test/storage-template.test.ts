import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@relay/contracts/storage";
import { initialize, openWorkspace } from "../src/storage/workspace.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { WorkHistoryService } from "../src/application/work-history/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { prepareTemplateSnapshot } from "../src/application/storage/template.js";
import { captureSnapshot, writeSnapshotFiles } from "../src/application/storage/snapshot.js";
import { validateWorkspace } from "../src/application/validate.js";
import { replaceOwnedRelations, readOwned } from "../src/storage/entity-store/relations.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-template-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks", join(root, "source/config.json"));
  return { root, workspace, engine: new EntityEngine(workspace) };
}
const obj = (value: JsonValue | undefined) => value as Record<string, JsonValue>;

test("Шаблон: полная копия сохраняет работу, историю, резервы и точный текст с новой идентичностью", async (t) => {
  const { root, workspace, engine } = await fixture(t);
  const oldId = workspace.config.projectId!;
  const text = `\n# ${oldId}\r\n\n  Пробелы\t  \nhttps://example.test/projects/${oldId}\n`;
  const project = await engine.get({ ref: "PROJECT" });
  await engine.update(
    {
      ref: "PROJECT",
      ifRevision: project.revision,
      requestId: "sections",
      changes: { kind: "project", documentSections: [{ id: "custom", name: "Шаблон" }] },
    },
    "author",
  );
  const feature = await engine.create(
    {
      requestId: "feature",
      data: { kind: "feature", name: "Фича", summary: "Описание", description: text },
    },
    "author",
  );
  const tasks = new BoardTasksService(workspace);
  const task = await tasks.create(
    { board: "product", title: "Выполнено в шаблоне", column: "done", requestId: "task" },
    "author",
  );
  const comment = await tasks.publishComment(task.id, {
    title: "Обсуждение",
    description: text,
    actor: "author",
    actorRole: "operator",
    requestId: "comment",
  });
  const product = await engine.get({ ref: "PRODUCT" });
  const document = await engine.create(
    {
      requestId: "document",
      data: {
        kind: "document",
        name: "Документ",
        summary: "Описание",
        documentKind: "specification",
        body: text,
        sectionId: "custom",
        relations: [
          project.ref,
          product.ref,
          feature.ref,
          { kind: "task" as const, id: task.id },
        ].map((target) => ({
          target,
          type: "documents" as const,
          description: text,
        })),
      },
    },
    "author",
  );
  const plans = new PlanningService(workspace);
  const plan = await plans.create(
    {
      title: "Завершённый план",
      scope: [
        { kind: "project", id: project.ref.id },
        { kind: "product", id: product.ref.id },
      ],
      requestId: "plan",
    },
    "author",
  );
  const stage = await plans.changeStage(
    plan.id,
    {
      action: "create",
      fields: { title: "Этап", outcome: text },
      ifRevision: plan.revision,
      requestId: "stage",
    },
    "author",
  );
  const composition = await plans.changeTasks(
    plan.id,
    { stage: stage.stageId, add: [task.id], ifRevision: stage.revision, requestId: "tasks" },
    "author",
  );
  await plans.transition(
    plan.id,
    { action: "complete", result: text, ifRevision: composition.revision, requestId: "complete" },
    "author",
  );
  const releases = new ReleasesService(workspace);
  const release = await releases.create(
    { title: "Выпуск шаблона", version: "1", planIds: [plan.id], requestId: "release" },
    "author",
  );
  await releases.update(
    release.id,
    {
      title: "Выпуск шаблона",
      version: "1",
      planIds: [plan.id],
      status: "released",
      ifRevision: release.revision,
      requestId: "publish",
    },
    "author",
  );
  const history = new WorkHistoryService(workspace);
  let state = await history.start(
    {
      title: "Подготовка шаблона",
      description: text,
      requestId: "start",
      git: { branch: "template", commit: "a".repeat(40) },
    },
    "agent",
  );
  state = await history.openCheckpoint(
    {
      ref: state.session.id,
      runId: state.run!.id,
      ifRevision: state.session.revision,
      requestId: "intent",
      title: "Намерение",
      body: text,
      references: ["PROJECT", document.key],
    },
    "agent",
  );
  const intent = state.checkpoint!.id;
  state = await history.completeCheckpoint(
    {
      ref: intent,
      runId: state.run!.id,
      ifRevision: state.session.revision,
      requestId: "result",
      title: "Готово",
      body: text,
    },
    "agent",
  );
  await history.complete(
    {
      ref: state.session.id,
      runId: state.run!.id,
      ifRevision: state.session.revision,
      requestId: "finish",
      result: text,
    },
    "agent",
  );
  const removed = await engine.create(
    {
      data: {
        kind: "document",
        name: "Удалённый",
        summary: "Описание",
        documentKind: "description",
        body: text,
      },
      requestId: "removed",
    },
    "author",
  );
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ ref: removed.key, kind: "document" });
  await deletion.delete(
    { ref: removed.key, kind: "document", ifVersion: preview.version, requestId: "delete" },
    "author",
  );
  const before = await captureSnapshot(workspace);
  const input = structuredClone(before.files);
  obj(input["config.json"]).server = { url: "https://template.example.test", port: 9000 };
  obj(input["config.json"]).storageDir = "/source/local/path";
  const prepared = await prepareTemplateSnapshot(input, root, {
    name: "Новый проект",
    slug: "new-project",
  });
  assert.notEqual(prepared.projectId, oldId);
  assert.equal(prepared.validation.valid, true);
  assert.equal((await captureSnapshot(workspace)).version, before.version);
  const targetRoot = join(root, "target");
  await writeSnapshotFiles(targetRoot, prepared.files);
  const target = await openWorkspace(targetRoot, join(targetRoot, "config.json"));
  await new StorageService(target).reindex();
  assert.equal((await validateWorkspace(target)).valid, true);
  const copied = new EntityEngine(target);
  const newProject = await copied.get({ ref: "PROJECT" });
  assert.equal(newProject.ref.id, prepared.projectId);
  assert.equal(newProject.title, "Новый проект");
  assert.equal(newProject.data.kind === "project" && newProject.data.slug, "new-project");
  assert.equal(
    newProject.data.kind === "project" && newProject.data.documentSections?.[0]?.id,
    "custom",
  );
  assert.equal(target.config.server.url, undefined);
  assert.equal(target.config.storageDir, "tasks");
  assert.deepEqual((await copied.get({ ref: "PRODUCT" })).ref, product.ref);
  assert.equal((await copied.get({ ref: document.key })).data.kind, "document");
  assert.deepEqual(
    await new BoardTasksService(target).getComment(task.id, comment.commentId),
    await tasks.getComment(task.id, comment.commentId),
  );
  assert.equal((await new PlanningService(target).get(plan.id)).status, "completed");
  assert.equal((await new PlanningService(target).get(plan.id)).projectId, prepared.projectId);
  assert.equal((await new ReleasesService(target).get(release.id)).status, "released");
  assert.equal((await new ReleasesService(target).get(release.id)).projectId, prepared.projectId);
  const checkpoint = await new WorkHistoryService(target).checkpoint({ ref: intent });
  assert.equal(checkpoint.body, text);
  assert.equal(checkpoint.references[0]?.ref.id, prepared.projectId);
  assert.deepEqual(
    await new WorkHistoryService(target).get({ ref: state.session.id }),
    await history.get({ ref: state.session.id }),
  );
  const originalGraph = await new GraphService(workspace).context({ root: "PROJECT" });
  const copiedGraph = await new GraphService(target).context({ root: "PROJECT" });
  assert.deepEqual(
    copiedGraph.edges.map((edge) => edge.id).sort(),
    originalGraph.edges.map((edge) => edge.id).sort(),
  );
  for (const [path, value] of Object.entries(before.files)) {
    if (!path.startsWith("entities/") || path === `entities/projects/${oldId}.json`) continue;
    // Все постоянные записи сохранены; в пяти владельцах меняются лишь предметные адреса.
    assert(prepared.files[path], path);
    const record = obj(value),
      next = obj(prepared.files[path]);
    for (const field of [
      "id",
      "revision",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy",
      "aliases",
      "comments",
      "deleted",
    ])
      assert.deepEqual(next[field], record[field], `${path}: ${field}`);
  }
  await assert.rejects(copied.get({ ref: removed.key }), { code: "ENTITY_NOT_FOUND" });
  const doc = await copied.get({ ref: document.key });
  assert.equal(doc.data.kind === "document" && doc.data.body, text);
  await copied.update(
    {
      ref: document.key,
      ifRevision: doc.revision,
      changes: { kind: "document", body: "Только новая база" },
      requestId: "independent",
    },
    "new-author",
  );
  assert.equal((await captureSnapshot(workspace)).version, before.version);
});

test("Шаблон: сегментированные, неактивные и принадлежащие PROJECT отношения сохраняются", async (t) => {
  const { root, workspace, engine } = await fixture(t);
  const project = (await engine.get({ ref: "PROJECT" })).ref;
  const product = (await engine.get({ ref: "PRODUCT" })).ref;
  await workspace.mutate("template-fixture", { requestId: "edges" }, "test", async () => {
    return replaceOwnedRelations(
      workspace.storageSession!,
      project,
      "fixture",
      Array.from({ length: 270 }, (_, index) => ({
        from: project,
        to: product,
        type: `custom-${index}`,
        description: `Связь ${index}\r\n`,
      })),
      "test",
    );
  });
  await workspace.mutate("template-fixture", { requestId: "revoke" }, "test", async () => {
    const current = await readOwned(workspace.storageSession!, project);
    return replaceOwnedRelations(
      workspace.storageSession!,
      project,
      "fixture",
      current.entries.slice(1).map(({ edge }) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        type: edge.type,
        description: edge.description.join("\n"),
      })),
      "test",
    );
  });
  const source = await workspace.locked(() => readOwned(workspace.storageSession!, project));
  assert(source.files.length > 0);
  assert.equal(source.entries.filter(({ edge }) => !edge.active).length, 1);
  const snapshot = await captureSnapshot(workspace);
  const prepared = await prepareTemplateSnapshot(snapshot.files, root, { name: "Сегменты" });
  const rootPath = `relations/projects/${prepared.projectId}.json`;
  assert.equal(obj(prepared.files[rootPath]).storage, "segments");
  assert(!prepared.files[`relations/projects/${project.id}.json`]);
  assert(
    Object.keys(prepared.files).some((path) =>
      path.startsWith(`relations/projects/${prepared.projectId}/`),
    ),
  );
  assert.equal(prepared.validation.valid, true);
  assert.deepEqual(
    await readFile(join(workspace.dataRoot, `relations/projects/${project.id}.json`)),
    Buffer.from(
      JSON.stringify(snapshot.files[`relations/projects/${project.id}.json`], null, 2) + "\n",
    ),
  );
});

test("Шаблон: несовместимый или повреждённый источник отклоняется и staging очищается", async (t) => {
  const { root, workspace } = await fixture(t);
  const snapshot = await captureSnapshot(workspace);
  for (const version of [2, 999]) {
    const files = structuredClone(snapshot.files);
    obj(files["storage.json"]).dataModelVersion = version;
    await assert.rejects(prepareTemplateSnapshot(files, root, { name: "Проект" }), {
      code: version === 2 ? "STORAGE_MIGRATION_REQUIRED" : "STORAGE_VERSION_UNSUPPORTED",
    });
  }
  const damaged = structuredClone(snapshot.files);
  delete damaged[`entities/projects/${workspace.config.projectId}.json`];
  await assert.rejects(prepareTemplateSnapshot(damaged, root, { name: "Проект" }));
  assert.deepEqual(await readdir(root), ["source"]);
  assert.equal((await captureSnapshot(workspace)).version, snapshot.version);
});
