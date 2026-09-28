import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { FullContext, GraphPage, GraphSaved } from "@relay/core/domain/entity-graph";
import { openWorkspace } from "@relay/core/storage/workspace";
import { FullContextReader } from "@relay/core/storage/entity-store/context";
import {
  fixture,
  invoke,
  invokeRaw,
  successful,
  failed,
  tempDirectory,
  cliEnv,
} from "./helpers/cli.js";

for (const [label, directory] of [
  ["space", "проект с пробелом"],
  ["apostrophe", "проект с 'кавычкой"],
  ["TAB", "проект\tс табуляцией"],
  ["space/apostrophe/TAB/LF", "проект с 'кавычкой\tи\nпереносом"],
] as const)
  test(`init: однострочная source-подсказка сохраняет точный путь с ${label}`, async (t) => {
    const root = await tempDirectory(t);
    const configPath = join(root, directory, "config.json");
    const initialized = await invokeRaw(root, ["--config", configPath, "init"], {
      env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "24" },
    });
    assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
    assert.equal(initialized.stderr, "");
    assert.doesNotMatch(initialized.stdout, /\u001b/);
    const lines = initialized.stdout
      .split("\n")
      .filter((line) => line.trimStart().startsWith("npx @oim-dev/relay-cli"));
    assert.equal(lines.length, 1, initialized.stdout);
    const hint = lines[0]!;
    assert.doesNotMatch(hint, /[\r\n]/);
    assert.match(
      hint,
      /product create --help\s*$/,
      "подсказка целиком помещается в одну физическую строку",
    );
    // Shell разбирает настоящую подсказку. Подменяем только npx: никакой загрузки npm,
    // аргументы без повторной сериализации передаются исходнику CLI с tsx.
    const launcher = `
    const { spawnSync } = await import('node:child_process');
    const args = process.argv.slice(1);
    if (args.shift() !== '@oim-dev/relay-cli') throw new Error('Неожиданный пакет');
    const result = spawnSync(process.execPath, ['--conditions=tasks-source', '--import', process.env.TEST_TSX, process.env.TEST_CLI_SOURCE, ...args], {env: process.env, encoding: 'utf8', timeout: 15000});
    if (result.error) throw result.error;
    process.stdout.write(JSON.stringify({args, code: result.status, stdout: result.stdout, stderr: result.stderr}));
  `;
    const executed = await promisify(execFile)(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `npx() { "$TEST_NODE" --input-type=module -e "$TEST_LAUNCHER" -- "$@"; };\n${hint}`,
      ],
      {
        cwd: root,
        env: cliEnv({
          TEST_NODE: process.execPath,
          TEST_LAUNCHER: launcher,
          TEST_TSX: import.meta.resolve("tsx"),
          TEST_CLI_SOURCE: fileURLToPath(new URL("../src/main.ts", import.meta.url)),
          TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.dev.json", import.meta.url)),
        }),
        timeout: 20000,
      },
    );
    assert.equal(executed.stderr, "");
    const replay = JSON.parse(executed.stdout) as {
      args: string[];
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.deepEqual(replay.args, [
      "--local",
      "--config",
      configPath,
      "product",
      "create",
      "--help",
    ]);
    assert.equal(replay.code, 0, replay.stdout + replay.stderr);
    assert.equal(replay.stderr, "");
    assert.match(replay.stdout, /product create/);
    const read = successful(await invoke(root, [...replay.args.slice(0, 3), "config", "get"]));
    assert.equal((read.meta as { configPath: string }).configPath, configPath);
    assert.ok(await readFile(configPath, "utf8"));
  });

test("init / config get / project get/update: сохранность, ревизия, только имя и human", async (t) => {
  const root = await tempDirectory(t);
  const init = successful(await invoke<{ configPath: string; storageDir: string }>(root, ["init"]));
  assert.equal(init.data.configPath, join(root, ".relay/config.json"));
  const configPath = init.data.configPath;
  const before = await readFile(configPath, "utf8");
  const project = successful(await invoke<any>(root, ["project", "get"])).data;
  const changed = successful(
    await invoke<any>(
      root,
      [
        "project",
        "update",
        "--name-file",
        "-",
        "--if-revision",
        project.revision,
        "--request-id",
        "project-name",
      ],
      { input: "Проект Ω" },
    ),
  ).data;
  assert.equal(changed.requestId, "project-name");
  assert.equal(changed.key, "PROJECT");
  assert.equal(changed.revision, project.revision + 1);
  const after = successful(await invoke<any>(root, ["project", "get"])).data;
  assert.equal(after.data.name, "Проект Ω");
  assert.deepEqual(after.ref, project.ref);
  assert.ok(after.ref.id);
  assert.equal(after.data.slug, project.data.slug);
  failed(
    await invoke(root, [
      "project",
      "update",
      "--name",
      "Потерять",
      "--if-revision",
      project.revision,
    ]),
    "REVISION_CONFLICT",
    4,
  );
  failed(
    await invoke(root, ["project", "update", "--if-revision", after.revision]),
    "INVALID_ARGUMENT",
  );
  failed(
    await invoke(
      root,
      ["project", "update", "--name", "x", "--name-file", "-", "--if-revision", after.revision],
      { input: "y" },
    ),
    "CONFLICTING_OPTIONS",
  );
  assert.deepEqual(successful(await invoke(root, ["project", "get"])).data, after);
  const config = successful(await invoke<any>(root, ["config", "get"]));
  assert.equal(config.data.projectSettings.name, "Проект Ω");
  assert.equal((config.meta as any).configPath, configPath);
  assert.equal(await readFile(configPath, "utf8"), before);
  const again = await invoke(root, ["init"]);
  assert.notEqual(again.code, 0, "init не должен заменять существующую базу");
  assert.deepEqual(successful(await invoke(root, ["project", "get"])).data, after);
  const human = await invokeRaw(root, ["--local", "--config", configPath, "project", "get"], {
    env: { FORCE_COLOR: "1", COLUMNS: "24", NO_COLOR: undefined },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Проект Ω/);
  assert.match(human.stdout, /PROJECT/);
  assert.doesNotMatch(human.stdout, /\u001b/);
  const hint = human.stdout.split("\n").find((line) => line.includes("npx @oim-dev/relay-cli"));
  assert.ok(
    hint?.includes("--local") && hint.includes(configPath) && hint.includes("project update"),
    human.stdout,
  );
});

test("inspect graph list/context и doctor graph link/update/unlink/apply: ключи, цикл, атомарность и страницы", async (t) => {
  const app = await fixture(t);
  await app.create("Узел задачи");
  const task = successful(await app.run<any>(["task", "get", "PRODUCT-1"])).data.id;
  const doc = successful(
    await app.run<any>([
      "document",
      "create",
      "--name",
      "Контекстный документ",
      "--body",
      "## Полный текст\n\n  Содержание",
    ]),
  ).data;
  const initial = successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  const link = [
    "doctor",
    "graph",
    "link",
    "--from",
    "PRODUCT-1",
    "--to",
    doc.key,
    "--type",
    "example-for",
    "--description",
    "## Основание\n\nНе требование",
    "--if-version",
    initial.version,
    "--request-id",
    "edge-link",
  ];
  const saved = successful(await app.run<GraphSaved>(link)).data;
  assert.equal(saved.requestId, "edge-link");
  assert.equal(saved.ids.length, 1);
  failed(await app.run(link), "GRAPH_CHANGED", 4);
  let context = successful(
    await app.run<FullContext>(["inspect", "graph", "context", "PRODUCT-1"]),
  ).data;
  const edge = context.edges.find((entry) => entry.id === saved.ids[0])!;
  assert.deepEqual(edge.from, { kind: "task", id: task });
  const document = successful(await app.run<any>(["document", "get", doc.key])).data;
  assert.deepEqual(edge.to, document.ref);
  assert.equal(edge.type, "example-for");
  const updated = successful(
    await app.run<GraphSaved>(
      [
        "doctor",
        "graph",
        "update",
        edge.id,
        "--description-file",
        "-",
        "--if-version",
        context.version,
      ],
      { input: "## Обновлено\n\n  пробелы  \n" },
    ),
  ).data;
  context = successful(await app.run<FullContext>(["inspect", "graph", "context", doc.key])).data;
  const details = successful(
    await app.run<GraphPage>(["inspect", "graph", "list", "--root", doc.key]),
  ).data;
  assert.equal(
    details.edges.find((entry) => entry.id === edge.id)?.description,
    "## Обновлено\n\n  пробелы  \n",
  );
  const currentEdgeId = updated.ids[0]!;
  const cycle = [
    { action: "add", from: doc.key, to: "PRODUCT-1", type: "example-for", description: "Обратно" },
  ];
  successful(
    await app.run([
      "doctor",
      "graph",
      "apply",
      "--json",
      JSON.stringify(cycle),
      "--if-version",
      updated.version,
    ]),
  );
  context = successful(
    await app.run<FullContext>(["inspect", "graph", "context", "PRODUCT-1"]),
  ).data;
  assert.equal(context.complete, true);
  assert.equal(
    new Set(context.nodes.map((node) => `${node.ref.kind}:${node.ref.id}`)).size,
    context.nodes.length,
  );
  assert.equal(context.edges.filter((entry) => entry.type === "example-for").length, 2);
  const badBatch = [
    { action: "update", id: currentEdgeId, description: "Не сохранять" },
    { action: "remove", id: "missing-edge" },
  ];
  const rejected = await app.run([
    "doctor",
    "graph",
    "apply",
    "--json",
    JSON.stringify(badBatch),
    "--if-version",
    context.version,
  ]);
  assert.notEqual(rejected.code, 0);
  assert.deepEqual(
    successful(await app.run(["inspect", "graph", "context", "PRODUCT-1"])).data,
    context,
  );
  failed(
    await app.run(["doctor", "graph", "apply", "--json", "{", "--if-version", context.version]),
    "INVALID_JSON",
  );
  const first = successful(
    await app.run<GraphPage>([
      "inspect",
      "graph",
      "list",
      "--root",
      "PRODUCT-1",
      "--type",
      "example-for",
      "--depth",
      1,
      "--limit",
      1,
    ]),
  );
  assert.equal(first.meta?.page?.count, first.data.nodes.length + first.data.edges.length);
  assert.ok(first.meta?.page?.nextCursor);
  const next = successful(
    await app.run<GraphPage>([
      "inspect",
      "graph",
      "list",
      "--cursor",
      first.meta!.page!.nextCursor!,
    ]),
  );
  assert.equal(next.data.version, first.data.version);
  assert.ok(next.data.edges.every((entry) => entry.type === "example-for"));
  assert.equal(next.meta?.page?.limit, 1);
  assert.equal(next.meta?.page?.nextCursor, null);
  assert.equal(
    new Set(
      [...first.data.nodes, ...next.data.nodes].map((node) => `${node.ref.kind}:${node.ref.id}`),
    ).size,
    first.data.totalNodes,
  );
  assert.equal(
    new Set([...first.data.edges, ...next.data.edges].map((entry) => entry.id)).size,
    first.data.totalEdges,
  );
  const boundary = successful(
    await app.run<GraphPage>(["inspect", "graph", "list", "--root", "PRODUCT-1", "--depth", 0]),
  ).data;
  assert.equal(boundary.nodes.length, 1);
  assert.ok(
    context.nodes.length > boundary.nodes.length,
    "ограниченный граф не равен полной компоненте",
  );
  failed(
    await app.run([
      "inspect",
      "graph",
      "list",
      "--type",
      "different",
      "--cursor",
      first.meta!.page!.nextCursor!,
    ]),
    "INVALID_CURSOR",
  );
  const human = await invokeRaw(app.root, ["inspect", "graph", "context", "PRODUCT-1"], {
    env: { FORCE_COLOR: "1", NO_COLOR: undefined },
  });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Полный контекст/);
  assert.match(human.stdout, /example-for/);
  assert.doesNotMatch(human.stdout, /\u001b|"nodes":/);
  successful(
    await app.run(["doctor", "graph", "unlink", currentEdgeId, "--if-version", context.version]),
  );
  const removed = successful(
    await app.run<FullContext>(["inspect", "graph", "context", "PRODUCT-1"]),
  ).data;
  assert.ok(!removed.edges.some((entry) => entry.id === currentEdgeId));
  assert.equal(removed.edges.filter((entry) => entry.type === "example-for").length, 1);
  const stale = await app.run([
    "inspect",
    "graph",
    "list",
    "--cursor",
    first.meta!.page!.nextCursor!,
  ]);
  assert.notEqual(stale.code, 0);
  assert.ok(!stale.body.ok && /CONFLICT|CHANGED/.test(stale.body.error.code));
  successful(await app.run(["doctor", "check"]));
});

test("полный context: явные бюджеты Core дают ошибку, CLI не предлагает max-bytes", async (t) => {
  const app = await fixture(t);
  await app.create("Узел с окружением");
  const workspace = await openWorkspace(app.root);
  await workspace.locked(async () => {
    assert.ok(workspace.storageSession);
    for (const limits of [
      { nodes: 1, edges: 100, bytes: 1_000_000 },
      { nodes: 100, edges: 100, bytes: 1 },
    ]) {
      await assert.rejects(
        new FullContextReader(workspace.storageSession.store, limits).readSnapshot(
          workspace.storageSession,
          "PRODUCT-1",
        ),
        { code: "CONTEXT_TOO_LARGE" },
      );
    }
  });
  const full = successful(
    await app.run<FullContext>(["inspect", "graph", "context", "PRODUCT-1"]),
  ).data;
  assert.equal(full.complete, true);
  assert.ok(full.nodes.length > 1);
  const rejected = await app.run([
    "inspect",
    "graph",
    "context",
    "PRODUCT-1",
    "--max-bytes",
    100000,
  ]);
  assert.equal(rejected.code, 2);
  assert.ok(!rejected.body.ok);
});

test("human graph link/update/apply/unlink/list: квитанции, направление, ключи, пояснения и контекст продолжения", async (t) => {
  const app = await fixture(t);
  await app.create("Начало отношения");
  successful(
    await app.run(["document", "create", "--name", "Конец отношения", "--body", "Документ графа"]),
  );
  const configPath = join(app.root, ".relay/config.json");
  const graph = async () => successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  const humanMutation = async (args: Array<string | number>, requestId: string) => {
    const before = await graph();
    const human = await invokeRaw(
      app.root,
      [
        "--local",
        "--config",
        configPath,
        "doctor",
        "graph",
        ...args,
        "--if-version",
        before.version,
        "--request-id",
        requestId,
      ],
      {
        env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "160" },
      },
    );
    assert.equal(human.code, 0, human.stdout + human.stderr);
    assert.equal(human.stderr, "");
    assert.doesNotMatch(human.stdout, /\u001b|"ok":true/);
    assert.match(human.stdout, /Пакет операций.*применён/);
    assert.match(human.stdout, /Ревизия графа/);
    assert.ok(human.stdout.includes(requestId), human.stdout);
    const after = await graph();
    assert.notEqual(after.version, before.version);
    assert.ok(human.stdout.includes(after.version), human.stdout);
    const next = human.stdout.split("\n").find((line) => line.startsWith("npx @oim-dev/relay-cli"));
    assert.ok(
      next?.includes("inspect graph list") && next.includes("--local") && next.includes(configPath),
      human.stdout,
    );
    return { human, after };
  };
  const linked = await humanMutation(
    [
      "link",
      "--from",
      "PRODUCT-1",
      "--to",
      "DOC-1",
      "--type",
      "human-example",
      "--description",
      "## Основание связи\n\nПервое пояснение",
    ],
    "human-link",
  );
  const edge = linked.after.edges.find((entry) => entry.type === "human-example")!;
  assert.ok(edge);
  assert.ok(linked.human.stdout.includes(edge.id));
  const updated = await humanMutation(
    ["update", edge.id, "--description", "## Изменённое пояснение\n\nСмысл отношения сохранён"],
    "human-update",
  );
  assert.equal(
    updated.after.edges.find((entry) => entry.id === edge.id)?.description,
    "## Изменённое пояснение\n\nСмысл отношения сохранён",
  );
  assert.ok(updated.human.stdout.includes(edge.id));
  const applied = await humanMutation(
    [
      "apply",
      "--json",
      JSON.stringify([
        {
          action: "add",
          from: "DOC-1",
          to: "PRODUCT-1",
          type: "human-return",
          description: "Обратное направление",
        },
      ]),
    ],
    "human-apply",
  );
  const reverse = applied.after.edges.find((entry) => entry.type === "human-return")!;
  assert.ok(reverse && applied.human.stdout.includes(reverse.id));
  const listArgs = [
    "--local",
    "--config",
    configPath,
    "inspect",
    "graph",
    "list",
    "--root",
    "PRODUCT-1",
    "--direction",
    "outgoing",
    "--type",
    "human-example",
    "--limit",
    1,
  ];
  const expected = successful(await app.run<GraphPage>(listArgs));
  const list = await invokeRaw(app.root, listArgs, {
    env: { FORCE_COLOR: "1", NO_COLOR: undefined, COLUMNS: "160" },
  });
  assert.equal(list.code, 0, list.stdout);
  assert.equal(list.stderr, "");
  for (const text of [
    "Исходящие",
    "human-example",
    "PRODUCT-1",
    "DOC-1",
    "Начало отношения",
    "Конец отношения",
    "Изменённое пояснение",
    "Смысл отношения сохранён",
    edge.id,
    expected.data.version,
  ])
    assert.ok(list.stdout.includes(text), `${text}\n${list.stdout}`);
  assert.match(list.stdout, /PRODUCT-1.*human-example.*→.*DOC-1/);
  assert.doesNotMatch(list.stdout, /\u001b/);
  const continuation = list.stdout.split("\n").find((line) => line.includes("--cursor"));
  assert.ok(
    continuation?.includes("inspect graph list") &&
      continuation.includes(configPath) &&
      continuation.includes("--local"),
    list.stdout,
  );
  assert.ok(expected.meta?.page?.nextCursor);
  assert.ok(continuation?.includes(expected.meta.page.nextCursor));
  const unlinked = await humanMutation(["unlink", edge.id], "human-unlink");
  assert.ok(unlinked.human.stdout.includes(edge.id));
  assert.ok(!unlinked.after.edges.some((entry) => entry.id === edge.id));
  assert.ok(unlinked.after.edges.some((entry) => entry.id === reverse.id));
});

test("storage migrate/reindex/reconcile-relations и doctor check: текущее хранение без потерь", async (t) => {
  const app = await fixture(t);
  await app.create("Родитель");
  await app.create("Ребёнок", [
    "--parent",
    "PRODUCT-1",
    "--description",
    "Текст\r\n\n  пробелы  \n",
  ]);
  const child = successful(await app.run<any>(["task", "get", "PRODUCT-2"])).data.id;
  const path = join(app.root, ".relay/entities/tasks", `${child}.json`);
  const before = await readFile(path, "utf8");
  const context = successful(
    await app.run<FullContext>(["inspect", "graph", "context", child]),
  ).data;
  const graph = successful(await app.run<GraphPage>(["inspect", "graph", "list"])).data;
  assert.equal(
    successful(await app.run<any>(["--local", "storage", "migrate"])).data.migrated,
    false,
  );
  await rm(join(app.root, ".relay/.indexes"), { recursive: true });
  assert.notEqual((await app.run(["doctor", "check"])).code, 0);
  const rebuilt = successful(await app.run<any>(["--local", "storage", "reindex"])).data;
  assert.equal(rebuilt.edges, graph.totalEdges);
  const repaired = successful(
    await app.run(["--local", "storage", "reconcile-relations", "--request-id", "relations-check"]),
  ).data;
  assert.deepEqual(repaired, { added: 0, updated: 0, removed: 0, requestId: "relations-check" });
  assert.equal(await readFile(path, "utf8"), before);
  const after = successful(await app.run<FullContext>(["inspect", "graph", "context", child])).data;
  assert.deepEqual(after.edges, context.edges);
  const checked = successful(await app.run<any>(["doctor", "check"])).data;
  assert.equal(checked.tasks, 2);
  for (const [args, pattern] of [
    [["storage", "migrate"], /Перенос не требуется/],
    [["storage", "reindex"], /Индексы.*(?:восстановлены|перестроены)/],
    [["storage", "reconcile-relations"], /Добавлено:\s+0/],
    [["doctor", "check"], /Проверка.*пройдена/],
  ] as const) {
    const human = await invokeRaw(app.root, ["--local", ...args], {
      env: { FORCE_COLOR: "1", NO_COLOR: undefined },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, pattern);
    assert.doesNotMatch(human.stdout, /\u001b/);
  }
  const userFile = join(app.root, ".relay", "user-notes.txt");
  await writeFile(userFile, "Не история операций: пользовательские заметки");
  successful(await app.run(["--local", "storage", "migrate"]));
  assert.equal(await readFile(userFile, "utf8"), "Не история операций: пользовательские заметки");
});
