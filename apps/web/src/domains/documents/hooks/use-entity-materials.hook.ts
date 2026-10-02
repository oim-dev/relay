import useSWRInfinite from "swr/infinite";
import type { SWRInfiniteResponse } from "swr/infinite";
import { getEntityMaterialsPage } from "../adapters/materials.adapter";
import { DocumentAccessError } from "../errors/document-errors";
import type { EntityMaterialsPage } from "../types/document.type";
import { useMaterialsSubscription } from "./use-materials-subscription.hook";

/**
 * Читает материалы, прикреплённые непосредственно к сущности (`kind:id`, ключ или ID), порциями по 50.
 * archived: null — все, true — только архив, false — без архива. ref null отключает чтение.
 * Продолжение читается в версии предыдущей порции; при обновлении все порции перечитываются от первой.
 */
export const useEntityMaterials = (
  projectId: string,
  ref: string | null,
  archived: boolean | null = false,
): SWRInfiniteResponse<EntityMaterialsPage, Error> => {
  const response = useSWRInfinite<EntityMaterialsPage, Error>(
    (index: number, previous: EntityMaterialsPage | null) => {
      if (ref === null || previous?.nextOffset === null) return null;
      return [
        "entity-materials",
        projectId,
        ref,
        archived,
        index === 0 ? 0 : previous?.nextOffset,
        previous?.version,
      ];
    },
    ([, project, target, isArchived, offset, version]: [
      string,
      string,
      string,
      boolean | null,
      number,
      string | undefined,
    ]) => getEntityMaterialsPage(project, target, isArchived, offset, version),
    { revalidateAll: true, shouldRetryOnError: false, keepPreviousData: true },
  );
  useMaterialsSubscription(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof DocumentAccessError))
    throw response.error;
  return response;
};
