import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { SWRResponse } from "swr";
import { getEntityMaterialRelations } from "../adapters/materials.adapter";
import { DocumentAccessError } from "../errors/document-errors";
import type { EntityMaterialRelations } from "../types/entity-material-relations.type";
import { useMaterialsSubscription } from "./use-materials-subscription.hook";

/** Ключ полного набора связей материалов с сущностью. */
type EntityMaterialRelationsKey = readonly ["entity-material-relations", string, string];

/** Ключ чтения; null отключает его. Второй элемент — проект, как у прочих чтений материалов. */
const getEntityMaterialRelationsKey = (
  projectId: string,
  ref: string | null,
): EntityMaterialRelationsKey | null =>
  ref === null ? null : ["entity-material-relations", projectId, ref];

/**
 * Читает полный набор связей материалов вне архива с сущностью (`kind:id`): точное «уже
 * прикреплён» для любого материала, а не только для показанной порции. data отсутствует,
 * пока набор не прочитан до конца или после ошибки чтения, — это «неизвестно», не «нет связи».
 * Набор перечитывается после записей материалов и сигналов проекта; при отключении (ref null)
 * кеш сбрасывается, поэтому следующее подключение не показывает прошлое состояние.
 */
export const useEntityMaterialRelations = (
  projectId: string,
  ref: string | null,
): SWRResponse<EntityMaterialRelations, Error> => {
  const { mutate } = useSWRConfig();
  const response = useSWR<EntityMaterialRelations, Error, EntityMaterialRelationsKey | null>(
    getEntityMaterialRelationsKey(projectId, ref),
    ([, project, target]: EntityMaterialRelationsKey) =>
      getEntityMaterialRelations(project, target),
    { shouldRetryOnError: false },
  );
  useEffect(() => {
    const key = getEntityMaterialRelationsKey(projectId, ref);
    if (key === null) return;
    return () => void mutate(key, undefined, { revalidate: false });
  }, [mutate, projectId, ref]);
  useMaterialsSubscription(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof DocumentAccessError))
    throw response.error;
  return response;
};
