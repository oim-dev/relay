import { createHash } from "node:crypto";
import type { ProductRecord } from "../../domain/product.js";
import type { ProductImplementation } from "../../domain/product-implementation.js";
import { productAddresses, resolveProductAddress } from "../../domain/product-addresses.js";
import type { ProductAddress } from "../../domain/product-addresses.js";
import { ProductRepository } from "../../storage/product.js";
import type { Workspace } from "../../storage/workspace.js";
import { invariant } from "../../shared/errors.js";
import { validateProduct } from "./model.js";

/** Публичные адреса, включая алиасы самостоятельных реализаций, из одного чтения. */
export async function readProductSelection(workspace: Workspace, owned: () => void) {
  const repository = new ProductRepository(workspace);
  const snapshot = await repository.snapshot(owned);
  validateProduct(snapshot.records);
  return {
    ...snapshot,
    repository,
    addresses: publicProductAddresses(snapshot.records, snapshot.implementations),
  };
}

export function publicProductAddresses(
  records: ProductRecord[],
  implementations = new Map<string, ProductImplementation>(),
) {
  return productAddresses(records)
    .filter((entry) => entry.kind !== "scope")
    .map((entry) => ({
      ...entry,
      kind: entry.kind === "passport" ? "product" : entry.kind,
      aliases: implementations.get(entry.id)?.reservedKeys ?? entry.aliases,
    }));
}

export function publicProductCard(addresses: ProductAddress[], id: string) {
  const selected = resolveProductAddress(addresses, id);
  return {
    ref: { kind: selected.kind, id: selected.id },
    key: selected.key ?? `${selected.kind}:${selected.id}`,
    title: selected.name,
  };
}

export function assertProductPageVersion(expected: string | undefined, actual: string) {
  invariant(
    expected === undefined || expected === actual,
    "VERSION_CONFLICT",
    "Состояние изменилось. Начните чтение с первой страницы.",
    4,
    { version: actual },
  );
}

export function productReadVersion(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
