import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { EntityStore } from "../src/storage/entity-store/store.js";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import { digest } from "../src/storage/entity-store/format.js";
import { migrateStorage } from "../src/application/storage/maintenance.js";
import { migrationBackupDir } from "./helpers/migration-bases.js";
import { defaultConfig } from "../src/domain/config.js";

for (const interrupted of [false, true])
  test(`orphan audit удаляется без allowlist и без восстановления плана; WAL=${interrupted}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relay-orphan-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const at = "2026-09-26T00:00:00.000Z";
    const path = "operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json";
    const operation = {
      schemaVersion: 1,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      at,
      actor: "agent",
      namespace: "planning",
      requestId: "old",
      requestHash: "old",
      result: { id: "missing" },
      refs: [{ kind: "work-plan", id: "missing" }],
      changes: [],
      events: [
        {
          kind: "indexed",
          index: "record-audit",
          key: "work-plan:missing:event:old",
          groups: [],
          value: { type: "event", value: { revision: 1, actor: "agent", at, action: "create" } },
        },
      ],
    };
    const leaf = { schemaVersion: 1, type: "leaf", entries: [[path, digest(operation)]] };
    const hash = digest(leaf);
    const put = async (path: string, value: unknown) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(value));
    };
    await put(path, operation);
    await put(`.indexes/segments/${hash.slice(0, 2)}/${hash}.json`, leaf);
    await put(".indexes/state.json", {
      schemaVersion: 1,
      version: "old",
      roots: { "file-hashes": hash },
    });
    await put("storage.json", { format: "relay-entities", schemaVersion: 1 });
    // Итог переноса должен открываться обычным Workspace: конфигурация по текущей схеме
    // и действующая запись проекта, на которую указывает её projectId.
    await put("config.json", { ...defaultConfig, projectId: "Project1" });
    await put("entities/projects/Project1.json", {
      schemaVersion: 1,
      dataVersion: 1,
      kind: "project",
      id: "Project1",
      key: "PROJECT",
      aliases: [],
      revision: 1,
      createdAt: at,
      createdBy: "agent",
      updatedAt: at,
      updatedBy: "agent",
      data: { name: "Проект", slug: "project" },
    });
    const target = { configPath: join(root, "config.json") };
    const backupDir = await migrationBackupDir();
    if (interrupted) {
      await assert.rejects(
        migrateStorage(
          target,
          { backupDir },
          {
            probe: (stage) => {
              if (stage === "intent") throw new Error("Сбой");
            },
          },
        ),
        /Сбой/,
      );
      // Продолжение из WAL выполняет исполнитель миграции, не обычное открытие.
      assert.equal((await migrateStorage(target)).resumed, true);
    } else await migrateStorage(target, { backupDir });
    const reopened = await EntityStore.open(root, workspaceStorageRegistry());
    assert.equal(reopened.formatVersion, 4);
    await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
    await assert.rejects(reopened.get({ kind: "work-plan", id: "missing" }), {
      code: "ENTITY_NOT_FOUND",
    });
    assert.deepEqual(
      (await reopened.read((tx) => tx.indexEntries("records"))).map(([key]) => key),
      ["project:Project1"],
    );
    assert(!(await readdir(join(root, "transactions"))).includes("pending.json"));
  });
