import type { EntityCodec, EntityStorageRegistry } from "../../entity-store/registry.js";
import { registryError } from "../errors.js";

/** Замороженный исторический вид: коллекция на диске и происхождение. */
export type HistoricalKind = {
  readonly kind: string;
  readonly collection: string;
  /** Публичный ли адрес (ключ, алиасы) у записей вида. */
  readonly addressable: boolean;
  /** Git SHA и источник, где вид существовал; номер релиза не приписывается. */
  readonly provenance: string;
};

/**
 * Исторические виды, которых нет (или не было в этой форме) в текущем реестре хранения.
 * Версии и схемы этих видов объявляют входы зарегистрированных переходов, а не каталог:
 * без перехода запись такого вида даёт STORAGE_TRANSITION_MISSING, а не молчаливый пропуск.
 */
export const HISTORICAL_KINDS: readonly HistoricalKind[] = Object.freeze([
  {
    kind: "plan-stage",
    collection: "plan-stages",
    addressable: true,
    provenance: "43d683b (1afe138^): packages/core/src/storage — этапы плана отдельными записями",
  },
  {
    kind: "release-snapshot",
    collection: "release-snapshots",
    addressable: false,
    provenance: "43d683b (1afe138^): application/releases/snapshot.ts — технический снимок выпуска",
  },
  {
    kind: "release-snapshot-entry",
    collection: "release-snapshot-entries",
    addressable: false,
    provenance: "43d683b (1afe138^): application/releases/snapshot.ts — элемент снимка выпуска",
  },
]);

export type CatalogEntry = {
  readonly kind: string;
  readonly collection: string;
  readonly addressable: boolean;
  /** Кодек текущего реестра хранения; null — вид только исторический. */
  readonly codec: EntityCodec | null;
};

/**
 * Каталог видов для обхода базы: текущие определения workspaceStorageRegistry плюс
 * замороженные исторические виды. Движок не перечисляет предметные виды сам.
 */
export class HistoricalKindCatalog {
  private readonly byKind = new Map<string, CatalogEntry>();
  private readonly byCollection = new Map<string, CatalogEntry>();

  constructor(
    storage: EntityStorageRegistry,
    historical: readonly HistoricalKind[] = HISTORICAL_KINDS,
  ) {
    for (const codec of storage.definitions())
      this.add({
        kind: codec.kind,
        collection: codec.collection,
        addressable: codec.addressable !== false,
        codec,
      });
    for (const entry of historical) {
      const existing = this.byKind.get(entry.kind);
      if (existing) {
        if (existing.collection !== entry.collection)
          throw registryError(
            "collection-conflict",
            "Исторический вид хранился в другой коллекции, чем текущий кодек",
            { owner: entry.kind, current: existing.collection, expected: entry.collection },
          );
        continue;
      }
      this.add({
        kind: entry.kind,
        collection: entry.collection,
        addressable: entry.addressable,
        codec: null,
      });
    }
  }

  private add(entry: CatalogEntry): void {
    const clash = this.byCollection.get(entry.collection);
    if (clash || this.byKind.has(entry.kind))
      throw registryError("collection-conflict", "Вид или коллекция объявлены дважды", {
        owner: entry.kind,
        ...(clash ? { id: clash.kind } : {}),
      });
    this.byKind.set(entry.kind, entry);
    this.byCollection.set(entry.collection, entry);
  }

  entries(): readonly CatalogEntry[] {
    return [...this.byKind.values()];
  }

  entry(kind: string): CatalogEntry | undefined {
    return this.byKind.get(kind);
  }

  /** Вид по каталогу entities/<collection>; undefined — неизвестная коллекция. */
  kindOfCollection(collection: string): string | undefined {
    return this.byCollection.get(collection)?.kind;
  }
}
