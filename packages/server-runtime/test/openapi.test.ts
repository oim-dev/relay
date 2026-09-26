import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import type { OpenAPIObject, OperationObject, SchemaObject } from "@nestjs/swagger";
import { fixture } from "./helpers/server.js";

for (const scoped of [false, true])
  test(`OpenAPI: ${scoped ? "проектные" : "локальные"} запросы и ответы соответствуют схемам`, async (t) => {
    const { app } = await fixture(t);
    const projectId = (await app.inject("/api/v1/context")).json().data.projectId;
    const document = (await app.inject("/api/openapi.json")).json<OpenAPIObject>();
    assert.equal(document.openapi, "3.1.0");
    const ajv = new Ajv({ strict: false, allErrors: true });
    formats.default(ajv);
    const validate = (schema: object, value: unknown) => {
      const validator = ajv.compile({ ...schema, components: document.components });
      assert(validator(value), JSON.stringify(validator.errors));
    };
    const ids = new Set<string>();
    const operations = new Map<string, OperationObject>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of ["get", "post", "patch", "put", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        assert(operation.operationId, `${method} ${path}`);
        assert(!ids.has(operation.operationId), `Повтор operationId: ${operation.operationId}`);
        ids.add(operation.operationId);
        operations.set(`${method.toUpperCase()} ${path}`, operation);
        for (const parameter of path.matchAll(/\{([^}]+)\}/g))
          assert(
            operation.parameters?.some(
              (item) =>
                !("$ref" in item) &&
                item.in === "path" &&
                item.name === parameter[1] &&
                item.required,
            ),
          );
      }
    }
    assert.equal(operations.size, 149);
    for (const path of [
      "/api/v1/tasks",
      "/api/v1/board",
      "/api/v1/overview",
      "/api/v1/project/state",
      "/api/v1/project/records",
      "/api/v1/releases/{reference}/snapshot",
      "/api/v1/projects/{project}/releases/{reference}/snapshot",
    ])
      assert.equal(document.paths[path], undefined, `Удалённый маршрут ${path}`);
    for (const [name, schema] of Object.entries(document.components!.schemas!)) {
      ajv.compile({ ...schema, components: document.components });
      if (!("$ref" in schema) && Array.isArray(schema.examples))
        for (const example of schema.examples) validate(schema, example);
      assert(!["CreateTaskRequest", "UpdateTaskRequest", "ProjectRecord"].includes(name));
    }

    const visited = new Set<string>();
    async function request(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      url = path,
      payload?: object,
      status = 200,
    ) {
      if (
        scoped &&
        ![
          "/api/v1/health",
          "/api/v1/server",
          "/api/v1/projects",
          "/api/v1/projects/{project}",
        ].includes(path)
      ) {
        path = path.replace("/api/v1/", "/api/v1/projects/{project}/");
        url = url.replace("/api/v1/", `/api/v1/projects/${projectId}/`);
      }
      const operation = operations.get(`${method} ${path}`);
      assert(operation, `${method} ${path}`);
      if (payload) {
        const body = operation.requestBody;
        assert(body && !("$ref" in body) && body.required);
        validate(body.content["application/json"]!.schema!, payload);
      }
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, status, response.body);
      const definition = operation.responses[status];
      assert(definition && !("$ref" in definition), `${method} ${path} ${status}`);
      validate(definition.content!["application/json"]!.schema!, response.json());
      visited.add(`${method} ${path}`);
      return response.json();
    }
    await request("GET", "/api/v1/health");
    await request("GET", "/api/v1/server");
    await request("GET", "/api/v1/projects");
    await request("PUT", "/api/v1/projects/{project}", "/api/v1/projects/a", { path: "." }, 400);
    await request("DELETE", "/api/v1/projects/{project}", "/api/v1/projects/a", undefined, 400);
    await request("GET", "/api/v1/context");
    const graph = await request("GET", "/api/v1/graph");
    const fullContext = await request(
      "GET",
      "/api/v1/graph/context",
      "/api/v1/graph/context?root=PRODUCT",
    );
    assert.equal(fullContext.data.complete, true);
    await request("POST", "/api/v1/graph", undefined, {
      ifVersion: graph.data.version,
      requestId: "openapi-graph",
      operations: [
        {
          action: "add",
          type: "references",
          from: graph.data.nodes[0].ref,
          to: graph.data.nodes[1].ref,
        },
      ],
    });
    const settings = await request("GET", "/api/v1/context/settings");
    await request("PUT", "/api/v1/context/settings", undefined, {
      name: "Проверка настроек",
      slug: "schema-project",
      ifRevision: settings.data.revision,
    });
    await request("GET", "/api/v1/boards");
    await request("GET", "/api/v1/boards/{slug}", "/api/v1/boards/product");
    const card = await request("POST", "/api/v1/board-tasks", undefined, {
      board: "product",
      requestId: "kanban-empty",
      includeTask: true,
    });
    assert.equal(card.data.task.title, "");
    const otherCard = await request("POST", "/api/v1/board-tasks", undefined, {
      board: "infrastructure",
      title: "Зависимость канбана",
      requestId: "kanban-dependency",
    });
    const cardBase = `/api/v1/board-tasks/${card.data.id}`;
    const message = await request(
      "POST",
      "/api/v1/board-tasks/{reference}/comments",
      `${cardBase}/comments`,
      {
        title: "Проверка контракта обсуждений",
        description: "## Результат\n\nПроверено",
        actor: "worker-api",
        actorRole: "worker",
        requestId: "openapi-message",
      },
    );
    await request("GET", "/api/v1/board-tasks/{reference}/comments", `${cardBase}/comments`);
    await request(
      "GET",
      "/api/v1/board-tasks/{reference}/comments/{entryId}",
      `${cardBase}/comments/${message.data.commentId}`,
    );
    await request("GET", "/api/v1/board-tasks");
    await request("GET", "/api/v1/board-tasks/{reference}", cardBase);
    await request("POST", "/api/v1/board-tasks/{reference}/update", `${cardBase}/update`, {
      title: "Проверка контракта",
      description: "## Цель\n\nПроверить Markdown",
      ifRevision: 1,
      requestId: "kanban-update",
    });
    await request("POST", "/api/v1/board-tasks/{reference}/move", `${cardBase}/move`, {
      board: "infrastructure",
      column: "ready",
      ifRevision: 2,
      requestId: "kanban-move",
    });
    await request("POST", "/api/v1/board-tasks/{reference}/links", `${cardBase}/links`, {
      target: otherCard.data.id,
      relation: "depends-on",
      ifRevision: 3,
      requestId: "kanban-link",
    });
    await request("GET", "/api/v1/board-tasks/{reference}/links", `${cardBase}/links`);
    const criterion = await request(
      "POST",
      "/api/v1/board-tasks/{reference}/criteria",
      `${cardBase}/criteria`,
      {
        action: "add",
        title: "Критерий схемы",
        ifRevision: 4,
        requestId: "criterion",
      },
    );
    await request("GET", "/api/v1/board-tasks/{reference}/criteria", `${cardBase}/criteria`);
    await request(
      "GET",
      "/api/v1/board-tasks/{reference}/criteria/{criterionId}",
      `${cardBase}/criteria/${criterion.data.criterionId}`,
    );
    await request("POST", "/api/v1/product/records", undefined, {
      action: "create",
      requestId: "product-passport",
      fields: {
        kind: "passport",
        name: "OpenAPI продукт",
        summary: "Контракт",
        description: "## Назначение\n\nОбщее описание",
      },
    });
    await request("GET", "/api/v1/product/state");
    await request("GET", "/api/v1/product/overview");
    await request("GET", "/api/v1/product/records");
    await request("GET", "/api/v1/product/context");
    const feature = await request("POST", "/api/v1/product/records", undefined, {
      action: "create",
      requestId: "progress-feature",
      fields: { kind: "feature", name: "Фича", summary: "", description: "Описание" },
    });
    const scenario = await request("POST", "/api/v1/product/records", undefined, {
      action: "create",
      requestId: "progress-scenario",
      fields: {
        kind: "scenario",
        featureId: feature.data.id,
        name: "Сценарий",
        description: "Описание",
      },
    });
    const application = await request("POST", "/api/v1/product/records", undefined, {
      action: "create",
      requestId: "progress-app",
      fields: {
        kind: "application",
        name: "API",
        slug: "api",
        type: "backend",
        summary: "",
        description: "Описание",
      },
    });
    const state = await request("GET", "/api/v1/product/state");
    await request("POST", "/api/v1/product/records", undefined, {
      action: "create",
      requestId: "progress-scope",
      ifVersion: state.data.version,
      fields: {
        kind: "scope",
        applicationId: application.data.id,
        contracts: [null, scenario.data.id].map((scenarioId) => ({
          featureId: feature.data.id,
          scenarioId,
          title: "Вклад",
          description: "Описание",
          status: "none",
        })),
      },
    });
    for (const [kind, ref] of [
      ["task", card.data.id],
      ["implementation", "API-FI-1"],
      ["scenario", scenario.data.id],
      ["feature", feature.data.id],
      ["application", application.data.id],
    ])
      await request("GET", `/api/v1/progress/${kind}`, `/api/v1/progress/${kind}?ref=${ref}`);
    await request("GET", "/api/v1/progress/product");
    await request("GET", "/api/v1/entities/types");
    await request("GET", "/api/v1/entities/type", "/api/v1/entities/type?kind=task");
    const entity = await request("POST", "/api/v1/entities", undefined, {
      requestId: "entity-task",
      data: { kind: "task", board: "BOARD-PRODUCT", title: "Задача движка" },
    });
    const entityKey = entity.data.key;
    await request("GET", "/api/v1/entities", "/api/v1/entities?kind=task&board=BOARD-PRODUCT");
    await request("GET", "/api/v1/entities/get", `/api/v1/entities/get?ref=${entityKey}`);
    await request(
      "GET",
      "/api/v1/entities/resolve",
      `/api/v1/entities/resolve?ref=${entity.data.ref.id}`,
    );
    await request("GET", "/api/v1/entities/keys", `/api/v1/entities/keys?ref=${entityKey}`);
    await request("GET", "/api/v1/entities/key-spaces", "/api/v1/entities/key-spaces?kind=task");
    await request("POST", "/api/v1/entities/update", undefined, {
      ref: entityKey,
      ifRevision: 1,
      requestId: "entity-update",
      changes: { kind: "task", description: "## Работа\n\nОписание" },
    });
    await request("POST", "/api/v1/entities/rename", undefined, {
      ref: entityKey,
      key: "TASK-SCHEMA-23",
      ifRevision: 2,
      requestId: "entity-rename",
    });
    await request("POST", "/api/v1/entities/move-task", undefined, {
      ref: entityKey,
      column: "ready",
      board: "BOARD-INFRA",
      ifRevision: 3,
      requestId: "entity-move",
    });
    await request("POST", "/api/v1/entities/link-task", undefined, {
      ref: entityKey,
      target: otherCard.data.key,
      relation: "depends-on",
      ifRevision: 4,
      requestId: "entity-link",
    });
    await request("GET", "/api/v1/validation");
    await request(
      "GET",
      "/api/v1/board-tasks/{reference}",
      "/api/v1/board-tasks/missing",
      undefined,
      404,
    );
    await request(
      "POST",
      "/api/v1/board-tasks/{reference}/update",
      `${cardBase}/update`,
      { title: "Конфликт", ifRevision: 1, requestId: "stale" },
      409,
    );
    const deletion = await request(
      "GET",
      "/api/v1/entities/deletion-preview",
      `/api/v1/entities/deletion-preview?kind=task&ref=${entityKey}`,
    );
    const deleteCommand = {
      kind: "task",
      ref: entityKey,
      ifVersion: deletion.data.version,
      requestId: "delete-entity",
    };
    await request(
      "POST",
      "/api/v1/entities/delete",
      undefined,
      { ...deleteCommand, ifVersion: "stale" },
      409,
    );
    const deleted = await request("POST", "/api/v1/entities/delete", undefined, deleteCommand);
    assert.deepEqual(
      await request("POST", "/api/v1/entities/delete", undefined, deleteCommand),
      deleted,
    );
    await request(
      "GET",
      "/api/v1/entities/get",
      `/api/v1/entities/get?ref=${entityKey}`,
      undefined,
      404,
    );
    assert.equal(visited.size, 52);
    const sse = operations.get("GET /api/v1/events")!.responses[200]!;
    assert(!("$ref" in sse) && sse.content?.["text/event-stream"]);
    const updateSchema = document.components!.schemas!.UpdateBoardTask as SchemaObject;
    assert.equal(updateSchema.additionalProperties, false);
    assert(updateSchema.required!.includes("ifRevision"));
    const createSchema = document.components!.schemas!.CreateBoardTask as SchemaObject;
    assert.deepEqual(new Set(createSchema.required), new Set(["board", "requestId"]));
    assert.equal(createSchema.properties!.rank, undefined);
  });
