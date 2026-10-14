# Явная миграция хранилища из checkout

`migrate-storage.mts` вызывает публичный API Core
`application/storage/maintenance.ts` (`inspectStorage`, `planStorageMigration`,
`migrateStorage`) — ту же реализацию, что `npx @oim-dev/relay-cli --local storage status|migrate`.
Собственных правил переноса у runner нет.

```sh
# Диагностика без изменений
node --conditions=tasks-source --import tsx packages/core/scripts/migrate-storage.mts \
  --project /absolute/path/to/project-copy --status
# Точный план в памяти; база не меняется, backup не создаётся
node --conditions=tasks-source --import tsx packages/core/scripts/migrate-storage.mts \
  --project /absolute/path/to/project-copy --dry-run
# Перенос с внешней резервной копией и проверкой отпечатка плана
node --conditions=tasks-source --import tsx packages/core/scripts/migrate-storage.mts \
  --project /absolute/path/to/project-copy --backup-dir /backups/relay --if-plan PLAN_FINGERPRINT
```

`--config` принимает файл конфигурации любого имени вместо `--project`. `--backup-dir`
обязателен для изменяющего переноса и должен находиться вне базы и Git-рабочей копии;
при no-op копия не создаётся. Продолжение незавершённой миграции выполняется без
`--backup-dir`: используется проверенная копия, записанная в WAL. Результат — JSON по схемам
`@relay/contracts/storage-maintenance`. Exit code совпадает с CLI: 0 — успешный исход
(`current`/`migration-required`, применимый dry-run, перенос или no-op); статусы
`invalid`, `unsupported`, `recovery-required`, неприменимый dry-run и ошибка переноса дают
`{ "ok": false, "error": { code, message, details } }` и код из
`STORAGE_MAINTENANCE_ERROR_EXIT_CODES`.

Сначала запускайте на отдельной копии и остановите процессы Relay, работающие с базой.
Порядок исполнения, состав резервной копии и восстановление описаны в
[FORMAT](../docs/FORMAT.md) и [руководстве по восстановлению](../../../docs/guides/RECOVERY.md).
