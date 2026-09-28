import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import stringWidth from "string-width";
import { openWorkspace } from "@relay/core/storage/workspace";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import type { BoardTaskView } from "@relay/core/domain/board-task";
import { fixture, successful, failed, invokeRaw, invoke } from "./helpers/cli.js";

type TaskPage = { items: BoardTaskView[]; total: number; version: string };
const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{23}/i;

test(
  "task target graph-sync: create/update/clear сохраняют предметные рёбра и остальные связи",
  { timeout: 150_000 },
  async (t) => {
    const app = await fixture(t);
    type Ref = { kind: string; id: string };
    type Edge = { id: string; type: string; from: Ref; to: Ref };
    type Graph = { edges: Edge[]; complete?: boolean };
    const features: Array<{ key: string; ref: Ref }> = [];
    for (const name of ["Исходная цель", "Новая цель"]) {
      const saved = successful(
        await app.run<{ key: string }>([
          "feature",
          "create",
          "--name",
          name,
          "--description",
          "Проверка предметной связи",
        ]),
      ).data;
      features.push(
        successful(await app.run<{ key: string; ref: Ref }>(["feature", "get", saved.key])).data,
      );
    }
    const parent = await app.create("Родитель связанной задачи");
    const dependency = await app.create("Необходимый результат");
    const related = await app.create("Справочная связь");
    const id = await app.create("Задача с целью", [
      "--description",
      "## Содержание сохраняется\n\nНе потерять при снятии цели.",
      "--targets",
      features[0]!.key,
      "--parent",
      parent,
      "--dependencies",
      dependency,
      "--related",
      related,
    ]);
    const get = async () => successful(await app.run<BoardTaskView>(["task", "get", id])).data;
    let task = await get();
    const from: Ref = { kind: "task", id };
    const otherEdges = [
      { from, type: "part-of", to: { kind: "board", id: task.boardId } },
      { from, type: "part-of", to: { kind: "task", id: parent } },
      { from, type: "depends-on", to: { kind: "task", id: dependency } },
      { from, type: "related", to: { kind: "task", id: related } },
    ];
    const signature = (edge: { from: Ref; type: string; to: Ref }) =>
      `${edge.from.kind}:${edge.from.id} ${edge.type} ${edge.to.kind}:${edge.to.id}`;
    const readEdges = async (target?: Ref) => {
      const expected = [
        ...otherEdges,
        ...(target ? [{ from, type: "implements", to: target }] : []),
      ]
        .map(signature)
        .sort();
      const graph = successful(
        await app.run<Graph>([
          "inspect",
          "graph",
          "list",
          "--root",
          task.key,
          "--direction",
          "outgoing",
          "--depth",
          1,
          "--limit",
          100,
        ]),
      );
      assert.equal(
        graph.meta!.page!.nextCursor,
        null,
        "Проверяем весь набор рёбер, а не первую страницу",
      );
      const context = successful(
        await app.run<Graph>(["inspect", "graph", "context", task.key]),
      ).data;
      assert.equal(context.complete, true);
      for (const data of [graph.data, context]) {
        const owned = data.edges.filter((edge) => edge.from.kind === "task" && edge.from.id === id);
        assert.deepEqual(owned.map(signature).sort(), expected);
      }
      return graph.data.edges
        .filter(
          (edge) => edge.from.kind === "task" && edge.from.id === id && edge.type !== "implements",
        )
        .map(({ id, from, type, to }) => ({ id, from, type, to }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    assert.deepEqual(task.productLinks, [features[0]!.ref]);
    const initialOtherEdges = await readEdges(features[0]!.ref);
    const neighborsBefore = await Promise.all(
      [parent, dependency, related].map(
        async (ref) => successful(await app.run<BoardTaskView>(["task", "get", ref])).data,
      ),
    );
    successful(
      await app.run([
        "task",
        "update",
        task.key,
        "--targets",
        features[1]!.key,
        "--if-revision",
        task.revision,
      ]),
    );
    task = await get();
    assert.deepEqual(task.productLinks, [features[1]!.ref]);
    assert.deepEqual(await readEdges(features[1]!.ref), initialOtherEdges);
    const beforeClear = task;
    successful(
      await app.run([
        "task",
        "update",
        task.key,
        "--clear-targets",
        "--if-revision",
        task.revision,
      ]),
    );
    task = await get();
    assert.deepEqual(task.productLinks, []);
    assert.equal(task.revision, beforeClear.revision + 1);
    for (const field of [
      "id",
      "key",
      "title",
      "description",
      "boardId",
      "column",
      "parentId",
      "dependencies",
      "related",
    ] as const) {
      assert.deepEqual(task[field], beforeClear[field], `Снятие цели не должно менять ${field}`);
    }
    assert.deepEqual(await readEdges(), initialOtherEdges);
    const neighborsAfter = await Promise.all(
      [parent, dependency, related].map(
        async (ref) => successful(await app.run<BoardTaskView>(["task", "get", ref])).data,
      ),
    );
    assert.deepEqual(neighborsAfter, neighborsBefore);
  },
);

test(
  "task dependency move-alias: обе стороны links показывают новый ключ после переноса",
  { timeout: 150_000 },
  async (t) => {
    const app = await fixture(t);
    const blockerId = await app.create("Блокирующий результат");
    const dependentId = await app.create("Зависимая задача");
    const get = async (ref: string) =>
      successful(await app.run<BoardTaskView>(["task", "get", ref])).data;
    let blocker = await get(blockerId);
    let dependent = await get(dependentId);
    const oldBlockerKey = blocker.key;
    const oldDependentKey = dependent.key;
    successful(
      await app.run([
        "task",
        "dependency",
        "add",
        dependent.key,
        blocker.key,
        "--if-revision",
        dependent.revision,
      ]),
    );
    dependent = await get(dependentId);
    type Links = { items: Array<{ relation: string; task: { id: string; key: string } }> };
    const checkBothSides = async () => {
      for (const [source, relation, target] of [
        [dependent, "depends-on", blocker],
        [blocker, "blocks", dependent],
      ] as const) {
        const links = successful(await app.run<Links>(["task", "links", source.key]));
        assert.equal(links.meta!.page!.nextCursor, null);
        assert.deepEqual(
          links.data.items.map(({ relation, task }) => ({ relation, id: task.id, key: task.key })),
          [{ relation, id: target.id, key: target.key }],
        );
        const human = await invokeRaw(app.root, ["task", "links", source.key]);
        assert.equal(human.code, 0, human.stdout + human.stderr);
        assert.equal(human.stderr, "");
        assert.ok(human.stdout.includes(target.key), human.stdout);
        assert.match(human.stdout, relation === "blocks" ? /Блокирует/ : /Зависит от/);
        assert.ok(human.stdout.includes(target.title), human.stdout);
      }
    };
    await checkBothSides();
    successful(
      await app.run([
        "task",
        "move",
        blocker.key,
        "--board",
        "infrastructure",
        "--column",
        "ready",
        "--if-revision",
        blocker.revision,
      ]),
    );
    blocker = await get(blockerId);
    assert.equal(blocker.id, blockerId);
    assert.equal(blocker.key, "INFRA-1");
    assert.deepEqual(await get(oldBlockerKey), blocker);
    assert.deepEqual(await get(dependentId), dependent);
    await checkBothSides();
    // Прежняя регрессия: обратный blocks должен обновить ключ перемещённой зависимой задачи.
    successful(
      await app.run([
        "task",
        "move",
        dependent.key,
        "--board",
        "infrastructure",
        "--column",
        "ready",
        "--if-revision",
        dependent.revision,
      ]),
    );
    dependent = await get(dependentId);
    assert.equal(dependent.id, dependentId);
    assert.equal(dependent.key, "INFRA-2");
    assert.deepEqual(dependent.dependencies, [blockerId]);
    assert.deepEqual(await get(oldDependentKey), dependent);
    assert.deepEqual(await get(oldBlockerKey), blocker);
    await checkBothSides();
  },
);

test(
  "task create/update/get/rename/move: полное содержание, источники, цели, aliases и guards",
  { timeout: 240_000 },
  async (t) => {
    const app = await fixture(t);
    const description =
      "## Полное описание 界\n\n" +
      Array.from({ length: 1600 }, (_, i) => `Строка ${i}: результат = 🧪`).join("\n\n") +
      "\n\n```text\n  последний = да\n```\n";
    const file = join(app.root, "полный текст.md");
    await writeFile(file, description);
    const created = await invokeRaw(app.root, [
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Проверка 界",
      "--description-file",
      file,
    ]);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    assert.equal(created.stderr, "");
    assert.match(created.stdout, /PRODUCT-1/);
    assert.match(created.stdout, /Ревизия:\s+1/);
    assert.match(created.stdout, /npx @oim-dev\/relay-cli .*task get PRODUCT-1/);
    assert.doesNotMatch(created.stdout, uuid);
    const get = async (ref = "PRODUCT-1") =>
      successful(await app.run<BoardTaskView>(["task", "get", ref])).data;
    let task = await get();
    assert.match(task.id, /^[A-Za-z0-9]{8}$/);
    assert.deepEqual(
      {
        title: task.title,
        description: task.description,
        column: task.column,
        revision: task.revision,
        parent: task.parentId,
        dependencies: task.dependencies,
        related: task.related,
        targets: task.productLinks,
      },
      {
        title: "Проверка 界",
        description,
        column: "inbox",
        revision: 1,
        parent: null,
        dependencies: [],
        related: [],
        targets: [],
      },
    );
    for (const width of [40, 100]) {
      const human = await invokeRaw(app.root, ["task", "get", task.key], {
        env: { COLUMNS: String(width), FORCE_COLOR: "3" },
      });
      assert.equal(human.code, 0, human.stderr);
      assert.equal(human.stderr, "");
      for (const fragment of [
        "PRODUCT-1",
        "Проверка 界",
        "Входящие",
        "Ревизия:",
        "Родитель:",
        "## Полное описание 界",
        "  последний = да",
      ])
        assert.ok(human.stdout.includes(fragment), human.stdout.slice(0, 1000));
      assert.match(human.stdout, /Ревизия:\s+1/);
      for (let i = 0; i < 1600; i++)
        assert.ok(
          human.stdout.includes(`Строка ${i}: результат = 🧪`),
          `Нет строки ${i} при width=${width}`,
        );
      assert.doesNotMatch(human.stdout, /\u001b|усечён|truncated/);
      for (const line of human.stdout.split("\n")) {
        if (!line.includes("npx @oim-dev/relay-cli"))
          assert.ok(stringWidth(line) <= width, `Ширина ${width}: ${line}`);
      }
      const json = successful(
        await app.run<BoardTaskView>(["task", "get", task.key], {
          env: { COLUMNS: String(width), FORCE_COLOR: "3" },
        }),
      );
      assert.deepEqual(json.data, task);
    }
    const update = await invokeRaw(app.root, [
      "task",
      "update",
      task.key,
      "--title",
      "Новое имя",
      "--if-revision",
      task.revision,
    ]);
    assert.equal(update.code, 0, update.stdout);
    assert.match(update.stdout, /Ревизия:\s+2/);
    task = await get();
    assert.equal(task.title, "Новое имя");
    assert.equal(task.description, description);
    failed(
      await app.run(["task", "update", task.key, "--title", "Устаревшее", "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    assert.deepEqual(await get(), task);
    for (const extra of [
      ["--description", "inline", "--description-file", "-"],
      ["--description-file", join(app.root, "missing.md")],
      ["--targets", "FEATURE-1", "--clear-targets"],
    ]) {
      const rejected = await app.run(
        ["task", "update", task.key, "--if-revision", task.revision, ...extra],
        { input: "stdin" },
      );
      assert.equal(rejected.body.ok, false, rejected.stdout);
      assert.notEqual(rejected.code, 0);
      assert.deepEqual(await get(), task);
    }
    successful(
      await app.run(
        ["task", "update", task.key, "--description-file", "-", "--if-revision", task.revision],
        { input: "## stdin\n\n  текст = 界\n" },
      ),
    );
    task = await get();
    assert.equal(task.description, "## stdin\n\n  текст = 界\n");
    assert.equal(task.title, "Новое имя");
    successful(
      await app.run([
        "task",
        "update",
        task.key,
        "--description",
        "",
        "--if-revision",
        task.revision,
      ]),
    );
    task = await get();
    assert.equal(task.description, "");
    const feature = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Цель",
        "--description",
        "Требование",
      ]),
    ).data;
    successful(
      await app.run([
        "task",
        "update",
        task.key,
        "--targets",
        feature.key,
        "--if-revision",
        task.revision,
      ]),
    );
    task = await get();
    assert.equal(task.productLinks.length, 1);
    const incompatible = await app.run([
      "task",
      "move",
      task.key,
      "--board",
      "infrastructure",
      "--column",
      "ready",
      "--if-revision",
      task.revision,
    ]);
    assert.equal(incompatible.body.ok, false, incompatible.stdout);
    assert.deepEqual(await get(), task);
    successful(
      await app.run([
        "task",
        "update",
        task.key,
        "--clear-targets",
        "--if-revision",
        task.revision,
      ]),
    );
    task = await get();
    assert.deepEqual(task.productLinks, []);
    const rename = await invokeRaw(app.root, [
      "task",
      "rename",
      task.key,
      "CHECK-42",
      "--if-revision",
      task.revision,
    ]);
    assert.equal(rename.code, 0, rename.stdout);
    assert.match(rename.stdout, /CHECK-42/);
    task = await get();
    assert.equal(task.key, "CHECK-42");
    assert.equal(task.title, "Новое имя");
    assert.deepEqual(await get("CHECK-42"), task);
    const moved = await invokeRaw(app.root, [
      "task",
      "move",
      task.key,
      "--board",
      "infrastructure",
      "--column",
      "ready",
      "--if-revision",
      task.revision,
    ]);
    assert.equal(moved.code, 0, moved.stdout);
    assert.match(moved.stdout, /INFRA-1/);
    const after = await get();
    assert.deepEqual(
      { id: after.id, board: after.boardSlug, column: after.column, key: after.key },
      { id: task.id, board: "infrastructure", column: "ready", key: "INFRA-1" },
    );
    assert.deepEqual(await get("CHECK-42"), after);
    assert.deepEqual(await get(task.id), after);
  },
);

test(
  "task relations: children/parent/dependency/links/progress, циклы и отсутствие частичной записи",
  { timeout: 240_000 },
  async (t) => {
    const app = await fixture(t);
    const parent = await app.create("Родитель");
    const child = await app.create("Ребёнок 界");
    const dependency = await app.create("Обязательный результат");
    const related = await app.create("Справочная задача");
    const get = async (id: string) =>
      successful(await app.run<BoardTaskView>(["task", "get", id])).data;
    const mutation = async (args: Array<string | number>, id: string) => {
      const before = await get(id);
      const result = await invokeRaw(app.root, [...args, "--if-revision", before.revision]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Ревизия:/);
      assert.match(result.stdout, /npx @oim-dev\/relay-cli .*task get/);
      assert.doesNotMatch(result.stdout, uuid);
      return get(id);
    };
    let current = await mutation(["task", "parent", "set", child, parent], child);
    assert.equal(current.parentId, parent);
    let children = successful(
      await app.run<{ items: { ref: { id: string }; title: string }[] }>([
        "task",
        "children",
        parent,
        "--limit",
        1,
      ]),
    );
    assert.deepEqual(
      children.data.items.map((x) => x.ref.id),
      [child],
    );
    assert.equal(children.meta!.page!.total, 1);
    const parentBefore = await get(parent);
    failed(
      await app.run([
        "task",
        "parent",
        "set",
        parent,
        child,
        "--if-revision",
        parentBefore.revision,
      ]),
      "DEPENDENCY_CYCLE",
      4,
    );
    assert.deepEqual(await get(parent), parentBefore);
    assert.deepEqual(await get(child), current);
    // Родитель уже зависит от результата ребёнка; обратная зависимость создаёт смешанный цикл.
    const mixed = await app.run([
      "task",
      "dependency",
      "add",
      child,
      parent,
      "--if-revision",
      current.revision,
    ]);
    assert.equal(mixed.body.ok, false, mixed.stdout);
    assert.deepEqual(await get(child), current);
    current = await mutation(["task", "dependency", "add", child, dependency], child);
    assert.deepEqual(current.dependencies, [dependency]);
    const dependencyBefore = await get(dependency);
    failed(
      await app.run([
        "task",
        "dependency",
        "add",
        dependency,
        child,
        "--if-revision",
        dependencyBefore.revision,
      ]),
      "DEPENDENCY_CYCLE",
      4,
    );
    assert.deepEqual(await get(dependency), dependencyBefore);
    current = await mutation(["task", "link", child, related], child);
    assert.deepEqual(current.related, [related]);
    const childCard = await invokeRaw(app.root, ["task", "get", child]);
    assert.equal(childCard.code, 0, childCard.stdout + childCard.stderr);
    assert.equal(childCard.stderr, "");
    assert.match(childCard.stdout, new RegExp(`Родитель:\\s+task:${parent}`));
    assert.match(childCard.stdout, new RegExp(`Ревизия:\\s+${current.revision}`));
    assert.match(childCard.stdout, /Ребёнок 界/);
    const links = successful(
      await app.run<{ items: { relation: string; task: { id: string } }[] }>([
        "task",
        "links",
        child,
      ]),
    );
    assert.deepEqual(
      links.data.items.map((x) => [x.relation, x.task.id]).sort(),
      [
        ["parent", parent],
        ["depends-on", dependency],
        ["related", related],
      ].sort(),
    );
    const progress = successful(
      await app.run<{ dependencies: { items: { id: string }[] }; canComplete: boolean }>([
        "task",
        "progress",
        child,
      ]),
    );
    assert.deepEqual(
      progress.data.dependencies.items.map((x) => x.id),
      [dependency],
    );
    assert.equal(progress.data.canComplete, false);
    const dependencies = successful(
      await app.run<{ dependencies: { items: { id: string }[] } }>([
        "task",
        "dependency",
        "list",
        child,
        "--limit",
        1,
      ]),
    );
    assert.deepEqual(
      dependencies.data.dependencies.items.map((x) => x.id),
      [dependency],
    );
    assert.equal(dependencies.meta!.page!.count, 1);
    for (const [args, fragments] of [
      [
        ["task", "children", parent],
        ["Ребёнок 界", "PRODUCT-2", "Ревизия"],
      ],
      [
        ["task", "links", child],
        ["Родитель", "PRODUCT-1", "Обязательный результат", "Справочная задача"],
      ],
      [
        ["task", "dependency", "list", child],
        ["Обязательный результат", "PRODUCT-3", "Фактически выполнена"],
      ],
      [
        ["task", "progress", child],
        ["Ребёнок 界", "PRODUCT-2"],
      ],
    ] as const) {
      const human = await invokeRaw(app.root, [...args], {
        env: { COLUMNS: "100", FORCE_COLOR: "3" },
      });
      assert.equal(human.code, 0, human.stdout + human.stderr);
      assert.equal(human.stderr, "");
      for (const fragment of fragments) assert.ok(human.stdout.includes(fragment), human.stdout);
      assert.doesNotMatch(human.stdout, /\u001b/);
    }
    failed(
      await app.run(["task", "parent", "clear", child, "--if-revision", 1]),
      "REVISION_CONFLICT",
    );
    assert.deepEqual(await get(child), current);
    failed(
      await app.run(["task", "move", child, "--column", "done", "--if-revision", current.revision]),
      "TASK_BLOCKED",
      4,
    );
    assert.deepEqual(await get(child), current);
    current = await mutation(["task", "unlink", child, related], child);
    assert.deepEqual(current.related, []);
    current = await mutation(["task", "dependency", "remove", child, dependency], child);
    assert.deepEqual(current.dependencies, []);
    current = await mutation(["task", "parent", "clear", child], child);
    assert.equal(current.parentId, null);
    failed(
      await app.run(["task", "parent", "clear", child, "--if-revision", current.revision]),
      "INVALID_ARGUMENT",
    );
    children = successful(await app.run(["task", "children", parent]));
    assert.deepEqual(children.data.items, []);
    assert.equal((await get(parent)).id, parent);
    assert.equal((await get(dependency)).id, dependency);
    assert.equal((await get(related)).id, related);
  },
);

test(
  "task create: labels, отношения одной операцией и отклонение некорректного ввода без записей",
  { timeout: 180_000 },
  async (t) => {
    const app = await fixture(t);
    const parent = await app.create("Родитель");
    const dependency = await app.create("Зависимость");
    const related = await app.create("Связь");
    const invalidCases = [
      ["--criterion-title", "one=Один", "--criterion-title", "one=Повтор"],
      ["--criterion-summary", "missing=Нет заголовка"],
      ["--criterion-title", "метка=Кириллица в метке"],
      ["--criterion-title", "нет разделителя"],
      ["--criterion-title", "one=Две\nстроки"],
      ["--criterion-title", "one=Верный", "--dependencies", "MISSING-1"],
      ["--description", "inline", "--description-file", "-"],
      ["--targets", "FEATURE-1", "--clear-targets"],
      Array.from({ length: 101 }, (_, index) => [
        "--criterion-title",
        `c${index}=Критерий ${index}`,
      ]).flat(),
    ];
    const before = successful(await app.run<TaskPage>(["task", "list"])).data;
    for (const args of invalidCases) {
      const result = await app.run(
        ["task", "create", "--board", "product", "--title", "Не сохранить", ...args],
        { input: "stdin" },
      );
      assert.equal(result.body.ok, false, result.stdout);
      assert.notEqual(result.code, 0);
      assert.deepEqual(successful(await app.run<TaskPage>(["task", "list"])).data, before);
    }
    const id = await app.create("Атомарная задача", [
      "--parent",
      parent,
      "--dependencies",
      dependency,
      "--related",
      related,
      "--criterion-description",
      "second=## Полный текст\n\nx=y=z 🧪\n",
      "--criterion-title",
      "first=Первый = 界",
      "--criterion-summary",
      "first=Раз\nДва = три",
      "--criterion-title",
      "second=Второй",
    ]);
    const task = successful(await app.run<BoardTaskView>(["task", "get", id])).data;
    assert.deepEqual(
      [task.parentId, task.dependencies, task.related],
      [parent, [dependency], [related]],
    );
    const criteria = successful(
      await app.run<{ items: { id: string; title: string; summary: string }[] }>([
        "task",
        "criterion",
        "list",
        id,
      ]),
    ).data.items;
    assert.deepEqual(
      criteria.map(({ title, summary }) => ({ title, summary })),
      [
        { title: "Первый = 界", summary: "Раз\nДва = три" },
        { title: "Второй", summary: "" },
      ],
    );
    const full = successful(
      await app.run<{ criterion: { description: string } }>([
        "task",
        "criterion",
        "get",
        id,
        criteria[1]!.id,
      ]),
    ).data;
    assert.equal(full.criterion.description, "## Полный текст\n\nx=y=z 🧪\n");
    assert.equal(task.revision, 1);
  },
);

test(
  "task list: 300 задач, три доски, фильтрация до paging, cursor-only, дети, stale и контекст",
  { timeout: 600_000 },
  async (t) => {
    const app = await fixture(t);
    successful(
      await app.run([
        "application",
        "create",
        "--name",
        "Третья доска",
        "--slug",
        "third",
        "--prefix",
        "THIRD",
        "--description",
        "Для нагрузочного сценария",
      ]),
    );
    const workspace = await openWorkspace(app.root);
    const service = new BoardTasksService(workspace);
    const parents: string[] = [];
    const expected = new Set<string>();
    const expectedChildren = new Set<string>();
    const all = [];
    const columns = ["ready", "in-progress", "review", "done", "cancelled"] as const;
    // Только публичная предметная запись Core: никаких файлов сущностей или обхода инвариантов.
    for (let index = 0; index < 300; index++) {
      const board = ["product", "infrastructure", "third"][index % 3]!;
      const column = index < 3 ? "inbox" : columns[Math.floor(index / 3) % 5]!;
      const parentId = index >= 3 && index % 4 === 0 ? parents[index % 3] : undefined;
      const title = index % 2 === 0 ? `Найти 界 ${index}` : `Другая ${index}`;
      const saved = await service.create(
        {
          board,
          title,
          description: `## Описание\n\nМаркер-описания ${index}`,
          column,
          parentId,
          requestId: `seed-${index}`,
        },
        "seed",
      );
      all.push(saved);
      if (index < 3) parents.push(saved.id);
      if (parentId === parents[0]) expectedChildren.add(saved.id);
      if (board === "product" && index % 2 === 0 && column !== "done" && column !== "cancelled")
        expected.add(saved.id);
    }
    assert.equal(all.length, 300);
    assert.ok(expected.size > 20);
    const defaultPage = successful(await app.run<TaskPage>(["task", "list"]));
    assert.equal(defaultPage.data.total, 300);
    assert.equal(defaultPage.data.items.length, 20);
    assert.equal(defaultPage.meta!.page!.limit, 20);
    assert.equal(defaultPage.meta!.page!.count, 20);
    assert.equal(defaultPage.meta!.page!.total, 300);
    assert.ok(defaultPage.meta!.page!.nextCursor);
    failed(await app.run(["task", "list", "--limit", 101]), "INVALID_ARGUMENT");
    failed(await app.run(["task", "list", "--limit", 0]), "INVALID_ARGUMENT");
    let maximum = successful(await app.run<TaskPage>(["task", "list", "--limit", 100]));
    const maximumIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      assert.equal(maximum.data.items.length, 100);
      assert.equal(maximum.meta!.page!.count, 100);
      assert.equal(maximum.meta!.page!.limit, 100);
      assert.equal(maximum.meta!.page!.total, 300);
      maximumIds.push(...maximum.data.items.map((item) => item.id));
      if (index < 2) {
        assert.ok(maximum.meta!.page!.nextCursor);
        maximum = successful(
          await app.run<TaskPage>(["task", "list", "--cursor", maximum.meta!.page!.nextCursor]),
        );
      }
    }
    assert.equal(maximum.meta!.page!.nextCursor, null);
    assert.equal(maximum.meta!.page!.nextCommand, null);
    assert.equal(new Set(maximumIds).size, 300);
    assert.deepEqual(new Set(maximumIds), new Set(all.map((item) => item.id)));
    const other = await fixture(t);
    const context = ["--local", "--config", join(app.root, ".relay", "config.json")];
    const filters = [
      "--board",
      "product",
      "--completion",
      "unfinished",
      "--search-in",
      "title",
      "--q",
      "Найти 界",
    ];
    const first = successful(await app.run<TaskPage>([...context, "task", "list", ...filters]));
    const explicitTwenty = successful(
      await app.run<TaskPage>([...context, "task", "list", ...filters, "--limit", 20]),
    );
    assert.deepEqual(explicitTwenty.data, first.data);
    assert.deepEqual(explicitTwenty.meta!.page, first.meta!.page);
    assert.equal(first.meta!.page!.total, expected.size);
    assert.equal(first.meta!.page!.count, 20);
    const cursor = first.meta!.page!.nextCursor!;
    assert.ok(cursor);
    let page = first;
    const seen: string[] = [];
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 20);
      assert.equal(page.meta!.page!.limit, 20);
      assert.equal(page.meta!.page!.count, page.data.items.length);
      assert.equal(page.meta!.page!.total, expected.size);
      assert.equal(page.data.total, expected.size);
      assert.equal(page.meta!.page!.consistency, "snapshot");
      seen.push(...page.data.items.map((x) => x.id));
      if (!page.meta!.page!.nextCursor) break;
      page = successful(
        await app.run<TaskPage>([
          ...context,
          "task",
          "list",
          "--cursor",
          page.meta!.page!.nextCursor,
        ]),
      );
    }
    assert.equal(page.meta!.page!.nextCommand, null);
    assert.equal(seen.length, expected.size);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(new Set(seen), expected);
    failed(
      await app.run([
        "--local",
        "--config",
        join(other.root, ".relay", "config.json"),
        "task",
        "list",
        "--cursor",
        cursor,
      ]),
      "INVALID_CURSOR",
    );
    failed(
      await app.run([...context, "task", "list", "--cursor", cursor, "--board", "third"]),
      "INVALID_CURSOR",
    );
    let children = successful(
      await app.run<{ items: { ref: { id: string } }[] }>([
        "task",
        "children",
        parents[0]!,
        "--limit",
        20,
      ]),
    );
    const childIds: string[] = [];
    const childCursor = children.meta!.page!.nextCursor!;
    assert.ok(childCursor);
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 20);
      assert.equal(children.meta!.page!.total, expectedChildren.size);
      childIds.push(...children.data.items.map((x) => x.ref.id));
      if (!children.meta!.page!.nextCursor) break;
      children = successful(
        await app.run([
          "task",
          "children",
          parents[0]!,
          "--cursor",
          children.meta!.page!.nextCursor,
        ]),
      );
    }
    assert.equal(new Set(childIds).size, childIds.length);
    assert.deepEqual(new Set(childIds), expectedChildren);
    failed(
      await app.run(["task", "children", parents[1]!, "--cursor", childCursor]),
      "INVALID_CURSOR",
    );
    const empty = successful(
      await app.run<TaskPage>(["task", "list", "--q", "Совершенно отсутствует", "--limit", 20]),
    );
    assert.deepEqual(empty.data.items, []);
    assert.deepEqual(empty.meta!.page, {
      count: 0,
      total: 0,
      limit: 20,
      nextCursor: null,
      nextCommand: null,
      consistency: "snapshot",
    });
    const descriptions = successful(
      await app.run<TaskPage>(["task", "list", "--q", "Маркер-описания", "--search-in", "title"]),
    );
    assert.equal(descriptions.data.total, 0);
    assert.equal(
      successful(
        await app.run<TaskPage>(["task", "list", "--q", "Маркер-описания", "--search-in", "all"]),
      ).data.total,
      300,
    );
    for (const width of [40, 100]) {
      const human = await invokeRaw(
        app.root,
        [...context, "task", "list", ...filters, "--limit", 20],
        { env: { COLUMNS: String(width), FORCE_COLOR: "3" } },
      );
      assert.equal(human.code, 0, human.stderr);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /Найти 界/);
      assert.match(human.stdout, /Ревизия/);
      const readable = human.stdout.replace(/\s+/g, " ");
      assert.match(readable, /Доска: product/);
      assert.match(readable, /Завершённость: без done\/cancelled/);
      assert.match(readable, /Поиск: Найти 界/);
      assert.match(readable, /Область поиска: ключ, ID и заголовок/);
      assert.doesNotMatch(human.stdout, /\u001b/);
      assert.match(
        human.stdout.replace(/\s+/g, " "),
        new RegExp(`Показано: 20 из ${expected.size} подходящих записей Есть продолжение`),
      );
      const continuation = human.stdout
        .split("\n")
        .filter((line) => line.includes("npx @oim-dev/relay-cli") && line.includes("--cursor"));
      assert.equal(continuation.length, 1, human.stdout);
      assert.equal(continuation[0], first.meta!.page!.nextCommand!.replace(" --format json", ""));
    }
    successful(
      await app.run([
        "task",
        "update",
        all[0]!.id,
        "--title",
        "Снимок устарел",
        "--if-revision",
        1,
      ]),
    );
    const stale = await app.run([...context, "task", "list", "--cursor", cursor]);
    assert.equal(stale.body.ok, false, stale.stdout);
    assert.notEqual(stale.code, 0);
    if (!stale.body.ok) assert.equal(stale.body.error.code, "BOARD_CHANGED");
    const staleHuman = await invokeRaw(app.root, [...context, "task", "list", "--cursor", cursor]);
    assert.notEqual(staleHuman.code, 0);
    assert.equal(staleHuman.stderr, "");
    assert.match(staleHuman.stdout, /BOARD_CHANGED/);
    assert.match(staleHuman.stdout, /без --cursor/);
  },
);

test(
  "task list: длинный config с пробелом и кавычкой, копируемый footer в width 40",
  { timeout: 120_000 },
  async (t) => {
    const app = await fixture(t);
    const empty = await invokeRaw(app.root, ["task", "list"]);
    assert.equal(empty.code, 0, empty.stdout + empty.stderr);
    // Маленький golden проверяет смысл пустоты и единый footer, а не оформление всей карточки.
    assert.equal(
      empty.stdout
        .trim()
        .split(/\n\s*\n/)
        .at(-1),
      "Показано: 0 из 0 подходящих записей\nКонец списка",
    );
    const config = join(
      app.root,
      "конфигурация с пробелами и 'кавычкой' очень длинный путь для копирования",
      ".relay",
      "config.json",
    );
    // Проверка реальной shell-копируемости с пробелом и кавычкой, без сетевого npx.
    await mkdir(dirname(config), { recursive: true });
    successful(await invoke(app.root, ["--config", config, "init"]));
    for (const title of ["Раз", "Два"])
      successful(
        await invoke(app.root, [
          "--config",
          config,
          "task",
          "create",
          "--board",
          "product",
          "--title",
          title,
        ]),
      );
    const quoted = successful(
      await invoke<TaskPage>(app.root, [
        "--local",
        "--config",
        config,
        "task",
        "list",
        "--limit",
        1,
      ]),
    );
    const nextCommand = quoted.meta!.page!.nextCommand!;
    assert.ok(nextCommand.startsWith("npx @oim-dev/relay-cli "));
    assert.doesNotMatch(nextCommand, /\n/);
    const human = await invokeRaw(
      app.root,
      ["--local", "--config", config, "task", "list", "--limit", 1],
      { env: { COLUMNS: "40", FORCE_COLOR: "3" } },
    );
    assert.equal(human.code, 0, human.stdout + human.stderr);
    assert.equal(human.stderr, "");
    const footer = human.stdout
      .split("\n")
      .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
    assert.deepEqual(footer, [nextCommand.replace(" --format json", "")]);
    const { stdout } = await promisify(execFile)("bash", [
      "-c",
      `set -- ${nextCommand.slice("npx @oim-dev/relay-cli ".length)}; printf '%s\\0' "$@"`,
    ]);
    const args = stdout.split("\0").filter(Boolean);
    assert.equal(args[args.indexOf("--config") + 1], config);
    const replay = successful(await invoke<TaskPage>(app.root, args));
    assert.equal(replay.data.items.length, 1);
    assert.notEqual(replay.data.items[0]!.id, quoted.data.items[0]!.id);
  },
);

test(
  "task move/list: порядок before под version, фильтры состояния, готовности и цели",
  { timeout: 150_000 },
  async (t) => {
    const app = await fixture(t);
    const feature = successful(
      await app.run<{ key: string }>([
        "feature",
        "create",
        "--name",
        "Фильтр цели",
        "--description",
        "Требование",
      ]),
    ).data;
    const first = await app.create("Первая", ["--column", "ready", "--targets", feature.key]);
    const second = await app.create("Вторая", ["--column", "ready"]);
    const blocked = await app.create("Заблокирована", [
      "--column",
      "ready",
      "--dependencies",
      first,
    ]);
    const cancelled = await app.create("Отменена", ["--column", "cancelled"]);
    const done = await app.create("Выполнена", ["--column", "done"]);
    const list = async (...filters: Array<string | number>) =>
      successful(await app.run<TaskPage>(["task", "list", ...filters])).data;
    for (const [filters, ids] of [
      [
        ["--readiness", "ready"],
        [first, second],
      ],
      [["--readiness", "blocked"], [blocked]],
      [
        ["--completion", "finished"],
        [cancelled, done],
      ],
      [
        ["--completion", "unfinished"],
        [first, second, blocked],
      ],
      [
        ["--column", "ready"],
        [first, second, blocked],
      ],
      [["--product-target", feature.key], [first]],
    ] as const) {
      const result = await list(...filters);
      assert.equal(result.total, ids.length);
      assert.deepEqual(new Set(result.items.map((x) => x.id)), new Set(ids));
    }
    for (const width of [40, 100]) {
      const human = await invokeRaw(
        app.root,
        ["task", "list", "--readiness", "blocked", "--column", "ready"],
        { env: { COLUMNS: String(width), FORCE_COLOR: "3" } },
      );
      assert.equal(human.code, 0, human.stdout + human.stderr);
      assert.equal(human.stderr, "");
      const readable = human.stdout.replace(/\s+/g, " ");
      for (const fragment of [
        "Готовность: с блокерами",
        "Колонка: К выполнению",
        "PRODUCT-3",
        "Заблокирована",
        "Ревизия: 1",
        "Блокеры: 1",
      ])
        assert.ok(readable.includes(fragment), human.stdout);
      for (const id of [first, second, blocked, cancelled, done])
        assert.ok(
          !human.stdout.includes(id),
          `Список показывает внутренний ID ${id}: ${human.stdout}`,
        );
      assert.doesNotMatch(human.stdout, /\u001b/);
    }
    const before = await list("--column", "ready");
    successful(
      await app.run([
        "task",
        "move",
        second,
        "--column",
        "ready",
        "--before",
        first,
        "--if-version",
        before.version,
        "--if-revision",
        1,
      ]),
    );
    const reordered = await list("--column", "ready");
    assert.deepEqual(
      reordered.items.map((x) => x.id),
      [second, first, blocked],
    );
    const stale = await app.run([
      "task",
      "move",
      first,
      "--column",
      "review",
      "--if-version",
      before.version,
      "--if-revision",
      1,
    ]);
    assert.equal(stale.body.ok, false, stale.stdout);
    assert.deepEqual(await list("--column", "ready"), reordered);
    const self = await app.run(["task", "link", first, first, "--if-revision", 1]);
    assert.equal(self.body.ok, false, self.stdout);
    assert.deepEqual(
      successful(await app.run<BoardTaskView>(["task", "get", first])).data.related,
      [],
    );
  },
);
