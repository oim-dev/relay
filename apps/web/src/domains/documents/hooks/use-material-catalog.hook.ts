import { useEffect, useRef } from "react";
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
  const { setSize, size, data, isValidating } = response;
  /*
   * Объём выдачи задаёт адрес, а SWR хранит размер в кеше ключа и при повторном открытии
   * восстанавливает его, игнорируя initialSize. Поэтому объём сверяется с адресом:
   *  - каждое изменение pages после монтирования применяется через setSize, даже если size
   *    уже совпал (пока размер не задан явно, size берётся из initialSize, но недостающие
   *    порции сами не дочитываются);
   *  - при монтировании и смене ключа размер из кеша, отличный от pages, исправляется;
   *  - после завершения чтения число полученных порций сверяется с pages: setSize при монтировании
   *    может совпасть с уже идущей проверкой SWR старого размера и не перечитать выдачу.
   * Одна и та же попытка не повторяется, чтобы ошибка сети не зациклила чтение.
   */
  const loadedPages = data?.length;
  const lastPage = data?.at(-1);
  const hasMorePages = lastPage !== undefined && lastPage.nextOffset !== null;
  const hasPageMismatch =
    !isValidating &&
    loadedPages !== undefined &&
    (loadedPages > pages || (loadedPages < pages && hasMorePages));
  const appliedPagesRef = useRef(pages);
  const attemptRef = useRef("");
  useEffect(() => {
    const attempt = `${pages}:${size}:${String(loadedPages)}`;
    const isPagesChanged = appliedPagesRef.current !== pages;
    if (!isPagesChanged && size === pages && !hasPageMismatch) return;
    if (!isPagesChanged && attemptRef.current === attempt) return;
    appliedPagesRef.current = pages;
    attemptRef.current = attempt;
    void setSize(pages);
  }, [pages, size, loadedPages, hasPageMismatch, setSize]);
  useMaterialsSubscription(projectId, response.mutate);
  if (response.error !== undefined && !(response.error instanceof DocumentAccessError))
    throw response.error;
  return response;
};
