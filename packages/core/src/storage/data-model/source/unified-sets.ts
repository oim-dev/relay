import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { StorageBlocker } from "@relay/contracts/storage-maintenance";
import { relative, sep } from "node:path";
import { createFsSourceIo } from "../../migration/unified-sources.js";
import { Problems, readKeyspaces, readRelationSets } from "../transitions/physical-unified.js";
import type { TransitionRegistry } from "../registry.js";
import type { PhysicalRecordCatalog } from "../types.js";
import { blockerOf } from "./reader.js";

/**
 * Полное чтение отношений и пространств ключей формата 4 замороженными строгими схемами
 * (те же, что у физических переходов unified 1/2/3): владелец и сегменты набора, отпечатки
 * сегментов, повторы ID рёбер, неизвестные поля и объекты. Используется явными `status`,
 * `dry-run` и `migrate`; обычное открытие базы его не выполняет.
 */

/** Служебные файлы VCS/ОС допустимы в любом каталоге и не являются неизвестной структурой. */
const SERVICE = new Set([".gitignore", ".gitkeep", ".DS_Store", "Thumbs.db"]);

export type UnifiedSets = {
  readonly relations: readonly { owner: EntityRef; value: JsonValue }[];
  readonly keyspaces: readonly StoredKeySpace[];
  readonly blockers: readonly StorageBlocker[];
};

function catalogOf(registry: TransitionRegistry): PhysicalRecordCatalog {
  return {
    kindOfCollection(collection) {
      try {
        return registry.kindOfCollection(collection);
      } catch {
        return undefined;
      }
    },
    collectionOf: (kind) => registry.catalog.entry(kind)?.collection,
    validateRecord: (value): StoredRecord => registry.validateRecord(value),
  };
}

export async function readUnifiedSets(
  source: { readonly root: string; readonly configPath: string },
  registry: TransitionRegistry,
  owned: () => void,
): Promise<UnifiedSets> {
  const io = createFsSourceIo({
    root: source.root,
    layout: "unified-4",
    configName: relative(source.root, source.configPath).split(sep).join("/"),
    configPath: source.configPath,
    catalog: catalogOf(registry),
  });
  const problems = new Problems();
  let relations: { owner: EntityRef; value: JsonValue }[] = [];
  let keyspaces: StoredKeySpace[] = [];
  try {
    relations = await readRelationSets(io, owned, problems);
    keyspaces = await readKeyspaces(io, owned, problems);
  } catch (error) {
    problems.addError(error);
  }
  const blockers: StorageBlocker[] = [];
  for (const error of problems.errors) {
    const blocker = blockerOf(error);
    const name = blocker.path?.split("/").at(-1);
    if (blocker.code === "STORAGE_FORMAT_UNKNOWN" && name && SERVICE.has(name)) continue;
    // Каталог неизвестной коллекции сам по себе не данные: каждый файл в нём уже блокирует
    // инвентаризация `readStorageSource` (UNKNOWN_ENTITY_KIND), а пустой остаток прежней
    // раскладки (relations/current и т. п.) безвреден.
    if (blocker.code === "UNKNOWN_ENTITY_KIND" && blocker.path?.split("/").length === 2) continue;
    blockers.push(blocker);
  }
  return { relations, keyspaces, blockers };
}
