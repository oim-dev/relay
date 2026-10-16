import type { ProductState } from "../../domain/product.js";
import { productIdSchema } from "../../domain/product.js";
import { z } from "zod";
import { invariant } from "../../shared/errors.js";

export const productContentQuerySchema = z.strictObject({
  id: productIdSchema.optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(30),
});
export type ProductContentQuery = z.input<typeof productContentQuerySchema>;

export interface ContentWarning {
  id: string;
  name: string;
  field: string;
  code: "UNSTRUCTURED_MARKDOWN" | "MISSING_ACCEPTANCE";
  message: string;
}

/** Одна классификация для совместимой утилиты и адресного серверного lint. */
export function lintProductText(
  kind: string,
  text: string,
): Pick<ContentWarning, "code" | "message">[] {
  const warnings: Pick<ContentWarning, "code" | "message">[] = [];
  if (text.length >= 200 && !/^#{1,6}\s|^\s*(?:[-*+] |\d+[.)] )/m.test(text))
    warnings.push({
      code: "UNSTRUCTURED_MARKDOWN",
      message:
        "Большое описание без разделов или списков: выделите цель, правила, ошибки и результат.",
    });
  if (
    (kind === "feature" || kind === "scenario") &&
    !/(критери|при[её]мк|проверк|результат)/iu.test(text)
  )
    warnings.push({
      code: "MISSING_ACCEPTANCE",
      message: "Не найдены критерии или проверяемый результат. Уточните, как принять требование.",
    });
  return warnings;
}

/** Структурные подсказки: не заменяют содержательную проверку требований человеком. */
export function lintProduct(state: ProductState, input: ProductContentQuery = {}) {
  const query = productContentQuerySchema.parse(input);
  const records = state.records.filter((record) => !query.id || record.id === query.id);
  invariant(
    !query.id || records.length > 0,
    "PRODUCT_RECORD_NOT_FOUND",
    "Запись для проверки содержания не найдена",
    3,
  );
  const warnings: ContentWarning[] = [];
  for (const record of records) {
    const data = record.fields;
    const texts =
      data.kind === "scope"
        ? data.contracts
            .filter((entry) => entry.active)
            .map((entry) => ({
              field: `contracts.${entry.id}.description`,
              name: entry.title,
              text: entry.description,
            }))
        : [
            {
              field: data.kind === "document" ? "body" : "description",
              name: data.name,
              text: data.kind === "document" ? data.body : data.description,
            },
          ];
    for (const entry of texts) {
      for (const warning of lintProductText(data.kind, entry.text))
        warnings.push({
          id: record.id,
          name: entry.name,
          field: entry.field,
          ...warning,
        });
    }
  }
  const nextOffset = query.offset + query.limit;
  return {
    warnings: warnings.slice(query.offset, nextOffset),
    records: records.length,
    total: warnings.length,
    nextOffset: nextOffset < warnings.length ? nextOffset : null,
  };
}
