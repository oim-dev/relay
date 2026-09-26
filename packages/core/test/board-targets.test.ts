import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "../src/application/storage/service.js";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { ProductQueries } from "@relay/core/application/product/queries";
import { fixture } from "./helpers/workspace.js";

/** Создаёт общие требования и два независимых состава приложений. */
async function targetsFixture(t: TestContext) {
  const { workspace } = await fixture(t);
  const product = new ProductQueries(workspace);
  const feature = await product.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Каталог", summary: "", description: "Требования" },
    },
    "agent",
  );
  const scenario = await product.mutate(
    {
      action: "create",
      requestId: "scenario",
      fields: { kind: "scenario", featureId: feature.id, name: "Поиск", description: "Найти" },
    },
    "agent",
  );
  for (const slug of ["web", "api"]) {
    const application = await product.mutate(
      {
        action: "create",
        requestId: slug,
        fields: {
          kind: "application",
          slug,
          prefix: slug.toUpperCase(),
          name: slug,
          summary: "",
          description: "Приложение",
          type: "frontend",
        },
      },
      "agent",
    );
    await product.mutate(
      {
        action: "create",
        requestId: `scope-${slug}`,
        ifVersion: (await product.state()).version,
        fields: {
          kind: "scope",
          applicationId: application.id,
          contracts: [
            {
              featureId: feature.id,
              scenarioId: null,
              title: `Каталог ${slug}`,
              description: "Вклад",
              status: "none",
            },
            {
              featureId: feature.id,
              scenarioId: scenario.id,
              title: `Поиск ${slug}`,
              description: "Вклад",
              status: "none",
            },
          ],
        },
      },
      "agent",
    );
  }
  return { workspace, product, feature, scenario, tasks: new BoardTasksService(workspace) };
}

test("цели карточки ограничены доской при создании, обновлении и переносе", async (t) => {
  const { product, feature, scenario, tasks } = await targetsFixture(t);
  const webFeature = await product.entity("WEB-FI-1");
  const webScenario = await product.entity("WEB-SI-1");
  const apiFeature = await product.entity("API-FI-1");
  const goals = [
    { kind: "feature" as const, id: feature.id },
    { kind: "scenario" as const, id: scenario.id },
    { kind: "implementation" as const, id: webFeature.id },
    { kind: "implementation" as const, id: webScenario.id },
    { kind: "implementation" as const, id: apiFeature.id },
  ];
  for (const board of ["product", "web", "infrastructure"]) {
    const empty = await tasks.create({ board, requestId: `empty-${board}` }, "agent");
    for (const [index, goal] of goals.entries()) {
      const allowed =
        board === "product" ? index < 2 : board === "web" && (index === 2 || index === 3);
      const command = { board, productLinks: [goal], requestId: `${board}-${index}` };
      if (allowed) {
        const created = await tasks.create(command, "agent");
        assert.deepEqual((await tasks.get(created.id)).productLinks, [goal]);
        assert.deepEqual(await tasks.create(command, "agent"), created);
      } else {
        await assert.rejects(tasks.create(command, "agent"), { code: "INVALID_REFERENCE" });
        await assert.rejects(
          tasks.update(
            empty.id,
            {
              productLinks: [goal],
              ifRevision: 1,
              requestId: `update-${board}-${index}`,
            },
            "agent",
          ),
          { code: "INVALID_REFERENCE" },
        );
        assert.equal((await tasks.get(empty.id)).revision, 1);
      }
    }
  }
  const task = await tasks.create(
    { board: "web", productLinks: [goals[2]!], requestId: "movable" },
    "agent",
  );
  for (const board of ["product", "api", "infrastructure"]) {
    await assert.rejects(
      tasks.move(
        task.id,
        {
          board,
          column: "inbox",
          ifRevision: 1,
          requestId: `move-${board}`,
        },
        "agent",
      ),
      { code: "INVALID_REFERENCE" },
    );
    assert.equal((await tasks.get(task.id)).boardSlug, "web");
    assert.equal((await tasks.get(task.id)).revision, 1);
  }
  const update = { productLinks: [goals[3]!], ifRevision: 1, requestId: "valid-update" };
  const saved = await tasks.update(task.id, update, "agent");
  assert.deepEqual(await tasks.update(task.id, update, "agent"), saved);
  await assert.rejects(tasks.update(task.id, { ...update, requestId: "stale" }, "agent"), {
    code: "REVISION_CONFLICT",
  });
  await tasks.update(task.id, { productLinks: [], ifRevision: 2, requestId: "clear" }, "agent");
  await tasks.move(
    task.id,
    { board: "infrastructure", column: "inbox", ifRevision: 3, requestId: "move-cleared" },
    "agent",
  );
  assert.equal((await tasks.get(task.id)).boardSlug, "infrastructure");
});

test("снятые реализации сохраняются в прежних ссылках, но не добавляются заново", async (t) => {
  const { product, tasks } = await targetsFixture(t);
  const implementation = await product.entity("WEB-SI-1");
  const links = [{ kind: "implementation" as const, id: implementation.id }];
  const task = await tasks.create(
    { board: "web", productLinks: links, requestId: "linked" },
    "agent",
  );
  const state = await product.state();
  const application = state.records.find(
    (record) => record.fields.kind === "application" && record.fields.slug === "web",
  );
  assert.ok(application);
  const scope = state.records.find(
    (record) => record.fields.kind === "scope" && record.fields.applicationId === application.id,
  );
  assert.ok(scope);
  await product.mutate(
    {
      action: "update",
      id: scope.id,
      ifRevision: scope.revision,
      ifVersion: state.version,
      requestId: "withdraw",
      fields: { kind: "scope", applicationId: application.id, contracts: [] },
    },
    "agent",
  );
  await tasks.update(task.id, { productLinks: links, ifRevision: 1, requestId: "retain" }, "agent");
  await tasks.move(task.id, { column: "ready", ifRevision: 2, requestId: "same-board" }, "agent");
  await assert.rejects(
    tasks.create({ board: "web", productLinks: links, requestId: "new-link" }, "agent"),
    { code: "INVALID_REFERENCE" },
  );
  assert.equal(
    (
      await product.entities({
        kind: "implementation",
        application: application.id,
        active: "true",
      })
    ).total,
    0,
  );
});

test("старые несовместимые цели читаются без миграции и удаляются явно", async (t) => {
  const { workspace, feature, tasks } = await targetsFixture(t);
  const task = await tasks.create({ board: "infrastructure", requestId: "legacy" }, "agent");
  await writeLegacyMigrationFixture(workspace);
  const path = join(
    dirname(workspace.configPath),
    "boards/infrastructure/tasks",
    `${task.id}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.productLinks = [{ kind: "feature", id: feature.id }];
  await writeFile(path, JSON.stringify(stored));
  const original = await readFile(path, "utf8");
  assert.deepEqual((await tasks.get(task.id)).productLinks, stored.productLinks);
  assert.equal(await readFile(path, "utf8"), original);
  await new StorageService(workspace).migrate();
  await tasks.update(task.id, { title: "Исправляем", ifRevision: 1, requestId: "title" }, "agent");
  await tasks.move(task.id, { column: "ready", ifRevision: 2, requestId: "column" }, "agent");
  await tasks.update(task.id, { productLinks: [], ifRevision: 3, requestId: "repair" }, "agent");
  assert.deepEqual((await tasks.get(task.id)).productLinks, []);
});

test("каталог разделяет реализации до total и пагинации, сохраняя фильтр приложения", async (t) => {
  const { product } = await targetsFixture(t);
  for (const implementationTarget of ["feature", "scenario"] as const) {
    const query = {
      kind: "implementation" as const,
      implementationTarget,
      active: "true" as const,
      limit: 1,
    };
    const first = await product.entities(query);
    assert.equal(first.total, 2);
    assert.equal(first.nextOffset, 1);
    const second = await product.entities({ ...query, offset: first.nextOffset! });
    assert.equal(second.total, 2);
    assert.equal(second.nextOffset, null);
    assert.notEqual(first.items[0]!.id, second.items[0]!.id);
    assert.ok(
      [...first.items, ...second.items].every(
        (entry) => (entry.scenarioId === null) === (implementationTarget === "feature"),
      ),
    );
    const own = await product.entities({ ...query, application: "WEB" });
    assert.equal(own.total, 1);
    assert.equal(own.nextOffset, null);
    assert.ok(own.items[0]!.key?.startsWith("WEB-"));
  }
  assert.equal(
    (await product.entities({ kind: "feature", implementationTarget: "scenario" })).total,
    0,
  );
});
