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
  return command ? text.replaceAll(STORAGE_CLI, () => command) : text;
}

/** Только исходный шаблон в прозе Core, никогда не готовый вызов с путём пользователя. */
const EMBEDDED_COMMAND =
  /npx @oim-dev\/relay-cli(?:@\S+)?(?:[ \t]+(?:<[^>\n]*>|'(?:[^']|'\\'')*'|[^\s;<>'\p{Script=Cyrillic}][^\s;<>]*))*/gu;

/**
 * Следующее действие: проза переносится по ширине, встроенные команды выводятся отдельными
 * строками целиком, чтобы их можно было скопировать.
 */
export function storageNextText(text: string, width: number, command?: string): string {
  const lines: string[] = [];
  let last = 0;
  // Связки между командами («; затем выполните:») — отдельная фраза с заглавной буквы.
  const prose = (part: string) => {
    const text = part.replace(/^[\s;,.]+/, "").trim();
    if (text) lines.push(wrap(safeText(text.charAt(0).toUpperCase() + text.slice(1)), width));
  };
  // Сначала выделяем команды из авторского шаблона, затем буквально вставляем invocation.
  // Повторный разбор shell-строки повредил бы ANSI-C quoting, кириллицу и `$'` в пути.
  for (const match of text.matchAll(EMBEDDED_COMMAND)) {
    prose(text.slice(last, match.index));
    const template = command ? match[0].replaceAll(STORAGE_CLI, "") : match[0];
    if (/<[^>]+>/.test(template)) prose("Шаблон команды: замените значения в <…> перед запуском.");
    lines.push(commandText(localizeStorageCommand(match[0], command)));
    last = match.index + match[0].length;
  }
  prose(text.slice(last));
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
  const groups = new Map<string, StorageBlocker[]>();
  for (const blocker of blockers) {
    const { code, message, owner, step, current, expected, next } = blocker;
    const key = JSON.stringify([code, message, owner, step, current, expected, next]);
    const group = groups.get(key);
    if (group) group.push(blocker);
    else groups.set(key, [blocker]);
  }
  const items = [...groups.values()].map((group) => {
    const blocker = group[0]!;
    const where = [
      blocker.owner && `вид ${blocker.owner}`,
      blocker.step && `шаг ${blocker.step}`,
      blocker.current !== undefined && `фактически ${blocker.current}`,
      blocker.expected !== undefined && `ожидается ${blocker.expected}`,
    ].filter(Boolean);
    return [
      wrap(safeText(`${blocker.code} — ${blocker.message}`), width),
      ...(group.length > 1 ? [`  Блокеров в группе: ${group.length}`] : []),
      ...(where.length ? [indent(where.join(", "), width)] : []),
      ...group.flatMap((item) => [
        ...(item.path ? [`  путь ${safeText(item.path)}`] : []),
        ...(item.id ? [`  ID ${safeText(item.id)}`] : []),
      ]),
      `  Действие:\n${storageNextText(blocker.next, width, command)}`,
    ].join("\n");
  });
  if (total > blockers.length)
    items.push(wrap(`Показано ${blockers.length} из ${total} блокеров.`, width));
  return items.join("\n\n");
}

/** Действие группы уже напечатано: footer не повторяет ту же готовую команду. */
function withoutBlockerCommands(
  commands: OutputCommand[],
  blockers: readonly StorageBlocker[],
  invocation: Invocation,
): OutputCommand[] {
  const shown = new Set(
    blockers.flatMap((blocker) =>
      [...blocker.next.matchAll(EMBEDDED_COMMAND)].map((match) =>
        localizeStorageCommand(match[0], invocation([])),
      ),
    ),
  );
  return commands.filter((item) => !shown.has(item.command));
}

function warningsText(
  warnings: readonly StorageWarning[],
  total: number,
  options: TextOptions,
): string {
  const width = lineWidth(options);
  const items = warnings.map((warning) =>
    [
      wrap(safeText(`${warning.code} — ${warning.message}`), width),
      ...(warning.path ? [indent(`путь ${warning.path}`, width)] : []),
    ].join("\n"),
  );
  items.push(
    wrap(
      total === 0
        ? "Предупреждений нет."
        : `Показано ${warnings.length} из ${total} предупреждений.`,
      width,
    ),
  );
  return items.join("\n\n");
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
          label:
            "Затем выполните перенос. Шаблон: замените DIR каталогом копии вне базы и Git, PLAN_FINGERPRINT — отпечатком плана",
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
          label:
            status.pending?.kind === "migration"
              ? "Остановите процессы Relay и продолжите миграцию с исходной резервной копией"
              : "Остановите процессы Relay. Шаблон: замените DIR каталогом новой резервной копии вне базы и Git-рабочей копии",
          command: invocation([
            "storage",
            "migrate",
            ...(status.pending?.kind === "migration" ? [] : ["--backup-dir", "DIR"]),
          ]),
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
    { title: "Предупреждения", body: warningsText(status.warnings, status.warningsTotal, options) },
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
      commands: withoutBlockerCommands(
        statusCommands(status, invocation),
        status.blockers,
        invocation,
      ),
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
        ...(empty
          ? ([["Отношения и адреса", "план не затрагивает"]] satisfies OutputField[])
          : ([
              [
                "Отношения",
                `сохраняются ${plan.changes.relations.kept}, отзываются ${plan.changes.relations.revoked}, создаются ${plan.changes.relations.created}`,
              ],
              [
                "Адреса",
                `резервов сохраняется ${plan.changes.addresses.reservedKept}, перенаправляется ${plan.changes.addresses.relocated}`,
              ],
            ] satisfies OutputField[])),
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
        { title: "Предупреждения", body: warningsText(plan.warnings, plan.warningsTotal, options) },
      ],
      commands: !plan.applicable
        ? withoutBlockerCommands(
            plan.status === "recovery-required"
              ? statusCommands(plan, invocation)
              : [
                  {
                    label: "Устраните блокеры и повторите диагностику",
                    command: invocation(["storage", "status"]),
                  },
                ],
            plan.blockers,
            invocation,
          )
        : empty
          ? []
          : [
              {
                label:
                  "Применить этот план. Шаблон: замените DIR каталогом резервной копии вне базы и Git-рабочей копии",
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
