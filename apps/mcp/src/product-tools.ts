import { z } from "zod";
import { productMutationSchema } from "@relay/core/domain/product";
import type { Backend } from "@relay/project-runtime/backend/types";
import type { ProductMutation } from "@relay/core/domain/product";
import type { Result } from "./output.js";

const fields = productMutationSchema.shape.fields.options;
export const productWriteTools = [
  {
    name: "product_passport_save",
    kind: "passport",
    title: "паспорт продукта",
    schema: fields[0].omit({ kind: true }),
  },
  {
    name: "product_feature_save",
    kind: "feature",
    title: "фичу: цель, правила и критерии приёмки",
    schema: fields[1].omit({ kind: true }),
  },
  {
    name: "product_scenario_save",
    kind: "scenario",
    title: "сценарий: участник, предусловия, шаги, ошибки и результат",
    schema: fields[2].omit({ kind: true }),
  },
  {
    name: "product_application_save",
    kind: "application",
    title: "приложение: ответственность и границы",
    schema: fields[3].omit({ kind: true }),
  },
  {
    name: "product_document_save",
    kind: "document",
    title: "документ: ТЗ, правило, описание или решение",
    schema: fields[4].omit({ kind: true }),
  },
] as const;

export const productWriteArguments = productMutationSchema.omit({
  fields: true,
  actor: true,
}).shape;
export const productScopeArguments = fields[5].omit({ kind: true }).shape;
export const productContractArguments = fields[6].omit({ kind: true }).shape;
export const scopeRevision = z
  .number()
  .int()
  .nonnegative()
  .describe("Ревизия состава; 0 при первом сохранении, иначе значение из прочитанного состава");

/** Результат текущего запроса без хранения для последующего повтора. */
export async function saveProduct(
  backend: Backend,
  command: ProductMutation,
  actor: string,
): Promise<Result> {
  const saved = await backend.product.mutate(command, actor);
  const fields = command.fields;
  const name = "name" in fields ? fields.name : "title" in fields ? fields.title : undefined;
  const labels = {
    passport: "Паспорт",
    feature: "Фича",
    scenario: "Сценарий",
    application: "Приложение",
    document: "Документ",
    scope: "Состав приложения",
    contract: "Контракт",
    implementation: "Реализация",
  };
  return {
    data: {
      ...saved,
      kind: fields.kind,
      action: command.action,
      ...(name ? { name } : {}),
      requestId: command.requestId,
    },
    text: `${command.action === "create" ? "Создана запись" : "Сохранена запись"}: ${labels[fields.kind]}${name ? ` «${name.replace(/[\u0000-\u001f\u007f]/g, " ")}»` : ""}\nID: ${saved.id}\nРевизия: ${saved.revision}\nrequestId: ${command.requestId}`,
  };
}
