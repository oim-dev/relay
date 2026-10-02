import { defaultTextOptions } from "../presentation/theme.js";
import type { TextOptions } from "../presentation/theme.js";
import { valueText } from "../presentation/text.js";
import { safeText, safeJson } from "../presentation/safe.js";
import { commandText } from "../presentation/common.js";
import { wrap } from "../presentation/layout.js";

export interface CliPage {
  count: number;
  /** Отсутствует, если Backend не сообщает общее количество. */
  total?: number;
  limit: number;
  nextCursor: string | null;
  nextCommand: string | null;
  /** snapshot у offset-страниц — проверка версии текущего состояния, не история. */
  consistency: "snapshot" | "live";
}

export interface Result {
  data: unknown;
  meta?: Record<string, unknown>;
  page?: CliPage;
  /** Человекочитаемое представление не входит в JSON-контракт. */
  text?: string | ((options: TextOptions) => string);
  /**
   * Ненулевой код выхода при полном выводе результата, например частичный отказ
   * массовой операции. Ошибки без результата по-прежнему выбрасываются как AppError.
   */
  exitCode?: number;
}

export type OutputFormat = "json" | "text";

function pageFooter(page: CliPage, options: TextOptions): string {
  const width = Number.isFinite(options.width) ? Math.max(24, Math.min(160, options.width)) : 100;
  return [
    wrap(
      `Показано: ${page.count}${page.total === undefined ? " записей" : ` из ${page.total} подходящих записей`}`,
      width,
    ),
    ...(page.consistency === "live"
      ? [wrap("Живая выборка: данные между страницами могут измениться.", width)]
      : []),
    page.nextCursor !== null
      ? `Есть продолжение\n${page.nextCommand ? commandText(page.nextCommand, options) : `Курсор: ${safeText(page.nextCursor)}`}`
      : "Конец списка",
  ].join("\n");
}

export function serializeResult(
  result: Result,
  format: OutputFormat,
  options: TextOptions = defaultTextOptions,
): string {
  if (format === "json") {
    const meta = { ...result.meta, ...(result.page ? { page: result.page } : {}) };
    return `${safeJson({ ok: true, data: result.data, ...(Object.keys(meta).length ? { meta } : {}) })}\n`;
  }
  const body =
    typeof result.text === "function"
      ? result.text({ ...options, color: false })
      : result.text === undefined
        ? valueText(result.data, options)
        : safeText(result.text);
  const footer = result.page
    ? `\n\n${pageFooter(result.page, options)}`
    : result.meta?.nextCursor
      ? `\n\nПродолжение: --cursor ${safeText(String(result.meta.nextCursor))}`
      : result.meta?.truncated
        ? "\n\nПоказана часть данных."
        : "";
  const rendered = safeText(body + footer);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function resultBytes(
  result: Result,
  format: OutputFormat,
  options: TextOptions = defaultTextOptions,
): number {
  return Buffer.byteLength(serializeResult(result, format, options));
}
