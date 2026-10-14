import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fixture } from "./helpers/workspace.js";
import { validateWorkspace } from "../src/application/validate.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { GraphService } from "../src/application/graph/service.js";
import { StorageService } from "../src/application/storage/service.js";
import { AppError } from "../src/shared/errors.js";
import type { Workspace } from "../src/storage/workspace.js";
import type { ValidationIssue } from "../src/application/storage/validation.js";
import { StorageSession } from "../src/storage/entity-store/store.js";
import { digest } from "../src/storage/entity-store/format.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { EntityDeletionService } from "../src/application/entities/deletion.js";

async function files(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(result, await files(root, path));
    else result[path] = (await readFile(join(root, path))).toString("base64");
  }
  return result;
}

async function check(workspace: Workspace, valid = false): Promise<ValidationIssue[]> {
  const before = await files(workspace.root);
  let issues: ValidationIssue[] = [];
  try {
    const result = await validateWorkspace(workspace);
    assert.ok(valid, "Повреждение не должно пройти проверку");
    assert.equal(result.valid, true);
  } catch (error) {
    assert.ok(!valid, `Исправный проект должен пройти проверку: ${JSON.stringify(error)}`);
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.ok(Array.isArray(error.details));
    issues = error.details as ValidationIssue[];
  }
  assert.deepEqual(
    await files(workspace.root),
    before,
    "Check не создаёт и не меняет файлы, включая индексы/runtime",
  );
  return issues;
}

async function tasksFixture(t: TestContext) {
  const { workspace } = await fixture(t);
  const tasks = new BoardTasksService(workspace);
  const parent = await tasks.create(
    { board: "product", title: "Родитель", requestId: "parent" },
    "agent",
  );
  const child = await tasks.create(
    { board: "product", title: "Ребёнок", parentId: parent.id, requestId: "child" },
    "agent",
  );
  return {
    workspace,
    tasks,
    parent,
    child,
    storage: new StorageService(workspace),
    graph: new GraphService(workspace),
  };
}

type SetFile = {
  entries: {
    slot: string;
    edge: {
      id: string;
      type: string;
      from: { kind: string; id: string };
      to: { kind: string; id: string };
      description: string[];
      active: boolean;
    };
  }[];
};
async function editSet(workspace: Workspace, path: string, edit: (value: SetFile) => void) {
  const full = join(workspace.root, path);
  const value = JSON.parse(await readFile(full, "utf8")) as SetFile;
  edit(value);
  await writeFile(full, JSON.stringify(value));
}

test("doctor: новый проект без задач и диагностических рёбер, затем здоровый граф — read-only", async (t) => {
  const { workspace } = await fixture(t);
  await check(workspace, true);
  assert.deepEqual(await validateWorkspace(workspace), {
    valid: true,
    entities: 4,
    tasks: 0,
    boards: 2,
  });
  const tasks = new BoardTasksService(workspace);
  await tasks.create({ board: "product", requestId: "task" }, "agent");
  await check(workspace, true);
});

for (const damage of ["endpoint", "description", "json"] as const)
  test(`doctor: ${damage} в relation-файле вне первой страницы графа не пропускается`, async (t) => {
    const { workspace, graph, parent, child } = await tasksFixture(t);
    const first = await graph.read({ limit: 1 });
    const owners = [parent.id, child.id];
    const id = owners.find((id) => first.edges[0]?.from.id !== id)!;
    const path = `relations/tasks/${id}.json`;
    if (damage === "json") await writeFile(join(workspace.root, path), "{invalid-record");
    else
      await editSet(workspace, path, (value) => {
        if (damage === "endpoint") value.entries[0]!.edge.to = { kind: "task", id: "MISSING1" };
        else value.entries[0]!.edge.description = ["Внешняя правка\r", "", "  хвост  "];
      });
    const issues = await check(workspace);
    assert.ok(issues.some((issue) => (issue.details as { path?: string })?.path === path));
    if (damage === "description")
      assert.equal(
        issues.filter(
          (issue) =>
            issue.code === "STORAGE_INDEX_STALE" &&
            (issue.details as { path: string }).path === path,
        ).length,
        1,
      );
  });

for (const mode of ["missing", "extra", "drift"] as const)
  test(`doctor: managed ${mode} остаётся после reindex и исчезает только после reconcile`, async (t) => {
    const { workspace, parent, child, tasks, storage, graph } = await tasksFixture(t);
    const saved = await graph.mutate(
      {
        requestId: "diagnostic",
        ifVersion: (await graph.read()).version,
        operations: [
          {
            action: "add",
            type: "references",
            from: { kind: "task", id: child.id },
            to: { kind: "task", id: parent.id },
            description: "Диагностика\r\n\n  tail  \n",
          },
        ],
      },
      "agent",
    );
    const beforeTasks = await Promise.all([tasks.get(parent.id), tasks.get(child.id)]);
    const diagnostic = (await graph.read()).edges.find((edge) => edge.id === saved.ids[0]);
    const path = `relations/tasks/${child.id}.json`;
    await editSet(workspace, path, (value) => {
      const link = value.entries.find(
        (entry) => entry.slot === "task-links" && entry.edge.to.id === parent.id,
      )!;
      if (mode === "missing") value.entries = value.entries.filter((entry) => entry !== link);
      if (mode === "drift") link.edge.description = ["Не предметное описание"];
      if (mode === "extra")
        value.entries.push({
          ...structuredClone(link),
          edge: { ...structuredClone(link.edge), id: randomUUID() },
        });
    });
    await storage.reindex();
    const issues = await check(workspace);
    const mismatch = issues.find((issue) => issue.code === "MANAGED_RELATIONS_MISMATCH");
    assert.ok(mismatch);
    const details = mismatch.details as Record<string, unknown>;
    assert.equal(details.path, path);
    assert.deepEqual(details.ref, { kind: "task", id: child.id });
    assert.equal(details.slot, "task-links");
    assert.equal((details[mode] as unknown[]).length, 1);
    await storage.reconcileRelations({ requestId: "explicit-reconcile" }, "agent");
    await check(workspace, true);
    assert.deepEqual(await Promise.all([tasks.get(parent.id), tasks.get(child.id)]), beforeTasks);
    assert.deepEqual(
      (await graph.read()).edges.find((edge) => edge.id === saved.ids[0]),
      diagnostic,
    );
  });

for (const damage of ["json", "schema"] as const)
  for (const count of [1, 2])
    test(`doctor: ${count} файлов с ${damage} — ${count} адресных причин, прямой Core сохраняет details`, async (t) => {
      const { workspace, parent, child } = await tasksFixture(t);
      for (const id of [parent.id, child.id].slice(0, count)) {
        const path = join(workspace.root, `entities/tasks/${id}.json`);
        const raw = JSON.parse(await readFile(path, "utf8"));
        raw.data.title = 17;
        await writeFile(path, damage === "json" ? "{invalid-record" : JSON.stringify(raw));
      }
      const issues = await check(workspace);
      assert.equal(issues.length, count, JSON.stringify(issues));
      assert.equal(
        new Set(issues.map((issue) => (issue.details as { path: string }).path)).size,
        count,
      );
      for (const issue of issues) {
        assert.equal(issue.code, "INVALID_DATA");
        const details = issue.details as {
          path: string;
          ref: { kind: string; id: string };
          issues?: { path: string[] }[];
        };
        assert.equal(details.path, `entities/tasks/${details.ref.id}.json`);
        assert.equal(details.ref.kind, "task");
        assert.ok(issue.checks?.includes("storage.entities"));
        if (damage === "schema") assert.deepEqual(details.issues?.[0]?.path, ["title"]);
      }
      await assert.rejects(
        workspace.locked(() => workspace.storageSession!.get({ kind: "task", id: parent.id })),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "INVALID_DATA");
          assert.equal(
            (error.details as { path: string }).path,
            `entities/tasks/${parent.id}.json`,
          );
          return true;
        },
      );
    });

test("doctor: потерянный сегмент ранее прогретого индекса обнаруживается без записи", async (t) => {
  const { workspace } = await tasksFixture(t);
  await check(workspace, true);
  const state = JSON.parse(await readFile(join(workspace.root, ".indexes/state.json"), "utf8"));
  const hash = state.roots.edges as string;
  const path = `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;
  await rm(join(workspace.root, path));
  const issues = await check(workspace);
  assert.ok(issues.some((issue) => (issue.details as { path?: string })?.path === path));
});

test("doctor: пустой сохранённый граф не выдаётся за исправный при обязательной managed-связи", async (t) => {
  const { workspace } = await fixture(t);
  await editSet(workspace, "relations/products/passport.json", (value) => {
    value.entries = [];
  });
  const storage = new StorageService(workspace);
  await storage.reindex();
  assert.equal((await new GraphService(workspace).read()).totalEdges, 0);
  const issues = await check(workspace);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "MANAGED_RELATIONS_MISMATCH");
  await storage.reconcileRelations({ requestId: "restore-root" }, "agent");
  await check(workspace, true);
});

test("doctor: корректный по checksum, но ложный индекс рёбер обнаруживается без reindex", async (t) => {
  const { workspace } = await tasksFixture(t);
  const statePath = join(workspace.root, ".indexes/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const old = state.roots.edges as string;
  const page = JSON.parse(
    await readFile(
      join(workspace.root, `.indexes/segments/${old.slice(0, 2)}/${old}.json`),
      "utf8",
    ),
  );
  page.entries.pop();
  assert.ok(page.entries.length);
  const hash = digest(page);
  await mkdir(join(workspace.root, `.indexes/segments/${hash.slice(0, 2)}`), { recursive: true });
  await writeFile(
    join(workspace.root, `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`),
    JSON.stringify(page),
  );
  state.roots.edges = hash;
  await writeFile(statePath, JSON.stringify(state));
  const issues = await check(workspace);
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "STORAGE_INDEX_STALE" &&
        (issue.details as { index?: string }).index === "edges",
    ),
  );
});

test("doctor: потерянная запись и внешняя неиндексированная запись не маскируются каталогом", async (t) => {
  const { workspace, child } = await tasksFixture(t);
  const path = `entities/tasks/${child.id}.json`;
  const raw = JSON.parse(await readFile(join(workspace.root, path), "utf8"));
  await rm(join(workspace.root, path));
  raw.id = "EXTERNAL";
  raw.key = "PRODUCT-900";
  raw.aliases = [];
  await writeFile(join(workspace.root, "entities/tasks/EXTERNAL.json"), JSON.stringify(raw));
  const issues = await check(workspace);
  assert.ok(issues.some((issue) => (issue.details as { path?: string })?.path === path));
  assert.ok(
    issues.some(
      (issue) => (issue.details as { path?: string })?.path === "entities/tasks/EXTERNAL.json",
    ),
  );
});

test("doctor: чужое поле keyspace и два испорченных relation-файла сохраняют независимые адреса", async (t) => {
  const { workspace, parent, child } = await tasksFixture(t);
  const paths = [`relations/tasks/${parent.id}.json`, `relations/tasks/${child.id}.json`];
  for (const path of paths) await writeFile(join(workspace.root, path), "{invalid-record");
  const keyPath = "keyspaces/global-feature.json";
  const value = JSON.parse(await readFile(join(workspace.root, keyPath), "utf8"));
  value.unknown = true;
  await writeFile(join(workspace.root, keyPath), JSON.stringify(value));
  const issues = await check(workspace);
  for (const path of [...paths, keyPath])
    assert.ok(issues.some((issue) => (issue.details as { path?: string })?.path === path));
  for (const path of paths)
    assert.equal(
      issues.filter((issue) => (issue.details as { path?: string })?.path === path).length,
      1,
    );
});

test("doctor: check не выполняет recovery даже обычного pending WAL", async (t) => {
  const { workspace } = await fixture(t);
  await writeFile(
    join(workspace.root, "transactions/pending.json"),
    JSON.stringify({ schemaVersion: 1 }),
  );
  const before = await files(workspace.root);
  await assert.rejects(validateWorkspace(workspace), { code: "STORAGE_RECOVERY_REQUIRED" });
  assert.deepEqual(await files(workspace.root), before);
});

test("doctor: schema-ошибка одной записи не скрывает независимый разрыв отношения другой", async (t) => {
  const { workspace, parent, child } = await tasksFixture(t);
  const entityPath = `entities/tasks/${parent.id}.json`;
  await writeFile(join(workspace.root, entityPath), "{invalid-record");
  const relationPath = `relations/tasks/${child.id}.json`;
  await editSet(workspace, relationPath, (value) => {
    value.entries[0]!.edge.to = { kind: "task", id: "MISSING1" };
  });
  const issues = await check(workspace);
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "INVALID_DATA" && (issue.details as { path: string }).path === entityPath,
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "STORAGE_REFERENCE_BROKEN" &&
        (issue.details as { path: string }).path === relationPath,
    ),
  );
});

test("doctor: все чтения держат один замок и не видят параллельную публикацию", async (t) => {
  const { workspace, tasks } = await tasksFixture(t);
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const reached = deferred();
  const proceed = deferred();
  const original = StorageSession.prototype.readFile;
  let intercepted = false;
  t.mock.method(
    StorageSession.prototype,
    "readFile",
    async function (this: StorageSession, path: string) {
      if (this.store.root === workspace.root && !intercepted && path.startsWith("entities/")) {
        intercepted = true;
        reached.resolve();
        await proceed.promise;
      }
      return original.call(this, path);
    },
  );
  const validation = validateWorkspace(workspace);
  await reached.promise;
  let published = false;
  const writer = tasks
    .create({ board: "product", requestId: "parallel-writer" }, "agent")
    .then(() => {
      published = true;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(published, false);
  } finally {
    proceed.resolve();
  }
  assert.equal((await validation).tasks, 2);
  await writer;
  assert.equal((await validateWorkspace(workspace)).tasks, 3);
});

test("doctor: включения плана и релиза проверяются теми же managed-правилами", async (t) => {
  const { workspace, child, storage } = await tasksFixture(t);
  const plans = new PlanningService(workspace);
  const plan = await plans.create({ title: "План", requestId: "plan" }, "agent");
  const stage = await plans.changeStage(
    plan.id,
    { action: "create", fields: { title: "Этап" }, ifRevision: plan.revision, requestId: "stage" },
    "agent",
  );
  await plans.changeTasks(
    plan.id,
    { stage: stage.stageId, add: [child.id], ifRevision: stage.revision, requestId: "include" },
    "agent",
  );
  const release = await new ReleasesService(workspace).create(
    { title: "Релиз", version: "v1", planIds: [plan.id], requestId: "release" },
    "agent",
  );
  await check(workspace, true);
  const before = Object.fromEntries(
    Object.entries(await files(workspace.root)).filter(([path]) => path.startsWith("entities/")),
  );
  await editSet(workspace, `relations/work-plans/${plan.id}.json`, (value) => {
    value.entries = value.entries.filter((entry) => entry.slot !== "planning-membership");
  });
  await editSet(workspace, `relations/releases/${release.id}.json`, (value) => {
    value.entries = value.entries.filter((entry) => entry.edge.to.id !== plan.id);
  });
  await storage.reindex();
  const issues = await check(workspace);
  assert.equal(issues.filter((issue) => issue.code === "MANAGED_RELATIONS_MISMATCH").length, 2);
  await storage.reconcileRelations({ requestId: "reconcile" }, "agent");
  await check(workspace, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(await files(workspace.root)).filter(([path]) => path.startsWith("entities/")),
    ),
    before,
  );
});

test("doctor: повреждение сегмента отношений за первой страницей сохраняет путь сегмента", async (t) => {
  const { workspace, parent, child, graph } = await tasksFixture(t);
  for (let batch = 0; batch < 3; batch++)
    await graph.mutate(
      {
        ifVersion: (await graph.read()).version,
        requestId: `batch-${batch}`,
        operations: Array.from({ length: 90 }, (_, index) => ({
          action: "add" as const,
          type: "references",
          from: { kind: "task", id: parent.id },
          to: { kind: "task", id: child.id },
          description: `Связь ${batch}-${index}`,
        })),
      },
      "agent",
    );
  const base = `relations/tasks/${parent.id}`;
  const owner = JSON.parse(await readFile(join(workspace.root, `${base}.json`), "utf8"));
  assert.equal(owner.storage, "segments");
  const first = await graph.read({ limit: 1 });
  let path = "";
  for (const prefix of Object.keys(owner.segments)) {
    const candidate = `${base}/${prefix}.json`;
    const data = JSON.parse(await readFile(join(workspace.root, candidate), "utf8")) as SetFile;
    if (data.entries.some((entry) => entry.edge.id === first.edges[0]?.id)) continue;
    path = candidate;
    data.entries[0]!.edge.description = [17] as unknown as string[];
    await writeFile(join(workspace.root, path), JSON.stringify(data));
    break;
  }
  assert.ok(path);
  const issues = await check(workspace);
  const cause = issues.find(
    (issue) => issue.code === "INVALID_DATA" && (issue.details as { path: string }).path === path,
  );
  assert.ok(cause, JSON.stringify(issues));
  assert.ok((cause.details as { issues: unknown[] }).issues.length);
});

test("doctor: продукт, FI/SI, доска приложения и оба направления документа; drift сохраняет Markdown", async (t) => {
  const { workspace } = await fixture(t);
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
      requestId: "application",
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
  await engine.create(
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
  const si = await engine.create(
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
  const markdown = "## Основание\r\n\n  текст Ω 界  \n";
  const document = await engine.create(
    {
      requestId: "document",
      data: {
        kind: "document",
        name: "Материал",
        summary: "",
        body: markdown,
        documentKind: "specification",
        relations: [
          { type: "references", target: si.ref, description: markdown },
          { type: "documents", target: feature.ref, description: "" },
        ],
      },
    },
    "agent",
  );
  await check(workspace, true);
  const before = Object.fromEntries(
    Object.entries(await files(workspace.root)).filter(([path]) => path.startsWith("entities/")),
  );
  await editSet(workspace, `relations/documents/${document.ref.id}.json`, (value) => {
    value.entries.find((entry) => entry.edge.type === "references")!.edge.description = [
      "Неверное пояснение",
    ];
  });
  const storage = new StorageService(workspace);
  await storage.reindex();
  const issues = await check(workspace);
  assert.equal(issues.length, 1, JSON.stringify(issues));
  const details = issues[0]!.details as { slot: string; drift: { expected: string }[] };
  assert.equal(details.slot, "document-links");
  assert.equal(details.drift[0]!.expected, markdown);
  await storage.reconcileRelations({ requestId: "reconcile-doc" }, "agent");
  await check(workspace, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(await files(workspace.root)).filter(([path]) => path.startsWith("entities/")),
    ),
    before,
  );
});

test("doctor: полный набор включает надгробие, отсутствующее в предметном каталоге", async (t) => {
  const { workspace, child } = await tasksFixture(t);
  const deletion = new EntityDeletionService(workspace);
  const preview = await deletion.preview({ kind: "task", ref: child.id });
  await deletion.delete(
    { kind: "task", ref: child.id, ifVersion: preview.version, requestId: "delete-child" },
    "agent",
  );
  await check(workspace, true);
  const path = `entities/tasks/${child.id}.json`;
  const value = JSON.parse(await readFile(join(workspace.root, path), "utf8"));
  assert.ok(value.deleted);
  value.revision = "повреждение";
  await writeFile(join(workspace.root, path), JSON.stringify(value));
  const issues = await check(workspace);
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal((issues[0]!.details as { path: string }).path, path);
});
