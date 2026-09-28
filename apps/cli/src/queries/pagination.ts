import { z } from "zod";
import { decodeCursor, encodeCursor } from "@relay/core/shared/cursor";
import type { OutputFormat, Result } from "./result.js";
import type { TextOptions } from "../presentation/theme.js";

export interface PageOptions {
  /** Совместимый helper для старых команд; размер определяется числом элементов. */
  limit?: number;
  maxBytes?: number;
  format: OutputFormat;
  cursor?: string;
  text?: TextOptions;
  all?: boolean;
  project?: string;
  storage?: string;
}

export function creationKey(item: { createdAt: string; id: string }): string {
  return `${item.createdAt}/${item.id}`;
}

export function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Курсор всегда указывает на последний выданный элемент. */
export function paginate<T>(
  items: readonly T[],
  key: (item: T) => string,
  scope: unknown,
  options: PageOptions,
  descending = false,
  render?: (items: readonly T[], options: TextOptions) => string,
): Result {
  if (options.project) scope = { project: options.project, storage: options.storage, query: scope };
  const order = descending ? -1 : 1;
  const after = options.cursor ? decodeCursor(options.cursor, scope, z.string()) : undefined;
  const available = [...items]
    .sort((a, b) => order * compareKeys(key(a), key(b)))
    .filter((item) => after === undefined || order * compareKeys(key(item), after) > 0);
  const selected: T[] = [];
  const response = (truncated = false): Result => {
    const hasMore = selected.length < available.length;
    const page = [...selected];
    return {
      data: { items: page },
      ...(render ? { text: (view: TextOptions) => render(page, view) } : {}),
      meta: {
        ...(options.project ? { project: options.project } : {}),
        hasMore,
        nextCursor: hasMore && selected.length ? encodeCursor(scope, key(selected.at(-1)!)) : null,
        truncated,
      },
    };
  };
  // Сначала пробуем страницу целиком: последней странице не нужен длинный курсор.
  // Для помещающегося рабочего списка это также исключает рендеринг каждого префикса.
  const candidates = options.all ? available : available.slice(0, options.limit ?? 20);
  for (const item of candidates) selected.push(item);
  return response();
}
