import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductQueries } from "@relay/core/application/product/queries";
import { fixture } from "./helpers/server.js";

test("HTTP продукта: scoped-маршруты, прямой Markdown, повторы и реальные ошибки", async (t) => {
  const { app, workspace } = await fixture(t);
  const projectId = (await app.inject("/api/v1/context")).json().data.projectId;
  const prefix = `/api/v1/projects/${projectId}/product`;
  const payload = {
    action: "create",
    requestId: "passport",
    fields: {
      kind: "passport",
      name: "Продукт",
      summary: "Назначение",
      description: "## Цель\n\nСохранить текст  \n",
    },
  };
  const response = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(response.statusCode, 200, response.body);
  const repeated = await app.inject({ method: "POST", url: `${prefix}/records`, payload });
  assert.equal(repeated.statusCode, 409, repeated.body);
  const records = await app.inject(`${prefix}/records?kind=passport&limit=1`);
  assert.equal(records.statusCode, 200, records.body);
  assert.equal(records.json().data.items[0].fields.description, payload.fields.description);
  assert.equal(records.json().data.nextOffset, null);
  assert.deepEqual(
    (await app.inject(`${prefix}/state`)).json().data,
    await new ProductQueries(workspace).state(),
  );
  const conflict = await app.inject({
    method: "POST",
    url: `${prefix}/records`,
    payload: { ...payload, action: "update", id: "passport", ifRevision: 7, requestId: "update" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, "REVISION_CONFLICT");
  const overview = (await app.inject(`${prefix}/overview`)).json().data;
  assert.equal(overview.items[0].name, "Продукт");
  assert.ok(!JSON.stringify(overview).includes("Сохранить текст"));
  const context = (await app.inject(`${prefix}/context`)).json().data;
  assert.equal(context.records[0].record.id, "passport");
});
