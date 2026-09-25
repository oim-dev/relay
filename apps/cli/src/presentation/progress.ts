import Table from "cli-table3";
import type { Progress, ProgressPageQuery, ProgressAddress } from "@relay/contracts/progress";
import type { TextOptions } from "./theme.js";
import type { GlobalOptions } from "../context.js";
import { wrap, section } from "./layout.js";
import { safeText } from "./text.js";
import { planningStatusLabels } from "./planning.js";

/** Человек видит полный итог и может раскрыть составляющую отдельной командой. */
export function progressText(
  progress: Progress,
  query: ProgressPageQuery,
  options: TextOptions,
  globals: GlobalOptions = {},
): string {
  const quote = (value: string) => `'${safeText(value).replaceAll("'", "'\\''")}'`;
  const command = [
    "relay-cli",
    ...(globals.config ? ["--config", quote(globals.config)] : []),
    ...(globals.project ? ["--project", quote(globals.project)] : []),
    ...(globals.serverUrl ? ["--server-url", quote(globals.serverUrl)] : []),
    ...(globals.local ? ["--local"] : []),
    ...(globals.format ? ["--format", globals.format] : []),
    ...(globals.maxBytes === undefined ? [] : ["--max-bytes", String(globals.maxBytes)]),
  ].join(" ");
  const parts = [
    section(
      `Прогресс · ${safeText(progress.entity.title)}`,
      `${progress.entity.key ?? progress.entity.id}\n${progress.completed ? "Выполнено" : "Не выполнено"}`,
      options,
    ),
  ];
  const continuations = new Set<number>();
  const list = (
    title: string,
    value: {
      items: (ProgressAddress & { completed: boolean })[];
      total: number;
      nextOffset: number | null;
    },
  ) => {
    if (value.nextOffset !== null) continuations.add(value.nextOffset);
    const table = new Table({
      head: ["Адрес", "Название", "Выполнено"],
      wordWrap: true,
      colWidths: [25, Math.max(20, options.width - 46), 13],
      style: { head: [], border: [] },
    });
    table.push(
      ...value.items.map((entry) => [
        `${entry.kind}:${entry.id}`,
        safeText(entry.title),
        entry.completed ? "Да" : "Нет",
      ]),
    );
    const body =
      value.items.length === 0
        ? "На этой странице записей нет."
        : options.width < 80
          ? value.items
              .map((entry) =>
                wrap(
                  `${entry.kind}:${entry.id} · ${safeText(entry.title)}\n${entry.completed ? "Выполнено" : "Не выполнено"}`,
                  options.width,
                ),
              )
              .join("\n\n")
          : table.toString();
    parts.push(section(`${title} · всего ${value.total}`, body, options));
  };
  if (progress.kind === "task") {
    parts.push(
      `Колонка: ${progress.column}\nМожно завершить: ${progress.canComplete ? "да" : "нет"}\nКритерии: ${progress.acceptance.completed}/${progress.acceptance.total}`,
    );
    parts.push(
      section(
        "Критерии приёмки",
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
    if (progress.criteria.nextOffset !== null) continuations.add(progress.criteria.nextOffset);
    list("Подзадачи", progress.children);
    list("Обязательные зависимости", progress.dependencies);
  } else if (progress.kind === "release") {
    parts.push(
      `Текущая готовность: ${progress.readiness.ready}/${progress.readiness.total} планов\nСостояние: ${planningStatusLabels[progress.status]}\nИсточник: актуальные планы`,
    );
    list("Планы", progress.plans);
  } else {
    parts.push(`Уникальные задачи состава: ${progress.counts.completed}/${progress.counts.total}`);
    if (progress.kind === "implementation")
      parts.push(
        `Участие: ${progress.active ? "активно" : "снято"}\nВид: ${progress.implementationKind}\nПриложение: ${safeText(progress.application.title)}`,
      );
    if (progress.kind === "application")
      parts.push(
        `Задачи с продуктовыми целями: ${progress.businessTasks.completed}/${progress.businessTasks.total}\nВсе задачи досок приложения: ${progress.allTasks.completed}/${progress.allTasks.total}`,
      );
    if ("tasks" in progress) list("Прямые задачи", progress.tasks);
    if ("implementations" in progress) list("Реализации", progress.implementations);
    if (progress.kind === "feature") list("Сценарии", progress.scenarios);
    if (progress.kind === "product") list("Фичи", progress.features);
    if (progress.kind === "work-plan") {
      parts.push(
        `Состояние: ${planningStatusLabels[progress.status]}\nМожно начать: ${progress.canStart ? "да" : "нет"}\nМожно завершить: ${progress.canComplete ? "да" : "нет"}\nРасхождение с завершением: ${progress.diverged ? "есть" : "нет"}`,
      );
      parts.push(
        section(
          `Этапы · всего ${progress.stages.total}`,
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
      if (progress.stages.nextOffset !== null) continuations.add(progress.stages.nextOffset);
    }
  }
  parts.push(
    section(
      `Причины · всего ${progress.reasons.total}`,
      progress.reasons.items
        .map(
          (reason) =>
            `${wrap(safeText(reason.message), options.width)}\n→ ${command} progress ${reason.source.kind}${reason.source.kind === "product" ? "" : ` ${reason.source.kind}:${reason.source.id}`}`,
        )
        .join("\n\n") || "На этой странице причин нет.",
      options,
    ),
  );
  if (progress.reasons.nextOffset !== null) continuations.add(progress.reasons.nextOffset);
  for (const offset of continuations)
    parts.push(
      `Продолжение: ${command} progress ${progress.kind}${progress.kind === "product" ? "" : ` ${progress.kind}:${progress.entity.id}`} --offset ${offset} --limit ${query.limit ?? 20} --snapshot-version ${progress.version}`,
    );
  parts.push(
    "Раскрытие составляющей: relay-cli progress <вид> <адрес>. Используйте тот же выбранный проект.",
  );
  return parts.join("\n\n");
}
