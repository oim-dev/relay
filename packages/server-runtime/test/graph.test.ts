import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/server.js";

test("HTTP графа: новые связи, контекст, CAS, повтор и проектный маршрут", async (t) => {
  const { app } = await fixture(t);
  const context = (await app.inject("/api/v1/context")).json().data;
  const url = `/api/v1/projects/${context.projectId}/graph`;
  const graph = await app.inject(url);
  assert.equal(graph.statusCode, 200, graph.body);
  const page = graph.json().data;
  assert.ok(page.nodes.length >= 3);
  assert.equal(page.totalEdges, 1);
  assert.equal(page.edges[0].type, "part-of");
  assert.equal(page.edges[0].from.kind, "product");
  assert.equal(page.edges[0].to.kind, "project");
  const payload = {
    ifVersion: page.version,
    requestId: "graph-http",
    operations: [
      {
        action: "add",
        type: "arbitrary",
        from: page.nodes[0].ref,
        to: page.nodes[1].ref,
        description: "## Контекст\nМатериал",
      },
    ],
  };
  const saved = await app.inject({ method: "POST", url, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual((await app.inject({ method: "POST", url, payload })).json(), saved.json());
  assert.equal(
    (await app.inject({ method: "POST", url, payload: { ...payload, requestId: "stale" } }))
      .statusCode,
    409,
  );
  assert.equal((await app.inject(`${url}?version=${page.version}`)).statusCode, 409);
  const root = page.nodes[0].ref;
  const read = (await app.inject(`${url}?root=${root.kind}:${root.id}&depth=1`)).json().data;
  assert.equal(read.totalEdges, 1);
  assert.equal(read.edges[0].source, "graph");
  assert.deepEqual(
    (await app.inject(`${url}?root=${root.kind}:${root.id}&depth=1&profile=context`)).json().data,
    read,
  );
  assert.ok(read.paths.some((path: { edges: string[] }) => path.edges.length === 1));
  assert.equal((await app.inject(`${url}/history`)).statusCode, 404);
  assert.equal((await app.inject("/api/v1/projects/missing/graph")).statusCode, 404);
  const schema = (await app.inject("/api/openapi.json")).json();
  assert.ok(schema.paths["/api/v1/graph"].post);
});
