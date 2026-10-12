import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, stat, statfs } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError, isErrno } from "../../shared/errors.js";
import { storageCommand, storageError } from "./errors.js";
import type { SourceArea, StorageSource } from "./source/reader.js";

/**
 * Внешняя резервная копия перед изменяющей миграцией (ТЗ 8.2, дизайн §4.4).
 *
 * Каталог создаётся заново под `--backup-dir` вне корня базы, каталога legacy-данных и
 * Git-рабочей копии, содержащей базу. Копируется весь прочитанный набор файлов под замком:
 * конфигурация любого имени, маркер, записи, отношения, индексы, незавершённый WAL обычной
 * операции, посторонние файлы и каталоги рекурсивно и пустые каталоги. Не копируются активный
 * process-lock (`runtime/write.lock`) и временные файлы `runtime/` — кроме диагностической
 * отметки `runtime/index-stale.json`. Байты каждого файла сверяются с sha256 того чтения,
 * по которому построен план; запись `wx` + fsync файла и каталогов, затем повторное чтение.
 * `backup-manifest.json` пишется последним и означает завершённую копию. Backup не удаляется.
 */

export const BACKUP_MANIFEST = "backup-manifest.json";
export const BACKUP_RESTORE = "RESTORE.md";
const BACKUP_FORMAT = "relay-storage-backup";

/** Ввод-вывод копии; тесты подменяют его для отказов записи, fsync и места. */
export interface BackupIo {
  mkdir(path: string): Promise<void>;
  /** Новый файл (`wx`), запись и fsync до закрытия. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Свободное место файловой системы каталога, байт. */
  freeBytes(path: string): Promise<number>;
}

export const nodeBackupIo: BackupIo = {
  async mkdir(path) {
    await mkdir(path);
  },
  async writeFile(path, bytes) {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async syncDirectory(path) {
    if (process.platform === "win32") return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readFile: (path) => readFile(path),
  async freeBytes(path) {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
};

const hash = /^[a-f0-9]{64}$/;
const backupFileSchema = z.strictObject({
  area: z.enum(["config-root", "storage-root"]),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(hash),
});
export const backupManifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  project: z.strictObject({
    id: z.string().nullable(),
    configName: z.string().min(1),
    root: z.string().min(1),
    storageRoot: z.string().min(1).nullable(),
  }),
  source: z.strictObject({
    layout: z.string().nullable(),
    physical: z.number().int().nullable(),
    profile: z.number().int().nullable(),
  }),
  target: z.strictObject({ profile: z.number().int().positive() }),
  planFingerprint: z.string().regex(hash),
  /** В копию входит незавершённый WAL обычной операции (до его восстановления). */
  pendingOperationWal: z.boolean(),
  directories: z.array(
    z.strictObject({ area: z.enum(["config-root", "storage-root"]), path: z.string().min(1) }),
  ),
  files: z.array(backupFileSchema),
  totals: z.strictObject({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  complete: z.literal(true),
});
export type BackupManifest = z.output<typeof backupManifestSchema>;

export type BackupRef = { path: string; manifestSha256: string };

export type BackupInput = {
  readonly backupDir: string;
  readonly source: StorageSource;
  /** Каталог legacy-данных, если он отличается от корня (область storage-root). */
  readonly storageRoot: string | null;
  readonly targetProfile: number;
  readonly planFingerprint: string;
  readonly pendingOperationWal: boolean;
  readonly owned: () => void;
  readonly io?: BackupIo;
  readonly now?: () => Date;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/** Файлы и каталоги, входящие в копию: весь прочитанный набор, кроме замка и временных runtime. */
export function backupEntries(source: StorageSource) {
  const files = source.entries.filter(
    (entry) => entry.type === "file" && entry.category !== "lock" && entry.persistent,
  );
  const directories = source.entries.filter(
    (entry) => entry.type === "dir" && entry.category !== "lock" && entry.category !== "runtime",
  );
  return { files, directories };
}

/** Объём копии в байтах (файлы плюс служебные файлы копии с запасом). */
export function backupBytes(source: StorageSource): number {
  return backupEntries(source).files.reduce((sum, entry) => sum + entry.size, 0);
}

/** Требуемое место для backup: размер × 1.05 + 1 МиБ на manifest и метаданные ФС. */
export function backupRequiredBytes(source: StorageSource): number {
  return Math.ceil(backupBytes(source) * 1.05) + 1024 * 1024;
}

/** Ближайший предок каталога, содержащий `.git` (рабочая копия репозитория); null — нет. */
async function workingCopy(path: string): Promise<string | null> {
  let current = path;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Проверка `--backup-dir` до любых изменений: реальный путь вне корня базы, каталога
 * legacy-данных и Git-рабочей копии, содержащей базу. Отсутствующий каталог создаётся.
 */
export async function resolveBackupDirectory(
  backupDir: string,
  source: StorageSource,
  storageRoot: string | null,
  io: BackupIo = nodeBackupIo,
): Promise<string> {
  const requested = resolve(backupDir);
  // Реальный путь проверяется до создания: несуществующая часть добавляется к реальному предку.
  let existing = requested;
  const rest: string[] = [];
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw unsafe("backup-unreadable");
      const parent = dirname(existing);
      if (parent === existing) throw unsafe("backup-unreadable");
      rest.unshift(existing.slice(parent.length).replace(/^[/\\]+/, ""));
      existing = parent;
    }
  }
  const real = join(existing, ...rest);
  const forbidden = [source.root, ...(storageRoot ? [await realOrSelf(storageRoot)] : [])];
  const checkout = await workingCopy(source.root);
  if (checkout) forbidden.push(checkout);
  for (const parent of forbidden)
    if (inside(parent, real))
      throw storageError(
        "STORAGE_UNSAFE_PATH",
        parent === checkout
          ? "Каталог резервной копии находится внутри Git-рабочей копии с базой"
          : "Каталог резервной копии находится внутри каталога базы",
        { reason: parent === checkout ? "backup-in-checkout" : "backup-in-storage" },
      );
  // Отсутствующая цепочка создаётся по одному каталогу; запись каждого нового имени
  // закрепляется fsync его родителя до начала копирования.
  let current = existing;
  for (const part of rest) {
    const next = join(current, part);
    try {
      await io.mkdir(next);
    } catch (error) {
      if (!isErrno(error, "EEXIST"))
        throw storageError("STORAGE_BACKUP_FAILED", "Нельзя создать каталог резервной копии", {
          reason: "backup-mkdir",
        });
    }
    try {
      await io.syncDirectory(current);
    } catch (error) {
      throw failure(error);
    }
    current = next;
  }
  const info = await lstat(real);
  if (!info.isDirectory() || (await realpath(real)) !== real)
    throw storageError("STORAGE_UNSAFE_PATH", "Путь резервной копии не является каталогом", {
      reason: "backup-not-directory",
    });
  return real;
}

async function realOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

function unsafe(reason: string): AppError {
  return storageError("STORAGE_UNSAFE_PATH", "Каталог резервной копии недоступен", { reason });
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function failure(error: unknown, path?: string): AppError {
  if (error instanceof AppError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "io";
  if (code === "ENOSPC" || code === "EDQUOT")
    return storageError("STORAGE_INSUFFICIENT_SPACE", "Недостаточно места для резервной копии", {
      reason: code.toLowerCase(),
    });
  return storageError("STORAGE_BACKUP_FAILED", "Ошибка записи резервной копии; база не изменена", {
    reason: code.slice(0, 64).toLowerCase(),
    ...(path ? { path } : {}),
  });
}

/** Ровно одна новая резервная копия; неполный каталог остаётся без manifest и не удаляется. */
export async function createBackup(input: BackupInput): Promise<BackupRef> {
  const io = input.io ?? nodeBackupIo;
  const { source, owned } = input;
  const parent = await resolveBackupDirectory(input.backupDir, source, input.storageRoot, io);
  const { files, directories } = backupEntries(source);
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  let free: number;
  try {
    free = await io.freeBytes(parent);
  } catch (error) {
    throw failure(error);
  }
  if (free < backupRequiredBytes(source))
    throw storageError("STORAGE_INSUFFICIENT_SPACE", "Недостаточно места для резервной копии", {
      reason: "backup",
      current: Math.min(free, Number.MAX_SAFE_INTEGER),
      expected: backupRequiredBytes(source),
    });

  const now = (input.now ?? (() => new Date()))();
  const project = (source.config?.projectId ?? "project").replace(/[^A-Za-z0-9_-]/g, "_");
  let directory = "";
  for (let attempt = 0; ; attempt++) {
    const name = `relay-backup-${project.slice(0, 64)}-${stamp(now)}-${randomBytes(4).toString("hex")}`;
    directory = join(parent, name);
    try {
      await io.mkdir(directory);
      break;
    } catch (error) {
      if (isErrno(error, "EEXIST") && attempt < 4) continue;
      throw failure(error);
    }
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(directory)) !== directory)
    throw storageError("STORAGE_UNSAFE_PATH", "Каталог резервной копии подменён", {
      reason: "backup-replaced",
    });
  // Имя новой копии в `--backup-dir` закрепляется до копирования: без fsync родителя
  // каталог мог бы исчезнуть после сбоя питания, когда база уже меняется.
  try {
    await io.syncDirectory(parent);
  } catch (error) {
    throw failure(error);
  }

  const areaRoot = (area: SourceArea) =>
    area === "config-root" ? source.root : (input.storageRoot ?? source.root);
  const target = (area: SourceArea, path: string) => join(directory, "files", area, path);
  try {
    const made = new Set<string>([directory]);
    const ensure = async (path: string) => {
      const chain: string[] = [];
      for (let current = path; !made.has(current); current = dirname(current)) {
        chain.push(current);
        if (current === dirname(current)) break;
      }
      for (const entry of chain.reverse()) {
        await io.mkdir(entry);
        made.add(entry);
        await io.syncDirectory(dirname(entry));
      }
    };
    for (const entry of directories) await ensure(target(entry.area, entry.path));
    for (const entry of files) {
      owned();
      const bytes = await readFile(join(areaRoot(entry.area), entry.path));
      if (sha256(bytes) !== entry.sha256)
        throw storageError(
          "STORAGE_PLAN_STALE",
          "Исходный файл изменён после построения плана; резервная копия не создана",
          { path: entry.path },
        );
      const path = target(entry.area, entry.path);
      await ensure(dirname(path));
      await io.writeFile(path, bytes);
    }
    for (const path of made) await io.syncDirectory(path);
    // Повторное чтение: на диске копии ровно те байты, что были прочитаны.
    for (const entry of files) {
      const copied = await io.readFile(target(entry.area, entry.path));
      if (sha256(copied) !== entry.sha256)
        throw storageError("STORAGE_BACKUP_FAILED", "Проверка резервной копии не прошла", {
          reason: "verify",
          path: entry.path,
        });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      schemaVersion: 1,
      createdAt: now.toISOString(),
      project: {
        id: source.config?.projectId ?? null,
        configName: relative(source.root, source.configPath).split(sep).join("/"),
        root: source.root,
        storageRoot: input.storageRoot,
      },
      source: { layout: source.layout, physical: source.physical, profile: source.profile },
      target: { profile: input.targetProfile },
      planFingerprint: input.planFingerprint,
      pendingOperationWal: input.pendingOperationWal,
      directories: directories.map((entry) => ({ area: entry.area, path: entry.path })),
      files: files.map((entry) => ({
        area: entry.area,
        path: entry.path,
        size: entry.size,
        sha256: entry.sha256!,
      })),
      totals: { files: files.length, bytes: total },
      complete: true,
    };
    await io.writeFile(
      join(directory, BACKUP_RESTORE),
      Buffer.from(restoreInstructions(manifest, directory)),
    );
    const bytes = Buffer.from(`${JSON.stringify(backupManifestSchema.parse(manifest), null, 2)}\n`);
    await io.writeFile(join(directory, BACKUP_MANIFEST), bytes);
    await io.syncDirectory(directory);
    const written = await io.readFile(join(directory, BACKUP_MANIFEST));
    if (sha256(written) !== sha256(bytes))
      throw storageError("STORAGE_BACKUP_FAILED", "Проверка manifest резервной копии не прошла", {
        reason: "verify",
      });
    return { path: directory, manifestSha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof AppError && error.code === "STORAGE_PLAN_STALE") throw error;
    throw failure(error);
  }
}

/**
 * Готовность записанной копии для продолжения миграции из WAL: manifest на месте, его sha256
 * совпадает с WAL, копия завершена, файлы присутствуют с прежними размерами. Иначе
 * STORAGE_BACKUP_MISSING — продолжения без защиты нет.
 */
export async function verifyBackup(
  ref: BackupRef,
  options: { walWritten?: boolean } = {},
): Promise<BackupManifest> {
  // До записи WAL база не изменена: нужна новая копия, а не возврат прежней.
  const walWritten = options.walWritten ?? true;
  const before = `База не изменена: незавершённой миграции нет. Повторите ${storageCommand("storage migrate --backup-dir <каталог вне базы>")}, чтобы создать новую резервную копию`;
  const missing = (reason: string) =>
    storageError(
      "STORAGE_BACKUP_MISSING",
      walWritten
        ? "Резервная копия незавершённой миграции отсутствует или повреждена; продолжение остановлено"
        : "Резервная копия повреждена до начала изменений; перенос не начат",
      {
        reason,
        next: walWritten
          ? `Не удаляйте transactions/pending.json. Верните резервную копию по пути из WAL и повторите ${storageCommand("storage migrate")}`
          : before,
      },
    );
  let bytes: Buffer;
  try {
    bytes = await readFile(join(ref.path, BACKUP_MANIFEST));
  } catch {
    throw missing("manifest");
  }
  if (sha256(bytes) !== ref.manifestSha256) throw missing("manifest-hash");
  let manifest: BackupManifest;
  try {
    manifest = backupManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw missing("manifest-format");
  }
  // Полная проверка содержимого: размер и sha256 каждого файла копии.
  for (const file of manifest.files) {
    const path = join(ref.path, "files", file.area, file.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size !== file.size) throw missing("file");
    if (sha256(await readFile(path)) !== file.sha256)
      throw storageError(
        "STORAGE_BACKUP_MISSING",
        walWritten
          ? "Файл резервной копии повреждён; продолжение остановлено"
          : "Файл резервной копии повреждён до начала изменений; перенос не начат",
        {
          reason: "file-hash",
          ...(file.area === "config-root" ? { path: file.path } : {}),
          next: walWritten
            ? `Не удаляйте transactions/pending.json. Верните неповреждённую резервную копию по пути из WAL и повторите ${storageCommand("storage migrate")}`
            : before,
        },
      );
  }
  return manifest;
}

/** Синоним полной проверки (sha256 каждого файла). */
export const verifyBackupContent = verifyBackup;

function restoreInstructions(manifest: BackupManifest, directory: string): string {
  const legacy = manifest.project.storageRoot
    ? `
Каталог прежних legacy-данных находился вне корня базы: \`${manifest.project.storageRoot}\`.
Его содержимое лежит в \`files/storage-root/\`; разверните его рядом в отдельный каталог
и укажите путь в \`storageDir\` развёрнутой конфигурации.
`
    : "";
  return `# Восстановление резервной копии Relay

Копия создана перед \`storage migrate\` ${manifest.createdAt}.
Исходная база: \`${manifest.project.root}\` (конфигурация \`${manifest.project.configName}\`),
раскладка \`${manifest.source.layout ?? "не распознана"}\`, физический формат
\`${manifest.source.physical ?? "—"}\`, профиль \`${manifest.source.profile ?? "—"}\`.
Отпечаток плана: \`${manifest.planFingerprint}\`.
Файлов: ${manifest.totals.files}, байт: ${manifest.totals.bytes}.

Откат выполняется только развёртыванием копии в **отдельный** каталог. Не перезаписывайте
действующую базу: автоматического restore и обратной миграции нет.

1. Остановите процессы Relay, работающие с отдельным каталогом восстановления.
2. Создайте пустой каталог, например \`/restore/project/.relay\`.
3. Скопируйте в него содержимое \`files/config-root/\` из \`${directory}\` с сохранением путей.
   Пустые каталоги перечислены в \`${BACKUP_MANIFEST}\` (\`directories\`).
4. Сверьте sha256 каждого файла со списком \`files\` в \`${BACKUP_MANIFEST}\`.
5. Проверьте развёрнутую копию версией Relay, совместимой с исходной раскладкой и профилем,
   командой чтения, которая есть в этой версии, например
   \`npx <пакет>@<версия> --local --config /restore/project/.relay/${manifest.project.configName} task list\`
   (пакет \`@oim-dev/relay-cli\`, у ранних сборок — \`@gromlab/relay-cli\`); затем прочитайте
   важные записи. \`doctor check\` доступен только в версиях, где он есть (с 0.9.0).
${legacy}
Не входит в копию служебный каталог \`runtime/\`: активный замок процесса \`runtime/write.lock\`,
временные копии атомарной записи \`runtime/<uuid>.json\`, временные страницы индекса миграции
\`runtime/migration-pages/\` и прочие следы процессов. Они не являются данными базы, не нужны для
восстановления, а скопированный замок помешал бы открыть развёрнутую копию. Исключение —
отметка внешних изменений \`runtime/index-stale.json\`: она копируется. Пустой \`runtime/\` в
развёрнутой копии создаётся автоматически при первом открытии.

Копия не удаляется автоматически. Удалите её вручную, когда она больше не нужна.
`;
}
