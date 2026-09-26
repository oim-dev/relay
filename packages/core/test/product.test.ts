import assert from "node:assert/strict";
import { writeLegacyMigrationFixture } from "./helpers/legacy-migration-fixture.js";
import { StorageService } from "../src/application/storage/service.js";
import { legacyFixture } from "./helpers/workspace.js";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ProductQueries } from "@relay/core/application/product/queries";
import type { ProductMutation } from "@relay/core/domain/product";
import { fixture } from "./helpers/workspace.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductRepository } from "@relay/core/storage/product";
import { encodeProduct } from "@relay/core/storage/product-codec";
import { lintProduct } from "@relay/core/application/product/content";

test("проверка содержания выдаёт страницы предупреждений без изменения требований", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const feature = await service.mutate(
    {
      action: "create",
      requestId: "content-feature",
      fields: {
        kind: "feature",
        name: "Слитное описание",
        summary: "Первая строка\nВторая строка",
        description: "Общее длинное описание без структуры. ".repeat(12),
      },
    },
    "agent",
  );
  const state = await service.state();
  const first = lintProduct(state, { limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  const second = lintProduct(state, { limit: 1, offset: first.nextOffset! });
  assert.equal(second.nextOffset, null);
  assert.notEqual(first.warnings[0]!.code, second.warnings[0]!.code);
  assert.equal(lintProduct(state, { id: feature.id }).records, 1);
  assert.deepEqual(await service.state(), state);
});

test("хранение продукта: Markdown по строкам, миграция без потери текста, ревизий и повторов", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const repository = new ProductRepository(app.workspace);
  const text = "## Правила\r\n\r\n- Пункт  \r\n\n```js\n  пример\n```\n";
  const command: ProductMutation = {
    action: "create",
    requestId: "migration-feature",
    fields: {
      kind: "feature",
      name: "Миграция",
      summary: "Кратко\nВторая строка",
      description: text,
    },
  };
  const saved = await service.mutate(command, "agent");
  const target = join(repository.root, "features", `${saved.id}.json`);
  const stored = JSON.parse(await readFile(join(repository.root, "../entities/features", `${saved.id}.json`), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.data.description, text.split("\n"));
  assert.equal(stored.data.summary, "Кратко\nВторая строка");
  const original = (await repository.all())[0]!;
  const application = await service.mutate(
    {
      action: "create",
      requestId: "migration-app",
      fields: {
        kind: "application",
        slug: "server",
        name: "Сервер",
        summary: "",
        description: text,
        type: "backend",
      },
    },
    "agent",
  );
  const scope = await service.mutate(
    {
      action: "create",
      requestId: "migration-scope",
      ifVersion: (await service.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: saved.id,
            scenarioId: null,
            title: "Проверенный вклад",
            description: text,
            status: "done",
          },
        ],
      },
    },
    "agent",
  );
  const document = await service.mutate(
    {
      action: "create",
      requestId: "migration-doc",
      fields: {
        kind: "document",
        name: "Правила",
        summary: "",
        body: text,
        documentKind: "rules",
        links: [{ kind: "feature", id: saved.id }],
      },
    },
    "agent",
  );
  const scopeView = (await service.state()).records.find((entry) => entry.id === scope.id)!;
  assert.ok(scopeView.fields.kind === "scope");
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          repository.root,
          "../entities/implementations",
          `${scopeView.fields.contracts[0]!.id}.json`,
        ),
        "utf8",
      ),
    ).data.description,
    text.split("\n"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(repository.root, "../entities/documents", `${document.id}.json`), "utf8"))
      .data.body,
    text.split("\n"),
  );
  const legacy = join(repository.root, `${saved.id}.json`);
  await writeLegacyMigrationFixture(app.workspace);
  await rename(target, legacy);
  await writeFile(legacy, JSON.stringify(original));
  const before = await service.state();
  assert.equal((await new StorageService(app.workspace).migrate()).migrated, true);
  assert.deepEqual(await service.state(), before);
  assert.deepEqual(
    (await repository.all()).find((record) => record.id === saved.id),
    original,
  );
  assert.deepEqual(await service.mutate(command, "agent"), saved);
  assert.equal((await new StorageService(app.workspace).migrate()).migrated, false);
  // Сбой между заменой формата и переносом: новый кодек ещё в плоском каталоге.
  await writeLegacyMigrationFixture(app.workspace);
  await rename(target, legacy);
  await writeFile(legacy, JSON.stringify(encodeProduct(original)));
  assert.deepEqual(await service.state(), before);
  assert.equal((await new StorageService(app.workspace).migrate()).migrated, true);
  assert.deepEqual(await service.state(), before);
  // Дубликат не игнорируется и не перезаписывается миграцией.
  await writeLegacyMigrationFixture(app.workspace);
  await mkdir(repository.root, { recursive: true });
  await writeFile(legacy, JSON.stringify(original));
  await assert.rejects(service.state(), { code: "INVALID_DATA" });
});

test("миграция продукта сохраняет порядок и version при ID с разным регистром", async (t) => {
  const { workspace } = await legacyFixture(t);
  const repository = new ProductRepository(workspace);
  await mkdir(join(repository.root, "features"), { recursive: true });
  for (const [index, id] of ["Zed00001", "alpha001"].entries()) {
    await writeFile(join(repository.root, "features", `${id}.json`), JSON.stringify({
      version: 1, productId: repository.productId, id, key: `FEATURE-${index + 1}`, reservedKeys: [], revision: 1,
      fields: { kind: "feature", name: id, summary: "Кратко", description: "Текст\r\n" },
      createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z",
      createdBy: "agent", updatedBy: "agent", events: [], requests: {},
    }));
  }
  const service = new ProductQueries(workspace);
  const before = await service.state();
  assert.deepEqual(before.records.map((record) => record.id), ["Zed00001", "alpha001"]);
  await new StorageService(workspace).migrate();
  assert.deepEqual(await service.state(), before);
});

test("продукт: все участники, версии требований, история связей и атомарный состав", async (t) => {
  const app = await fixture(t);
  const service = new ProductQueries(app.workspace);
  const create = (fields: ProductMutation["fields"]) =>
    service.mutate({ action: "create", fields, requestId: randomUUID() }, "agent");
  assert.equal((await service.state()).records.length, 0);
  const feature = await create({
    kind: "feature",
    name: "Каталог",
    summary: "Товары",
    description: "## Каталог\n\nОбщие правила\n",
  });
  const scenario = await create({
    kind: "scenario",
    featureId: feature.id,
    name: "Поиск",
    description: "Найти товар",
  });
  const frontend = await create({
    kind: "application",
    slug: "web",
    name: "Web",
    summary: "Интерфейс",
    description: "Фронтенд",
    type: "frontend",
  });
  const backend = await create({
    kind: "application",
    slug: "api",
    name: "API",
    summary: "Данные",
    description: "Бэкенд",
    type: "backend",
  });
  const scope = async (applicationId: string, status: "done" | "partial") => {
    const state = await service.state();
    return service.mutate(
      {
        action: "create",
        requestId: randomUUID(),
        ifVersion: state.version,
        fields: {
          kind: "scope",
          applicationId,
          contracts: [
            {
              featureId: feature.id,
              scenarioId: null,
              title: "Общий вклад",
              description: "Правила приложения",
              status: "done",
            },
            {
              featureId: feature.id,
              scenarioId: scenario.id,
              title: "Поиск",
              description: "Своя реализация",
              status,
            },
          ],
        },
      },
      "agent",
    );
  };
  const webScope = await scope(frontend.id, "done");
  const apiScope = await scope(backend.id, "partial");
  let state = await service.state();
  assert.equal(state.readiness.find((entry) => entry.id === scenario.id)?.status, "none");
  assert.equal(state.readiness.find((entry) => entry.id === feature.id)?.status, "none");
  const apiRecord = state.records.find((record) => record.id === apiScope.id);
  assert.ok(apiRecord?.fields.kind === "scope");
  const readyCommand: ProductMutation = {
    action: "update",
    id: apiRecord.id,
    ifRevision: apiRecord.revision,
    ifVersion: state.version,
    requestId: randomUUID(),
    fields: {
      ...apiRecord.fields,
      contracts: apiRecord.fields.contracts.map(
        ({ id: _id, active: _active, basis: _basis, ...contract }) => ({
          ...contract,
          status: "done",
        }),
      ),
    },
  };
  const ready = await service.mutate(readyCommand, "agent");
  assert.deepEqual(await service.mutate(readyCommand, "agent"), ready);
  state = await service.state();
  assert.equal(state.readiness.find((entry) => entry.id === feature.id)?.status, "none");
  await assert.rejects(service.mutate({ ...readyCommand, requestId: randomUUID() }, "agent"), {
    code: "REVISION_CONFLICT",
  });
  await assert.rejects(service.mutate({ ...readyCommand, ifRevision: 100 }, "agent"), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const webRecord = state.records.find((record) => record.id === webScope.id);
  assert.ok(webRecord?.fields.kind === "scope");
  const contract = webRecord.fields.contracts.find((entry) => entry.scenarioId === scenario.id);
  assert.ok(contract);
  const document = await create({
    kind: "document",
    name: "ТЗ поиска",
    summary: "",
    body: "## Поиск\n\nСохранить  два пробела  \n",
    documentKind: "specification",
    links: [
      { kind: "scenario", id: scenario.id },
      { kind: "implementation", applicationId: frontend.id, id: contract.id },
    ],
  });
  const context = await service.context({ id: scenario.id, applicationId: frontend.id });
  assert.equal(context.records.filter((entry) => entry.record.id === document.id).length, 1);
  assert.equal(context.records.find((entry) => entry.record.id === document.id)?.reasons.length, 2);
  state = await service.state();
  const before = state.version;
  await assert.rejects(
    service.mutate(
      {
        action: "update",
        id: webRecord.id,
        ifRevision: webRecord.revision,
        ifVersion: state.version,
        requestId: randomUUID(),
        fields: {
          kind: "scope",
          applicationId: frontend.id,
          contracts: [
            {
              featureId: feature.id,
              scenarioId: scenario.id,
              title: "Без родителя",
              description: "Ошибка",
              status: "done",
            },
          ],
        },
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  assert.equal((await service.state()).version, before);
  await service.mutate(
    {
      action: "update",
      id: scenario.id,
      ifRevision: 1,
      requestId: randomUUID(),
      fields: {
        kind: "scenario",
        featureId: feature.id,
        name: "Поиск",
        description: "Поиск с опечатками",
      },
    },
    "agent",
  );
  state = await service.state();
  assert.equal(state.readiness.find((entry) => entry.id === scenario.id)?.stale, 0);
  assert.equal(state.readiness.find((entry) => entry.id === feature.id)?.status, "none");
  await service.mutate(
    {
      action: "update",
      id: webRecord.id,
      ifRevision: webRecord.revision,
      ifVersion: state.version,
      requestId: randomUUID(),
      fields: { kind: "scope", applicationId: frontend.id, contracts: [] },
    },
    "agent",
  );
  state = await service.state();
  const historical = state.records.find((entry) => entry.id === webRecord.id);
  assert.ok(historical?.fields.kind === "scope");
  assert.equal(
    historical.fields.contracts.find((entry) => entry.id === contract.id)?.active,
    false,
  );
  assert.ok(state.records.some((entry) => entry.id === document.id));
  assert.equal(
    (await new ProductQueries(app.workspace).list({ kind: "document", q: "два пробела" })).total,
    1,
  );
});

test("продукт: пустые наборы, конкурентная запись и изоляция областей", async (t) => {
  const left = new ProductQueries((await fixture(t)).workspace);
  const right = new ProductQueries((await fixture(t)).workspace);
  const command: ProductMutation = {
    action: "create",
    requestId: "passport-create",
    fields: {
      kind: "passport",
      name: "Продукт",
      summary: "Смысл",
      description: "## Цель\n\nМногострочный текст\n",
    },
  };
  const saved = await left.mutate(command, "agent");
  assert.deepEqual(await left.mutate(command, "agent"), saved);
  assert.equal((await right.state()).records.length, 0);
  const update = {
    ...command,
    action: "update" as const,
    id: saved.id,
    ifRevision: saved.revision,
  };
  const results = await Promise.allSettled([
    left.mutate({ ...update, requestId: "update-a" }, "a"),
    left.mutate({ ...update, requestId: "update-b" }, "b"),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  await assert.rejects(
    left.mutate(
      {
        action: "create",
        requestId: "bad-link",
        fields: {
          kind: "document",
          name: "Плохая ссылка",
          summary: "",
          body: "Текст",
          documentKind: "description",
          links: [{ kind: "feature", id: "feature_00000000000000000000000000000000" }],
        },
      },
      "agent",
    ),
    { code: "INVALID_REFERENCE" },
  );
  const feature = await left.mutate(
    {
      action: "create",
      requestId: "feature",
      fields: { kind: "feature", name: "Без сценариев", summary: "", description: "Описание" },
    },
    "agent",
  );
  assert.equal(
    (await left.state()).readiness.find((entry) => entry.id === feature.id)?.status,
    "none",
  );
});

test("точечное подтверждение не переподтверждает соседние контракты и переживает повтор", async (t) => {
  const service = new ProductQueries((await fixture(t)).workspace);
  const create = (fields: ProductMutation["fields"]) =>
    service.mutate({ action: "create", fields, requestId: randomUUID() }, "agent");
  const feature = await create({
    kind: "feature",
    name: "Фича",
    summary: "",
    description: "Версия 1",
  });
  const scenario = await create({
    kind: "scenario",
    featureId: feature.id,
    name: "Сценарий",
    description: "Шаг",
  });
  const application = await create({
    kind: "application",
    slug: "web",
    name: "Web",
    summary: "",
    description: "Интерфейс",
    type: "frontend",
  });
  const scope = await service.mutate(
    {
      action: "create",
      requestId: randomUUID(),
      ifVersion: (await service.state()).version,
      fields: {
        kind: "scope",
        applicationId: application.id,
        contracts: [
          {
            featureId: feature.id,
            scenarioId: null,
            title: "Общий вклад",
            description: "Общий",
            status: "done",
          },
          {
            featureId: feature.id,
            scenarioId: scenario.id,
            title: "Сценарий",
            description: "Частный",
            status: "done",
          },
        ],
      },
    },
    "agent",
  );
  await service.mutate(
    {
      action: "update",
      id: feature.id,
      ifRevision: 1,
      requestId: randomUUID(),
      fields: { kind: "feature", name: "Фича", summary: "", description: "Версия 2" },
    },
    "agent",
  );
  const state = await service.state();
  const record = state.records.find((entry) => entry.id === scope.id);
  assert.ok(record?.fields.kind === "scope");
  // Прежнее подтверждение сохраняется совместимо, но не заменяет прямые задачи.
  assert.ok(record.fields.contracts.every((entry) => entry.status === "none"));
  const scenarioContract = record.fields.contracts.find(
    (entry) => entry.scenarioId === scenario.id,
  );
  assert.ok(scenarioContract);
  const command: ProductMutation = {
    action: "update",
    ifRevision: scope.revision,
    ifVersion: state.version,
    requestId: "confirm-scenario",
    fields: {
      kind: "contract",
      applicationId: application.id,
      contractId: scenarioContract.id,
      status: "done",
    },
  };
  const saved = await service.mutate(command, "agent");
  assert.deepEqual(await service.mutate(command, "agent"), saved);
  const current = await service.state();
  assert.equal(current.readiness.find((entry) => entry.id === scenario.id)?.status, "none");
  assert.equal(current.readiness.find((entry) => entry.id === feature.id)?.status, "none");
  assert.equal(current.readiness.find((entry) => entry.id === feature.id)?.stale, 0);
  const context = await service.context({ id: scenarioContract.id });
  assert.ok(context.records.some((entry) => entry.record.id === scope.id));
});
