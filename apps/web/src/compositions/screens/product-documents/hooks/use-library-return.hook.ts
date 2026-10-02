import { useCallback, useEffect, useRef } from "react";
import { isDefined } from "shared/value-predicates";
import { readReturnPoint, writeReturnPoint } from "../helpers/library-return-point";
import type { ReturnPoint } from "../helpers/library-return-point";

/**
 * Возвращает каталог к прежнему положению после карточки материала, Back или reload.
 * Положение запоминается при уходе с экрана и восстанавливается один раз для того же адреса,
 * когда показан тот же объём выдачи; фокус возвращается к открытому материалу.
 */
export const useLibraryReturn = (
  projectId: string,
  location: string,
  isReady: boolean,
): ((materialId: string) => void) => {
  const locationRef = useRef(location);
  const materialRef = useRef<string | null>(null);
  const scrollRef = useRef(0);
  const pendingRef = useRef<ReturnPoint | null | undefined>(undefined);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);
  useEffect(() => {
    /* К моменту размонтирования новый экран уже сбросил прокрутку, поэтому она запоминается заранее. */
    const track = (): void => {
      scrollRef.current = window.scrollY;
    };
    const save = (): void => {
      writeReturnPoint(projectId, {
        location: locationRef.current,
        scrollY: scrollRef.current,
        materialId: materialRef.current,
      });
    };
    /* Точка возврата читается до первой записи: повторный монтаж в StrictMode её не затирает. */
    if (pendingRef.current === undefined) {
      pendingRef.current = readReturnPoint(projectId);
    }
    track();
    window.addEventListener("scroll", track, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("scroll", track);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [projectId]);
  useEffect(() => {
    const stored = pendingRef.current;
    if (!isReady || !isDefined(stored)) return;
    pendingRef.current = null;
    if (stored.location !== location) return;
    window.scrollTo({ top: stored.scrollY });
    scrollRef.current = stored.scrollY;
    if (stored.materialId === null) return;
    const link = document.querySelector<HTMLElement>(
      `[data-material-id="${CSS.escape(stored.materialId)}"] [data-material-link]`,
    );
    link?.focus({ preventScroll: true });
  }, [isReady, location]);
  return useCallback((materialId: string) => {
    materialRef.current = materialId;
  }, []);
};
