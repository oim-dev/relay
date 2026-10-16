import type { DocumentRelation } from "domains/documents";

/** Условия создания материала, переданные через адрес редактора. */
export type EditorParams = {
  /** Адрес сущности `kind:id`, к которой материал прикрепляется при создании. */
  attach: string | null;
  /** Смысл начального прикрепления. */
  relation: DocumentRelation["type"];
  /** Внутренний адрес возврата после создания; null — открыть карточку материала. */
  returnTo: string | null;
  /** Раздел библиотеки по умолчанию. */
  section: string | null;
};

/**
 * Разбирает адрес редактора: `attach=<kind>:<id>`, `relation=references|documents`,
 * `return=<путь внутри проекта>`, `section=<ID>`. Прежний параметр `target` читается как `attach`.
 * Возврат допускается только внутрь текущего проекта SPA, чтобы адрес не увёл на чужой сайт.
 */
export const readEditorParams = (params: URLSearchParams, basePath: string): EditorParams => {
  const attach = params.get("attach") || params.get("target") || null;
  const requested = params.get("return");
  const isInternal =
    requested !== null &&
    (requested === basePath ||
      requested.startsWith(`${basePath}/`) ||
      requested.startsWith(`${basePath}?`)) &&
    !requested.includes("\\") &&
    !requested.startsWith("//");
  return {
    attach,
    relation: params.get("relation") === "documents" ? "documents" : "references",
    returnTo: isInternal ? requested : null,
    section: params.get("section") || null,
  };
};
