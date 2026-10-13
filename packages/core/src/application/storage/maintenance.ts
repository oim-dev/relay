import { STORAGE_MAINTENANCE_ERROR_EXIT_CODES } from "@relay/contracts/storage-maintenance";
import type {
  StorageMaintenanceErrorCode,
  StorageMigrateOptions,
  StorageMigrationPlan,
  StorageMigrationResult,
  StorageStatus,
} from "@relay/contracts/storage-maintenance";
import { AppError } from "../../shared/errors.js";
import {
  executeMigration,
  inspectMigrationStatus,
  planMigrationDryRun,
} from "../../storage/data-model/executor.js";
import type { MigrationHooks } from "../../storage/data-model/executor.js";

/**
 * Публичный API обслуживания хранилища Core: status, dry-run и migrate.
 *
 * Единственная реализация для CLI (`storage status|migrate`) и runner
 * `packages/core/scripts/migrate-storage.mts`. Вход — путь файла конфигурации (любого имени)
 * или каталога базы; текущая схема проекта не применяется, `Workspace` не открывается.
 * Поиск конфигурации вверх по каталогам и выбор проекта выполняет вызывающий (project-runtime).
 * Транспорт не оформляется: результат — объекты схем `@relay/contracts/storage-maintenance`,
 * ошибки — `AppError` с кодом и details по `storageErrorDetailsSchema`.
 */

export type MaintenanceTarget = {
  /** Абсолютный путь файла конфигурации проекта (может отсутствовать при pending WAL). */
  readonly configPath: string;
};
export type MaintenanceHooks = MigrationHooks;
export type { StorageMigrateOptions };

/** Полная диагностика без recovery, миграции, reindex и создания постоянных файлов. */
export function inspectStorage(
  target: MaintenanceTarget,
  hooks: MaintenanceHooks = {},
): Promise<StorageStatus> {
  return inspectMigrationStatus(target.configPath, hooks);
}

/**
 * `storage migrate --dry-run`: точный план с изолированной подготовкой в памяти.
 * Неприменимый план возвращается с `applicable: false`, статусом и блокерами.
 */
export function planStorageMigration(
  target: MaintenanceTarget,
  hooks: MaintenanceHooks = {},
): Promise<StorageMigrationPlan> {
  return planMigrationDryRun(target.configPath, hooks);
}

/**
 * `storage migrate`: изменяющий перенос до целевого профиля одной публикацией WAL.
 * No-op на текущем профиле без backup и изменений; изменяющий план требует `backupDir`;
 * незавершённая собственная миграция продолжается из WAL с её проверенным backup.
 */
export function migrateStorage(
  target: MaintenanceTarget,
  options: StorageMigrateOptions = {},
  hooks: MaintenanceHooks = {},
): Promise<StorageMigrationResult> {
  return executeMigration(target.configPath, options, hooks);
}

const UNSUPPORTED: readonly StorageMaintenanceErrorCode[] = [
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_TRANSITION_MISSING",
  "UNKNOWN_ENTITY_KIND",
  "STORAGE_FORMAT_UNKNOWN",
];

/**
 * Ненулевой исход диагностики (ТЗ §7): `status` вне current/migration-required или
 * неприменимый dry-run → AppError с машинной причиной, exit code из общей таблицы Contracts
 * и полным отчётом в details; null — успешный исход (exit 0). Правило совпадает с CLI
 * `storage status|migrate --dry-run`.
 */
export function maintenanceFailure(
  report: StorageStatus | StorageMigrationPlan,
  message: string,
): AppError | null {
  const applicable = "applicable" in report ? report.applicable : true;
  const ready = report.status === "current" || report.status === "migration-required";
  if (ready && applicable) return null;
  let code: StorageMaintenanceErrorCode;
  if (report.status === "recovery-required") code = "STORAGE_RECOVERY_REQUIRED";
  else if (report.status === "unsupported")
    code =
      report.pending?.kind === "unknown"
        ? "STORAGE_VERSION_UNSUPPORTED"
        : (report.blockers.find((blocker) => UNSUPPORTED.includes(blocker.code))?.code ??
          "STORAGE_FORMAT_UNKNOWN");
  else code = report.blockers[0]?.code ?? "STORAGE_FORMAT_UNKNOWN";
  return new AppError(code, message, STORAGE_MAINTENANCE_ERROR_EXIT_CODES[code], report);
}
