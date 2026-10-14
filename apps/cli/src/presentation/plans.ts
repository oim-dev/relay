import type { PlanSummary, PlanningCounts } from "@relay/contracts/planning";
import { AppError } from "@relay/core/shared/errors";
import { PresentedError } from "../output.js";
import { cardText, listText, type OutputCommand, type OutputField } from "./common.js";
import { planningStatusLabels } from "./planning.js";
import { renderMarkdown } from "./markdown.js";
import { wrap } from "./layout.js";
import { diagnosticValueText, safeText } from "./text.js";
import { unwrapServerDetails } from "./recovery.js";
import type { TextOptions } from "./theme.js";

/** Полные показатели Core, не пересчёт по видимой странице. */
export function planCountFields(counts: PlanningCounts): OutputField[] {
  return [
    ["Выполнено задач", `${counts.completed}/${counts.total}`],
    ["В работе", counts.active],
    ["На проверке", counts.review],
    ["Заблокировано", counts.blocked],
  ];
}

/** Собственная карточка плана; общие рендереры релизов не меняются. */
export function planCardText(
  plan: PlanSummary,
  options: TextOptions,
  commands: readonly OutputCommand[],
): string {
  return cardText(
    {
      title: `${plan.key} · ${plan.title}`,
      fields: [
        ["Состояние", planningStatusLabels[plan.status]],
        ["Ревизия", plan.revision],
        ["Этапов", plan.stageCount],
        ...planCountFields(plan.counts),
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
        ...[
          ["Цель", plan.goal],
          ["Обоснование", plan.rationale],
          ["Границы", plan.boundaries],
          ["Ожидаемый результат", plan.expectedResult],
          ["Итог", plan.result],
        ]
          .filter(([, body]) => body?.trim())
          .map(([title, body]) => ({ title: title!, body: renderMarkdown(body!, options) })),
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
      commands,
    },
    options,
  );
}

/** Один набор примеров на страницу; большие тексты и footer остаются у своих владельцев. */
export function planListText(
  title: string,
  items: Parameters<typeof listText>[0]["items"],
  query: Record<string, unknown>,
  options: TextOptions,
  commands: readonly OutputCommand[],
): string {
  const labels: Record<string, string> = {
    q: "Поиск",
    status: "Состояние",
    board: "Доска",
    plan: "План",
    stage: "Этап",
    availableOnly: "Только доступные",
    projection: "Проекция",
  };
  return listText(
    {
      title,
      filters: Object.entries(query)
        .filter(([key, value]) => key in labels && value !== undefined)
        .map(([key, value]): OutputField => [
          labels[key]!,
          key === "status" ? (planningStatusLabels[String(value)] ?? String(value)) : String(value),
          ...(["board", "plan", "stage"].includes(key) ? (["opaque"] as const) : ([] as const)),
        ]),
      items,
      emptyMessage: "На этой странице записей нет.",
      commands,
    },
    options,
  );
}

export interface PlanFailureContext {
  plan?: string | undefined;
  stage?: string | undefined;
  task?: string | undefined;
  targetPlan?: string | undefined;
  action: string;
  invoke: (args: readonly string[]) => string;
}

/** Адресное чтение без retry; code/message/details машинной ошибки остаются прежними. */
export function planPresentedError(error: unknown, context: PlanFailureContext): unknown {
  if (!(error instanceof AppError)) return error;
  const { plan, stage, targetPlan, invoke } = context;
  const details = unwrapServerDetails(error.details);
  const taskId =
    details &&
    typeof details === "object" &&
    "taskId" in details &&
    typeof details.taskId === "string"
      ? details.taskId
      : undefined;
  const task = taskId ?? context.task;
  let advice: string;
  let reads: { label: string; args: string[] }[];
  if (plan && ["PLAN_INCOMPLETE", "PLAN_EMPTY", "PLAN_GOAL_REQUIRED"].includes(error.code)) {
    advice =
      "Прочитайте полный прогресс и препятствия. Не повторяйте переход до проверки состава и обязательств.";
    reads = [{ label: "Прогресс плана", args: ["plan", "progress", plan] }];
  } else if (error.code === "TASK_IN_PLAN" && task) {
    advice =
      "Прочитайте текущее участие задачи. Для переноса согласуйте оба плана и их ревизии; повторное включение не заменяет перенос.";
    reads = [{ label: "Участие задачи", args: ["plan", "task", "memberships", task] }];
  } else if (error.code === "STAGE_NOT_EMPTY" && plan && stage) {
    advice =
      "Сначала изучите состав этапа. Исключение задачи из открытого плана и удаление самой задачи — разные действия.";
    reads = [{ label: "Задачи этапа", args: ["plan", "stage", "task", "list", plan, stage] }];
  } else if (error.code === "REVISION_CONFLICT" && plan) {
    advice =
      "Сравните сохранённое состояние со своим изменением. Не подставляйте свежую ревизию автоматически.";
    reads = [
      { label: "Исходный план", args: ["plan", "get", plan] },
      ...(targetPlan && targetPlan !== plan
        ? [{ label: "Целевой план", args: ["plan", "get", targetPlan] }]
        : []),
    ];
  } else if (error.code === "PLAN_CLOSED" && plan) {
    advice =
      "Закрытый план доступен только для чтения; штатного изменения состава, возобновления или удаления нет.";
    reads = [{ label: "Прочитать план", args: ["plan", "get", plan] }];
  } else if (["NOT_FOUND", "INVALID_REFERENCE"].includes(error.code) && plan && stage) {
    advice = "Проверьте адрес плана и ID этапа; ID этапа используется только вместе с планом.";
    reads = [{ label: "Этапы выбранного плана", args: ["plan", "stage", "list", plan] }];
  } else if (
    ["SERVER_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(error.code) &&
    !["get", "list", "candidates", "memberships"].includes(context.action)
  ) {
    advice =
      "Ответ записи не получен: изменение могло сохраниться. Сначала перечитайте состояние; request-id не защищает от повторной записи.";
    reads = [
      { label: "Проверить состояние", args: plan ? ["plan", "get", plan] : ["plan", "list"] },
    ];
  } else return error;
  return new PresentedError(error.code, error.message, error.exitCode, error.details, (options) =>
    cardText(
      {
        title: error.message,
        sections: [
          ...(error.details === undefined
            ? []
            : [{ title: "Подробности", body: diagnosticValueText(error.details) }]),
          { title: "Следующий шаг", body: wrap(advice, options.width) },
        ],
        commands: reads.map(({ label, args }) => ({ label, command: invoke(args) })),
      },
      options,
    ),
  );
}
