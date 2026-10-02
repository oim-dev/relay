import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RESTORE_PAGES } from "../config/library.config";
import { readReturnPoint } from "../helpers/library-return-point";

/** Объём, достигнутый продолжением выдачи на этом экране. */
type ReachedVolume = {
  /** Выдача: проект и условия выборки. */
  catalogKey: string;
  /** Число показанных порций. */
  pages: number;
};

/**
 * Определяет показанный объём каталога и его продолжение, сохраняя объём в адресе.
 * Запрошенное адресом число порций предварительно загружается не больше RESTORE_PAGES,
 * если этот объём не был показан в этой вкладке: точка возврата из карточки или reload
 * восстанавливает его полностью. Продолжение пользователем добавляет по одной порции без предела.
 * Некорректное или чрезмерное значение приводится в адресе к фактическому объёму.
 */
export const useCatalogVolume = (
  projectId: string,
  catalogKey: string,
  location: string,
  requested: number,
): { pages: number; loadMore: () => void } => {
  const [params, setParams] = useSearchParams();
  const [reached, setReached] = useState<ReachedVolume | null>(() =>
    readReturnPoint(projectId)?.location === location ? { catalogKey, pages: requested } : null,
  );
  const allowed =
    reached?.catalogKey === catalogKey ? Math.max(reached.pages, RESTORE_PAGES) : RESTORE_PAGES;
  const pages = Math.min(requested, allowed);
  const canonical = pages > 1 ? String(pages) : null;
  const current = params.get("pages");
  useEffect(() => {
    if (current === canonical) return;
    setParams(
      (latest) => {
        const next = new URLSearchParams(latest);
        if (canonical === null) next.delete("pages");
        else next.set("pages", canonical);
        return next;
      },
      { replace: true },
    );
  }, [current, canonical, setParams]);
  /** Добавляет следующую порцию без новой записи истории. */
  const loadMore = (): void => {
    const next = pages + 1;
    setReached({ catalogKey, pages: next });
    setParams(
      (latest) => {
        const updated = new URLSearchParams(latest);
        updated.set("pages", String(next));
        return updated;
      },
      { replace: true },
    );
  };
  return { pages, loadMore };
};
