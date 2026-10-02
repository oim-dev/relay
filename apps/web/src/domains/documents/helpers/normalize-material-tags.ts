import { MATERIAL_TAG_LIMITS } from "../config/documents.config";

/**
 * Приводит ввод тегов к виду, который сохранит Core: обрезает края, отбрасывает пустые,
 * повторы без учёта регистра (остаётся первое написание) и сверх лимитов контракта.
 */
export const normalizeMaterialTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLocaleLowerCase("ru-RU");
    if (tag === "" || tag.length > MATERIAL_TAG_LIMITS.length || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length === MATERIAL_TAG_LIMITS.count) break;
  }
  return result;
};
