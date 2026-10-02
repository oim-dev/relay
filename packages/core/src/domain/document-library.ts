/** Правила материала библиотеки знаний, общие для записи, каталога и массовых действий. */

/** Обрезает края, отбрасывает пустые и повторы без учёта регистра; первое написание сохраняется. */
export function normalizeDocumentTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const folded = documentTagKey(tag);
    if (!tag || seen.has(folded)) continue;
    seen.add(folded);
    result.push(tag);
  }
  return result;
}

/** Ключ сравнения тегов: без учёта регистра и формы Unicode. */
export const documentTagKey = (tag: string) => tag.trim().normalize("NFC").toLocaleLowerCase();

/** Прежние записи без поля формата остаются Markdown-материалами. */
export const documentFormatOf = (fields: { documentFormat?: "markdown" | "link" | undefined }) =>
  fields.documentFormat ?? "markdown";
