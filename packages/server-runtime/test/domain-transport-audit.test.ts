import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import type { OpenAPIObject, SchemaObject } from "@nestjs/swagger";
import { initialize } from "@relay/core/storage/workspace";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import {
  createHttpBackend,
  ENTITY_SEARCH_CAPABILITY,
  WORK_READ_MODELS_CAPABILITY,
  PRODUCT_QUERIES_CAPABILITY,
  RELEASE_REFS_CAPABILITY,
} from "@relay/project-runtime/backend/http";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { createServer } from "../src/bootstrap.js";

async function fixture(t: TestContext, scoped: boolean) {
  const root = await mkdtemp("/tmp/opencode/relay-domain-transport-");
  let close: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    await close?.();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await initialize(root, "tasks");
  const local = await createLocalBackend(root);
  const app = await createServer({ cwd: root, actor: "server-default" });
  close = () => app.close();
  const document = (await app.inject("/api/openapi.json")).json<OpenAPIObject>();
  const ajv = new Ajv({ strict: false, allErrors: true });
  formats.default(ajv);
  const base = scoped ? `/api/v1/projects/${workspace.config.projectId}` : "/api/v1";
  async function request(
    method: "GET" | "POST",
    path: string,
    payload?: object,
    status = 200,
    route = path.split("?")[0]!,
  ): Promise<any> {
    const response = await app.inject({
      method,
      url: `${base}${path}`,
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, status, response.body);
    const data = response.json();
    const operation =
      document.paths[`${scoped ? "/api/v1/projects/{project}" : "/api/v1"}${route}`]?.[
        method === "GET" ? "get" : "post"
      ];
    assert.ok(operation, `OpenAPI ${method} ${route}`);
    const result = operation.responses[String(status)]!;
    assert.ok(!("$ref" in result));
    const schema = result.content!["application/json"]?.schema as SchemaObject | undefined;
    // Nest хранит явно заданный JSON schema в content application/json.
    assert.ok(schema);
    const validate = ajv.compile({ ...schema, components: document.components });
    assert.ok(validate(data), JSON.stringify(validate.errors));
    return data;
  }
  return { local, request, document, app, projectId: workspace.config.projectId };
}

for (const scoped of [false, true]) {
  test(`HTTP Backend ${scoped ? "scoped" : "local"}: generated SDK, реальные capability, предметные ответы и CAS`, async (t) => {
    const { local, app, projectId } = await fixture(t, scoped);
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const contextPath = scoped ? `/api/v1/projects/${projectId}/context` : "/api/v1/context";
    const contextResponse = await fetch(`${url}${contextPath}`);
    assert.equal(contextResponse.status, 200);
    const serverContext = await contextResponse.json();
    for (const capability of [
      ENTITY_SEARCH_CAPABILITY,
      WORK_READ_MODELS_CAPABILITY,
      PRODUCT_QUERIES_CAPABILITY,
      RELEASE_REFS_CAPABILITY,
    ])
      assert.ok(serverContext.data.capabilities.includes(capability), capability);
    const http = await createHttpBackend(url, scoped ? projectId : undefined);
    assert.equal(http.workspace.projectId, projectId);
    const plan = await local.plans.create(
      { title: "HTTP план", goal: "## Цель\nПроверить транспорт", requestId: "http-plan" },
      "local-author",
    );
    assert.deepEqual(
      await http.plans.listCompact({ projection: "compact" }),
      await local.plans.listCompact({ projection: "compact" }),
    );
    const release = await http.releases.createByRefs(
      {
        title: "HTTP выпуск",
        version: "1",
        plans: [plan.key],
        requestId: "http-release",
        actor: "body-author",
      },
      "default-author",
    );
    assert.equal((await local.releases.get(release.id)).createdBy, "body-author");
    assert.deepEqual(
      await http.releases.listCompact({ projection: "compact" }),
      await local.releases.listCompact({ projection: "compact" }),
    );
    assert.deepEqual(
      await http.releases.compositionCompact(release.id, { projection: "compact" }),
      await local.releases.compositionCompact(release.id, { projection: "compact" }),
    );
    assert.deepEqual(
      await http.releases.previewCompact({ projection: "compact", plans: [plan.key] }),
      await local.releases.previewCompact({ projection: "compact", plans: [plan.key] }),
    );
    const update = {
      title: "Обновлённый выпуск",
      version: "2",
      plans: [plan.key],
      status: "planned" as const,
      ifRevision: release.revision,
      requestId: "http-update",
    };
    await http.releases.updateByRefs(release.id, update, "update-author");
    await assert.rejects(http.releases.updateByRefs(release.id, update, "update-author"), {
      code: "REVISION_CONFLICT",
    });
    const dependency = await local.boardTasks.create(
      { board: "product", requestId: "dependency" },
      "local-author",
    );
    const task = await local.boardTasks.create(
      { board: "product", dependencies: [dependency.id], requestId: "task" },
      "local-author",
    );
    assert.deepEqual(
      await http.progress.taskDependencies({ ref: task.key }),
      await local.progress.taskDependencies({ ref: task.key }),
    );
    const feature = await local.product.mutate(
      {
        action: "create",
        fields: { kind: "feature", name: "Фича", summary: "", description: "Описание требования" },
        requestId: "feature",
      },
      "local-author",
    );
    const application = await local.product.mutate(
      {
        action: "create",
        fields: {
          kind: "application",
          name: "HTTP Web",
          slug: "http-web",
          prefix: "WEB",
          type: "frontend",
          summary: "",
          description: "Назначение приложения",
        },
        requestId: "application",
      },
      "local-author",
    );
    assert.deepEqual(await http.product.validate(), await local.product.validate());
    assert.deepEqual(await http.product.lint(), await local.product.lint());
    const overview = await local.product.overview();
    assert.deepEqual(
      await http.product.overviewMap({ version: overview.snapshotVersion }),
      await local.product.overviewMap({ version: overview.snapshotVersion }),
    );
    const page = await http.product.participation({ application: application.key! });
    const replace = {
      application: application.key!,
      ifVersion: page.version,
      ifRevision: page.revision,
      selections: [
        {
          kind: "target" as const,
          target: feature.key!,
          title: "Собственный вклад",
          description: "\r\n  Точный Markdown\t\n",
          status: "done" as const,
        },
      ],
      requestId: "http-participation",
      actor: "participation-author",
    };
    const saved = await http.product.replaceParticipation(replace, "default-author");
    assert.equal(saved.selected, 1);
    await assert.rejects(http.product.replaceParticipation(replace, "default-author"), {
      code: "REVISION_CONFLICT",
    });
    await assert.rejects(local.product.replaceParticipation(replace, "default-author"), {
      code: "REVISION_CONFLICT",
    });
    const current = await http.product.participation({ application: application.key! });
    assert.deepEqual(current, await local.product.participation({ application: application.key! }));
    const implementation = await http.product.implementation(current.items[0]!.key);
    assert.equal(implementation.fields.description, replace.selections[0]!.description);
    assert.equal(implementation.createdBy, "participation-author");
    assert.equal(implementation.savedStatus, "done");
    assert.equal(implementation.fields.status, "none");
    const query = { q: "Точный Markdown", implementationTarget: "feature" as const };
    assert.deepEqual(await http.entities.list(query), await local.entities.list(query));

    // Сервер действительно сохранил запись, но клиент не получил её ответ.
    const originalFetch = globalThis.fetch.bind(globalThis);
    let sent = 0;
    const lostResponse = t.mock.method(
      globalThis,
      "fetch",
      async (input: string, init: RequestInit) => {
        const response = await originalFetch(input, init);
        if (new URL(input).pathname.endsWith("/releases/by-refs") && init.method === "POST") {
          sent++;
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          throw new TypeError("Соединение потеряно после успешной записи");
        }
        return response;
      },
    );
    try {
      await assert.rejects(
        http.releases.createByRefs(
          {
            title: "Потерянный ответ",
            version: "3",
            plans: [plan.key],
            requestId: "lost-response",
          },
          "lost-author",
        ),
        { code: "SERVER_UNAVAILABLE" },
      );
    } finally {
      lostResponse.mock.restore();
    }
    assert.equal(sent, 1, "Запись после потери ответа не отправляется повторно");
    const written = await local.releases.list({ q: "Потерянный ответ" });
    assert.equal(written.total, 1);
    assert.equal(written.items[0]!.createdBy, "lost-author");
  });

  test(`Предметный REST ${scoped ? "scoped" : "local"}: компактные проекции, refs, зависимости и прежний ответ`, async (t) => {
    const { local, request, document } = await fixture(t, scoped);
    for (const [path, method, operationId] of [
      ["/releases/{reference}/plans/compact", "get", "getReleasePlansCompact"],
      ["/releases/{reference}/update-by-refs", "post", "updateReleaseByRefs"],
    ] as const) {
      for (const prefix of ["/api/v1", "/api/v1/projects/{project}"]) {
        const operation = document.paths[`${prefix}${path}`]![method]!;
        assert.equal(
          operation.operationId,
          `${operationId}${prefix.includes("{project}") ? "ForProject" : ""}`,
        );
        const reference = operation.parameters?.find(
          (item) => !("$ref" in item) && item.in === "path" && item.name === "reference",
        );
        assert.ok(
          reference && !("$ref" in reference),
          `${operation.operationId}: reference должен быть path-параметром`,
        );
        assert.equal(reference.required, true);
        assert.deepEqual(
          reference.schema,
          { type: "string" },
          `${operation.operationId}: пустая схема превращает адрес в any в SDK`,
        );
      }
    }
    for (const [path, method, response] of [
      ["/plans", "get", "PlansPage"],
      ["/releases", "get", "ReleasesPage"],
      ["/releases/{reference}/plans", "get", "ReleaseComposition"],
      ["/releases/preview", "post", "ReleaseComposition"],
    ] as const) {
      const operation = document.paths[`/api/v1${path}`]![method]!;
      const result = operation.responses["200"]!;
      assert.ok(!("$ref" in result));
      const schema = result.content!["application/json"]!.schema as SchemaObject;
      assert.deepEqual(schema.properties!.data, { $ref: `#/components/schemas/${response}` });
      assert.ok(
        !operation.parameters?.some((item) => !("$ref" in item) && item.name === "projection"),
      );
    }
    const markdown = "## Полный текст\r\n  Сохранить пробелы  \n".repeat(50);
    const plan = await local.plans.create(
      { title: "План", goal: markdown, requestId: "plan" },
      "author",
    );
    const other = await local.plans.create({ title: "Второй", requestId: "other" }, "author");
    const full = (await request("GET", "/plans?limit=1")).data;
    const compact = (await request("GET", "/plans/compact?projection=compact&limit=1")).data;
    assert.deepEqual(compact, await local.plans.listCompact({ projection: "compact", limit: 1 }));
    assert.equal("goal" in full.items[0], true);
    assert.equal("goal" in compact.items[0]!, false);
    assert.equal(
      (
        await request(
          "GET",
          `/plans/compact?projection=compact&offset=1&limit=1&version=${compact.version}`,
        )
      ).data.items.length,
      1,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/plans/compact?projection=compact&offset=1&limit=1&version=${full.version}`,
          undefined,
          409,
        )
      ).error.code,
      "PLANNING_CHANGED",
    );
    await request("GET", "/plans/compact?projection=unknown", undefined, 400);
    await request("GET", "/plans/compact", undefined, 400);
    const release = (
      await request("POST", "/releases/by-refs", {
        title: "Выпуск",
        version: "v1",
        description: markdown,
        plans: [plan.key, `work-plan:${other.id}`],
        requestId: "release",
        actor: "release-author",
      })
    ).data;
    const getRelease = await local.releases.get(release.id);
    assert.equal(getRelease.createdBy, "release-author");
    assert.deepEqual(getRelease.planIds, [plan.id, other.id]);
    assert.equal((await request("GET", "/releases")).data.items[0].description, markdown);
    const releases = (await request("GET", "/releases/compact?projection=compact")).data;
    assert.deepEqual(releases, await local.releases.listCompact({ projection: "compact" }));
    assert.equal("description" in releases.items[0]!, false);
    assert.equal("planIds" in releases.items[0]!, false);
    const route = "/releases/{reference}/plans/compact";
    const composition = (
      await request(
        "GET",
        `/releases/${release.id}/plans/compact?projection=compact`,
        undefined,
        200,
        route,
      )
    ).data;
    const preview = (
      await request("POST", "/releases/preview/compact?projection=compact", {
        plans: [plan.key, other.id],
      })
    ).data;
    assert.deepEqual(preview.items, composition.items);
    assert.equal("goal" in composition.items[0].plan, false);
    assert.equal(
      (await request("POST", "/releases/preview", { plans: [plan.key] })).data.items[0].plan.goal,
      markdown,
    );
    await request("POST", "/releases/preview/compact?projection=broken", { plans: [] }, 400);
    const updated = (
      await request(
        "POST",
        `/releases/${release.id}/update-by-refs`,
        {
          title: "Новый",
          version: "v2",
          plans: [other.key],
          status: "planned",
          ifRevision: release.revision,
          requestId: "update",
        },
        200,
        "/releases/{reference}/update-by-refs",
      )
    ).data;
    assert.equal(updated.revision, release.revision + 1);
    assert.equal(
      (
        await request(
          "POST",
          `/releases/${release.id}/update-by-refs`,
          {
            title: "Устарел",
            version: "v3",
            plans: [plan.key],
            status: "planned",
            ifRevision: release.revision,
            requestId: "conflict",
          },
          409,
          "/releases/{reference}/update-by-refs",
        )
      ).error.code,
      "REVISION_CONFLICT",
    );
    const dependency = await local.boardTasks.create(
      { board: "product", title: "Зависимость", requestId: "dependency" },
      "author",
    );
    const task = await local.boardTasks.create(
      { board: "product", dependencies: [dependency.id], requestId: "task" },
      "author",
    );
    const dependencies = (await request("GET", `/progress/task/dependencies?ref=${task.key}`)).data;
    assert.deepEqual(dependencies, await local.progress.taskDependencies({ ref: task.key }));
    assert.deepEqual(
      dependencies.items.map((item: { id: string }) => item.id),
      [dependency.id],
    );
    assert.equal("reasons" in dependencies, false);
    assert.ok(document.paths["/api/v1/projects/{project}/progress/task/dependencies"]);
  });

  test(`Продуктовый REST ${scoped ? "scoped" : "local"}: страницы, атомарная замена, guards и Markdown`, async (t) => {
    const { local, request } = await fixture(t, scoped);
    const product = local.product;
    const feature = await product.mutate(
      {
        action: "create",
        fields: {
          kind: "feature",
          name: "Фича",
          summary: "",
          description: "Описание. ".repeat(30),
        },
        requestId: "feature",
      },
      "author",
    );
    const application = await product.mutate(
      {
        action: "create",
        fields: {
          kind: "application",
          name: "Web",
          slug: "web",
          prefix: "WEB",
          type: "frontend",
          summary: "",
          description: "Приложение",
        },
        requestId: "application",
      },
      "author",
    );
    assert.deepEqual((await request("GET", "/product/validate")).data, await product.validate());
    assert.deepEqual(
      (await request("GET", "/product/lint?limit=1")).data,
      await product.lint({ limit: 1 }),
    );
    const overview = await product.overview();
    const map = (
      await request("GET", `/product/overview/map?limit=1&version=${overview.snapshotVersion}`)
    ).data;
    assert.deepEqual(
      map,
      await product.overviewMap({ limit: 1, version: overview.snapshotVersion }),
    );
    assert.equal("snapshot" in map, false);
    const query = `/product/participation?application=${application.key}`;
    const initial = (await request("GET", query)).data;
    assert.equal(initial.revision, 0);
    const markdown = "\r\n  Свой вклад\t\n\nНе менять пробелы  \n";
    const command = {
      application: application.key!,
      ifRevision: initial.revision,
      ifVersion: initial.version,
      selections: [
        {
          kind: "target",
          target: feature.key,
          title: "Вклад",
          description: markdown,
          status: "done",
        },
      ],
      requestId: "participation",
      actor: "body-author",
    };
    const saved = (await request("POST", "/product/participation", command)).data;
    assert.equal(saved.selected, 1);
    assert.equal((await request("POST", "/product/participation", command, 409)).ok, false);
    const page = (await request("GET", query)).data;
    assert.deepEqual(page, await product.participation({ application: application.key! }));
    const ref = page.items[0]!.key;
    const implementation = (await request("GET", `/product/implementation?ref=${ref}`)).data;
    assert.equal(implementation.fields.description, markdown);
    assert.equal(implementation.createdBy, "body-author");
    assert.equal(implementation.savedStatus, "done");
    assert.equal(implementation.fields.status, "none");
    assert.deepEqual(
      (await request("GET", `/product/lint?ref=${ref}`)).data,
      await product.lint({ ref }),
    );
    assert.equal(
      (await request("GET", `${query}&version=${initial.snapshotVersion}`, undefined, 409)).error
        .code,
      "VERSION_CONFLICT",
    );
    const replace = async (selections: object[]) => {
      const current = await product.participation({ application: application.key! });
      return request("POST", "/product/participation", {
        application: application.key!,
        selections,
        ifRevision: current.revision,
        ifVersion: current.version,
        requestId: "replace",
      });
    };
    await replace([]);
    assert.equal(
      (await product.participation({ application: application.key! })).items[0]!.active,
      false,
    );
    await replace([{ kind: "existing", ref }]);
    const restored = await product.implementation(ref);
    assert.equal(restored.id, implementation.id);
    assert.equal(restored.fields.description, markdown);
    assert.equal(restored.savedStatus, "done");
    const entitiesQuery = { q: "Свой вклад", implementationTarget: "feature" as const };
    const search = (
      await request(
        "GET",
        `/entities?q=${encodeURIComponent(entitiesQuery.q)}&implementationTarget=feature`,
      )
    ).data;
    assert.deepEqual(search, await local.entities.list(entitiesQuery));
    assert.equal(search.total, 1);
    assert.equal(search.items[0]!.implementation!.type, "FI");
    assert.equal(search.items[0]!.implementation!.application.key, application.key);
    assert.equal(search.items[0]!.implementation!.target.key, feature.key);
    assert.ok(search.items[0]!.updatedAt);
    const detail = (await request("GET", `/entities/get?ref=${ref}`)).data;
    assert.deepEqual(detail, await local.entities.get({ ref }));
    assert.equal(detail.savedStatus, "done");
    assert.ok(detail.data.kind === "implementation");
    assert.equal(detail.data.status, "none");
    assert.ok(detail.metadata!.createdBy);
    assert.equal(
      (await request("GET", `/entities/get?ref=${feature.key}`)).data.metadata.createdBy,
      "author",
    );
    assert.equal((await request("GET", "/entities?implementationTarget=scenario")).data.total, 0);
    await request("GET", "/entities?implementationTarget=task", undefined, 400);
    assert.equal(
      (await request("GET", `/product/overview/map?version=${map.snapshotVersion}`, undefined, 409))
        .error.code,
      "VERSION_CONFLICT",
    );
    await request("GET", "/product/lint?limit=0", undefined, 400);
  });
}

test("Новые scoped операции изолированы проектом, ссылки не разрешаются в соседней базе", async (t) => {
  const root = await mkdtemp("/tmp/opencode/relay-domain-isolation-");
  let close: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    await close?.();
    await rm(root, { recursive: true, force: true });
  });
  await initialize(join(root, "a"), "tasks");
  await initialize(join(root, "b"), "tasks");
  const a = await createLocalBackend(join(root, "a"));
  const b = await createLocalBackend(join(root, "b"));
  const registry = await initializeRegistry(root);
  await registerProject(registry.configPath, "a", { path: "a" });
  await registerProject(registry.configPath, "b", { path: "b" });
  const plan = await a.plans.create({ title: "Только А", requestId: "plan" }, "author-a");
  const appA = await a.product.mutate(
    {
      action: "create",
      fields: {
        kind: "application",
        name: "Приложение А",
        slug: "only-a",
        prefix: "AAA",
        type: "frontend",
        summary: "",
        description: "Назначение приложения А",
      },
      requestId: "app-a",
    },
    "author-a",
  );
  const app = await createServer({ cwd: root, actor: "server-default" });
  close = () => app.close();
  for (const [key, total] of [
    ["a", 1],
    ["b", 0],
  ] as const) {
    const response = await app.inject(`/api/v1/projects/${key}/plans/compact?projection=compact`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.total, total);
  }
  const crossRead = await app.inject(
    `/api/v1/projects/b/product/participation?application=${appA.id}`,
  );
  assert.equal(crossRead.statusCode, 409, crossRead.body);
  assert.equal(crossRead.json().error.code, "INVALID_REFERENCE");
  const crossWrite = await app.inject({
    method: "POST",
    url: "/api/v1/projects/b/releases/by-refs",
    payload: { title: "Чужой план", version: "1", plans: [plan.id], requestId: "cross" },
  });
  assert.equal(crossWrite.statusCode, 404, crossWrite.body);
  assert.equal((await b.releases.list()).total, 0);
  assert.equal((await a.releases.list()).total, 0);
});
