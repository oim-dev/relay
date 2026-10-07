import {
  STORAGE_MAINTENANCE_ERROR_EXIT_CODES,
  storageErrorDetailsSchema,
} from "@relay/contracts/storage-maintenance";
import type {
  StorageErrorDetails,
  StorageMaintenanceErrorCode,
  StorageRegistryIssue,
} from "@relay/contracts/storage-maintenance";
import { AppError } from "../../shared/errors.js";

/**
 * Копируемый вызов обслуживания. Core не знает рабочий каталог клиента, поэтому путь
 * конфигурации — плейсхолдер `<config>`; абсолютные пути пользователя в подсказку не попадают.
 */
export const STORAGE_CLI = "npx @oim-dev/relay-cli --local --config <config>";
export const storageCommand = (args: string) => `${STORAGE_CLI} ${args}`;

/** Следующие действия по умолчанию; конкретная ошибка может передать своё. */
export const STORAGE_NEXT = {
  migrate: `Остановите процессы Relay и проверьте план: ${storageCommand("storage migrate --dry-run")}; затем выполните: ${storageCommand("storage migrate --backup-dir <каталог вне базы> --if-plan <planFingerprint>")}`,
  status: `Выполните ${storageCommand("storage status")} и устраните указанные блокеры`,
  upgrade: "Откройте базу версией Relay, которая её создала, или более новой",
  report: "Сообщите о дефекте поставки Relay: реестр переходов повреждён",
  restore: "Восстановите файл из резервной копии или обратитесь к RECOVERY",
} as const;

/** Следующее действие при WAL миграции предварительной сборки (без итога плана). */
export const PRE_RELEASE_WAL_NEXT =
  "Не запускайте обычную работу с базой. Разверните резервную копию из пути backup в transactions/pending.json в отдельный каталог по её RESTORE.md, либо завершите перенос той же сборкой Relay, которая его начала";

type Details = Omit<StorageErrorDetails, "code" | "next"> & { next?: string };

/**
 * Ошибка хранилища с exit code из общей таблицы Contracts и details по общей схеме.
 * Details содержат только коды, версии, относительные пути и ID — без текста пользователя.
 */
export function storageError(
  code: StorageMaintenanceErrorCode,
  message: string,
  details: Details = {},
): AppError {
  const value = storageErrorDetailsSchema.parse({
    code,
    ...details,
    next: details.next ?? defaultNext(code),
  });
  return new AppError(code, message, STORAGE_MAINTENANCE_ERROR_EXIT_CODES[code], value);
}

export function registryError(
  reason: StorageRegistryIssue,
  message: string,
  details: Omit<Details, "reason"> = {},
): AppError {
  return storageError("STORAGE_REGISTRY_INVALID", message, {
    ...details,
    reason,
    next: STORAGE_NEXT.report,
  });
}

function defaultNext(code: StorageMaintenanceErrorCode): string {
  switch (code) {
    case "STORAGE_MIGRATION_REQUIRED":
    case "STORAGE_DATA_MIGRATION_REQUIRED":
      return STORAGE_NEXT.migrate;
    case "STORAGE_VERSION_UNSUPPORTED":
      return STORAGE_NEXT.upgrade;
    case "STORAGE_REGISTRY_INVALID":
    case "STORAGE_TRANSITION_OUTPUT_INVALID":
      return STORAGE_NEXT.report;
    case "STORAGE_DATA_CORRUPT":
    case "STORAGE_RECORD_MISSING":
    case "STORAGE_FORMAT_MISSING":
      return STORAGE_NEXT.restore;
    case "STORAGE_RECOVERY_REQUIRED":
      return `Остановите процессы Relay и выполните ${storageCommand("storage migrate --backup-dir <каталог вне базы>")}: незавершённая транзакция будет завершена`;
    case "STORAGE_PLAN_STALE":
      return `Повторите ${storageCommand("storage migrate --dry-run")} и используйте новый отпечаток плана`;
    case "STORAGE_BUSY":
    case "LOCK_LOST":
      return "Остановите другие процессы Relay и повторите команду";
    case "STORAGE_BACKUP_REQUIRED":
      return `Повторите с резервной копией: ${storageCommand("storage migrate --backup-dir <каталог вне базы>")}`;
    case "LOCAL_REQUIRED":
      return "Повторите команду с --local и --config";
    default:
      return STORAGE_NEXT.status;
  }
}
