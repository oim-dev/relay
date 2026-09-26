import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { z } from "zod";
import { Workspace } from "../../src/storage/workspace.js";
import { defaultConfig } from "../../src/domain/config.js";
import { EntityStore } from "../../src/storage/entity-store/store.js";
import { EntityStorageRegistry } from "../../src/storage/entity-store/registry.js";
import { jsonValue } from "../../src/storage/entity-store/format.js";
import { withStorageLock } from "../../src/storage/lock.js";
import type { GraphNode } from "../../src/domain/entity-graph.js";

/** Изолированный v3-граф: каждый узел каталога действительно сохранён зарегистрированным кодеком. */
export async function graphFixture(t: TestContext, nodes: readonly GraphNode[]) {
  const root = await mkdtemp(join(tmpdir(), "relay-graph-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, ".relay");
  const config = { ...structuredClone(defaultConfig), projectId: "GraphPrj" };
  const registry = new EntityStorageRegistry([...new Set(["project", ...nodes.map((node) => node.ref.kind)])].map((kind) => ({
    kind, collection: `${kind}s`, dataVersion: 1, addressable: kind !== "project",
    schema: z.strictObject({ title: z.string(), status: z.string() }),
    encode: (data) => jsonValue(data) as Record<string, ReturnType<typeof jsonValue>>,
    decode: (data) => data,
    card: (record) => ({ title: String(record.data.title), status: String(record.data.status), selectors: [] }),
  })));
  const store = await EntityStore.create(storage, registry);
  await writeFile(join(storage, "config.json"), JSON.stringify(config));
  class GraphWorkspace extends Workspace {
    override async withEntityStorage<T>(operation: (store: EntityStore, owned: () => void) => Promise<T>): Promise<T> {
      const active = this.storageSession;
      if (active) return super.locked((owned) => operation(active.store, owned));
      return withStorageLock(storage, async (owned) => operation(await EntityStore.underLock(storage, registry, owned), owned), join(storage, "runtime"));
    }
    override async locked<T>(operation: (owned: () => void) => Promise<T>): Promise<T> {
      if (this.storageSession) return super.locked(operation);
      return this.withEntityStorage((current, owned) => current.transaction(owned, (session) =>
        this.inStorageSession(session, owned, () => operation(owned))));
    }
  }
  const reopen = () => new GraphWorkspace(join(storage, "config.json"), storage, config);
  const workspace = reopen();
  await workspace.locked(async () => {
    const tx = workspace.storageSession!;
    const at = "2026-09-26T00:00:00.000Z";
    for (const node of [...nodes, { ref: { kind: "project", id: config.projectId }, key: null, title: "Владелец графа", status: "", revision: 1 }])
      await tx.put({ schemaVersion: 2, dataVersion: 1, ...node.ref, key: node.key ?? null, aliases: [], revision: node.revision,
        createdAt: at, updatedAt: at, createdBy: "agent", updatedBy: "agent", data: { title: node.title, status: node.status ?? "" } }, null);
  });
  return { root, storage, workspace, store, registry, reopen };
}
