import Table from "cli-table3";
import { kanbanColumns } from "@relay/contracts/entities/board-task";
import type { PlanSummary, PlanningSaved } from "@relay/contracts/planning";
import type { ReleaseSummary } from "@relay/contracts/releases";
import type { TextOptions } from "./theme.js";
import type { GlobalOptions } from "../context.js";
import { renderMarkdown } from "./markdown.js";
import { safeText } from "./text.js";
import { wrap, section } from "./layout.js";

export const planningStatusLabels: Record<string, string> = {
  draft: "Черновик",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
  planned: "Запланирован",
  released: "Выпущен",
};
const quote = (value: string) => `'${safeText(value).replaceAll("'", "'\\''")}'`;

/** Колонка остаётся отдельным фактом, но читается человеком по-русски. */
export const planningColumnLabel = (column: string): string =>
  kanbanColumns.find((entry) => entry.id === column)?.label ??
  (column === "cancelled" ? "Отменена" : column);

/** Полные тексты плана и серверные показатели, отдельно от исторического статуса. */
export function planText(plan: PlanSummary, options: TextOptions): string {
  return [
    wrap(`${plan.key} · ${safeText(plan.title)}`, options.width),
    `Состояние: ${planningStatusLabels[plan.status]}\nID: ${plan.id}\nРевизия: ${plan.revision}\nЭтапов: ${plan.stageCount}\nВыполнено задач: ${plan.counts.completed}/${plan.counts.total}`,
    wrap(safeText(plan.summary), options.width),
    ...[
      ["Цель", plan.goal],
      ["Обоснование", plan.rationale],
      ["Границы", plan.boundaries],
      ["Ожидаемый результат", plan.expectedResult],
      ["Итог", plan.result],
    ].map(([title, text]) =>
      section(title!, renderMarkdown(text || "Пока не заполнено.", options), options),
    ),
    section(
      "Область",
      plan.scope.map((ref) => `${ref.kind}:${ref.id}`).join("\n") || "Не задана.",
      options,
    ),
    `Этапы: relay-cli plan stages ${quote(plan.key)}\nПрогресс: relay-cli progress work-plan ${quote(plan.key)}`,
  ].join("\n\n");
}
/** Текущая готовность и сохранённый факт выпуска различаются в человеческом выводе. */
export function releaseText(release: ReleaseSummary, options: TextOptions): string {
  return [
    wrap(`${release.key} · ${safeText(release.title)}`, options.width),
    `Версия: ${safeText(release.version)}\nСостояние: ${planningStatusLabels[release.status]}\nID: ${release.id}\nРевизия: ${release.revision}\nТекущая готовность: ${release.readiness.ready}/${release.readiness.total} планов`,
    `Плановая дата: ${release.plannedFor || "—"}\nВыпущен: ${release.releasedAt ?? "—"}\nАвтор выпуска: ${safeText(release.releasedBy ?? "—")}`,
    wrap(safeText(release.summary), options.width),
    renderMarkdown(release.description || "Описание пока не заполнено.", options),
    `Состав: relay-cli release plans ${quote(release.key)}`,
  ].join("\n\n");
}
/** Таблица предметных строк с узким представлением и точной командой продолжения. */
export function planningListText(
  title: string,
  columns: string[],
  rows: string[][],
  page: { total: number; nextOffset: number | null; version: string },
  command: string,
  query: Record<string, unknown>,
  options: TextOptions,
  globals: GlobalOptions,
): string {
  const table = new Table({
    head: columns,
    wordWrap: true,
    colWidths: columns.map(() =>
      Math.max(12, Math.floor((options.width - columns.length - 1) / columns.length)),
    ),
    style: { head: [], border: [] },
  });
  table.push(...rows.map((row) => row.map(safeText)));
  const body =
    rows.length === 0
      ? "На этой странице записей нет."
      : options.width < 90
        ? rows.map((row) => wrap(row.map(safeText).join(" · "), options.width)).join("\n\n")
        : table.toString();
  const context = Object.entries({
    config: globals.config,
    project: globals.project,
    "server-url": globals.serverUrl,
    "max-bytes": globals.maxBytes,
    format: globals.format,
    ...(globals.local ? { local: true } : {}),
  })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => (value === true ? `--${name}` : `--${name} ${quote(String(value))}`))
    .join(" ");
  const next =
    page.nextOffset === null
      ? "Конец списка."
      : `Продолжение: relay-cli ${context} ${command} ${Object.entries({
          ...query,
          offset: page.nextOffset,
          snapshotVersion: page.version,
        })
          .filter(([, value]) => value !== undefined)
          .map(
            ([name, value]) =>
              `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${Array.isArray(value) ? value.map((item) => quote(String(item))).join(" ") : quote(String(value))}`,
          )
          .join(" ")}`;
  return `${title}\n\n${body}\n\nПоказано ${rows.length} из ${page.total}.\n${next}`;
}
/** Ответ текущей записи; результат не хранится для последующего повтора. */
export function planningSavedText(saved: PlanningSaved): string {
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
  const action = labels[saved.action] ?? `Выполнено действие ${safeText(saved.action)}`;
  return `${safeText(saved.key)}: ${action}.\nID владельца: ${saved.id}\nРевизия: ${saved.revision}${saved.stageId ? `\nЭтап: ${saved.stageId}` : ""}${saved.targetRevision ? `\nРевизия целевого плана: ${saved.targetRevision}` : ""}\nИдентификатор запроса: ${safeText(saved.requestId)}`;
}
