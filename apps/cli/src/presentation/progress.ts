import type { Progress, ProgressPageQuery, ProgressAddress } from "@relay/contracts/progress";
import type { TextOptions } from "./theme.js";
import { wrap, section } from "./layout.js";
import { safeText } from "./text.js";
import { planningStatusLabels, planningColumnLabel } from "./planning.js";
import { cardText, listText } from "./common.js";

/** Человек видит полный итог и может раскрыть составляющую отдельной командой. */
export function progressText(
  progress: Progress,
  query: ProgressPageQuery,
  options: TextOptions,
  command: (tokens: readonly string[]) => string,
): string {
  const parts = [
    cardText(
      {
        title: `Прогресс · ${progress.entity.key ?? progress.entity.id} · ${progress.entity.title}`,
        fields: [
          ["Итог", progress.completed ? "Выполнено" : "Не выполнено"],
          ["Область расчёта", "Полный предметный состав; итоги не зависят от страницы"],
          ["Лимит каждого списка", query.limit === undefined ? undefined : String(query.limit)],
        ],
      },
      options,
    ),
  ];
  const text = (value: string) => parts.push(wrap(value, options.width));
  const showCollection = (value: {
    items: readonly unknown[];
    total: number;
    nextOffset: number | null;
  }) => value.items.length > 0 || value.total > 0 || value.nextOffset !== null;
  const list = (
    title: string,
    value: {
      items: (ProgressAddress & { completed: boolean; column?: string; status?: string })[];
      total: number;
      nextOffset: number | null;
    },
  ) => {
    if (!showCollection(value)) return;
    parts.push(
      listText(
        {
          title: `${title} · показано ${value.items.length} из ${value.total}`,
          items: value.items.map((entry) => ({
            key: entry.key ?? `${entry.kind}:${entry.id}`,
            title: entry.title,
            details: [
              entry.completed ? "Выполнено" : "Не выполнено",
              ...(entry.column ? [`Колонка: ${planningColumnLabel(entry.column)}`] : []),
              ...(entry.status
                ? [`Состояние: ${planningStatusLabels[entry.status] ?? entry.status}`]
                : []),
            ],
          })),
          emptyMessage: value.total
            ? "На этой странице записей нет; полный состав непуст."
            : "На этой странице записей нет; чтение продолжается.",
        },
        options,
      ),
    );
  };
  if (progress.kind === "task") {
    text(
      `Колонка: ${planningColumnLabel(progress.column)}\nМожно завершить: ${progress.canComplete ? "да" : "нет"}\nКритерии: ${progress.acceptance.completed}/${progress.acceptance.total}`,
    );
    if (progress.planning)
      text(
        `Текущий план: ${safeText(progress.planning.planKey)} · ${safeText(progress.planning.planTitle)}\nЭтап: ${safeText(progress.planning.stageTitle)} (${progress.planning.stageId})`,
      );
    if (showCollection(progress.criteria))
      parts.push(
        section(
          `Критерии приёмки · показано ${progress.criteria.items.length} из ${progress.criteria.total}`,
          progress.criteria.items
            .map((entry) =>
              wrap(
                `${entry.completed ? "✓" : "○"} ${safeText(entry.title)} (${entry.id})`,
                options.width,
              ),
            )
            .join("\n") || "На этой странице критериев нет.",
          options,
        ),
      );
    list("Подзадачи", progress.children);
    list("Обязательные зависимости", progress.dependencies);
  } else if (progress.kind === "release") {
    text(
      `Текущая готовность: ${progress.readiness.ready}/${progress.readiness.total} планов\nСостояние: ${planningStatusLabels[progress.status]}\nИсточник: актуальные планы, не исторический снимок выпуска.${progress.status === "released" ? "\nФакт выпуска сохранён независимо от текущей готовности." : ""}`,
    );
    list("Планы", progress.plans);
  } else {
    text(`Уникальные задачи состава: ${progress.counts.completed}/${progress.counts.total}`);
    if (!progress.counts.total)
      parts.push(
        wrap(
          "Задач в учитываемом составе нет. Отсутствие работы не означает выполнение обязательств.",
          options.width,
        ),
      );
    if (progress.kind === "implementation")
      text(
        `Участие: ${progress.active ? "активно" : "снято"}\nВид: ${progress.implementationKind === "FI" ? "Реализация фичи" : "Реализация сценария"}\nПриложение: ${safeText(progress.application.key ?? progress.application.id)} · ${safeText(progress.application.title)}\nЦель: ${safeText(progress.target.key ?? progress.target.id)} · ${safeText(progress.target.title)}`,
      );
    if (progress.kind === "application")
      text(
        `Задачи с продуктовыми целями: ${progress.businessTasks.completed}/${progress.businessTasks.total}\nВсе задачи досок приложения: ${progress.allTasks.completed}/${progress.allTasks.total}`,
      );
    if ("tasks" in progress && progress.kind !== "work-plan") list("Прямые задачи", progress.tasks);
    if ("implementations" in progress) list("Реализации", progress.implementations);
    if (progress.kind === "feature") list("Сценарии", progress.scenarios);
    if (progress.kind === "product") list("Фичи", progress.features);
    if (progress.kind === "work-plan") {
      text(
        `Состояние: ${planningStatusLabels[progress.status]}\nМожно начать: ${progress.canStart ? "да" : "нет"}\nМожно завершить: ${progress.canComplete ? "да" : "нет"}\nРасхождение с завершением: ${progress.diverged ? "есть" : "нет"}`,
      );
      list("Явный состав задач", progress.tasks);
      if (showCollection(progress.stages))
        parts.push(
          section(
            `Этапы · показано ${progress.stages.items.length} из ${progress.stages.total}`,
            progress.stages.items
              .map((stage) =>
                wrap(
                  `${safeText(stage.title)} · ${stage.counts.completed}/${stage.counts.total}\nID этапа: ${stage.id}`,
                  options.width,
                ),
              )
              .join("\n") || "Этапов на странице нет.",
            options,
          ),
        );
    }
  }
  parts.push(
    section(
      `Причины · показано ${progress.reasons.items.length} из ${progress.reasons.total}`,
      progress.reasons.items
        .map((reason) => {
          const source = reason.source;
          const self = source.kind === progress.entity.kind && source.id === progress.entity.id;
          const kind = source.kind === "work-plan" ? "plan" : source.kind;
          const ref = source.key ?? `${source.kind}:${source.id}`;
          const tokens =
            self && source.kind === "release"
              ? ["release", "plans", ref]
              : self && source.kind === "work-plan"
                ? ["plan", "stage", "list", ref]
                : [kind, self ? "get" : "progress", ...(source.kind === "product" ? [] : [ref])];
          return `${wrap(`${safeText(ref)} · ${safeText(source.title)}\n${safeText(reason.message)}`, options.width)}\n→ ${command(tokens)}`;
        })
        .join("\n\n") ||
        (progress.reasons.total
          ? "На этой странице причин нет; причины есть на других страницах."
          : progress.completed
            ? "Невыполненных обязательств нет."
            : "Причины не возвращены; это не подтверждение выполнения."),
      options,
    ),
  );
  return parts.join("\n\n");
}
