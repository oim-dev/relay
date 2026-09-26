import { dirname, join } from "node:path";
import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson, exists, readJson, syncDirectory } from "./files.js";
import { GRAPH_INDEX_BYTES, GRAPH_RECORD_BYTES, graphDigest } from "./graph-format.js";
import { invariant } from "../shared/errors.js";
import { parse } from "../domain/validation.js";
import type { Workspace } from "./workspace.js";
import { activityFileSchema, TaskActivityRepository } from "./task-activity.js";
import type { ActivityFile } from "./task-activity.js";
import { DocumentLinksRepository, documentLinksPendingSchema } from "./document-links.js";

const pathSchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.json$/)
  .refine((value) => !value.split("/").some((part) => part === ".." || part === "."));
const changeSchema = z.strictObject({
  path: pathSchema,
  before: z.string().nullable(),
  after: z.unknown(),
});
const pendingSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  changes: z.array(changeSchema),
  activity: z.array(activityFileSchema).default([]),
  documentCheckpoint: z
    .strictObject({ before: z.string(), after: documentLinksPendingSchema })
    .optional(),
});
export type GraphFileChange = { path: string; after: unknown };
const MAX_TRANSACTION_BYTES = 128 * 1024 * 1024;

/** Атомарная видимость без индивидуального fsync: допустима под долговечным WAL или для кеша. */
export async function publishGraphJson(
  path: string,
  value: unknown,
  workspace: Workspace,
  assertOwned: () => void,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(workspace.runtime, `${randomUUID()}.json`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    } finally {
      await handle.close();
    }
    assertOwned();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Ограниченное число параллельных файловых операций без остановки уже начатых при отказе. */
export async function graphParallel<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += 16) {
    const results = await Promise.allSettled(items.slice(index, index + 16).map(operation));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

/** Долговечная запись связанных файлов под общей блокировкой; метаданные публикуются последними. */
export class GraphTransaction {
  readonly root: string;
  readonly pending: string;
  constructor(readonly workspace: Workspace) {
    this.root = join(dirname(workspace.configPath), "relations");
    this.pending = join(this.root, "transactions", "pending.json");
  }
  async publish(
    changes: GraphFileChange[],
    assertOwned: () => void,
    activity: ActivityFile[] = [],
    documentCheckpoint?: z.infer<typeof pendingSchema>["documentCheckpoint"],
  ): Promise<void> {
    new TaskActivityRepository(this.workspace).validate(activity);
    invariant(
      !(await exists(this.pending)),
      "INVALID_DATA",
      "Не восстановлена предыдущая транзакция графа",
      5,
    );
    invariant(
      new Set(changes.map((change) => change.path)).size === changes.length,
      "INVALID_DATA",
      "Пакет графа содержит повтор пути",
      5,
    );
    const prepared: z.infer<typeof changeSchema>[] = [];
    for (const change of changes) {
      pathSchema.parse(change.path);
      const limit = change.path.startsWith(".indexes/") ? GRAPH_INDEX_BYTES : GRAPH_RECORD_BYTES;
      invariant(
        Buffer.byteLength(JSON.stringify(change.after, null, 2) + "\n") <= limit,
        "RESPONSE_TOO_LARGE",
        `Запись графа ${change.path} превышает лимит отдельного файла; пакет не записан`,
        4,
      );
      const path = join(this.root, change.path);
      let before: string | null = null;
      if (await exists(path)) {
        try {
          before = graphDigest(await readJson(path, limit));
        } catch (error) {
          if (!change.path.startsWith(".indexes/")) throw error;
        }
      }
      prepared.push({ ...change, before });
    }
    // Канонические файлы проверяются полностью до первой публикации. Индексы производны.
    const transaction = pendingSchema.parse({
      schemaVersion: 2,
      changes: prepared,
      activity,
      documentCheckpoint,
    });
    invariant(
      Buffer.byteLength(JSON.stringify(transaction, null, 2) + "\n") <= MAX_TRANSACTION_BYTES,
      "RESPONSE_TOO_LARGE",
      "Пакет графа превышает 128 МиБ; уменьшите число операций",
      4,
    );
    await mkdir(dirname(this.pending), { recursive: true });
    await syncDirectory(this.root);
    await syncDirectory(dirname(this.root));
    await atomicJson(this.pending, transaction, this.workspace.runtime, true, assertOwned);
    await this.recover(assertOwned);
  }
  async recover(assertOwned: () => void): Promise<void> {
    if (!(await exists(this.pending))) return;
    const transaction = parse(
      pendingSchema,
      await readJson(this.pending, MAX_TRANSACTION_BYTES),
      this.pending,
      true,
    );
    const apply = async (change: z.infer<typeof changeSchema>) => {
      const path = join(this.root, change.path);
      const derived = change.path.startsWith(".indexes/");
      let actual: string | null = null;
      if (await exists(path)) {
        try {
          actual = graphDigest(
            await readJson(path, derived ? GRAPH_INDEX_BYTES : GRAPH_RECORD_BYTES),
          );
        } catch (error) {
          if (!derived) throw error;
        }
      }
      const expected = graphDigest(change.after);
      if (actual === expected) return;
      invariant(
        derived || actual === change.before,
        "GRAPH_RECOVERY_CONFLICT",
        "Файл графа изменён вне прерванной транзакции. Восстановление остановлено.",
        5,
        { path: change.path },
      );
      await publishGraphJson(path, change.after, this.workspace, assertOwned);
    };
    // Сначала проверяем все исходные канонические состояния, чтобы не затирать чужую правку.
    const documents = new DocumentLinksRepository(this.workspace);
    if (transaction.documentCheckpoint) {
      const actual = await documents.readPending();
      invariant(
        actual &&
          (graphDigest(actual) === transaction.documentCheckpoint.before ||
            graphDigest(actual) === graphDigest(transaction.documentCheckpoint.after)),
        "DOCUMENT_LINK_RECOVERY_CONFLICT",
        "Намерение прикрепления изменилось вне WAL",
        5,
      );
    }
    for (const change of transaction.changes.filter(
      (entry) => !entry.path.startsWith(".indexes/"),
    )) {
      const path = join(this.root, change.path);
      const actual = (await exists(path))
        ? graphDigest(await readJson(path, GRAPH_RECORD_BYTES))
        : null;
      invariant(
        actual === change.before || actual === graphDigest(change.after),
        "GRAPH_RECOVERY_CONFLICT",
        "Файл графа изменён вне прерванной транзакции. Восстановление остановлено.",
        5,
        { path: change.path },
      );
    }
    await graphParallel(
      transaction.changes.filter((change) => change.path !== "meta.json"),
      apply,
    );
    for (const change of transaction.changes.filter((entry) => entry.path === "meta.json"))
      await apply(change);
    await new TaskActivityRepository(this.workspace).publish(transaction.activity, assertOwned);
    if (transaction.documentCheckpoint)
      await documents.writePending(transaction.documentCheckpoint.after, assertOwned);
    // WAL остаётся до fsync всех канонических файлов и каталогов, включая уже опубликованные
    // до прерывания. Кеши можно потерять: их контрольные суммы/счётчики запускают восстановление.
    const canonical = transaction.changes.filter((change) => !change.path.startsWith(".indexes/"));
    await graphParallel(canonical, async (change) => {
      const handle = await open(join(this.root, change.path), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    const directories = new Set<string>();
    for (const change of canonical) {
      let directory = dirname(join(this.root, change.path));
      while (directory !== dirname(this.root)) {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
    // Нижние каталоги закрепляются перед родительскими ссылками на них.
    for (const depth of [
      ...new Set([...directories].map((directory) => directory.split("/").length)),
    ].sort((a, b) => b - a))
      await graphParallel(
        [...directories].filter((directory) => directory.split("/").length === depth),
        syncDirectory,
      );
    assertOwned();
    await unlink(this.pending);
    await syncDirectory(dirname(this.pending));
  }
}
