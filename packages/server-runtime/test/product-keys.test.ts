import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/server.js";
import { ProductQueries } from "@relay/core/application/product/queries";

test("HTTP: ключи, краткое пакетное чтение и независимая ревизия реализации", async (t) => {
  const { app, workspace } = await fixture(t);
  const product = new ProductQueries(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "f",
      fields: {
        kind: "feature",
        name: "Каталог",
        summary: "Товары",
        description: "Содержательное описание. ".repeat(1000),
      },
    },
    "agent",
  );
  const application = await product.mutate(
    {
      action: "create",
      requestId: "app",
      fields: {
        kind: "application",
        name: "Web",
        slug: "web",
        prefix: "WEB",
        summary: "",
        description: "Интерфейс",
        type: "frontend",
      },
    },
    "agent",
  );
  await product.mutate(
    {
      action: "create",
      requestId: "scope",
      ifVersion: (await product.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: feature.key!,
            scenarioId: null,
            title: "Каталог Web",
            description: "Вклад",
            status: "none",
          },
        ],
      },
    },
    "agent",
  );
  const base = `/api/v1/projects/${workspace.config.projectId}/product`;
  const list = await app.inject(`${base}/entities?q=WEB-FI-1&limit=1`);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data.items[0].key, "WEB-FI-1");
  const features = await app.inject(
    `${base}/entities?kind=implementation&application=${application.id}&implementationTarget=feature&active=true&limit=1`,
  );
  assert.equal(features.statusCode, 200, features.body);
  assert.equal(features.json().data.total, 1);
  assert.equal(features.json().data.items[0].key, "WEB-FI-1");
  assert.equal(features.json().data.nextOffset, null);
  const scenarios = await app.inject(
    `${base}/entities?application=${application.id}&implementationTarget=scenario`,
  );
  assert.equal(scenarios.statusCode, 200, scenarios.body);
  assert.equal(scenarios.json().data.total, 0);
  assert.equal((await app.inject(`${base}/entities?implementationTarget=invalid`)).statusCode, 400);
  const schema = (await app.inject("/api/openapi.json")).json();
  for (const path of ["/api/v1/product/entities", "/api/v1/projects/{project}/product/entities"]) {
    const parameter = schema.paths[path].get.parameters.find(
      (entry: { name: string }) => entry.name === "implementationTarget",
    );
    assert.deepEqual(parameter.schema.enum, ["feature", "scenario"]);
    assert.ok(parameter.schema.description.includes("до пагинации"));
  }
  assert.ok(list.body.length < 2000);
  const one = await app.inject(`${base}/entities?refs=FEATURE-1`);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().data.items[0].id, feature.id);
  const two = await app.inject(`${base}/entities?refs=FEATURE-1&refs=WEB-FI-1`);
  assert.equal(two.statusCode, 200, two.body);
  assert.equal(two.json().data.total, 2);
  const entity = await app.inject(`${base}/entity?ref=WEB-FI-1`);
  assert.equal(entity.statusCode, 200, entity.body);
  const record = entity.json().data;
  assert.equal(record.fields.applicationId, application.id);
  assert.equal(record.fields.featureId, feature.id);
  assert.equal(record.fields.kind, "implementation");
  const payload = {
    ref: "WEB-FI-1",
    ifRevision: record.revision,
    title: "Новый заголовок",
    requestId: "update",
  };
  const updated = await app.inject({ method: "POST", url: `${base}/implementations`, payload });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(
    (await app.inject({ method: "POST", url: `${base}/implementations`, payload })).statusCode,
    409,
  );
  const conflict = await app.inject({
    method: "POST",
    url: `${base}/implementations`,
    payload: { ...payload, requestId: "other" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal((await app.inject(`${base}/entity?ref=FEATURE-999`)).statusCode, 404);
  assert.equal((await app.inject(`${base}/entities?limit=101`)).statusCode, 400);
  assert.equal(
    (await app.inject(`/api/v1/projects/unknown/product/entity?ref=FEATURE-1`)).statusCode,
    404,
  );
});
