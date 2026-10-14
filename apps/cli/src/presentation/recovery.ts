import type { AppError } from "@relay/core/shared/errors";
import { actionsText, type OutputCommand } from "./common.js";
import type { TextOptions } from "./theme.js";
import { wrap } from "./layout.js";
import { safeText } from "./safe.js";

/** Только подтверждённый контекст подключения; серверные пути не считаются локальными. */
export interface RecoveryContext {
  command: (args: readonly string[]) => string;
  maintenance?: (args: readonly string[]) => string;
  actorAvailable?: boolean;
  deletion?: {
    preview: readonly string[];
    catalogs: readonly { label: string; args: readonly string[] }[];
    confirming: boolean;
  };
}

type Cause = { code: string; details?: unknown };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Оболочка HTTP-записи — контекст запроса, а не сама предметная причина. JSON не меняется. */
export function unwrapServerDetails(details: unknown): unknown {
  const envelope = record(details);
  return envelope &&
    Object.hasOwn(envelope, "serverDetails") &&
    typeof envelope.requestId === "string" &&
    typeof envelope.url === "string"
    ? envelope.serverDetails
    : details;
}

function ownerAddress(details: unknown): string | undefined {
  const data = record(details);
  // owner может обозначать вид хранения, а не адрес: строку владельца не угадываем.
  const ref = record(data?.owner) ?? record(data?.ref);
  if (typeof data?.ref === "string" && data.ref) return data.ref;
  return typeof ref?.kind === "string" && typeof ref.id === "string"
    ? `${ref.kind}:${ref.id}`
    : undefined;
}

/** Выбирает действия по причине; не читает граф повторно и не исправляет данные. */
export function diagnosticRecovery(
  error: AppError,
  options: TextOptions,
  context?: RecoveryContext,
): string | undefined {
  const deletion = context?.deletion;
  if (context && deletion) {
    if (error.code === "REVISION_CONFLICT")
      return [
        wrap(
          "Следующий шаг: заново изучите полный предпросмотр и согласуйте решение. Не подставляйте свежую версию к прежнему подтверждению автоматически.",
          options.width,
        ),
        actionsText(
          [
            {
              label: "Прочитать полный каскад без удаления",
              command: context.command(deletion.preview),
            },
          ],
          options,
        ),
      ].join("\n\n");
    if (error.code === "PLANNING_REFERENCE_IN_USE")
      return [
        wrap(
          "Следующий шаг: изучите ссылки планов из причины отказа. Удаление заблокировано; закрытый план неизменяем и штатного снятия его ссылок нет. После согласованного изменения открытого плана заново изучите полный предпросмотр.",
          options.width,
        ),
        actionsText(
          [{ label: "Найти планы выбранного проекта", command: context.command(["plan", "list"]) }],
          options,
        ),
      ].join("\n\n");
    if (
      deletion.confirming &&
      ["SERVER_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(error.code)
    )
      return [
        wrap(
          "Следующий шаг: ответ удаления не получен, но запись могла завершиться. Сначала проверьте оставшиеся каталоги и снятые ссылки; не повторяйте POST вслепую. request-id не обеспечивает дедупликацию.",
          options.width,
        ),
        actionsText(
          deletion.catalogs.map(({ label, args }) => ({ label, command: context.command(args) })),
          options,
        ),
      ].join("\n\n");
  }
  const details = unwrapServerDetails(error.details);
  const causes: Cause[] =
    error.code === "VALIDATION_FAILED" && Array.isArray(details)
      ? details.flatMap((item) => {
          const cause = record(item);
          return typeof cause?.code === "string"
            ? [{ code: cause.code, details: unwrapServerDetails(cause.details) }]
            : [];
        })
      : [{ code: error.code, details }];
  const codes = new Set(causes.map(({ code }) => code));
  const changed = codes.has("GRAPH_CHANGED");
  const index = codes.has("STORAGE_INDEX_STALE") || codes.has("STORAGE_INDEX_CORRUPT");
  const managed = codes.has("RELATION_MANAGED") || codes.has("MANAGED_RELATIONS_MISMATCH");
  const damaged = causes.some(
    ({ code, details }) =>
      ["INVALID_DATA", "STORAGE_DATA_CORRUPT", "STORAGE_REFERENCE_BROKEN"].includes(code) ||
      (Array.isArray(record(details)?.issues) && typeof record(details)?.path === "string"),
  );
  if (!changed && !index && !managed && !damaged && error.code !== "VALIDATION_FAILED") return;

  const prose: string[] = [];
  const commands: OutputCommand[] = [];
  const addRead = (label: string, args: string[]) => {
    if (context) commands.push({ label, command: context.command(args) });
  };
  if (changed) {
    prose.push(
      "Перечитайте граф без устаревшего курсора. Сравните сохранённые связи со своим изменением; не повторяйте запись и не подставляйте новую версию автоматически.",
    );
    addRead("Прочитать текущий граф и версию", ["inspect", "graph", "list"]);
  }
  if (damaged) {
    prose.push(
      "Сначала восстановите указанные записи и ссылки из проверенной копии либо исправьте содержимое после сравнения. Reindex не исправляет JSON, поля схемы или предметные ссылки.",
    );
  }
  if (managed) {
    prose.push(
      "Управляемую связь изменяют предметной командой владельца, не прямым ремонтом графа. Для рассогласования сохранённых отношений предусмотрено отдельное явное storage reconcile-relations.",
    );
    for (const owner of new Set(
      causes
        .filter(({ code }) => /MANAGED/.test(code))
        .map(({ details }) => ownerAddress(details))
        .filter((owner): owner is string => !!owner),
    )) {
      addRead(`Прочитать адрес владельца ${owner} и найти предметную команду`, [
        "inspect",
        "resolve",
        owner,
      ]);
    }
  }
  if (index || managed || damaged) {
    prose.push(
      "Перед локальным обслуживанием остановите писателей и сохраните резервную копию базы.",
    );
    if (context?.maintenance) {
      if (damaged && !causes.some(({ details }) => typeof record(details)?.path === "string")) {
        commands.push({
          label: "Диагностика файлов без исправления",
          command: context.maintenance(["storage", "status"]),
        });
      }
      if (index || damaged) {
        commands.push({
          label: damaged
            ? "Только после восстановления содержимого: перестроить индексы"
            : "Явно перестроить производные индексы (не содержимое записей)",
          command: context.maintenance(["storage", "reindex"]),
        });
      }
      if (managed) {
        if (!context.actorAvailable)
          prose.push(
            "Для согласования нужен автор: --actor или RELAY_ACTOR. Сначала изучите условия команды.",
          );
        commands.push({
          label: context.actorAvailable
            ? "Отдельное явное согласование отношений после проверки и резерва"
            : "Условия явного согласования отношений",
          command: context.maintenance([
            "storage",
            "reconcile-relations",
            ...(!context.actorAvailable ? ["--help"] : []),
          ]),
        });
      }
    } else if (context) {
      prose.push(
        "Обслуживание недоступно через HTTP. Оператор работает локально на стороне Server с реальной конфигурацией выбранного проекта, не клиентским workspace-реестром. CLI не подставляет удалённый путь как локальный.",
      );
      if (index && !damaged)
        prose.push("Для производных индексов требуется явное storage reindex.");
    } else {
      prose.push(
        "Подключение не установлено. Сначала уточните реальную конфигурацию проекта; CLI не выбирает другую базу для обслуживания.",
      );
    }
    addRead("После восстановления: проверить целостность", ["doctor", "check"]);
    // Чтение остаётся доступным и в remote-only/workspace; ремонт здесь не выполняется.
    if (!context?.maintenance)
      addRead("Прочитать сохранённые отношения", ["inspect", "graph", "list"]);
  } else if (error.code === "VALIDATION_FAILED") {
    prose.push(
      "Исправьте перечисленные причины целостности, сохранив исходные данные. Проверка не выполняет автоматический ремонт.",
    );
    addRead("Повторить проверку после исправления", ["doctor", "check"]);
  }
  return [
    "Следующий шаг:",
    ...prose.map((line) => wrap(safeText(line), options.width)),
    actionsText(commands, options),
  ]
    .filter(Boolean)
    .join("\n\n");
}
