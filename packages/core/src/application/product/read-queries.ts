import {
  productLintPageSchema,
  productLintQuerySchema,
  productOverviewMapPageSchema,
  productOverviewMapQuerySchema,
} from "@relay/contracts/product-query";
import type {
  ProductLintQuery,
  ProductLintPage,
  ProductLintWarning,
  ProductOverviewMapQuery,
  ProductOverviewMapPage,
} from "@relay/contracts/product-query";
import { parse } from "../../domain/validation.js";
import { resolveProductAddress } from "../../domain/product-addresses.js";
import type { Workspace } from "../../storage/workspace.js";
import { productState, productVersion } from "./model.js";
import { lintProductText } from "./content.js";
import {
  assertProductPageVersion,
  publicProductAddresses,
  publicProductCard,
  readProductSelection,
} from "./read-model.js";
import { readOverviewSources, overviewSnapshotVersion } from "./overview.js";
import { overviewCompletion } from "./operator.js";

export async function readProductLint(
  workspace: Workspace,
  input: ProductLintQuery = {},
): Promise<ProductLintPage> {
  const query = parse(productLintQuerySchema, input, "проверка содержания продукта");
  return workspace.locked(async (owned) => {
    const { records, addresses } = await readProductSelection(workspace, owned);
    const version = productVersion(records);
    assertProductPageVersion(query.version, version);
    const selected = query.ref ? resolveProductAddress(addresses, query.ref) : undefined;
    const warnings: ProductLintWarning[] = [];
    let checked = 0;
    for (const record of records) {
      const fields = record.fields;
      if (fields.kind === "scope") {
        const contracts = fields.contracts.filter((entry) =>
          selected ? entry.id === selected.id : entry.active,
        );
        if (!selected || contracts.length) checked++;
        for (const contract of contracts) {
          for (const warning of lintProductText("implementation", contract.description)) {
            const card = publicProductCard(addresses, contract.id);
            warnings.push(
              productLintPageSchema.shape.warnings.element.parse({
                ...card,
                canonicalRef: card.key,
                implementationTarget: contract.scenarioId === null ? "feature" : "scenario",
                recordId: record.id,
                field: `contracts.${contract.id}.description`,
                ...warning,
              }),
            );
          }
        }
      } else if (!selected || selected.id === record.id) {
        checked++;
        const card = publicProductCard(addresses, record.id);
        for (const warning of lintProductText(
          fields.kind,
          fields.kind === "document" ? fields.body : fields.description,
        ))
          warnings.push(
            productLintPageSchema.shape.warnings.element.parse({
              ...card,
              canonicalRef: card.key,
              implementationTarget: null,
              recordId: record.id,
              field: fields.kind === "document" ? "body" : "description",
              ...warning,
            }),
          );
      }
    }
    const next = query.offset + query.limit;
    return productLintPageSchema.parse({
      warnings: warnings.slice(query.offset, next),
      records: checked,
      version,
      total: warnings.length,
      nextOffset: next < warnings.length ? next : null,
    });
  });
}

/** Тот же состав и snapshot guard, что у overview; без расчёта/передачи его подборок. */
export async function readProductOverviewMap(
  workspace: Workspace,
  input: ProductOverviewMapQuery = {},
): Promise<ProductOverviewMapPage> {
  const query = parse(productOverviewMapQuerySchema, input, "страница карты продукта");
  return workspace.locked(async (owned) => {
    const sources = await readOverviewSources(workspace, owned);
    const snapshotVersion = overviewSnapshotVersion(sources);
    assertProductPageVersion(query.version, snapshotVersion);
    const state = productState(
      sources.productId,
      sources.records,
      sources.tasks,
      overviewCompletion(sources),
    );
    const statuses = new Map(state.readiness.map((entry) => [entry.id, entry.status]));
    const addresses = publicProductAddresses(sources.records);
    const next = query.offset + query.limit;
    return productOverviewMapPageSchema.parse({
      productId: state.productId,
      version: state.version,
      snapshotVersion,
      total: state.records.length,
      nextOffset: next < state.records.length ? next : null,
      items: state.records.slice(query.offset, next).map((record) => {
        const subject = publicProductCard(
          addresses,
          record.fields.kind === "scope" ? record.fields.applicationId : record.id,
        );
        return {
          id: record.id,
          kind: record.fields.kind,
          revision: record.revision,
          name:
            record.fields.kind === "scope" ? `Состав приложения ${subject.title}` : subject.title,
          subject,
          status: statuses.get(record.id) ?? null,
        };
      }),
    });
  });
}
