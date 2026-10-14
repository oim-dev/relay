import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  storageLayoutSchema,
  storageMigrationResultSchema,
} from "@relay/contracts/storage-maintenance";
import { PRE_RELEASE_WAL_NEXT, storageCommand, storageError } from "../data-model/errors.js";
import { atomicJson, exists, readJson, syncDirectory } from "../files.js";
import { invariant, isErrno } from "../../shared/errors.js";
import { MANIFEST_PATH, parseStorageManifest } from "../data-model/manifest.js";
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

const changeSchema = z.strictObject({
  path: relativePathSchema,
  before: hashSchema.nullable(),
  after: z.json().nullable(),
});
/** WAL обычной операции. Формат совпадает с Relay 0.9.2 (history/intent-v1.ts). */
const intentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  changes: z.array(changeSchema),
});
const transitionRefSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}@[1-9][0-9]*$/);
/**
 * Путь принятого постоянного файла относительно корня: любое допустимое имя, в том числе
 * Unicode (конфигурация может называться как угодно), без абсолютной части и `.`/`..`.
 */
export const persistentPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Ожидается безопасный относительный путь",
  );

/**
 * Описание незавершённой миграции модели данных. schemaVersion 2 намеренно не принимается
 * строгим parser 0.9.2 (`z.literal(1)`): прежний клиент не допубликует миграцию.
 */
export const migrationIntentSchema = z.strictObject({
  id: z.uuid(),
  registryDigest: hashSchema,
  planFingerprint: hashSchema,
  source: z.strictObject({
    layout: storageLayoutSchema,
    /** storage.json.schemaVersion источника; null — legacy-раскладка без маркера. */
    physical: z.number().int().positive().nullable(),
    profile: z.number().int().positive().nullable(),
  }),
  target: z.strictObject({ profile: z.number().int().positive() }),
  /** Упорядоченные `id@version` применённых переходов. */
  transitions: z.array(transitionRefSchema),
  backup: z.strictObject({
    /** Абсолютный путь проверенной резервной копии вне базы. */
    path: z.string().min(1).max(4096),
    manifestSha256: hashSchema,
  }),
  /**
   * Итог подготовленного плана для результата продолжения (шаги со счётчиками, счётчики,
   * число сущностей): продолжение публикует тот же результат и не пересчитывает его.
   */
  report: z
    .strictObject({
      entities: storageMigrationResultSchema.shape.entities,
      steps: storageMigrationResultSchema.shape.steps,
      counts: storageMigrationResultSchema.shape.counts,
    })
    .optional(),
  /** Обычный WAL, восстановленный перед планированием этой миграции. */
  preRecovered: z.strictObject({ walSha256: hashSchema }).optional(),
  /**
   * Новые неизменяемые страницы индекса (sha256), подготовленные до intent во временной
   * области `runtime/migration-pages/`; recovery миграции переносит их в `.indexes/segments`
   * после записи intent и до публикации корней. Постоянный набор до intent не меняется.
   */
  pages: z.array(hashSchema).optional(),
  /**
   * Постоянные файлы корня, которые публикация не меняет, с sha256 байтов по плану: результат
   * миграции зависит от них. Recovery сверяет их и состав каталогов записей, отношений и
   * пространств ключей до публикации; расхождение — STORAGE_RECOVERY_CONFLICT с путём.
   */
  unchanged: z.array(z.strictObject({ path: persistentPathSchema, sha256: hashSchema })).optional(),
});
export type MigrationIntent = z.output<typeof migrationIntentSchema>;
/**
 * Изменение WAL миграции: путь — любое безопасное относительное имя (конфигурация legacy-базы
 * может называться по-русски и переписывается переносом). WAL v1 сохраняет схему 0.9.2.
 */
const migrationChangeSchema = changeSchema.extend({ path: persistentPathSchema });
const intentV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  changes: z.array(migrationChangeSchema),
  migration: migrationIntentSchema,
});
type Intent = z.output<typeof intentV1Schema> | z.output<typeof intentV2Schema>;
export const PENDING_PATH = "transactions/pending.json";
const SUPPORTED_INTENT = 2;

/** Состояние WAL без recovery, mkdir и блокировки; sha256 — по байтам файла. */
export type PendingInspection =
  | { kind: "none" }
  | { kind: "operation"; sha256: string; intent: z.output<typeof intentV1Schema> }
  | { kind: "migration"; sha256: string; intent: z.output<typeof intentV2Schema> }
  | { kind: "unknown"; sha256: string; reason: "version" | "corrupt"; schemaVersion?: number };

export async function inspectPending(root: string): Promise<PendingInspection> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, PENDING_PATH));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "none" };
    throw error;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "unknown", sha256, reason: "corrupt" };
  }
  const version =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).schemaVersion
      : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > SUPPORTED_INTENT)
    return { kind: "unknown", sha256, reason: "version", schemaVersion: version };
  const v1 = intentV1Schema.safeParse(value);
  if (v1.success) return { kind: "operation", sha256, intent: v1.data };
  const v2 = intentV2Schema.safeParse(value);
  if (v2.success) return { kind: "migration", sha256, intent: v2.data };
  return { kind: "unknown", sha256, reason: "corrupt" };
}

/** Неизвестный WAL блокирует любую запись: его нельзя ни допубликовать, ни стереть. */
export function rejectUnknownPending(inspection: PendingInspection): void {
  if (inspection.kind !== "unknown") return;
  throw unknownPendingError(inspection);
}

function unknownPendingError(inspection: Extract<PendingInspection, { kind: "unknown" }>) {
  if (inspection.reason === "version")
    return storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Незавершённая операция записана более новой версией Relay; запись запрещена",
      {
        reason: "wal",
        path: PENDING_PATH,
        current: inspection.schemaVersion,
        expected: SUPPORTED_INTENT,
      },
    );
  return storageError(
    "STORAGE_DATA_CORRUPT",
    "Файл незавершённой операции повреждён или имеет неизвестную структуру; запись запрещена",
    { reason: "wal", path: PENDING_PATH },
  );
}

/** Миграционный WAL завершает только явный исполнитель миграции. */
export function migrationRecoveryRequired(intent: MigrationIntent) {
  // WAL предварительной сборки без итога плана `storage migrate` не продолжит: тот же
  // следующий шаг, что у `storage status`, — восстановление резервной копии.
  if (!intent.report)
    return storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Незавершённая миграция записана предварительной сборкой Relay без итога плана",
      { reason: "wal-report", path: PENDING_PATH, next: PRE_RELEASE_WAL_NEXT },
    );
  return storageError(
    "STORAGE_RECOVERY_REQUIRED",
    "Миграция хранилища не завершена. Обычная работа недоступна до её продолжения",
    {
      reason: "migration",
      path: PENDING_PATH,
      id: intent.id,
      current: intent.source.profile ?? intent.source.layout,
      expected: intent.target.profile,
      next: `Остановите процессы Relay и выполните ${storageCommand("storage migrate")}: перенос продолжится из записанного WAL с исходной резервной копией`,
    },
  );
}

/**
 * Проверка исполнителя миграции перед публикацией и продолжением WAL v2: готовность backup,
 * известность переходов и реестра. Ошибка останавливает recovery, WAL сохраняется.
 */
export type MigrationVerifier = (intent: MigrationIntent) => Promise<void>;
export type RecoverOptions = {
  /** Явный режим исполнителя миграции; без него WAL v2 не публикуется. */
  migration?: MigrationVerifier;
  /** Поддерживаемый профиль модели данных; по умолчанию профиль этой сборки. */
  profile?: number;
};
export type PublishOptions = {
  migration?: { intent: MigrationIntent; verify: MigrationVerifier };
};
/** Итог recovery: что было завершено (для preRecovered и отчёта). */
export type RecoveredIntent =
  { kind: "none" } | { kind: "operation" | "migration"; sha256: string };

/**
 * Probe-точки управляемого сбоя: intent записан; файл опубликован; фаза завершена
 * (path = entities | relations | journals | indexes | state | manifest); всё опубликовано,
 * WAL ещё на месте; WAL удалён. Для миграции также staged — страницы индекса подготовлены.
 */
export type TransactionStage = "staged" | "intent" | "file" | "phase" | "published" | "removed";
export type TransactionProbe = (stage: TransactionStage, path?: string) => void | Promise<void>;
const PHASES = ["entities", "relations", "journals", "indexes", "state", "manifest"] as const;
const SEGMENT_PATH = /^\.indexes\/segments\/([a-f0-9]{2})\/([a-f0-9]{64})\.json$/;
/** Временная область страниц индекса миграции (runtime не входит в постоянный набор). */
export const MIGRATION_PAGES = "runtime/migration-pages";

/** Комментарии имеют отдельный предметный бюджет; автоматических лент здесь нет. */
function budgetValue(path: string, value: ReturnType<typeof jsonValue>) {
  if (
    path.startsWith("entities/") &&
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 3
  ) {
    const { comments: _comments, ...data } = value as Record<string, unknown>;
    return jsonValue(data);
  }
  return value;
}

/** Разделение пакета миграции: новые страницы индекса готовятся вне WAL, остальное — в нём. */
export function splitMigrationChanges(changes: readonly FileChange[]) {
  const staged = changes.filter(
    (change) => change.after !== null && SEGMENT_PATH.test(change.path),
  );
  const pages = new Set(staged);
  return { staged, published: changes.filter((change) => !pages.has(change)) };
}

/** WAL v2 миграции в точности так, как он записывается (одинаково для плана и публикации). */
export function migrationIntentOf(
  changes: readonly FileChange[],
  migration: MigrationIntent,
  staged: readonly FileChange[],
): Intent {
  return intentV2Schema.parse({
    schemaVersion: 2,
    changes,
    migration: {
      ...migration,
      pages: staged.map((change) => SEGMENT_PATH.exec(change.path)![2]!).sort(),
    },
  });
}

/**
 * Размер WAL: `budget` — предметный бюджет (массив комментариев оболочки 3 исключён, предел
 * 128 МиБ), `disk` — фактические байты файла `transactions/pending.json`.
 */
export function intentBytes(intent: Intent): { budget: number; disk: number } {
  const size = (value: unknown) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
  return {
    budget: size({
      ...intent,
      changes: intent.changes.map((change) => ({
        ...change,
        after: budgetValue(change.path, change.after),
      })),
    }),
    disk: size(intent),
  };
}

/**
 * Recovery не «чинит» базу более нового или неизвестного формата (ТЗ 5.1–5.2, 8.1): знания
 * формата WAL недостаточно для записи в неизвестную модель данных. До первого изменения
 * маркер на диске и маркер, который публикует сам WAL, обязаны разобраться как совместимые;
 * повреждение, неизвестная структура или формат и версия новее поддерживаемой — отказ,
 * WAL и база сохраняются. Отсутствие маркера допустимо, только если сам WAL публикует
 * совместимый маркер (инициализация).
 */
async function requireCompatibleManifest(root: string, intent: Intent, profile?: number) {
  let bytes: Buffer | null = null;
  try {
    bytes = await readFile(join(root, MANIFEST_PATH));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if (bytes) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw storageError(
        "STORAGE_DATA_CORRUPT",
        "Маркер хранилища: некорректный JSON или UTF-8; незавершённая операция не восстановлена",
        { path: MANIFEST_PATH },
      );
    }
    parseStorageManifest(value, profile);
  }
  let publishes = false;
  for (const change of intent.changes)
    if (change.path === MANIFEST_PATH && change.after !== null) {
      parseStorageManifest(change.after, profile);
      publishes = true;
    }
  // Без маркера на диске recovery допустим только для WAL, который сам публикует
  // совместимый маркер (инициализация); иначе совместимость базы не подтверждена.
  if (!bytes && !publishes)
    throw storageError(
      "STORAGE_FORMAT_MISSING",
      "Маркер storage.json отсутствует, а незавершённая операция его не создаёт; восстановление остановлено",
      { path: MANIFEST_PATH },
    );
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
    return (await exists(path))
      ? digest(jsonValue(await readJson(path, Number.POSITIVE_INFINITY)))
      : null;
  }

  /** Подготовка производных неизменяемых страниц; видимость меняет только публикация корней. */
  async stageIndexes(changes: readonly FileChange[], owned: () => void): Promise<void> {
    await parallel(changes, async (change) => {
      const match = SEGMENT_PATH.exec(change.path);
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

  /** Страницы миграции во временной области runtime: до intent постоянный набор не меняется. */
  private async stagePages(changes: readonly FileChange[], owned: () => void): Promise<void> {
    const directory = join(this.root, MIGRATION_PAGES);
    await rm(directory, { recursive: true, force: true });
    await this.ensureDirectory(directory);
    await parallel(changes, async (change) => {
      const match = SEGMENT_PATH.exec(change.path);
      invariant(
        match && change.after !== null && digest(change.after) === match[2],
        "INVALID_DATA",
        "Неверная неизменяемая страница индекса",
        5,
      );
      await atomicJson(
        join(directory, `${match[2]}.json`),
        change.after,
        this.runtime,
        false,
        owned,
      );
    });
  }

  /** После intent: страницы из временной области на постоянные пути (идемпотентно). */
  private async installPages(pages: readonly string[], owned: () => void): Promise<void> {
    await parallel(pages, async (hash) => {
      const path = join(this.root, `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`);
      if ((await this.hash(path)) === hash) return;
      const staged = `${MIGRATION_PAGES}/${hash}.json`;
      const value = (await exists(join(this.root, staged)))
        ? jsonValue(await readJson(join(this.root, staged), Number.POSITIVE_INFINITY))
        : null;
      if (value === null || digest(value) !== hash)
        throw storageError(
          "STORAGE_RECOVERY_CONFLICT",
          "Подготовленная страница индекса миграции потеряна; восстановление остановлено",
          { path: staged, next: RECOVERY_CONFLICT_NEXT },
        );
      owned();
      await this.ensureDirectory(dirname(path));
      await atomicJson(path, value, this.runtime, false, owned);
    });
  }

  /**
   * Публикация пакета через WAL. С `migration` пишется intent v2: проверка исполнителя,
   * затем новые страницы индекса готовятся во временной области runtime (в WAL — только их
   * sha256) и переносятся на место после intent,
   * последним фазой публикуется storage.json целевого профиля.
   */
  async publish(
    changes: readonly FileChange[],
    owned: () => void,
    options: PublishOptions = {},
  ): Promise<void> {
    const pending = await inspectPending(this.root);
    rejectUnknownPending(pending);
    if (pending.kind === "migration") throw migrationRecoveryRequired(pending.intent.migration);
    if (pending.kind === "operation")
      throw storageError(
        "STORAGE_RECOVERY_REQUIRED",
        "Сначала восстановите незавершённую операцию хранилища",
        { reason: "operation", path: PENDING_PATH },
      );
    const migration = options.migration
      ? { ...options.migration, intent: migrationIntentSchema.parse(options.migration.intent) }
      : undefined;
    let staged: FileChange[] = [];
    let published = changes;
    if (migration) {
      ({ staged, published } = splitMigrationChanges(changes));
      const marker = published.find((change) => change.path === "storage.json");
      const target = z
        .looseObject({ dataModelVersion: z.number() })
        .safeParse(marker?.after ?? null);
      invariant(
        target.success && target.data.dataModelVersion === migration.intent.target.profile,
        "INVALID_DATA",
        "Миграция должна последним шагом опубликовать маркер целевого профиля",
        5,
      );
    }
    const paths = new Set<string>();
    for (const change of published) {
      // Обычная операция — ASCII-пути 0.9.2; миграция — любое безопасное имя (конфигурация).
      (migration ? persistentPathSchema : relativePathSchema).parse(change.path);
      invariant(
        !paths.has(change.path) &&
          !change.path.startsWith("transactions/") &&
          !change.path.startsWith("runtime/"),
        "INVALID_DATA",
        "Повторный или служебный путь в операции",
        5,
      );
      paths.add(change.path);
      if (change.after !== null)
        checkSize(
          budgetValue(change.path, change.after),
          RECORD_BYTES,
          "Предметные данные записи превышают 16 МиБ",
        );
    }
    const candidates = await parallel(published, async (change) => {
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
    const intent: Intent = migration
      ? migrationIntentOf(prepared, migration.intent, staged)
      : intentV1Schema.parse({ schemaVersion: 1, changes: prepared });
    invariant(
      intentBytes(intent).budget <= WAL_BYTES,
      "STORAGE_LIMIT_EXCEEDED",
      "Предметные данные пакета публикации превышают 128 МиБ",
      4,
    );
    if (migration) {
      // Backup и переходы проверяются до любого изменения базы.
      await migration.verify(migration.intent);
      await this.stagePages(staged, owned);
      await this.probe?.("staged");
    }
    owned();
    await this.ensureDirectory(dirname(this.pending));
    await atomicJson(this.pending, intent, this.runtime, true, owned);
    await this.probe?.("intent");
    // Профиль проверенного намерения — поддерживаемый исполнителем (его проверил verifier).
    await this.recover(
      owned,
      migration ? { migration: migration.verify, profile: migration.intent.target.profile } : {},
    );
  }

  /**
   * Завершает записанный WAL вперёд. WAL v1 — всегда (обычный recovery);
   * WAL v2 — только в явном режиме миграции после проверки исполнителя.
   */
  async recover(owned: () => void, options: RecoverOptions = {}): Promise<RecoveredIntent> {
    const pending = await inspectPending(this.root);
    if (pending.kind === "none") return pending;
    if (pending.kind === "unknown") throw unknownPendingError(pending);
    const intent = pending.intent;
    await requireCompatibleManifest(this.root, intent, options.profile);
    if (pending.kind === "migration") {
      if (!options.migration) throw migrationRecoveryRequired(pending.intent.migration);
      await options.migration(pending.intent.migration);
      await this.checkUnchanged(pending.intent, owned);
      await this.installPages(pending.intent.migration.pages ?? [], owned);
    }
    await this.apply(intent, owned);
    if (pending.kind === "migration")
      await rm(join(this.root, MIGRATION_PAGES), { recursive: true, force: true });
    return { kind: pending.kind, sha256: pending.sha256 };
  }

  /**
   * Файлы вне изменений WAL миграции остались такими, какими их видел план, и в каталогах
   * записей, отношений и пространств ключей нет файлов вне плана. Иначе подготовленный
   * результат мог бы сослаться на удалённую запись или скрыть чужую; WAL сохраняется.
   */
  private async checkUnchanged(
    intent: z.output<typeof intentV2Schema>,
    owned: () => void,
  ): Promise<void> {
    const expected = intent.migration.unchanged;
    if (!expected) return;
    const conflict = (path: string) =>
      storageError(
        "STORAGE_RECOVERY_CONFLICT",
        "Файл, от которого зависит незавершённая миграция, изменён вне неё. Восстановление остановлено",
        { path, next: RECOVERY_CONFLICT_NEXT },
      );
    await parallel(expected, async (file) => {
      owned();
      let bytes: Buffer;
      try {
        bytes = await readFile(join(this.root, file.path));
      } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) throw conflict(file.path);
        throw error;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw conflict(file.path);
    });
    const known = new Set([
      ...expected.map((file) => file.path),
      ...intent.changes.map((change) => change.path),
    ]);
    for (const top of ["entities", "relations", "keyspaces"])
      for (const path of await listFiles(this.root, top))
        if (!known.has(path) && !IGNORED_NAMES.has(path.slice(path.lastIndexOf("/") + 1)))
          throw conflict(path);
  }

  private async apply(intent: Intent, owned: () => void): Promise<void> {
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
      if (actual !== target && actual !== change.before)
        throw storageError(
          "STORAGE_RECOVERY_CONFLICT",
          "Файл изменён вне незавершённой операции. Восстановление остановлено",
          { path: change.path, next: RECOVERY_CONFLICT_NEXT },
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
    for (let step = 0; step <= 5; step++) {
      await parallel(
        intent.changes.filter((change) => phase(change.path) === step),
        async (change) => {
          const path = join(this.root, change.path);
          const target = change.after === null ? null : digest(change.after);
          const actual = await this.hash(path);
          if (actual === target) return;
          if (actual !== change.before)
            throw storageError(
              "STORAGE_RECOVERY_CONFLICT",
              "Файл изменён во время восстановления; запись остановлена",
              { path: change.path, next: RECOVERY_CONFLICT_NEXT },
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
      await this.probe?.("phase", PHASES[step]);
    }
    await this.probe?.("published");
    owned();
    await unlink(this.pending);
    await syncDirectory(dirname(this.pending));
    await this.probe?.("removed");
  }
}

/** Служебные файлы VCS/ОС, появление которых не меняет данные базы. */
const IGNORED_NAMES = new Set([".gitignore", ".gitkeep", ".DS_Store", "Thumbs.db"]);

/** Все файлы под каталогом корня (POSIX-пути от корня); отсутствующий каталог — пусто. */
async function listFiles(root: string, directory: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (path: string) => {
    let entries;
    try {
      entries = await readdir(join(root, path), { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else output.push(child);
    }
  };
  await visit(directory);
  return output;
}

const RECOVERY_CONFLICT_NEXT =
  "Не удаляйте transactions/pending.json и резервную копию; восстановите указанный файл к исходному или целевому состоянию и повторите команду";
