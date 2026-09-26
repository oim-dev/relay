import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@relay/core/domain/config";
import { boardTaskRecordSchema } from "@relay/core/domain/board-task";
import type { FullContext } from "@relay/core/domain/entity-graph";
import { failed, invoke, invokeRaw, successful } from "./helpers/cli.js";

test("CLI хранилища: явный перенос, читаемый повтор и восстановление потерянных индексов", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-storage-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Прежний формат задаётся файлами: актуальный Core создаёт только v3 и запрещает legacy-записи.
  const at = "2026-09-26T00:00:00.000Z";
  await mkdir(join(root, ".relay/boards/product/tasks"), { recursive: true });
  await writeFile(
    join(root, ".relay/config.json"),
    JSON.stringify({
      ...structuredClone(defaultConfig),
      projectId: "Legacy01",
      storageDir: "tasks",
      projectSettings: { version: 1, name: "Legacy", slug: "legacy", revision: 1 },
    }),
  );
  await writeFile(
    join(root, ".relay/boards/product/board.json"),
    JSON.stringify({
      version: 1,
      id: "board_product",
      slug: "product",
      prefix: "PRODUCT",
      kind: "product",
      applicationId: null,
      revision: 1,
      createdAt: at,
      createdBy: "relay",
    }),
  );
  const task = boardTaskRecordSchema.parse({
    version: 4,
    id: "LegacyT1",
    key: "PRODUCT-1",
    keys: ["PRODUCT-1"],
    boardId: "board_product",
    title: "Сохранить данные",
    description: "Текст\r\n\n  пробелы  \n",
    productLinks: [],
    column: "inbox",
    rank: 1,
    revision: 1,
    dependencies: [],
    related: [],
    parentId: null,
    acceptanceCriteria: [],
    requests: {},
    events: [],
    createdAt: at,
    updatedAt: at,
    createdBy: "agent",
    updatedBy: "agent",
  });
  const legacyPath = join(root, ".relay/boards/product/tasks", `${task.id}.json`);
  const original = JSON.stringify({ ...task, description: task.description.split("\n") });
  await writeFile(legacyPath, original);
  failed(
    await invoke(root, [
      "--local",
      "task",
      "update",
      task.id,
      "--title",
      "Не записывать",
      "--if-revision",
      "1",
    ]),
    "STORAGE_MIGRATION_REQUIRED",
    4,
  );
  assert.equal(await readFile(legacyPath, "utf8"), original);
  const migrated = successful(
    await invoke<{ migrated: boolean }>(root, ["--local", "storage", "migrate"]),
  );
  assert.equal(migrated.data.migrated, true);
  const path = join(root, ".relay/entities/tasks", `${task.id}.json`);
  assert.equal(JSON.parse(await readFile(path, "utf8")).data.title, "Сохранить данные");
  assert.equal(
    JSON.parse(await readFile(join(root, ".relay/storage.json"), "utf8")).schemaVersion,
    3,
  );
  const restored = successful(
    await invoke<{ description: string }>(root, ["task", "get", task.id]),
  ).data;
  assert.equal(restored.description, task.description);
  const repeated = await invokeRaw(root, ["--local", "storage", "migrate"]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /Перенос не требуется/);
  assert.doesNotMatch(repeated.stdout, /"migrated"/);
  await rm(join(root, ".relay/.indexes"), { recursive: true, force: true });
  const rebuilt = await invokeRaw(root, ["--local", "storage", "reindex"]);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /Индексы единого хранилища восстановлены/);
  const context = successful(await invoke<FullContext>(root, ["graph", "context", task.key])).data;
  assert.equal(context.complete, true);
  assert.equal(context.nodes.length, 2);
  assert.equal(context.edges.length, 1);
  const command = ["--local", "storage", "reconcile-relations", "--request-id", "relations"];
  const repaired = successful(
    await invoke<{ added: number; updated: number; removed: number }>(root, command),
  );
  assert.deepEqual(repaired.data, { added: 0, updated: 0, removed: 0, requestId: "relations" });
  const human = await invokeRaw(root, command);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Предметные связи согласованы/);
  assert.match(human.stdout, /Добавлено: 0/);
  assert.doesNotMatch(human.stdout, /"added"/);
});
