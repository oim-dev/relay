import { z } from "zod";
import { entityRefSchema } from "./entities/graph.js";

/**
 * Переносимые результаты обслуживания хранилища: status, dry-run и migrate.
 * Схемы описывают ответ Core/CLI; правила переходов, чтение диска и публикация принадлежат Core.
 * REST эти схемы не использует: миграция выполняется только локальным CLI или runner.
 */

/** Коды ошибок совместимости и обслуживания хранилища с exit code CLI. */
export const STORAGE_MAINTENANCE_ERROR_EXIT_CODES = {
  STORAGE_MIGRATION_REQUIRED: 4,
  STORAGE_DATA_MIGRATION_REQUIRED: 4,
  STORAGE_VERSION_UNSUPPORTED: 4,
  STORAGE_TRANSITION_MISSING: 4,
  UNKNOWN_ENTITY_KIND: 4,
  STORAGE_FORMAT_UNKNOWN: 4,
  STORAGE_REGISTRY_INVALID: 5,
  STORAGE_TRANSITION_OUTPUT_INVALID: 5,
  STORAGE_DATA_CORRUPT: 5,
  STORAGE_RECORD_MISSING: 5,
  STORAGE_FORMAT_MISSING: 5,
  STORAGE_ADDRESS_COLLISION: 4,
  STORAGE_MIGRATION_CONFLICT: 4,
  STORAGE_REFERENCE_BROKEN: 4,
  STORAGE_PLAN_STALE: 4,
  STORAGE_BUSY: 4,
  LOCK_LOST: 4,
  STORAGE_RECOVERY_REQUIRED: 4,
  STORAGE_RECOVERY_CONFLICT: 5,
  STORAGE_INDEX_STALE: 4,
  STORAGE_BACKUP_FAILED: 5,
  STORAGE_BACKUP_MISSING: 5,
  STORAGE_UNSAFE_PATH: 2,
  STORAGE_BACKUP_REQUIRED: 2,
  STORAGE_INSUFFICIENT_SPACE: 4,
  STORAGE_LIMIT_EXCEEDED: 4,
  LOCAL_REQUIRED: 2,
  ENTITY_RELOCATED: 3,
} as const;
export type StorageMaintenanceErrorCode = keyof typeof STORAGE_MAINTENANCE_ERROR_EXIT_CODES;
export const storageMaintenanceErrorCodeSchema = z
  .enum(
    Object.keys(STORAGE_MAINTENANCE_ERROR_EXIT_CODES) as [
      StorageMaintenanceErrorCode,
      ...StorageMaintenanceErrorCode[],
    ],
  )
  .describe("Машинная причина ошибки совместимости или обслуживания хранилища");

/** Причина ошибки реестра переходов в `details.reason` кода `STORAGE_REGISTRY_INVALID`. */
export const storageRegistryIssueSchema = z
  .enum([
    "duplicate-id",
    "invalid-id",
    "invalid-version",
    "non-adjacent",
    "non-monotonic",
    "cycle",
    "ambiguous",
    "gap",
    "deadlock",
    "unknown-dependency",
    "unknown-kind",
    "collection-conflict",
    "profile-invalid",
    "profile-mismatch",
    "output-mismatch",
    "removed-current",
    "beyond-target",
    "physical-duplicate",
  ])
  .describe(
    "Вид ошибки реестра: повтор ID, недопустимый ID, неверная версия, шаг не N→N+1, немонотонный выход, цикл, два перехода из одной версии, разрыв цепочки, взаимная блокировка шагов, неизвестная зависимость или вид, конфликт коллекций, неверный профиль, расхождение профиля с владельцами, несовместимый выход шага, удаление текущего вида, версия выше целевой, повтор физического перехода",
  );

const nonNegative = z.number().int().nonnegative();
const kindSchema = entityRefSchema.shape.kind;
const versionKeySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .describe("Версия данных владельца десятичной строкой");
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Ожидается безопасный относительный путь",
  )
  .describe("Путь относительно корня базы или каталога legacy-данных, без абсолютной части");
const nextSchema = z
  .string()
  .min(1)
  .max(512)
  .describe("Следующее действие пользователя: команда или шаг на русском языке");
const stepIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,127}$/)
  .describe("Стабильный ID определения перехода");

export const storageLayoutSchema = z
  .enum(["legacy", "unified-1", "unified-2", "unified-3", "unified-4"])
  .describe(
    "Исходная раскладка: legacy — прежние репозитории до единого хранилища, unified-N — физический формат N единого хранилища",
  );
export const storageStatusKindSchema = z
  .enum(["current", "migration-required", "recovery-required", "unsupported", "invalid"])
  .describe(
    "Итог диагностики: current — актуально, migration-required — есть применимый план, recovery-required — есть незавершённый WAL, unsupported — версия или формат не поддерживаются, invalid — база повреждена",
  );

export const storageVersionCountSchema = z
  .strictObject({
    live: nonNegative.describe("Число действующих записей этой версии"),
    tombstones: nonNegative.describe("Число надгробий этой версии"),
  })
  .describe("Количество записей одной версии данных");
export const storageOwnerVersionsSchema = z
  .strictObject({
    versions: z
      .record(versionKeySchema, storageVersionCountSchema)
      .describe("Фактические версии данных владельца на диске и количества записей"),
    target: z
      .union([z.number().int().positive(), z.literal("removed")])
      .describe("Целевая версия текущего профиля; removed — исторический вид удаляется переходом"),
  })
  .describe("Версии одного владельца");
export const storageVersionsSchema = z
  .strictObject({
    physical: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Физический формат storage.json.schemaVersion; null — маркера нет (legacy)"),
    dataModel: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Профиль модели данных; null — поле отсутствует в manifest"),
    envelope: z
      .array(z.number().int().positive())
      .describe("Найденные версии общей оболочки записей по возрастанию"),
    owners: z
      .record(kindSchema, storageOwnerVersionsSchema)
      .describe("Версии и количества по видам записей"),
  })
  .describe("Фактические версии постоянного набора");

export const storageBlockerSchema = z
  .strictObject({
    code: storageMaintenanceErrorCodeSchema,
    message: z
      .string()
      .min(1)
      .max(1024)
      .describe("Причина на русском без пользовательского текста"),
    owner: kindSchema.optional().describe("Вид записи или владелец, к которому относится причина"),
    step: stepIdSchema.optional().describe("Переход, при подготовке которого найдена причина"),
    path: relativePathSchema.optional(),
    id: z.string().min(1).max(256).optional().describe("ID записи, ребра или файла"),
    current: z
      .union([z.number().int(), z.string().max(64)])
      .optional()
      .describe("Фактическая версия или значение"),
    expected: z
      .union([z.number().int(), z.string().max(64)])
      .optional()
      .describe("Ожидаемая или поддерживаемая версия"),
    next: nextSchema,
  })
  .describe("Блокер, из-за которого миграция неприменима");
export const storageWarningSchema = z
  .strictObject({
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .describe("Машинный код предупреждения"),
    message: z.string().min(1).max(1024).describe("Пояснение на русском"),
    path: relativePathSchema.optional(),
  })
  .describe(
    "Предупреждение, не блокирующее миграцию (например, посторонний файл вне управляемой области сохраняется)",
  );

export const storageProjectSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(256)
      .nullable()
      .describe("ID проекта из конфигурации; null — не задан"),
    configPath: z.string().min(1).describe("Абсолютный путь файла конфигурации"),
    root: z.string().min(1).describe("Реальный корень базы после разрешения symlink"),
    storageRoot: z
      .string()
      .min(1)
      .optional()
      .describe("Реальный каталог прежних legacy-данных, если он отличается от корня"),
  })
  .describe("Идентичность обслуживаемого проекта");
export const storagePendingSchema = z
  .strictObject({
    kind: z
      .enum(["operation", "migration", "legacy", "unknown"])
      .describe(
        "Вид незавершённого WAL: operation — обычная операция, migration — миграция данных, legacy — прежний журнал, unknown — неизвестная версия",
      ),
    path: relativePathSchema,
  })
  .describe("Незавершённая транзакция, требующая recovery");

export const storageStatusSchema = z
  .strictObject({
    status: storageStatusKindSchema,
    project: storageProjectSchema,
    layout: storageLayoutSchema.nullable().describe("Исходная раскладка; null — не распознана"),
    current: storageVersionsSchema,
    target: z
      .strictObject({
        dataModel: z.number().int().positive().describe("Целевой профиль модели данных"),
        owners: z
          .record(kindSchema, z.number().int().positive())
          .describe("Целевые версии данных владельцев текущего профиля"),
      })
      .describe("Целевые версии поставляемого Relay"),
    counts: z
      .strictObject({
        files: nonNegative.describe("Число файлов управляемой области"),
        bytes: nonNegative.describe("Суммарный размер файлов управляемой области в байтах"),
      })
      .describe("Объём проверенного постоянного набора"),
    pending: storagePendingSchema.nullable().describe("Незавершённый WAL; null — нет"),
    blockers: z.array(storageBlockerSchema).max(50).describe("Первые блокеры (не более 50)"),
    blockersTotal: nonNegative.describe("Полное число найденных блокеров"),
    warnings: z.array(storageWarningSchema).max(50).describe("Первые предупреждения (не более 50)"),
  })
  .describe("Полная диагностика хранилища без изменения постоянных данных");

export const storageRecordCountsSchema = z
  .strictObject({
    checked: nonNegative.describe("Записи и наборы, прошедшие полную проверку схемой"),
    changed: nonNegative.describe("Записи и наборы, изменённые шагом"),
    removed: nonNegative.describe("Записи, удалённые шагом по правилу перехода"),
  })
  .describe("Счётчики записей шага");
export const storageMigrationStepSchema = z
  .strictObject({
    id: stepIdSchema,
    version: z.number().int().positive().describe("Версия определения перехода"),
    type: z
      .enum(["physical", "record", "snapshot", "profile"])
      .describe(
        "Вид перехода: physical — составной перенос раскладки в формат 4, record — N→N+1 одной записи, snapshot — переход над согласованным снимком, profile — публикация маркера профиля (ID profile.<из>-to-<в>) с полной перепроверкой и перестроением индексов",
      ),
    owners: z.array(kindSchema).describe("Затрагиваемые владельцы в порядке ID"),
    records: storageRecordCountsSchema,
  })
  .describe("Шаг плана в порядке исполнения");

export const storageFileChangeCountsSchema = z
  .strictObject({
    create: nonNegative.describe("Создаваемые файлы"),
    update: nonNegative.describe("Изменяемые файлы"),
    delete: nonNegative.describe("Удаляемые файлы"),
  })
  .describe("Количество файловых изменений категории");
const categorySchema = z
  .string()
  .regex(/^[a-z][a-z0-9/-]{0,127}$/)
  .describe(
    "Категория файлов: entities/<вид>, relations, keyspaces, config, manifest, indexes, legacy-source, release-snapshot, release-snapshot-entry и другие",
  );
export const storageRemovedByRuleSchema = z
  .strictObject({
    category: categorySchema,
    count: nonNegative.describe("Число удаляемых распознанных структур"),
    bytes: nonNegative.describe("Их суммарный размер в байтах; полностью сохраняются в backup"),
  })
  .describe("Распознанные исторические структуры, удаляемые по правилу перехода");

export const storageMigrationPlanSchema = storageStatusSchema
  .extend({
    steps: z.array(storageMigrationStepSchema).describe("Упорядоченные шаги перехода"),
    profiles: z
      .strictObject({
        from: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe("Исходный профиль; null — до профилей"),
        to: z.number().int().positive().describe("Целевой профиль"),
      })
      .describe("Исходный и целевой профили модели данных"),
    changes: z
      .strictObject({
        files: z
          .record(categorySchema, storageFileChangeCountsSchema)
          .describe("Создаваемые, изменяемые и удаляемые файлы по категориям"),
        relations: z
          .strictObject({
            kept: nonNegative.describe("Рёбра без изменений"),
            revoked: nonNegative.describe("Рёбра, переведённые в неактивные с сохранением ID"),
            created: nonNegative.describe("Новые рёбра с детерминированным ID"),
          })
          .describe("Изменения явных отношений"),
        addresses: z
          .strictObject({
            reservedKept: nonNegative.describe("Сохранённые резервы ключей и алиасов"),
            relocated: nonNegative.describe("Прежние адреса, перенаправленные на нового владельца"),
          })
          .describe("Изменения адресов"),
      })
      .describe("Изменения постоянного набора"),
    removedByRule: z.array(storageRemovedByRuleSchema).describe("Удаляемые исторические структуры"),
    budgets: z
      .strictObject({
        maxRecordBytes: nonNegative.describe(
          "Наибольшая подготовленная запись без комментариев, байт",
        ),
        walBytes: nonNegative.describe("Размер пакета WAL, байт"),
        indexBytes: nonNegative.describe("Размер стейджируемых страниц индекса, байт"),
        backupBytes: nonNegative.describe("Размер резервной копии, байт"),
        limits: z
          .strictObject({
            recordBytes: z.number().int().positive().describe("Предел записи, байт"),
            walBytes: z.number().int().positive().describe("Предел пакета WAL, байт"),
          })
          .describe("Действующие пределы"),
      })
      .describe("Оценка бюджетов до любых изменений"),
    space: z
      .strictObject({
        backupRequired: nonNegative.describe("Требуемое свободное место для backup, байт"),
        rootRequired: nonNegative.describe("Требуемое свободное место в корне базы, байт"),
      })
      .describe("Оценка свободного места"),
    planFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe(
        "Отпечаток плана: реестр переходов и полный состав и содержание источников; для --if-plan",
      ),
    applicable: z.boolean().describe("План применим: нет блокеров и recovery"),
  })
  .describe("Точный план миграции, построенный изолированно без изменения базы");

export const storageMigrationCountersSchema = z
  .strictObject({
    checked: nonNegative.describe(
      "Записи и наборы отношений, прошедшие полную проверку текущими схемами после переноса",
    ),
    changed: nonNegative.describe("Файлы, байтовое содержание которых изменилось после публикации"),
    removedByRule: nonNegative.describe("Удалённые распознанные исторические структуры"),
  })
  .describe("Счётчики результата");

export const storageMigrationResultSchema = z
  .strictObject({
    migrated: z.boolean().describe("Изменён ли постоянный набор; false — подтверждённый no-op"),
    format: z.literal("relay-entities").describe("Итоговый маркер единого хранилища"),
    schemaVersion: z.literal(4).describe("Итоговый физический формат"),
    entities: nonNegative.describe(
      "Число действующих записей сущностей после переноса: все виды реестра без надгробий и без технических владельцев (scope, адреса совместимости plan-stage)",
    ),
    operations: z
      .literal(0)
      .describe("Совместимое поле прежнего результата; квитанции операций не переносятся"),
    resumed: z.boolean().describe("Миграция продолжена из собственного незавершённого WAL"),
    profiles: z
      .strictObject({
        from: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe("Исходный профиль; null — до профилей"),
        to: z.number().int().positive().describe("Итоговый профиль"),
      })
      .describe("Профили модели данных до и после"),
    steps: z.array(storageMigrationStepSchema).describe("Выполненные шаги в порядке исполнения"),
    planFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("Отпечаток исполненного плана"),
    counts: storageMigrationCountersSchema.extend({
      owners: z
        .record(z.string().regex(/^[a-z][a-z0-9/-]{0,127}$/), storageMigrationCountersSchema)
        .describe(
          "Те же счётчики по видам записей и категориям файлов (relations, keyspaces, config, manifest)",
        ),
    }),
    checks: z
      .strictObject({
        schemas: z.literal("passed").describe("Все записи прошли текущие схемы"),
        references: z.literal("passed").describe("Ссылки и отношения согласованы"),
        addresses: z.literal("passed").describe("ID, ключи и алиасы уникальны"),
        indexes: z.literal("passed").describe("Индексы построены заново и согласованы"),
        budgets: z.literal("passed").describe("Пределы записи и WAL соблюдены"),
      })
      .describe("Результат обязательных проверок до публикации"),
    backup: z
      .strictObject({
        path: z.string().min(1).describe("Абсолютный путь каталога резервной копии"),
        manifestSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .describe("SHA-256 файла backup-manifest.json"),
      })
      .nullable()
      .describe("Резервная копия; null — no-op без изменений"),
  })
  .describe("Результат команды storage migrate");

export const storageMigrateOptionsSchema = z
  .strictObject({
    backupDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Каталог резервной копии вне базы и Git-рабочей копии; обязателен для изменяющей миграции",
      ),
    ifPlan: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe("Ожидаемый planFingerprint; несовпадение останавливает до изменений"),
  })
  .describe("Параметры storage migrate");

export const storageErrorDetailsSchema = z
  .strictObject({
    code: storageMaintenanceErrorCodeSchema,
    reason: z
      .string()
      .max(64)
      .optional()
      .describe("Уточнение причины, например physical/profile или вид ошибки реестра"),
    step: stepIdSchema.optional().describe("Переход, к которому относится ошибка"),
    owner: kindSchema.optional().describe("Вид записи или владелец"),
    current: z
      .union([z.number().int(), z.string().max(64)])
      .optional()
      .describe("Фактическая версия"),
    expected: z
      .union([z.number().int(), z.string().max(64)])
      .optional()
      .describe("Ожидаемая версия"),
    path: relativePathSchema.optional(),
    id: z.string().min(1).max(256).optional().describe("ID записи, перехода или ребра"),
    next: nextSchema,
    blockers: z.array(storageBlockerSchema).max(50).optional().describe("Первые блокеры плана"),
  })
  .describe(
    "Форма details ошибок хранилища: коды, версии, относительные пути, ID и следующее действие без пользовательского текста и конфигурации",
  );

export type StorageLayout = z.output<typeof storageLayoutSchema>;
export type StorageStatusKind = z.output<typeof storageStatusKindSchema>;
export type StorageRegistryIssue = z.output<typeof storageRegistryIssueSchema>;
export type StorageVersions = z.output<typeof storageVersionsSchema>;
export type StorageBlocker = z.output<typeof storageBlockerSchema>;
export type StorageWarning = z.output<typeof storageWarningSchema>;
export type StorageStatus = z.output<typeof storageStatusSchema>;
export type StorageMigrationStep = z.output<typeof storageMigrationStepSchema>;
export type StorageMigrationPlan = z.output<typeof storageMigrationPlanSchema>;
export type StorageMigrationResult = z.output<typeof storageMigrationResultSchema>;
export type StorageMigrateOptions = z.output<typeof storageMigrateOptionsSchema>;
export type StorageErrorDetails = z.output<typeof storageErrorDetailsSchema>;
