import { useSWRConfig } from "swr";
import type { EntitySaved } from "@relay/contracts/entities";
import { saveDocument, updateMaterialProperties } from "../adapters/documents.adapter";
import { bulkChangeMaterials, relateMaterial } from "../adapters/materials.adapter";
import { toWriteFailure } from "../errors/document-errors";
import { publishMaterialsChanged } from "../operations/materials-changes";
import type {
  DocumentInput,
  MaterialBulkOperation,
  MaterialBulkResult,
  MaterialPropertyChanges,
  MaterialRelationChange,
  MaterialRevision,
} from "../types/document.type";

/** Записи материалов проекта; после каждой записи перечитываются все зависимые чтения. */
export type MaterialMutations = {
  /** Создаёт материал или сохраняет его под ревизией existing. */
  saveMaterial: (
    input: DocumentInput,
    requestId: string,
    existing?: MaterialRevision,
  ) => Promise<EntitySaved>;
  /** Меняет закрепление, раздел или состояние без изменения содержания. */
  changeProperties: (
    material: MaterialRevision,
    changes: MaterialPropertyChanges,
    requestId: string,
  ) => Promise<EntitySaved>;
  /** Массовое действие; частичный результат возвращается без исключения. */
  bulkChange: (
    items: MaterialRevision[],
    operation: MaterialBulkOperation,
    requestId: string,
  ) => Promise<MaterialBulkResult>;
  /** Прикрепляет, изменяет или открепляет одну связь материала. */
  relate: (
    material: MaterialRevision,
    change: MaterialRelationChange,
    requestId: string,
  ) => Promise<EntitySaved>;
};

/**
 * Даёт записи материалов выбранного проекта с согласованным обновлением кешей:
 * каталог, счётчики, карточка, блоки материалов сущностей и прочие чтения проекта
 * перечитываются и после отказа, чтобы следующее решение принималось по актуальной ревизии.
 * Завершение записи не подтверждает успех перечитывания: ошибку чтения хранит и показывает
 * само чтение. Без ответа сервера запись завершается DocumentOutcomeUnknownError — исход неизвестен.
 * Автоматических повторов записи нет; requestId — корреляция, не идемпотентность.
 */
export const useMaterialMutations = (projectId: string): MaterialMutations => {
  const { mutate } = useSWRConfig();
  /** Выполняет запись и запускает перечитывание данных проекта независимо от исхода записи. */
  const withRefresh = async <T>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (failure) {
      throw toWriteFailure(failure);
    } finally {
      publishMaterialsChanged(projectId);
      await mutate((key) => Array.isArray(key) && key[1] === projectId).catch(() => undefined);
    }
  };
  return {
    saveMaterial: (input, requestId, existing) =>
      withRefresh(() => saveDocument(projectId, input, requestId, existing)),
    changeProperties: (material, changes, requestId) =>
      withRefresh(() => updateMaterialProperties(projectId, material, changes, requestId)),
    bulkChange: (items, operation, requestId) =>
      withRefresh(() => bulkChangeMaterials(projectId, items, operation, requestId)),
    relate: (material, change, requestId) =>
      withRefresh(() => relateMaterial(projectId, material, change, requestId)),
  };
};
