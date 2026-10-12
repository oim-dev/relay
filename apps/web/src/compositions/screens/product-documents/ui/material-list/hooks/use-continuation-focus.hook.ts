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

/** Переводит фокус к ссылке записи каталога. */
const focusMaterial = (materialId: string): void => {
  document
    .querySelector<HTMLElement>(
      `[data-material-id="${CSS.escape(materialId)}"] [data-material-link]`,
    )
    ?.focus();
};

/**
 * Не теряет фокус при продолжении выдачи. Намерение фиксируется нажатием «Показать ещё»:
 * как только появились новые записи, фокус переходит к первой из них — даже если кнопка
 * исчезла, потому что это была последняя порция, или загрузка завершилась быстрее, чем её
 * начало успели заметить. Если загрузка завершилась без новых записей (ошибка, пустая
 * порция), фокус возвращается к кнопке, а если её скрыли (после ошибки продолжение
 * недоступно, сообщение объявляет alert) — к последней показанной записи. Фокус,
 * переведённый человеком в другое место, не перехватывается.
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
    if (isLoadingMore) {
      hasStartedRef.current = true;
      return;
    }
    const firstNewId = itemIds[from];
    /* Без новых записей решение ждёт завершения начатой загрузки. */
    if (!isDefined(firstNewId) && !hasStartedRef.current) return;
    pendingRef.current = null;
    hasStartedRef.current = false;
    const active = document.activeElement;
    const isFocusFree =
      active === null ||
      active === document.body ||
      !active.isConnected ||
      active === buttonRef.current;
    if (!isFocusFree) return;
    if (isDefined(firstNewId)) {
      focusMaterial(firstNewId);
      return;
    }
    const button = buttonRef.current;
    if (button?.isConnected === true) button.focus();
    else {
      const lastShownId = itemIds[from - 1];
      if (isDefined(lastShownId)) focusMaterial(lastShownId);
    }
  }, [isLoadingMore, itemIds]);
  const loadMore = (): void => {
    pendingRef.current = shownCount;
    hasStartedRef.current = false;
    onLoadMore();
  };
  return { buttonRef, loadMore };
};
