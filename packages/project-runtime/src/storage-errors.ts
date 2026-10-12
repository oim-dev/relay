/**
 * Совместимость и состояние хранилища: база не пуста и не потеряна, но обычная работа
 * требует явного локального обслуживания (migrate, recovery, reindex). Такой отказ
 * определён: запись не выполнена, автоматический повтор не нужен. Общий источник для
 * HTTP-отображения Server (409) и HTTP Backend CLI/MCP.
 */
export const storageCompatibilityCodes: ReadonlySet<string> = new Set([
  "STORAGE_MIGRATION_REQUIRED",
  "STORAGE_DATA_MIGRATION_REQUIRED",
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_TRANSITION_MISSING",
  "STORAGE_FORMAT_UNKNOWN",
  "UNKNOWN_ENTITY_KIND",
  "STORAGE_ADDRESS_COLLISION",
  "STORAGE_MIGRATION_CONFLICT",
  "STORAGE_REFERENCE_BROKEN",
  "STORAGE_PLAN_STALE",
  "STORAGE_RECOVERY_REQUIRED",
  "STORAGE_RECOVERY_CONFLICT",
  "STORAGE_INDEX_STALE",
  "STORAGE_LIMIT_EXCEEDED",
]);

/** Новые причины Core семейства хранения с exit 4 относятся к тому же классу. */
export function isStorageCompatibility(code: string, exitCode?: number): boolean {
  return storageCompatibilityCodes.has(code) || (code.startsWith("STORAGE_") && exitCode === 4);
}
