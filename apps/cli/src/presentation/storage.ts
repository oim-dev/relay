import type {
  StorageBlocker,
  StorageMigrationPlan,
  StorageMigrationResult,
  StorageMigrationStep,
  StorageStatus,
  StorageWarning,
} from "@relay/contracts/storage-maintenance";
import { STORAGE_CLI } from "@relay/core/storage/data-model/errors";
import { cardText, commandText } from "./common.js";
import type { OutputCommand, OutputField, OutputSection } from "./common.js";
import type { TextOptions } from "./theme.js";
import { safeText } from "./safe.js";
import { wrap } from "./layout.js";

export type Invocation = (args: readonly string[]) => string;

const STATUS_TITLES: Record<StorageStatus["status"], string> = {
  current: "Хранилище актуально — перенос не требуется",
  "migration-required": "Требуется перенос хранилища",
  "recovery-required": "Требуется завершить незавершённую транзакцию",
  unsupported: "Версия или формат хранилища не поддерживаются этой версией Relay",
  invalid: "Хранилище повреждено или несогласовано",
};

const LAYOUTS: Record<NonNullable<StorageStatus["layout"]>, string> = {
  legacy: "legacy — прежние репозитории",
  "unified-1": "единое хранилище, формат 1",
  "unified-2": "единое хранилище, формат 2",
  "unified-3": "единое хранилище, формат 3",
  "unified-4": "единое хранилище, формат 4",
};

const PENDING: Record<NonNullable<StorageStatus["pending"]>["kind"], string> = {
  operation: "обычная операция",
  migration: "миграция данных",
  legacy: "журнал прежних репозиториев",
  unknown: "журнал неизвестной версии",
};

export function storageStatusTitle(status: StorageStatus): string {
  return STATUS_TITLES[status.status];
}

/** Подсказка Core с плейсхолдером `<config>` получает фактический вызов; JSON не меняется. */
export function localizeStorageCommand(text: string, command?: string): string {
  return command ? text.replaceAll(STORAGE_CLI, command) : text;
}

/** Команда в прозе: префикс CLI и аргументы до первого русского слова, `;` или конца. */
const EMBEDDED_COMMAND =
  /npx @oim-dev\/relay-cli(?:@\S+)?(?:[ \t]+(?:<[^>\n]*>|'(?:[^']|'\\'')*'|[^\s;<>'\p{Script=Cyrillic}][^\s;<>]*))*/gu;

/**
 * Следующее действие: проза переносится по ширине, встроенные команды выводятся отдельными
 * строками целиком, чтобы их можно было скопировать.
 */
export function storageNextText(text: string, width: number, command?: string): string {
  const localized = localizeStorageCommand(text, command);
  const lines: string[] = [];
  let last = 0;
  // Связки между командами («; затем выполните:») — отдельная фраза с заглавной буквы.
  const prose = (part: string) => {
    const text = part.replace(/^[\s;,.]+/, "").trim();
    if (text) lines.push(wrap(safeText(text.charAt(0).toUpperCase() + text.slice(1)), width));
  };
  for (const match of localized.matchAll(EMBEDDED_COMMAND)) {
    prose(localized.slice(last, match.index));
    lines.push(commandText(match[0]));
    last = match.index + match[0].length;
  }
  prose(localized.slice(last));
  return lines.join("\n");
}

function indent(text: string, width: number): string {
  return wrap(safeText(text), width - 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function lineWidth(options: TextOptions): number {
  return Number.isFinite(options.width)
    ? Math.max(24, Math.min(160, Math.floor(options.width)))
    : 100;
}

function ownersText(status: StorageStatus, options: TextOptions): string {
  const width = lineWidth(options);
  return Object.entries(status.current.owners)
    .map(([kind, owner]) => {
      const versions = Object.entries(owner.versions)
        .map(
          ([version, count]) =>
            `версия ${version}: действующих ${count.live}, надгробий ${count.tombstones}`,
        )
        .join("; ");
      const target = owner.target === "removed" ? "удаляется переходом" : `цель ${owner.target}`;
      return `${wrap(safeText(kind), width)}\n${indent(`${versions || "записей нет"}; ${target}`, width)}`;
    })
    .join("\n");
}

function blockersText(
  blockers: readonly StorageBlocker[],
  total: number,
  options: TextOptions,
  command?: string,
): string {
  const width = lineWidth(options);
  const items = blockers.map((blocker) => {
    const where = [
      blocker.path && `путь ${blocker.path}`,
      blocker.owner && `вид ${blocker.owner}`,
      blocker.id && `ID ${blocker.id}`,
      blocker.step && `шаг ${blocker.step}`,
      blocker.current !== undefined && `фактически ${blocker.current}`,
      blocker.expected !== undefined && `ожидается ${blocker.expected}`,
    ].filter(Boolean);
    return [
      wrap(safeText(`${blocker.code} — ${blocker.message}`), width),
      ...(where.length ? [indent(where.join(", "), width)] : []),
      `  Действие:\n${storageNextText(blocker.next, width, command)}`,
    ].join("\n");
  });
  if (total > blockers.length)
    items.push(wrap(`Показано ${blockers.length} из ${total} блокеров.`, width));
  return items.join("\n\n");
}

function warningsText(warnings: readonly StorageWarning[], options: TextOptions): string {
  const width = lineWidth(options);
  return warnings
    .map((warning) =>
      [
        wrap(safeText(`${warning.code} — ${warning.message}`), width),
        ...(warning.path ? [indent(`путь ${warning.path}`, width)] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

function versionFields(status: StorageStatus): OutputField[] {
  const envelope = status.current.envelope.join(", ");
  return [
    ["Раскладка", status.layout ? LAYOUTS[status.layout] : "не распознана"],
    ["Физический формат", `${status.current.physical ?? "нет маркера"} → 4`],
    ["Профиль данных", `${status.current.dataModel ?? "не задан"} → ${status.target.dataModel}`],
    ["Версии оболочки записей", envelope || "записей нет"],
  ];
}

function statusCommands(status: StorageStatus, invocation: Invocation): OutputCommand[] {
  switch (status.status) {
    case "current":
      return [
        {
          label: "Проверить целостность проекта",
          command: invocation(["doctor", "check"]),
        },
      ];
    case "migration-required":
      return [
        {
          label: "Остановите процессы Relay и проверьте точный план без изменения базы",
          command: invocation(["storage", "migrate", "--dry-run"]),
        },
        {
          label: "Затем выполните перенос с резервной копией вне базы и отпечатком плана",
          command: invocation([
            "storage",
            "migrate",
            "--backup-dir",
            "DIR",
            "--if-plan",
            "PLAN_FINGERPRINT",
          ]),
        },
      ];
    case "recovery-required":
      return [
        {
          label: "Остановите процессы Relay и завершите незавершённую транзакцию",
          command: invocation(["storage", "migrate"]),
        },
        {
          label: "После этого повторите диагностику",
          command: invocation(["storage", "status"]),
        },
      ];
    default:
      return [
        {
          label: "Устраните причины из списка блокеров и повторите диагностику",
          command: invocation(["storage", "status"]),
        },
      ];
  }
}

export function storageStatusText(
  status: StorageStatus,
  invocation: Invocation,
  options: TextOptions,
): string {
  const sections: OutputSection[] = [
    { title: "Владельцы и версии данных", body: ownersText(status, options) },
    {
      title: "Блокеры",
      body: blockersText(status.blockers, status.blockersTotal, options, invocation([])),
    },
    { title: "Предупреждения", body: warningsText(status.warnings, options) },
  ];
  return cardText(
    {
      title: storageStatusTitle(status),
      fields: [
        ["Статус", status.status],
        ["Проект", status.project.id ?? "не задан"],
        ["Конфигурация", status.project.configPath],
        ["Корень базы", status.project.root],
        ["Каталог legacy-данных", status.project.storageRoot],
        ...versionFields(status),
        ["Файлов", status.counts.files],
        ["Байт", status.counts.bytes],
        [
          "Незавершённая транзакция",
          status.pending ? `${PENDING[status.pending.kind]}, ${status.pending.path}` : "нет",
        ],
        ["База не изменялась", "да"],
      ],
      sections,
      commands: statusCommands(status, invocation),
    },
    options,
  );
}

function filesText(plan: StorageMigrationPlan, options: TextOptions): string {
  const width = lineWidth(options);
  return Object.entries(plan.changes.files)
    .map(([category, count]) =>
      wrap(
        safeText(
          `${category}: файлов создать ${count.create}, изменить ${count.update}, удалить ${count.delete}`,
        ),
        width,
      ),
    )
    .join("\n");
}

const STEP_TYPES: Record<StorageMigrationStep["type"], string> = {
  physical: "перенос раскладки в формат 4",
  record: "переход записей N → N+1",
  snapshot: "переход над согласованным снимком",
  profile: "метка профиля данных",
};

function stepTitle(step: StorageMigrationStep): string {
  const profile = /^profile\.(\d+)-to-(\d+)$/.exec(step.id);
  if (step.type === "profile" && profile)
    return `Метка профиля данных ${profile[1]} → ${profile[2]} (${step.id}, версия ${step.version})`;
  return `${step.id} — ${STEP_TYPES[step.type]} (версия ${step.version})`;
}

function stepsText(steps: readonly StorageMigrationStep[], options: TextOptions): string {
  const width = lineWidth(options);
  return steps
    .map((step, index) =>
      [
        wrap(safeText(`${index + 1}. ${stepTitle(step)}`), width),
        indent(
          `Владельцы: ${step.owners.join(", ") || "нет"}; записей проверено ${step.records.checked}, изменено ${step.records.changed}, удалено по правилу ${step.records.removed}`,
          width,
        ),
      ].join("\n"),
    )
    .join("\n");
}

function countersText(result: StorageMigrationResult, options: TextOptions): string {
  const width = lineWidth(options);
  return Object.entries(result.counts.owners)
    .map(([category, count]) =>
      wrap(
        safeText(
          `${category}: проверено ${count.checked}, изменено файлов ${count.changed}, удалено по правилу ${count.removedByRule}`,
        ),
        width,
      ),
    )
    .join("\n");
}

export function storagePlanText(
  plan: StorageMigrationPlan,
  invocation: Invocation,
  options: TextOptions,
): string {
  // Пустой список шагов при migration-required — только маркер профиля: перенос всё равно нужен.
  const empty = plan.status === "current";
  return cardText(
    {
      title: !plan.applicable
        ? "План переноса неприменим — база не изменена"
        : empty
          ? "Перенос не требуется — план пуст, база не изменена"
          : "План переноса построен — база не изменена",
      fields: [
        ["Статус", plan.status],
        ["Проект", plan.project.id ?? "не задан"],
        ["Конфигурация", plan.project.configPath],
        ["Корень базы", plan.project.root],
        ["Профиль", `${plan.profiles.from ?? "до профилей"} → ${plan.profiles.to}`],
        ...versionFields(plan),
        [
          "Отношения",
          `сохраняются ${plan.changes.relations.kept}, отзываются ${plan.changes.relations.revoked}, создаются ${plan.changes.relations.created}`,
        ],
        [
          "Адреса",
          `резервов сохраняется ${plan.changes.addresses.reservedKept}, перенаправляется ${plan.changes.addresses.relocated}`,
        ],
        ["Нужно места для backup, байт", plan.space.backupRequired],
        ["Нужно места в корне базы, байт", plan.space.rootRequired],
        ["Отпечаток плана", plan.planFingerprint],
        ["Резервная копия", "при --dry-run не создаётся"],
      ],
      sections: [
        { title: "Шаги", body: stepsText(plan.steps, options) },
        { title: "Изменения файлов по категориям", body: filesText(plan, options) },
        {
          title: "Удаляется по правилу перехода (сохраняется в backup)",
          body: plan.removedByRule
            .map((item) => `${item.category}: ${item.count} (${item.bytes} байт)`)
            .join("\n"),
        },
        {
          title: "Блокеры",
          body: blockersText(plan.blockers, plan.blockersTotal, options, invocation([])),
        },
        { title: "Предупреждения", body: warningsText(plan.warnings, options) },
      ],
      commands: !plan.applicable
        ? [
            {
              label: "Устраните блокеры и повторите диагностику",
              command: invocation(["storage", "status"]),
            },
          ]
        : empty
          ? []
          : [
              {
                label: "Применить именно этот план с резервной копией вне базы",
                command: invocation([
                  "storage",
                  "migrate",
                  "--backup-dir",
                  "DIR",
                  "--if-plan",
                  plan.planFingerprint,
                ]),
              },
            ],
    },
    options,
  );
}

export function storageMigrationText(
  result: StorageMigrationResult,
  configPath: string,
  invocation: Invocation,
  options: TextOptions,
): string {
  return cardText(
    {
      title: result.migrated
        ? result.resumed
          ? "Незавершённый перенос продолжен и завершён"
          : "Хранилище перенесено"
        : "Перенос не требуется — хранилище не изменено",
      fields: [
        ["Формат", result.format],
        ["Физический формат", result.schemaVersion],
        ["Профиль", `${result.profiles.from ?? "до профилей"} → ${result.profiles.to}`],
        ["Записей сущностей", result.entities],
        [
          "Проверено",
          `${result.counts.checked} (записи с надгробиями, наборы отношений и keyspaces)`,
        ],
        [
          "Изменено файлов",
          `${result.counts.changed} (созданы, изменены или удалены в постоянном наборе)`,
        ],
        ["Удалено по правилу", `${result.counts.removedByRule} исторических структур`],
        ["Отпечаток плана", result.planFingerprint],
        ["Резервная копия", result.backup?.path ?? "не создавалась"],
        ["SHA-256 backup-manifest.json", result.backup?.manifestSha256],
        ["Конфигурация", configPath],
      ],
      sections: [
        { title: "Выполненные шаги", body: stepsText(result.steps, options) },
        { title: "Счётчики по категориям", body: countersText(result, options) },
      ],
      commands: [
        {
          label: "Проверить состояние хранилища",
          command: invocation(["storage", "status"]),
        },
        {
          label: "Проверить целостность после обслуживания",
          command: invocation(["doctor", "check"]),
        },
      ],
    },
    options,
  );
}
