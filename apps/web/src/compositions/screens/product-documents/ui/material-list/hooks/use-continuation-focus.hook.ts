import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { isDefined } from "shared/value-predicates";

/** Фокус продолжения выдачи и действие «Показать ещё». */
type ContinuationFocus = {
  /** Кнопка продолжения; фокус возвращается к ней, если новых записей не пришло. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** Запоминает показанный объём и запускает продолжение. */
  loadMore: () => void;
};

/**
 * Не теряет фокус при продолжении выдачи: пока кнопка недоступна во время загрузки,
 * браузер снимает с неё фокус. После загрузки фокус переходит к первой новой записи,
 * а если новых записей нет (ошибка) — обратно к кнопке. Фокус, переведённый человеком
 * в другое место, не перехватывается.
 */
export const useContinuationFocus = (
  itemIds: string[],
  isLoadingMore: boolean,
  onLoadMore: () => void,
): ContinuationFocus => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<number | null>(null);
  const hasStartedRef = useRef(false);
  const shownCount = itemIds.length;
  useEffect(() => {
    const from = pendingRef.current;
    if (!isDefined(from)) return;
    /* Решение принимается после завершения начатой загрузки, а не до её начала. */
    if (isLoadingMore) {
      hasStartedRef.current = true;
      return;
    }
    if (!hasStartedRef.current) return;
    pendingRef.current = null;
    hasStartedRef.current = false;
    const active = document.activeElement;
    const isFocusFree = active === null || active === document.body || active === buttonRef.current;
    if (!isFocusFree) return;
    const firstNewId = itemIds[from];
    if (isDefined(firstNewId)) {
      document
        .querySelector<HTMLElement>(
          `[data-material-id="${CSS.escape(firstNewId)}"] [data-material-link]`,
        )
        ?.focus();
      return;
    }
    buttonRef.current?.focus();
  }, [isLoadingMore, itemIds]);
  const loadMore = (): void => {
    pendingRef.current = shownCount;
    hasStartedRef.current = false;
    onLoadMore();
  };
  return { buttonRef, loadMore };
};
