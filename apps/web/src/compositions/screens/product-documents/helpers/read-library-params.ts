import { DOCUMENT_KIND_OPTIONS, normalizeMaterialTags } from "domains/documents";
import type { MaterialCatalogFilters, MaterialView } from "domains/documents";
import { VIEW_LABELS } from "../config/library.config";

/** Проверяет известное представление каталога. */
const isMaterialView = (value: string): value is MaterialView => value in VIEW_LABELS;

/**
 * Разбирает адрес каталога в условия выборки и запрошенный объём.
 * Неизвестные значения не ломают экран и приводятся к значениям по умолчанию;
 * допустимый к загрузке объём определяет экран, а не разбор адреса.
 */
export const readLibraryParams = (
  params: URLSearchParams,
): { filters: MaterialCatalogFilters; pages: number } => {
  const view = params.get("view") ?? "all";
  const kind = DOCUMENT_KIND_OPTIONS.find((entry) => entry.value === params.get("kind"));
  const pages = Number.parseInt(params.get("pages") ?? "1", 10);
  const format = params.get("format");
  const status = params.get("status");
  return {
    filters: {
      q: params.get("q") ?? "",
      view: isMaterialView(view) ? view : "all",
      section: params.get("section") || null,
      kind: kind?.value ?? null,
      target: params.get("target") || null,
      sort: params.get("sort") === "title" ? "title" : "updated",
      tags: normalizeMaterialTags(params.getAll("tags")),
      format: format === "markdown" || format === "link" ? format : null,
      status: status === "draft" || status === "active" ? status : null,
    },
    pages: Number.isFinite(pages) ? Math.max(1, pages) : 1,
  };
};
