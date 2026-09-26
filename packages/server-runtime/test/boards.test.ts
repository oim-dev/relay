import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/server.js";

test("HTTP досок: slug, страницы, создание приложения, повтор, конфликты и изоляция", async (t) => {
  const { app } = await fixture(t);
  const projectId = (await app.inject("/api/v1/context")).json().data.projectId;
  const prefix = `/api/v1/projects/${projectId}`;
  const first = await app.inject(`${prefix}/boards?limit=1`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.items[0].slug, "product");
  assert.equal(first.json().data.nextOffset, 1);
  assert.equal((await app.inject(`${prefix}/boards/product`)).json().data.name, "Продукт");
  assert.equal((await app.inject(`${prefix}/boards/unknown`)).statusCode, 404);
  assert.equal((await app.inject(`${prefix}/boards/INVALID`)).statusCode, 400);
  assert.equal((await app.inject("/api/v1/projects/missing/boards")).statusCode, 404);
  const payload = {
    action: "create",
    requestId: "web-create",
    fields: {
      kind: "application",
      slug: "web",
      name: "Веб",
      summary: "Интерфейс",
      description: "## Назначение\n\nИнтерфейс продукта.",
      type: "frontend",
    },
  };
  const saved = await app.inject({ method: "POST", url: `${prefix}/product/records`, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (await app.inject({ method: "POST", url: `${prefix}/product/records`, payload })).statusCode,
    409,
  );
  const board = await app.inject(`${prefix}/boards/web`);
  assert.equal(board.json().data.applicationId, saved.json().data.id);
  assert.equal(board.json().data.name, "Веб");
  assert.deepEqual(
    (await app.inject(`${prefix}/boards`))
      .json()
      .data.items.map((entry: { slug: string }) => entry.slug),
    ["product", "web", "infrastructure"],
  );
  assert.equal(
    (await app.inject(`${prefix}/boards?offset=1&version=${first.json().data.version}`)).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/product/records`,
        payload: { ...payload, requestId: "duplicate" },
      })
    ).statusCode,
    409,
  );
});
