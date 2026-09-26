import { dirname, join } from "node:path";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { entityDeletedSchema } from "@relay/contracts/entities";
import { atomicJson, exists, readJson, syncDirectory } from "./files.js";
import { invariant } from "../shared/errors.js";
import { forgetGraphIndex } from "./graph-index.js";
import type { Workspace } from "./workspace.js";

const pathSchema = z
  .string()
  .refine(
    (path) =>
      /^(product|boards|task-activity|relations|entity-deletions)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(
        path,
      ) && !path.split("/").some((part) => part === ".." || part === "."),
  );
const directorySchema = z.string().regex(/^boards\/[a-z0-9-]+$/);
const receiptSchema = z.strictObject({ hash: z.string(), result: entityDeletedSchema });
const transactionSchema = z.strictObject({
  version: z.literal(1),
  changes: z.array(
    z.strictObject({ path: pathSchema, before: z.string().nullable(), after: z.unknown() }),
  ),
  directories: z.array(directorySchema),
});

/** Файл общей операции; null означает удаление, остальные значения — готовый дисковый JSON. */
export type DeletionFile = { path: string; after: unknown };

/** Отпечаток дискового значения для защиты восстановления от внешних изменений. */
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Удаляет только пустое дерево каталогов; неизвестные файлы не уничтожаются. */
const removeEmptyTree = async (path: string, owned: () => void): Promise<void> => {
  if (!(await exists(path))) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    invariant(
      entry.isDirectory(),
      "DELETION_RECOVERY_CONFLICT",
      "В удаляемой доске появился неизвестный файл",
      5,
    );
    await removeEmptyTree(join(path, entry.name), owned);
  }
  owned();
  await rmdir(path);
  await syncDirectory(dirname(path));
};

/** Общий WAL удаления: восстанавливается до чтений всех владельцев и сохраняет квитанции отдельно. */
export class EntityDeletionRepository {
  readonly root: string;
  readonly pending: string;
  constructor(readonly workspace: Workspace) {
    this.root = dirname(workspace.configPath);
    this.pending = join(this.root, "entity-deletions", "pending.json");
  }

  async receipt(key: string) {
    invariant(/^[a-f0-9]{64}$/.test(key), "INVALID_DATA", "Неверный адрес квитанции", 5);
    if (this.workspace.storageSession) {
      const value = await this.workspace.storageSession.compatibilityReceipt("deletion-receipt", key);
      return value === undefined ? undefined : receiptSchema.parse(value);
    }
    const path = join(this.root, "entity-deletions", "receipts", `${key}.json`);
    return (await exists(path)) ? receiptSchema.parse(await readJson(path)) : undefined;
  }

  /** Удалённые адреса не передаются новым сущностям и не оживляют старые ссылки. */
  async reservedKeys(): Promise<string[]> {
    if (this.workspace.storageSession) {
      const output = new Set(
        (await this.workspace.storageSession.indexEntries("reserved-key")).map(([key]) => key),
      );
      for (const [key, value] of await this.workspace.storageSession.indexEntries("addresses")) {
        const entries = z
          .array(z.object({ deleted: z.boolean(), matches: z.array(z.string()) }))
          .parse(value);
        if (entries.some((entry) => entry.deleted && entry.matches.some((match) => match !== "id")))
          output.add(key);
      }
      return [...output];
    }
    const path = join(this.root, "entity-deletions", "keys.json");
    return (await exists(path))
      ? z.array(z.string()).parse(await readJson(path, 16 * 1024 * 1024))
      : [];
  }

  /** Возвращает только известные JSON-файлы удаляемого дерева. */
  async files(directory: string): Promise<DeletionFile[]> {
    invariant(
      /^(boards|task-activity|product)\/(?:[A-Za-z0-9_-]+\/?)+$/.test(directory),
      "INVALID_DATA",
      "Неверный каталог удаления",
      5,
    );
    const path = join(this.root, directory);
    if (!(await exists(path))) return [];
    const files: DeletionFile[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await this.files(relative)));
      else {
        invariant(entry.isFile(), "INVALID_DATA", "Неподдерживаемый файл в удаляемой сущности", 5);
        pathSchema.parse(relative);
        files.push({ path: relative, after: null });
      }
    }
    return files;
  }

  async publish(files: DeletionFile[], directories: string[], owned: () => void): Promise<void> {
    invariant(
      !(await exists(this.pending)),
      "INVALID_DATA",
      "Не восстановлено предыдущее удаление",
      5,
    );
    const changes = [];
    for (const file of files) {
      pathSchema.parse(file.path);
      const path = join(this.root, file.path);
      const before = (await exists(path)) ? digest(await readJson(path, 64 * 1024 * 1024)) : null;
      if ((file.after === null ? null : digest(file.after)) === before) continue;
      changes.push({ ...file, before });
    }
    invariant(
      new Set(changes.map((change) => change.path)).size === changes.length,
      "INVALID_DATA",
      "Повтор файла удаления",
      5,
    );
    const transaction = transactionSchema.parse({ version: 1, changes, directories });
    invariant(
      Buffer.byteLength(JSON.stringify(transaction, null, 2)) < 128 * 1024 * 1024,
      "RESPONSE_TOO_LARGE",
      "Удаление превышает 128 МиБ; удалите дочерние записи отдельно",
      4,
    );
    await atomicJson(this.pending, transaction, this.workspace.runtime, true, owned);
    await syncDirectory(this.root);
    await this.recover(owned);
  }

  async recover(owned: () => void): Promise<void> {
    if (!(await exists(this.pending))) return;
    const transaction = transactionSchema.parse(await readJson(this.pending, 128 * 1024 * 1024));
    for (const change of transaction.changes) {
      const path = join(this.root, change.path);
      const actual = (await exists(path)) ? digest(await readJson(path, 64 * 1024 * 1024)) : null;
      const expected = change.after === null ? null : digest(change.after);
      if (actual === expected) continue;
      invariant(
        actual === change.before,
        "DELETION_RECOVERY_CONFLICT",
        "Файл изменён вне незавершённого удаления; восстановление остановлено",
        5,
        { path: change.path },
      );
      owned();
      if (change.after === null) {
        await unlink(path);
        await syncDirectory(dirname(path));
      } else {
        await atomicJson(path, change.after, this.workspace.runtime, false, owned);
        let directory = dirname(path);
        while (directory !== this.root) {
          await syncDirectory(directory);
          directory = dirname(directory);
        }
        await syncDirectory(this.root);
      }
    }
    for (const directory of transaction.directories)
      await removeEmptyTree(join(this.root, directory), owned);
    forgetGraphIndex(join(this.root, "relations"));
    owned();
    await unlink(this.pending);
    await syncDirectory(dirname(this.pending));
  }
}
