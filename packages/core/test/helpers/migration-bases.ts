/**
 * Базы для проверок исполнителя миграции (K6). Все базы — временные копии; замороженные
 * фикстуры разворачиваются побайтно и не меняются.
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { restoreFixtureTree } from "../fixtures/data-migrations/restore-tree.mjs";

export const FIXTURES = new URL("../fixtures/data-migrations/", import.meta.url).pathname;

export async function tempDir(t: TestContext, prefix = "relay-k6-"): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export type Base = { project: string; root: string; configPath: string };

/** Замороженная историческая база, развёрнутая побайтно во временный каталог. */
export async function frozenProject(t: TestContext, name: string): Promise<Base> {
  const project = await tempDir(t, `relay-k6-${name.slice(0, 16)}-`);
  await restoreFixtureTree(join(FIXTURES, name, "base.json.gz"), project);
  const root = join(project, ".relay");
  return { project, root, configPath: join(root, "config.json") };
}

/**
 * Профиль 1 формата 4 с данными планирования v1 (A05): замороженная база 43d683b, у которой
 * физическая раскладка 2 заменена форматом 4 без изменения данных. Единственные правки —
 * литерал оболочки записи 1 → 3 (поля оболочки 1 — подмножество 3), маркер schemaVersion 4,
 * удаление журнала history/ и производных индексов формата 2. Данные записей и отношений
 * остаются байтово прежними в части значений.
 */
export async function planV1Format4(t: TestContext): Promise<Base> {
  const base = await frozenProject(t, "physical2-plan-v1-43d683b");
  const { root } = base;
  for (const collection of await readdir(join(root, "entities"))) {
    const directory = join(root, "entities", collection);
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (raw.schemaVersion !== 1) throw new Error(`Ожидалась оболочка 1: ${path}`);
      raw.schemaVersion = 3;
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, "storage.json"), "utf8"));
  await writeFile(
    join(root, "storage.json"),
    `${JSON.stringify({ ...manifest, schemaVersion: 4 }, null, 2)}\n`,
  );
  await rm(join(root, "history"), { recursive: true, force: true });
  await rm(join(root, "runtime/history-writer.json"), { force: true });
  await rm(join(root, ".indexes/segments"), { recursive: true, force: true });
  await rm(join(root, ".indexes/state.json"), { force: true });
  return base;
}

/** Хеши всего дерева: файл → sha256, каталог → "dir", symlink → цель. */
export async function treeHashes(
  directory: string,
  skip: (path: string) => boolean = () => false,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (relative: string) => {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (skip(path)) continue;
      const absolute = join(directory, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) result.set(path, `link:${await readlink(absolute)}`);
      else if (info.isDirectory()) {
        result.set(path, "dir");
        await visit(path);
      } else
        result.set(
          path,
          createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex"),
        );
    }
  };
  await visit("");
  return result;
}

/** Постоянный набор базы: без временного runtime (замок, отметки обслуживания). */
export const persistent = (path: string) => path === "runtime" || path.startsWith("runtime/");

export function diffTrees(before: Map<string, string>, after: Map<string, string>) {
  const changed: string[] = [];
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(`-${path}`);
  return changed.sort();
}

export async function readJsonFile<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

let backupRoot: string | undefined;
/**
 * Каталог резервной копии для изменяющей миграции в тестах вне K6: новый временный каталог
 * вне базы; общий корень удаляется при завершении процесса.
 */
export async function migrationBackupDir(): Promise<string> {
  if (!backupRoot) {
    backupRoot = await realpath(await mkdtemp(join(tmpdir(), "relay-test-backups-")));
    const created = backupRoot;
    process.once("exit", () => rmSync(created, { recursive: true, force: true }));
  }
  return realpath(await mkdtemp(join(backupRoot, "backup-")));
}
