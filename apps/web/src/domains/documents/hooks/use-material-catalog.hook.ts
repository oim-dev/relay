import { useEffect } from "react";
import useSWRInfinite from "swr/infinite";
import type { SWRInfiniteResponse } from "swr/infinite";
import { getMaterialCatalogPage } from "../adapters/documents.adapter";
import { DocumentAccessError } from "../errors/document-errors";
import type { MaterialCatalogFilters, MaterialCatalogPage } from "../types/document.type";
import { useMaterialsSubscription } from "./use-materials-subscription.hook";

/**
 * Читает каталог материалов порциями одной выдачи.
 * Число порций задаёт владелец адреса, чтобы reload и Back/Forward восстанавливали показанный объём.
 * Каждая следующая порция читается в версии предыдущей: при обновлении все порции перечитываются
 * от первой и не склеиваются из разных состояний.
 */
export const useMaterialCatalog = (
  projectId: string,
  filters: MaterialCatalogFilters,
  pages: number,
): SWRInfiniteResponse<MaterialCatalogPage, Error> => {
  const response = useSWRInfinite<MaterialCatalogPage, Error>(
    (index: number, previous: MaterialCatalogPage | null) => {
      if (previous?.nextOffset === null) return null;
      return [
        "material-catalog",
        projectId,
        filters,
        index === 0 ? 0 : previous?.nextOffset,
        previous?.version,
      ];
    },
    ([, project, query, offset, version]: [
      string,
      string,
      MaterialCatalogFilters,
      number,
      string | undefined,
    ]) => getMaterialCatalogPage(project, query, offset, version),
    {
      initialSize: pages,
      revalidateAll: true,
      revalidateFirstPage: false,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  );
  const { size, setSize } = response;
  useEffect(() => {
    if (size !== pages) void setSize(pages);
  }, [pages, size, setSize]);
  useMaterialsSubscription(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof DocumentAccessError))
    throw response.error;
  return response;
};
