import useSWR from "swr";
import type { SWRResponse } from "swr";
import { getMaterialFacets } from "../adapters/materials.adapter";
import { DocumentAccessError } from "../errors/document-errors";
import type { MaterialCatalogFilters, MaterialFacets } from "../types/document.type";
import { useMaterialsSubscription } from "./use-materials-subscription.hook";

/** Условия без строки поиска и без фильтров: счётчики всей библиотеки. */
export const ALL_MATERIALS_FILTERS: MaterialCatalogFilters = {
  q: "",
  view: "all",
  section: null,
  kind: null,
  target: null,
  sort: "updated",
};

/**
 * Читает серверные счётчики каталога по тем же условиям, что и выдача;
 * null отключает чтение. Прежние числа остаются видны до прихода новых.
 */
export const useMaterialFacets = (
  projectId: string,
  filters: MaterialCatalogFilters | null,
): SWRResponse<MaterialFacets, Error> => {
  const response = useSWR<MaterialFacets, Error>(
    filters === null ? null : ["material-facets", projectId, { ...filters, sort: "updated" }],
    ([, project, query]: [string, string, MaterialCatalogFilters]) =>
      getMaterialFacets(project, query),
    { shouldRetryOnError: false, keepPreviousData: true },
  );
  useMaterialsSubscription(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof DocumentAccessError))
    throw response.error;
  return response;
};
