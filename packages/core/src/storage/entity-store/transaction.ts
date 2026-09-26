import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicJson, exists, readJson, syncDirectory } from "../files.js";
import { invariant, isErrno } from "../../shared/errors.js";
import {
  WAL_BYTES,
  RECORD_BYTES,
  digest,
  jsonValue,
  relativePathSchema,
  hashSchema,
  checkSize,
} from "./format.js";
import type { FileChange } from "./format.js";

const intentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  changes: z.array(
    z.strictObject({
      path: relativePathSchema,
      before: hashSchema.nullable(),
      after: z.json().nullable(),
    }),
  ),
});
export type TransactionStage = "intent" | "file" | "published";
export type TransactionProbe = (stage: TransactionStage, path?: string) => void | Promise<void>;

/** Прежний бюджет предметной записи не ограничивает накопленные inline-квитанции и ленты. */
function budgetValue(path: string, value: ReturnType<typeof jsonValue>) {
  if (path.startsWith("entities/") && value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 2) {
    const { receipts: _receipts, comments: _comments, planningEvents: _events, ...data } = value as Record<string, unknown>;
    return jsonValue(data);
  }
  return value;
}

/** Ошибка ожидает завершения всех уже начатых записей до освобождения блокировки. */
async function parallel<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let position = 0;
  let failure: unknown;
  let failed = false;
  const workers = Array.from({ length: Math.min(16, items.length) }, async () => {
    while (!failed) {
      const index = position++;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index]!);
      } catch (error) {
        failed = true;
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

/** Общий WAL. Вызывающий держит блокировку базы до окончания публикации и восстановления. */
export class StorageTransaction {
  readonly pending: string;
  readonly runtime: string;
  constructor(
    readonly root: string,
    readonly probe?: TransactionProbe,
  ) {
    this.pending = join(root, "transactions/pending.json");
    this.runtime = join(root, "runtime");
  }

  async prepareDirectories() {
    for (const name of ["runtime", "transactions", ".indexes"]) {
      const directory = join(this.root, name);
      await this.ensureDirectory(directory);
      await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" }).catch(
        (error: unknown) => {
          if (!isErrno(error, "EEXIST")) throw error;
        },
      );
    }
  }

  private async ensureDirectory(path: string) {
    const first = await mkdir(path, { recursive: true });
    if (!first) return;
    // fsync файла и его каталога недостаточен, если не закреплена новая цепочка каталогов.
    let current = path;
    while (true) {
      await syncDirectory(current);
      if (current === dirname(first)) break;
      current = dirname(current);
    }
  }

  private async hash(path: string) {
    return (await exists(path)) ? digest(jsonValue(await readJson(path, Number.POSITIVE_INFINITY))) : null;
  }

  /** Подготовка производных неизменяемых страниц; видимость меняет только публикация корней. */
  async stageIndexes(changes: readonly FileChange[], owned: () => void): Promise<void> {
    await parallel(changes, async (change) => {
      const match = /^\.indexes\/segments\/([a-f0-9]{2})\/([a-f0-9]{64})\.json$/.exec(change.path);
      invariant(
        match &&
          match[1] === match[2]!.slice(0, 2) &&
          change.after !== null &&
          digest(change.after) === match[2],
        "INVALID_DATA",
        "Неверная неизменяемая страница индекса",
        5,
      );
      const path = join(this.root, change.path);
      await this.ensureDirectory(dirname(path));
      await atomicJson(path, change.after, this.runtime, false, owned);
    });
  }

  async publish(changes: readonly FileChange[], owned: () => void): Promise<void> {
    invariant(
      !(await exists(this.pending)),
      "STORAGE_RECOVERY_REQUIRED",
      "Сначала восстановите незавершённую операцию хранилища",
      5,
    );
    const paths = new Set<string>();
    for (const change of changes) {
      relativePathSchema.parse(change.path);
      invariant(
        !paths.has(change.path) &&
          !change.path.startsWith("transactions/") &&
          !change.path.startsWith("runtime/"),
        "INVALID_DATA",
        "Повторный или служебный путь в операции",
        5,
      );
      paths.add(change.path);
      if (change.after !== null) checkSize(budgetValue(change.path, change.after), RECORD_BYTES, "Предметные данные записи превышают 16 МиБ");
    }
    const candidates = await parallel(changes, async (change) => {
      const before = await this.hash(join(this.root, change.path));
      invariant(
        change.before === undefined || change.before === before,
        "STORAGE_WRITE_CONFLICT",
        "Файл изменён вне Core после чтения; запись остановлена",
        5,
        { path: change.path },
      );
      const after = change.after === null ? null : digest(change.after);
      // Явная before-проверка остаётся в WAL даже без изменения значения.
      // В частности, before:null/after:null защищает подтверждённое отсутствие файла
      // при recovery, но никогда не разрешает удалить появившийся чужой файл.
      return before !== after || change.before !== undefined ? { ...change, before } : undefined;
    });
    const prepared = candidates.filter((change) => change !== undefined);
    if (!prepared.length) return;
    const intent = intentSchema.parse({ schemaVersion: 1, changes: prepared });
    checkSize({ ...intent, changes: intent.changes.map((change) => ({ ...change, after: budgetValue(change.path, change.after) })) }, WAL_BYTES, "Предметные данные пакета публикации превышают 128 МиБ");
    owned();
    await this.ensureDirectory(dirname(this.pending));
    await atomicJson(this.pending, intent, this.runtime, true, owned);
    await this.probe?.("intent");
    await this.recover(owned);
  }

  async recover(owned: () => void): Promise<void> {
    if (!(await exists(this.pending))) return;
    const intent = intentSchema.parse(await readJson(this.pending, Number.POSITIVE_INFINITY));
    const paths = new Set<string>();
    // Проверяем весь пакет прежде, чем менять хотя бы один файл при восстановлении.
    for (const change of intent.changes) {
      invariant(
        !paths.has(change.path) &&
          !change.path.startsWith("transactions/") &&
          !change.path.startsWith("runtime/"),
        "INVALID_DATA",
        "Неверный путь в WAL",
        5,
      );
      paths.add(change.path);
    }
    await parallel(intent.changes, async (change) => {
      const actual = await this.hash(join(this.root, change.path));
      const target = change.after === null ? null : digest(change.after);
      invariant(
        actual === target || actual === change.before,
        "STORAGE_RECOVERY_CONFLICT",
        "Файл изменён вне незавершённой операции. Восстановление остановлено",
        5,
        { path: change.path },
      );
    });
    const phase = (path: string) =>
      path === ".indexes/state.json"
        ? 4
        : path === "storage.json"
          ? 5
          : path.startsWith(".indexes/")
            ? 3
            : path.startsWith("operations/") || path.startsWith("history/")
              ? 2
              : path.startsWith("relations/")
                ? 1
                : 0;
    for (let step = 0; step <= 5; step++)
      await parallel(
        intent.changes.filter((change) => phase(change.path) === step),
        async (change) => {
          const path = join(this.root, change.path);
          const target = change.after === null ? null : digest(change.after);
          const actual = await this.hash(path);
          if (actual === target) return;
          invariant(
            actual === change.before,
            "STORAGE_RECOVERY_CONFLICT",
            "Файл изменён во время восстановления; запись остановлена",
            5,
            { path: change.path },
          );
          owned();
          if (change.after === null) {
            await unlink(path);
            await syncDirectory(dirname(path));
          } else {
            await this.ensureDirectory(dirname(path));
            await atomicJson(path, change.after, this.runtime, false, owned);
          }
          await this.probe?.("file", change.path);
        },
      );
    await this.probe?.("published");
    owned();
    await unlink(this.pending);
    await syncDirectory(dirname(this.pending));
  }
}
