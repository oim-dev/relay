/**
 * Временные базы для диагностического reader (A13/A14/A16/A17). Строятся тестом во
 * временном каталоге; рабочая база не используется.
 */
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { defaultConfig } from "@relay/core/domain/config";
import { restoreFixtureTree } from "../fixtures/data-migrations/restore-tree.mjs";

export async function temporaryDirectory(
  t: TestContext,
  prefix = "relay-source-",
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Текущая база, созданная production-инициализацией; возвращает каталог проекта и корень базы. */
export async function unifiedBase(t: TestContext): Promise<{ project: string; root: string }> {
  const project = await temporaryDirectory(t);
  await initialize(project, "tasks");
  return { project, root: join(project, ".relay") };
}

/**
 * Замороженная историческая база (`test/fixtures/data-migrations/<name>`), развёрнутая
 * побайтно во временный каталог. Исходный снимок не меняется.
 */
export async function frozenBase(
  t: TestContext,
  name: string,
): Promise<{ project: string; root: string }> {
  const project = await temporaryDirectory(t, "relay-frozen-source-");
  await restoreFixtureTree(
    new URL(`../fixtures/data-migrations/${name}/base.json.gz`, import.meta.url).pathname,
    project,
  );
  return { project, root: join(project, ".relay") };
}

/** Копия базы в новом временном каталоге (замороженные фикстуры копируются так же). */
export async function copyBase(t: TestContext, root: string): Promise<string> {
  const target = join(await temporaryDirectory(t), ".relay");
  await cp(root, target, { recursive: true, verbatimSymlinks: true });
  return target;
}

export async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function setManifest(root: string, patch: Record<string, unknown | undefined>) {
  const manifest = await readJsonFile(join(root, "storage.json"));
  for (const [key, value] of Object.entries(patch))
    if (value === undefined) delete manifest[key];
    else manifest[key] = value;
  await writeJsonFile(join(root, "storage.json"), manifest);
}

/**
 * Legacy-раскладка: конфигурация старой формы и доски прежнего репозитория.
 * Конфигурация содержит поля, которые текущая схема проекта отвергает.
 */
export async function legacyBase(t: TestContext): Promise<{ project: string; root: string }> {
  const project = await temporaryDirectory(t, "relay-legacy-source-");
  const root = join(project, ".relay");
  await writeJsonFile(join(root, "config.json"), {
    ...structuredClone(defaultConfig),
    projectId: "Legacy01",
    storageDir: "tasks",
    projectSettings: { version: 1, name: "Legacy", slug: "legacy", revision: 1 },
  });
  for (const kind of ["product", "infrastructure"] as const)
    await writeJsonFile(join(root, "boards", kind, "board.json"), {
      version: 1,
      id: `board_${kind}`,
      slug: kind,
      prefix: kind === "product" ? "PRODUCT" : "INFRA",
      kind,
      applicationId: null,
      revision: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
      createdBy: "relay",
    });
  return { project, root };
}

/**
 * Снимок всего дерева: путь → sha256 файла, "dir" или цель symlink. Используется для
 * побайтовой проверки, что диагностика ничего не создала, не изменила и не удалила.
 */
export async function treeHashes(base: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (path: string) => {
    const absolute = path ? join(base, path) : base;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) result.set(path, `symlink:${await readlink(absolute)}`);
    else if (info.isDirectory()) {
      if (path) result.set(path, "dir");
      for (const name of (await readdir(absolute)).sort())
        await visit(path ? `${path}/${name}` : name);
    } else
      result.set(
        path,
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      );
  };
  await visit("");
  return result;
}
