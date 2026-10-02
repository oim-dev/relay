import type { MaterialCatalogPage } from "domains/documents";
import type { CatalogMaterial } from "../ui/material-list";

/**
 * Склеивает порции одной версии выдачи в список без повторов.
 * Материал без свойств документа в каталог не попадает.
 */
export const uniqueMaterials = (pages: MaterialCatalogPage[]): CatalogMaterial[] => {
  const seen = new Set<string>();
  const result: CatalogMaterial[] = [];
  for (const material of pages.flatMap((page) => page.items)) {
    const { document } = material;
    if (document === undefined || seen.has(material.ref.id)) continue;
    seen.add(material.ref.id);
    result.push({ ...material, document });
  }
  return result;
};
