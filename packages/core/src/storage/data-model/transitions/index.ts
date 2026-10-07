import { configSchema } from "../../../domain/config.js";
import { workspaceStorageRegistry } from "../../unified-adapter.js";
import { HISTORICAL_KINDS, HistoricalKindCatalog } from "../history/catalog.js";
import { DATA_MODEL_PROFILES } from "../profiles.js";
import { createTransitionRegistry } from "../registry.js";
import type { TransitionRegistry } from "../registry.js";
import type { DataTransition, PhysicalRecordCatalog, PhysicalTransition } from "../types.js";
import { planningV1ToV2 } from "./planning-v1-to-v2.js";
import { physicalLegacy } from "./physical-legacy.js";
import { physicalUnified1, physicalUnified2, physicalUnified3 } from "./physical-unified.js";

/**
 * Производственный реестр — единственный список определений переходов поставки.
 * Предметные переходы (record/snapshot) и составные физические переходы регистрируются
 * здесь; движок обхода и планирования их не перечисляет.
 *
 * Пакеты переноса подключают свои определения добавлением в эти списки:
 * физические unified 1/2/3 и legacy → 4, предметный planning v1 → v2.
 */
export const DATA_TRANSITIONS: readonly DataTransition[] = Object.freeze([planningV1ToV2]);
export const PHYSICAL_TRANSITIONS: readonly PhysicalTransition[] = Object.freeze([
  physicalLegacy,
  physicalUnified1,
  physicalUnified2,
  physicalUnified3,
]);

let cached: TransitionRegistry | undefined;

/** Проверенный реестр поставки; ошибка определения — STORAGE_REGISTRY_INVALID до работы с базой. */
export function productionTransitionRegistry(): TransitionRegistry {
  if (cached) return cached;
  const storage = workspaceStorageRegistry();
  cached = createTransitionRegistry({
    profiles: DATA_MODEL_PROFILES,
    transitions: DATA_TRANSITIONS,
    physical: PHYSICAL_TRANSITIONS,
    storage,
    historical: new HistoricalKindCatalog(storage, HISTORICAL_KINDS),
    config: configSchema,
  });
  return cached;
}

/**
 * Каталог видов физического шага по реестру переходов: коллекции текущих и исторических
 * видов, проверка записи схемой её версии данных (`registry.validateRecord`).
 */
export function physicalCatalog(
  registry: TransitionRegistry = productionTransitionRegistry(),
): PhysicalRecordCatalog {
  const collections = new Map<string, string>([
    ...workspaceStorageRegistry()
      .definitions()
      .map((entry): [string, string] => [entry.kind, entry.collection]),
    ...HISTORICAL_KINDS.map((entry): [string, string] => [entry.kind, entry.collection]),
  ]);
  return {
    kindOfCollection(collection) {
      try {
        return registry.kindOfCollection(collection);
      } catch {
        return undefined;
      }
    },
    collectionOf: (kind) => collections.get(kind),
    validateRecord: (value) => registry.validateRecord(value),
  };
}
