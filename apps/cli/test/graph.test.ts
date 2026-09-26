import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphPage, GraphSaved, FullContext } from "@relay/core/domain/entity-graph";
import { fixture, successful, invokeRaw, failed } from "./helpers/cli.js";

test("CLI графа: контекстный документ, путь, конфликт повтора и читаемое продолжение", async (t) => {
  const app = await fixture(t);
  const task = successful(
    await app.run<{ id: string }>([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Подготовить сборку",
    ]),
  ).data;
  const doc = successful(
    await app.run<{ id: string }>([
      "product",
      "save",
      "--json",
      JSON.stringify({
        action: "create",
        requestId: "context-doc",
        fields: {
          kind: "document",
          name: "Пример другого приложения",
          summary: "",
          body: "## Пример\nНастройка pipeline.",
          documentKind: "description",
          links: [],
        },
      }),
    ]),
  ).data;
  const initial = successful(await app.run<GraphPage>(["graph", "list"])).data;
  assert.equal(initial.totalEdges, 2);
  const link = [
    "graph",
    "link",
    "--from",
    `task:${task.id}`,
    "--to",
    `document:${doc.id}`,
    "--type",
    "example-for",
    "--description",
    "## Для контекста\nНе требование.",
    "--if-version",
    initial.version,
    "--request-id",
    "attach-doc",
  ];
  const saved = successful(await app.run<GraphSaved>(link)).data;
  failed(await app.run(link), "GRAPH_CHANGED", 4);
  const context = successful(
    await app.run<FullContext>(["graph", "context", `task:${task.id}`]),
  ).data;
  assert.ok(context.nodes.some((node) => node.ref.id === doc.id));
  assert.ok(context.edges.some((edge) => edge.to.id === doc.id && edge.id === saved.ids[0]));
  const human = await invokeRaw(app.root, ["graph", "context", `task:${task.id}`]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Полный контекст/);
  assert.match(human.stdout, /Граф прочитан полностью/);
  assert.match(human.stdout, /example-for/);
  assert.match(human.stdout, new RegExp(task.id));
  assert.equal(context.complete, true);
  const details = await invokeRaw(app.root, [
    "graph",
    "list",
    "--root",
    `task:${task.id}`,
    "--type",
    "example-for",
  ]);
  assert.match(details.stdout, /Для контекста/);
  assert.doesNotMatch(human.stdout, /Из предметной записи/);
  assert.doesNotMatch(human.stdout, /"nodes":/);
  const page = await invokeRaw(app.root, ["graph", "list", "--limit", "1"]);
  assert.match(page.stdout, /Продолжение: relay-cli graph list .*--snapshot-version/);
  const firstPage = successful(await app.run<GraphPage>(["graph", "list", "--limit", "1"])).data;
  const nextPage = successful(
    await app.run<GraphPage>([
      "graph",
      "list",
      "--limit",
      "1",
      "--offset",
      String(firstPage.nextOffset),
      "--snapshot-version",
      firstPage.version,
    ]),
  ).data;
  assert.notDeepEqual(firstPage.nodes, nextPage.nodes);
  const invalid = await app.run(["graph", "context", "неправильный-адрес"]);
  assert.notEqual(invalid.code, 0);
  const invalidJson = await app.run([
    "graph",
    "apply",
    "--json",
    "{",
    "--if-version",
    context.version,
  ]);
  assert.equal(invalidJson.code, 2);
  assert.ok(!invalidJson.body.ok && invalidJson.body.error.code === "INVALID_JSON");
  successful(await app.run(["graph", "unlink", saved.ids[0]!, "--if-version", context.version]));
  const afterUnlink = successful(
    await app.run<{ edges: { id: string }[] }>(["graph", "list"]),
  ).data;
  assert.ok(!afterUnlink.edges.some((edge) => edge.id === saved.ids[0]));
});
