import { randomUUID } from "node:crypto";
import { readdir, rm, rmdir, stat, statfs, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  storageMigrateOptionsSchema,
  storageMigrationPlanSchema,
  storageMigrationResultSchema,
} from "@relay/contracts/storage-maintenance";
import type {
  StorageMigrateOptions,
  StorageMigrationPlan,
  StorageMigrationResult,
  StorageStatus,
} from "@relay/contracts/storage-maintenance";
import { AppError, isErrno } from "../../shared/errors.js";
import {
  MIGRATION_PAGES,
  StorageTransaction,
  inspectPending,
  rejectUnknownPending,
} from "../entity-store/transaction.js";
import type { MigrationIntent, TransactionProbe } from "../entity-store/transaction.js";
import { backupBytes, backupRequiredBytes, createBackup, verifyBackup } from "./backup.js";
import type { BackupIo, BackupRef } from "./backup.js";
import { storageCommand, storageError } from "./errors.js";
import {
  fingerprintOf,
  planError,
  planMigration,
  statusOfBlockers,
  stepFromRef,
  stepRef,
} from "./plan/planner.js";
import { historicalSourceBlockers, prepareMigration } from "./plan/prepare.js";
import type { PreparedMigration } from "./plan/prepare.js";
import type { TransitionRegistry } from "./registry.js";
import {
  PRE_RELEASE_WAL_NEXT,
  blockerOf,
  diagnoseStorageSource,
  incompatibleMarker,
  readStorageSource,
  resolveSourceTarget,
} from "./source/reader.js";
import type { SourceTarget, StorageSource } from "./source/reader.js";
import { withMaintenanceLock } from "./source/maintenance-lock.js";
import { productionTransitionRegistry } from "./transitions/index.js";

/**
 * Исполнитель миграции модели данных (ТЗ 8.1–8.3, дизайн §4.3–4.6).
 *
 * Порядок: замок по realpath → вид WAL → полный набор источников и отпечаток → `--if-plan`
 * → подготовка вне опубликованного состояния → backup → повторная сверка файлов и состава
 * каталогов, владения замком и готовности backup → WAL v2 → публикация → удаление WAL.
 * До записи intent постоянное состояние не меняется; после него продолжение допубликовывает
 * подготовленный результат и не выполняет преобразования заново.
 */

export type MigrationHooks = {
  /** Реестр переходов; по умолчанию производственный. */
  readonly registry?: TransitionRegistry;
  /** Probe-точки WAL для управляемых сбоев. */
  readonly probe?: TransactionProbe;
  readonly backupIo?: BackupIo;
  readonly now?: () => Date;
  /** Свободное место корня базы, байт (тесты); по умолчанию statfs. */
  readonly freeBytes?: (path: string) => Promise<number>;
  /** Вызывается под замком после recovery обычного или legacy-журнала, до нового плана. */
  readonly afterRecovery?: () => Promise<void>;
  /** Пределы бюджетов (тесты уменьшают их); по умолчанию 16 МиБ записи и 128 МиБ WAL. */
  readonly limits?: { readonly recordBytes?: number; readonly walBytes?: number };
  /** 0 — не ждать занятый замок. */
  readonly lockRetries?: number;
};

const CHECKS = {
  schemas: "passed",
  references: "passed",
  addresses: "passed",
  indexes: "passed",
  budgets: "passed",
} as const;

type Locked = { target: SourceTarget; owned: () => void; registry: TransitionRegistry };

async function locked<T>(
  configPath: string,
  hooks: MigrationHooks,
  operation: (context: Locked) => Promise<T>,
): Promise<T> {
  const registry = hooks.registry ?? productionTransitionRegistry();
  const target = await resolveSourceTarget(configPath);
  return withMaintenanceLock(
    { root: target.root, storageRoot: target.legacyStorage },
    async (owned) => {
      // Конфигурация перечитывается под замком: каталог legacy-данных не должен измениться.
      const again = await resolveSourceTarget(target.configPath);
      if (again.root !== target.root || again.legacyStorage !== target.legacyStorage)
        throw storageError("STORAGE_BUSY", "Конфигурация изменилась во время получения замка", {
          reason: "config-changed",
        });
      return operation({ target: again, owned, registry });
    },
    hooks.lockRetries === undefined ? {} : { retries: hooks.lockRetries },
  );
}

/** Live-записи сущностей без технических владельцев по счётчикам источника (R8). */
function liveEntities(source: StorageSource, registry: TransitionRegistry): number {
  let total = 0;
  for (const [kind, versions] of source.counts) {
    let codec;
    try {
      codec = registry.storage.definition(kind);
    } catch {
      continue;
    }
    if (codec.addressable === false || codec.relocation) continue;
    for (const count of versions.values()) total += count.live;
  }
  return total;
}

function sourceCounts(source: StorageSource) {
  const owners: StorageMigrationResult["counts"]["owners"] = {};
  for (const record of source.records) {
    const key = `entities/${record.kind}`;
    (owners[key] ??= { checked: 0, changed: 0, removedByRule: 0 }).checked++;
  }
  const relations = source.entries.filter(
    (entry) => entry.category === "relations" && entry.path.split("/").length === 3,
  ).length;
  const keyspaces = source.entries.filter(
    (entry) => entry.category === "keyspaces" && entry.type === "file",
  ).length;
  if (relations) owners.relations = { checked: relations, changed: 0, removedByRule: 0 };
  if (keyspaces) owners.keyspaces = { checked: keyspaces, changed: 0, removedByRule: 0 };
  return {
    checked: source.records.length + relations + keyspaces,
    changed: 0,
    removedByRule: 0,
    owners: Object.fromEntries(Object.entries(owners).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** Свободное место корня базы для новых файлов, страниц индекса и WAL. */
async function requireRootSpace(root: string, required: number, hooks: MigrationHooks) {
  let free: number;
  try {
    free = hooks.freeBytes
      ? await hooks.freeBytes(root)
      : await statfs(root).then((info) => Number(info.bavail) * Number(info.bsize));
  } catch {
    return;
  }
  if (free < required)
    throw storageError("STORAGE_INSUFFICIENT_SPACE", "Недостаточно места в каталоге базы", {
      reason: "root",
      current: Math.min(free, Number.MAX_SAFE_INTEGER),
      expected: required,
    });
}

/** Каталог копии (или его ближайший существующий предок) на той же ФС, что корень базы. */
async function sameDevice(root: string, backupDir: string): Promise<boolean> {
  try {
    let current = resolve(backupDir);
    for (;;) {
      const info = await stat(current).catch(() => null);
      if (info) return info.dev === (await stat(root)).dev;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

const TEMPORARY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/**
 * Временные копии атомарной записи (`runtime/<uuid>.json`), оставшиеся после аварийного
 * завершения процесса. Под замком их никто не пишет; постоянный набор они не составляют.
 */
async function removeTemporaries(root: string) {
  for (const name of await readdir(join(root, "runtime")).catch(() => [] as string[]))
    if (TEMPORARY.test(name)) await rm(join(root, "runtime", name), { force: true });
}

/** Вне WAL после подтверждённой публикации: производные runtime-следы и пустые прежние каталоги. */
async function cleanup(
  source: StorageSource | null,
  root: string,
  runtime: readonly string[] = [],
) {
  for (const path of new Set([
    ...runtime,
    "runtime/history-writer.json",
    "runtime/index-stale.json",
  ]))
    await unlink(join(root, path)).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  // Каталоги шардов прежних страниц индекса, опустевшие после публикации.
  const segments = join(root, ".indexes/segments");
  for (const shard of await readdir(segments).catch(() => [] as string[])) {
    const items = await readdir(join(segments, shard)).catch(() => null);
    if (items && items.length === 0) await rmdir(join(segments, shard)).catch(() => {});
  }
  if (!source) return;
  const unified = new Set([
    "entities",
    "relations",
    "keyspaces",
    ".indexes",
    "transactions",
    "runtime",
  ]);
  const directories = source.entries
    .filter(
      (entry) =>
        entry.area === "config-root" &&
        entry.type === "dir" &&
        entry.managed &&
        !unified.has(entry.path.split("/")[0]!),
    )
    .map((entry) => entry.path)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  for (const path of directories) {
    const absolute = join(root, path);
    const items = await readdir(absolute).catch(() => null);
    if (items && items.length === 0)
      await rmdir(absolute).catch((error: unknown) => {
        if (!isErrno(error, "ENOTEMPTY") && !isErrno(error, "ENOENT")) throw error;
      });
  }
}

function verifier(registry: TransitionRegistry, root: string) {
  return async (intent: MigrationIntent) => {
    if (intent.target.profile > registry.profile.version)
      throw storageError(
        "STORAGE_VERSION_UNSUPPORTED",
        "Незавершённая миграция записана для более нового профиля",
        { reason: "wal", current: intent.target.profile, expected: registry.profile.version },
      );
    for (const ref of intent.transitions) stepFromRef(ref, registry);
    // Первая проверка публикации идёт до записи WAL: следующий шаг зависит от этого.
    const walWritten = (await inspectPending(root)).kind !== "none";
    await verifyBackup(intent.backup, { walWritten });
  };
}

function noop(
  source: StorageSource,
  registry: TransitionRegistry,
  fingerprint: string,
  backup: BackupRef | null,
  recovered: boolean,
): StorageMigrationResult {
  return storageMigrationResultSchema.parse({
    migrated: recovered,
    format: "relay-entities",
    schemaVersion: 4,
    entities: liveEntities(source, registry),
    operations: 0,
    resumed: false,
    profiles: { from: source.profile, to: registry.profile.version },
    steps: [],
    planFingerprint: fingerprint,
    counts: sourceCounts(source),
    checks: CHECKS,
    backup,
  });
}

/** Продолжение собственной незавершённой миграции из WAL с записанным backup. */
async function resume(
  context: Locked,
  intent: MigrationIntent,
  options: StorageMigrateOptions,
  hooks: MigrationHooks,
): Promise<StorageMigrationResult> {
  const { target, owned, registry } = context;
  if (options.ifPlan !== undefined && options.ifPlan !== intent.planFingerprint)
    throw storageError(
      "STORAGE_PLAN_STALE",
      "Незавершённая миграция относится к другому плану; повторите без --if-plan",
      { reason: "wal" },
    );
  // Итог плана записан в WAL до публикации: продолжение возвращает его, а не нули.
  if (!intent.report)
    throw storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Незавершённая миграция записана предварительной сборкой Relay без итога плана; база не изменена этим запуском",
      { reason: "wal-report", path: "transactions/pending.json", next: PRE_RELEASE_WAL_NEXT },
    );
  const verify = verifier(registry, target.root);
  await verify(intent);
  await new StorageTransaction(target.root, hooks.probe).recover(owned, {
    migration: verify,
    profile: registry.profile.version,
  });
  owned();
  await new StorageTransaction(target.root).prepareDirectories();
  const after = await readStorageSource(target, { registry, owned });
  await cleanup(after, target.root);
  // Опубликованный результат проверяется полностью: продолжение не скрывает блокеры.
  const diagnosis = diagnoseStorageSource(after, registry);
  if (diagnosis.status.status !== "current") throw planError(diagnosis);
  return storageMigrationResultSchema.parse({
    migrated: true,
    format: "relay-entities",
    schemaVersion: 4,
    entities: intent.report!.entities,
    operations: 0,
    resumed: true,
    profiles: { from: intent.source.profile, to: intent.target.profile },
    steps: intent.report!.steps,
    planFingerprint: intent.planFingerprint,
    counts: intent.report!.counts,
    checks: CHECKS,
    backup: intent.backup,
  });
}

/** Изменяющий запуск `storage migrate`. */
export async function executeMigration(
  configPath: string,
  input: StorageMigrateOptions = {},
  hooks: MigrationHooks = {},
): Promise<StorageMigrationResult> {
  const options = storageMigrateOptionsSchema.parse(input);
  return migrateLocked(configPath, options, hooks);
}

async function migrateLocked(
  configPath: string,
  options: StorageMigrateOptions,
  hooks: MigrationHooks,
): Promise<StorageMigrationResult> {
  return locked(configPath, hooks, async (context) => {
    const { target, owned, registry } = context;
    await removeTemporaries(target.root);
    const pending = await inspectPending(target.root);
    rejectUnknownPending(pending);
    if (pending.kind === "migration")
      return resume(context, pending.intent.migration, options, hooks);
    // Следы прерванной до intent подготовки (временные страницы индекса в runtime).
    await rm(join(target.root, MIGRATION_PAGES), { recursive: true, force: true });

    let source = await readStorageSource(target, { registry, owned });
    // Совместимость маркера, профиля и конфигурации — до копии, recovery и любой записи:
    // старый исполнитель не восстанавливает и не «чинит» базу более новой версии (ТЗ 5.2).
    if (source.blockers.some(incompatibleMarker))
      throw planError(diagnoseStorageSource(source, registry));
    let backup: BackupRef | null = null;
    let preRecovered: { walSha256: string } | undefined;
    const legacy = source.pending.find((entry) => entry.kind === "legacy");
    if ((legacy || pending.kind === "operation") && options.ifPlan !== undefined)
      throw storageError(
        "STORAGE_PLAN_STALE",
        "Есть незавершённая операция: отпечаток плана в этом состоянии неприменим; изменений нет",
        {
          reason: "pending",
          path: legacy?.path ?? "transactions/pending.json",
          next: `Выполните без --if-plan: ${storageCommand("storage migrate --backup-dir <каталог вне базы>")}; операция будет восстановлена после резервной копии, затем план построится заново`,
        },
      );
    if (legacy) {
      if (!options.backupDir)
        throw storageError(
          "STORAGE_BACKUP_REQUIRED",
          "Есть незавершённый журнал прежнего формата; перед его восстановлением нужна резервная копия",
          { reason: "legacy", path: legacy.path },
        );
      backup = await createBackup({
        backupDir: options.backupDir,
        source,
        storageRoot: target.storageRoot,
        targetProfile: registry.profile.version,
        planFingerprint: fingerprintOf(source, registry, []),
        pendingOperationWal: true,
        owned,
        ...(hooks.backupIo ? { io: hooks.backupIo } : {}),
        ...(hooks.now ? { now: hooks.now } : {}),
      });
      const entry = source.entries.find(
        (item) => item.area === legacy.area && item.path === legacy.path,
      );
      // Recovery прежних репозиториев под тем же непрерывным замком исполнителя.
      const { openWorkspace } = await import("../workspace.js");
      const workspace = await openWorkspace(dirname(target.root), target.configPath);
      await workspace.recoverLegacyUnderHeldLock(owned);
      preRecovered = { walSha256: entry!.sha256! };
      await hooks.afterRecovery?.();
      source = await readStorageSource(target, { registry, owned });
      if (source.pending.length)
        throw storageError(
          "STORAGE_RECOVERY_REQUIRED",
          "Незавершённый журнал прежнего формата не восстановлен",
          { reason: "legacy", path: source.pending[0]!.path },
        );
    }
    if (pending.kind === "operation") {
      // Обычный WAL: внешняя копия исходных файлов вместе с WAL, recovery, новое планирование.
      if (!options.backupDir)
        throw storageError(
          "STORAGE_BACKUP_REQUIRED",
          "Есть незавершённая операция; перед её восстановлением нужна резервная копия",
          { reason: "operation", path: "transactions/pending.json" },
        );
      backup = await createBackup({
        backupDir: options.backupDir,
        source,
        storageRoot: target.storageRoot,
        targetProfile: registry.profile.version,
        planFingerprint: fingerprintOf(source, registry, []),
        pendingOperationWal: true,
        owned,
        ...(hooks.backupIo ? { io: hooks.backupIo } : {}),
        ...(hooks.now ? { now: hooks.now } : {}),
      });
      await new StorageTransaction(target.root).recover(owned, {
        profile: registry.profile.version,
      });
      preRecovered = { walSha256: pending.sha256 };
      await hooks.afterRecovery?.();
      source = await readStorageSource(target, { registry, owned });
    }

    const diagnosis = diagnoseStorageSource(source, registry);
    if (diagnosis.status.status !== "current" && diagnosis.status.status !== "migration-required")
      throw planError(diagnosis);
    const plan = planMigration(source, diagnosis, registry);
    if (options.ifPlan !== undefined && options.ifPlan !== plan.fingerprint)
      throw storageError(
        "STORAGE_PLAN_STALE",
        preRecovered
          ? "После восстановления незавершённой операции план изменился; повторите без --if-plan"
          : "Источники или реестр изменились после построения плана; изменений нет",
        { reason: preRecovered ? "recovered" : "fingerprint" },
      );
    if (diagnosis.status.status === "current")
      return noop(source, registry, plan.fingerprint, backup, preRecovered !== undefined);
    if (!backup && !options.backupDir)
      throw storageError(
        "STORAGE_BACKUP_REQUIRED",
        "Изменяющая миграция требует --backup-dir с каталогом вне базы",
      );

    const prepared = await prepareMigration({
      source,
      target,
      registry,
      steps: plan.steps,
      profileStep: plan.profileStep,
      owned,
      ...(hooks.limits ? { limits: hooks.limits } : {}),
    });
    // Фактический объём корня; копия на той же файловой системе занимает то же место.
    const sharedBackup =
      !backup && options.backupDir ? await sameDevice(target.root, options.backupDir) : false;
    await requireRootSpace(
      target.root,
      prepared.rootRequired + (sharedBackup ? backupRequiredBytes(source) : 0),
      hooks,
    );
    backup ??= await createBackup({
      backupDir: options.backupDir!,
      source,
      storageRoot: target.storageRoot,
      targetProfile: registry.profile.version,
      planFingerprint: plan.fingerprint,
      pendingOperationWal: false,
      owned,
      ...(hooks.backupIo ? { io: hooks.backupIo } : {}),
      ...(hooks.now ? { now: hooks.now } : {}),
    });

    // Повторная сверка под тем же замком: содержимое и состав каталогов, владение, backup.
    owned();
    const again = await readStorageSource(target, { registry, owned });
    if (fingerprintOf(again, registry, plan.refs) !== plan.fingerprint)
      throw storageError(
        "STORAGE_PLAN_STALE",
        "Источник изменился во время подготовки; база не изменена, резервная копия сохранена",
        { reason: "verify" },
      );
    const verify = verifier(registry, target.root);
    const intent: MigrationIntent = {
      id: randomUUID(),
      registryDigest: registry.digest,
      planFingerprint: plan.fingerprint,
      source: { layout: source.layout!, physical: source.physical, profile: source.profile },
      target: { profile: registry.profile.version },
      transitions: plan.refs.map(stepRef),
      backup,
      report: { entities: prepared.entities, steps: [...prepared.steps], counts: prepared.counts },
      unchanged: [...prepared.unchanged],
      ...(preRecovered ? { preRecovered } : {}),
    };
    owned();
    const transaction = new StorageTransaction(target.root, hooks.probe);
    await transaction.publish(prepared.changes, owned, { migration: { intent, verify } });
    // Служебные .gitignore создаются только после публикации: до intent постоянный набор
    // не меняется (A19).
    await transaction.prepareDirectories();
    await cleanup(source, target.root, prepared.runtimeRemovals);
    return result(source, registry, plan.fingerprint, prepared, backup);
  });
}

function result(
  source: StorageSource,
  registry: TransitionRegistry,
  fingerprint: string,
  prepared: PreparedMigration,
  backup: BackupRef,
): StorageMigrationResult {
  return storageMigrationResultSchema.parse({
    migrated: true,
    format: "relay-entities",
    schemaVersion: 4,
    entities: prepared.entities,
    operations: 0,
    resumed: false,
    profiles: { from: source.profile, to: registry.profile.version },
    steps: prepared.steps,
    planFingerprint: fingerprint,
    counts: prepared.counts,
    checks: CHECKS,
    backup,
  });
}

/** Статус без изменений: минимальный reader под замком обслуживания. */
export async function inspectMigrationStatus(
  configPath: string,
  hooks: MigrationHooks = {},
): Promise<StorageStatus> {
  return locked(configPath, hooks, async ({ target, owned, registry }) => {
    const source = await readStorageSource(target, { registry, owned });
    const diagnosis = diagnoseStorageSource(source, registry);
    // Исходная раскладка до формата 4 проверяется целиком историческими схемами физического
    // шага (чистое чтение, преобразования не исполняются), как это делает подготовка.
    if (diagnosis.status.status !== "migration-required" || !diagnosis.steps?.physical) {
      owned();
      return diagnosis.status;
    }
    const plan = planMigration(source, diagnosis, registry);
    const blockers = await historicalSourceBlockers({
      source,
      target,
      registry,
      steps: plan.steps,
      owned,
    });
    owned();
    if (!blockers.length) return diagnosis.status;
    return diagnoseStorageSource(
      { ...source, blockers: [...source.blockers, ...blockers] },
      registry,
    ).status;
  });
}

/**
 * Dry-run: полный план с изолированной подготовкой в памяти. Исходный набор не меняется,
 * pending не исполняется, backup, индексы и sidecar не создаются.
 */
export async function planMigrationDryRun(
  configPath: string,
  hooks: MigrationHooks = {},
): Promise<StorageMigrationPlan> {
  return locked(configPath, hooks, async ({ target, owned, registry }) => {
    const source = await readStorageSource(target, { registry, owned });
    const diagnosis = diagnoseStorageSource(source, registry);
    const empty = {
      steps: [],
      profiles: { from: source.profile, to: registry.profile.version },
      changes: {
        files: {},
        relations: { kept: 0, revoked: 0, created: 0 },
        addresses: { reservedKept: 0, relocated: 0 },
      },
      removedByRule: [],
      budgets: {
        maxRecordBytes: 0,
        walBytes: 0,
        indexBytes: 0,
        backupBytes: 0,
        limits: { recordBytes: 16 * 1024 * 1024, walBytes: 128 * 1024 * 1024 },
      },
      space: { backupRequired: 0, rootRequired: 0 },
    };
    const status = diagnosis.status.status;
    if (status !== "current" && status !== "migration-required")
      return storageMigrationPlanSchema.parse({
        ...diagnosis.status,
        ...empty,
        planFingerprint: fingerprintOf(source, registry, []),
        applicable: false,
      });
    const plan = planMigration(source, diagnosis, registry);
    if (status === "current")
      return storageMigrationPlanSchema.parse({
        ...diagnosis.status,
        ...empty,
        planFingerprint: plan.fingerprint,
        applicable: true,
      });
    let prepared: PreparedMigration;
    try {
      prepared = await prepareMigration({
        source,
        target,
        registry,
        steps: plan.steps,
        profileStep: plan.profileStep,
        owned,
        ...(hooks.limits ? { limits: hooks.limits } : {}),
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const nested = (error.details as { blockers?: unknown[] } | undefined)?.blockers;
      const blockers = (
        Array.isArray(nested) && nested.length ? nested : [blockerOf(error)]
      ) as StorageStatus["blockers"];
      return storageMigrationPlanSchema.parse({
        ...diagnosis.status,
        status: statusOfBlockers(blockers),
        blockers: blockers.slice(0, 50),
        blockersTotal: blockers.length,
        ...empty,
        planFingerprint: plan.fingerprint,
        applicable: false,
      });
    }
    owned();
    return storageMigrationPlanSchema.parse({
      ...diagnosis.status,
      steps: prepared.steps,
      profiles: { from: source.profile, to: registry.profile.version },
      changes: prepared.changesSummary,
      removedByRule: prepared.removedByRule,
      budgets: { ...prepared.budgets, backupBytes: backupBytes(source) },
      space: {
        backupRequired: backupRequiredBytes(source),
        rootRequired: prepared.rootRequired,
      },
      planFingerprint: plan.fingerprint,
      applicable: true,
    });
  });
}
