import { kanbanColumns } from "@relay/contracts/entities/board-task";
import type { PlanSummary, PlanningSaved, PlanStage } from "@relay/contracts/planning";
import type { ReleaseSummary } from "@relay/contracts/releases";
import type { TextOptions } from "./theme.js";
import { defaultTextOptions } from "./theme.js";
import type { GlobalOptions } from "../context.js";
import { renderMarkdown } from "./markdown.js";
import { safeText } from "./text.js";
import { wrap } from "./layout.js";
import { cardText, listText, receiptText } from "./common.js";

const contentSections = (values: string[][], options: TextOptions) =>
  values
    .filter(([, body]) => body?.trim())
    .map(([title, body]) => ({
      title: title!,
      body: renderMarkdown(body!, options),
    }));

export const planningStatusLabels: Record<string, string> = {
  draft: "Черновик",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
  planned: "Запланирован",
  released: "Выпущен",
};

/** Колонка остаётся отдельным фактом, но читается человеком по-русски. */
export const planningColumnLabel = (column: string): string =>
  kanbanColumns.find((entry) => entry.id === column)?.label ??
  (column === "cancelled" ? "Отменена" : column);

/** Полные тексты плана и серверные показатели, отдельно от исторического статуса. */
export function planText(
  plan: PlanSummary,
  options: TextOptions,
  commands: { stages: string; progress: string },
): string {
  return cardText(
    {
      title: `${plan.key} · ${plan.title}`,
      fields: [
        ["Состояние", planningStatusLabels[plan.status]],
        ["Ревизия", plan.revision],
        ["Этапов", plan.stageCount],
        ["Выполнено задач", `${plan.counts.completed}/${plan.counts.total}`],
        [
          "Цель",
          plan.goal.trim()
            ? undefined
            : plan.status === "draft" || plan.status === "active"
              ? "Не задана; нужна для начала плана."
              : "Не была задана; закрытый план доступен только для чтения.",
        ],
        ["Состав", plan.counts.total ? undefined : "Задач нет; пустой план не готов к завершению."],
        ["Участники", plan.participants.join(", ") || undefined],
        ["Начат", plan.startedAt],
        ["Закрыт", plan.closedAt],
        ["Создан", `${plan.createdAt} · ${plan.createdBy}`],
        ["Изменён", `${plan.updatedAt} · ${plan.updatedBy}`],
      ],
      sections: [
        ...(plan.summary.trim()
          ? [{ title: "Краткое описание", body: wrap(safeText(plan.summary), options.width) }]
          : []),
        ...contentSections(
          [
            ["Цель", plan.goal],
            ["Обоснование", plan.rationale],
            ["Границы", plan.boundaries],
            ["Ожидаемый результат", plan.expectedResult],
            ["Итог", plan.result],
          ],
          options,
        ),
        ...(plan.scopeLabels.length
          ? [
              {
                title: "Область",
                body: plan.scopeLabels
                  .map((ref) => `${safeText(ref.label)} (${safeText(ref.ref)})`)
                  .join("\n"),
              },
            ]
          : []),
      ],
      commands: [
        { label: "Этапы", command: commands.stages },
        { label: "Прогресс", command: commands.progress },
      ],
    },
    options,
  );
}
/** Текущая готовность и сохранённый факт выпуска различаются в человеческом выводе. */
export function releaseText(
  release: ReleaseSummary,
  options: TextOptions,
  commands: { plans: string; progress: string },
): string {
  return cardText(
    {
      title: `${release.key} · ${release.title}`,
      fields: [
        ["Версия", release.version],
        ["Состояние", planningStatusLabels[release.status]],
        ["Ревизия", release.revision],
        ["Текущая готовность", `${release.readiness.ready}/${release.readiness.total} планов`],
        ["Плановая дата", release.plannedFor || undefined],
        ["Выпущен", release.releasedAt],
        ["Автор выпуска", release.releasedBy],
        ["Создан", `${release.createdAt} · ${release.createdBy}`],
        ["Изменён", `${release.updatedAt} · ${release.updatedBy}`],
      ],
      sections: [
        ...(release.summary.trim()
          ? [{ title: "Краткое описание", body: wrap(safeText(release.summary), options.width) }]
          : []),
        ...contentSections([["Описание", release.description]], options),
        {
          title: "Состав",
          body: wrap(
            "Готовность вычислена по актуальным планам, не по историческому снимку выпуска." +
              (release.status === "released"
                ? " Факт выпуска сохранён независимо от текущей готовности; запись неизменяема."
                : ""),
            options.width,
          ),
        },
      ],
      commands: [
        { label: "Планы", command: commands.plans },
        { label: "Прогресс", command: commands.progress },
      ],
    },
    options,
  );
}
/** Таблица предметных строк с узким представлением и точной командой продолжения. */
export function planningListText(
  title: string,
  columns: string[],
  rows: string[][],
  _page: { total: number; nextOffset: number | null; version: string },
  _command: string,
  query: Record<string, unknown>,
  options: TextOptions,
  _globals: GlobalOptions,
): string {
  const labels: Record<string, string> = {
    q: "Поиск",
    status: "Состояние",
    board: "Доска",
    plan: "План",
    stage: "Этап",
    availableOnly: "Только доступные",
    plans: "Выбранные планы",
  };
  return listText(
    {
      title,
      filters: Object.entries(query)
        .filter(([key, value]) => key in labels && (value !== undefined || key === "plans"))
        .map(
          ([key, value]) =>
            [
              labels[key]!,
              key === "plans"
                ? Array.isArray(value) && value.length
                  ? value.join(", ")
                  : "Планы не выбраны"
                : key === "status"
                  ? (planningStatusLabels[String(value)] ?? String(value))
                  : String(value),
            ] as const,
        ),
      items: rows.map((row) => ({
        key: row[0]!,
        title: row[1]!,
        details: row.slice(2).map((value, index) => `${columns[index + 2]}: ${value}`),
      })),
      emptyMessage: "На этой странице записей нет.",
    },
    options,
  );
}
/** Полный вложенный объект: тексты и состав не заменяются краткой строкой каталога. */
export function stageText(
  stage: PlanStage & { planId: string; planKey: string | null; planRevision: number },
  options: TextOptions,
  commands: { tasks: string },
): string {
  return cardText(
    {
      title: stage.title,
      fields: [
        ["План", stage.planKey ?? stage.planId],
        ["Ревизия плана", stage.planRevision],
        ["ID этапа", stage.id],
        ["Задач в составе", stage.taskIds.length],
      ],
      sections: [
        ...(stage.summary.trim()
          ? [{ title: "Краткое описание", body: wrap(safeText(stage.summary), options.width) }]
          : []),
        ...contentSections(
          [
            ["Результат", stage.outcome],
            ["Условия завершения", stage.completionConditions],
          ],
          options,
        ),
      ],
      commands: [{ label: "Задачи", command: commands.tasks }],
    },
    options,
  );
}
/** Ответ текущей записи; результат не хранится для последующего повтора. */
export function planningSavedText(
  saved: PlanningSaved,
  options: TextOptions = defaultTextOptions,
  commands: { label: string; command: string }[] = [],
  context: { action?: string; stageId?: string; task?: string; targetPlan?: string } = {},
): string {
  const labels: Record<string, string> = {
    create: "Запись создана",
    update: "Изменения сохранены",
    start: "План начат",
    complete: "План завершён",
    cancel: "Отмена сохранена",
    tasks: "Состав задач обновлён",
    transfer: "Задача перенесена",
    release: "Выпуск зафиксирован",
    plan: "Релиз перепланирован",
    "stage-create": "Этап создан",
    "stage-update": "Этап изменён",
    "stage-remove": "Этап удалён",
    "stage-move": "Порядок этапов изменён",
  };
  const action =
    context.action ?? labels[saved.action] ?? `Выполнено действие ${safeText(saved.action)}`;
  return receiptText(
    {
      title: `${action} · ${saved.key}`,
      fields: [
        ["Ревизия", saved.revision],
        ["ID этапа", context.stageId ?? saved.stageId],
        ["Задача", context.task],
        ["Целевой план", context.targetPlan],
        ["Ревизия целевого плана", saved.targetRevision],
      ],
      commands,
    },
    options,
  );
}
