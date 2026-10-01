import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** Записи списка в порядке отображения. */
const listEntries = (list: HTMLElement): HTMLElement[] =>
  [...list.children].filter(
    (item): item is HTMLElement =>
      item instanceof HTMLElement && item.dataset.entryId !== undefined,
  );

/**
 * Выбирает запись, которая заменит исчезнувшую: ближайшую следующую по прежнему
 * порядку, сохранившуюся в новом состоянии (она встала на место исчезнувшей), иначе
 * ближайшую предыдущую. Прежний порядок берётся из предыдущего обновления, поэтому
 * вставки и удаления выше записи с фокусом не сдвигают выбор.
 */
const findReplacementId = (
  previousIds: readonly string[],
  nextIds: ReadonlySet<string>,
  lostId: string,
): string | null => {
  const lostIndex = previousIds.indexOf(lostId);
  if (lostIndex === -1) return null;
  const following = previousIds.slice(lostIndex + 1).find((id) => nextIds.has(id));
  if (following !== undefined) return following;
  return previousIds.slice(0, lostIndex).findLast((id) => nextIds.has(id)) ?? null;
};

/**
 * Сохраняет фокус клавиатуры при обновлении записей списка: если запись с фокусом
 * исчезла из нового состояния, фокус переходит на соседнюю по актуальному порядку
 * запись (вставшую на её место или, в конце списка, предыдущую), а в пустом списке —
 * на запасной элемент, например заголовок. Фокус внутри вложенного содержимого записи,
 * включая вложенные списки, тоже относится к ней. Записи с прежним ID не пересоздаются,
 * поэтому их фокус React сохраняет сам.
 *
 * @param listRef Список, чьи прямые потомки помечены `data-entry-id`.
 * @param entryIds ID записей в порядке отображения.
 * @param fallbackRef Куда перевести фокус, если записей не осталось.
 */
export const useEntryFocus = (
  listRef: RefObject<HTMLElement | null>,
  entryIds: readonly string[],
  fallbackRef: RefObject<HTMLElement | null>,
): void => {
  /** ID записи, в которой последний раз был фокус. */
  const focusedIdRef = useRef<string | null>(null);
  /** ID записей предыдущего обновления в порядке отображения. */
  const previousIdsRef = useRef<readonly string[]>([]);
  const idsKey = entryIds.join("\n");

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const handleFocusIn = (event: FocusEvent): void => {
      const { target } = event;
      if (!(target instanceof Node)) return;
      // Ищется прямая запись этого списка: вложенные записи принадлежат своим спискам.
      const item = listEntries(list).find((entry) => entry.contains(target));
      if (item === undefined) return;
      focusedIdRef.current = item.dataset.entryId ?? null;
    };
    const handleFocusOut = (event: FocusEvent): void => {
      const { target } = event;
      // Человек сам увёл фокус: запоминать запись больше не нужно. Удалённый узел
      // остаётся отсоединённым, и его заменяет эффект ниже.
      requestAnimationFrame(() => {
        if (!(target instanceof Node) || !target.isConnected) return;
        if (!list.contains(document.activeElement)) focusedIdRef.current = null;
      });
    };
    list.addEventListener("focusin", handleFocusIn);
    list.addEventListener("focusout", handleFocusOut);
    return () => {
      list.removeEventListener("focusin", handleFocusIn);
      list.removeEventListener("focusout", handleFocusOut);
    };
  }, [listRef]);

  useLayoutEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split("\n");
    const previousIds = previousIdsRef.current;
    previousIdsRef.current = ids;
    const focusedId = focusedIdRef.current;
    if (focusedId === null || ids.includes(focusedId)) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    focusedIdRef.current = null;
    const replacementId = findReplacementId(previousIds, new Set(ids), focusedId);
    const list = listRef.current;
    const replacement =
      list === null || replacementId === null
        ? undefined
        : listEntries(list).find((entry) => entry.dataset.entryId === replacementId);
    const target =
      replacement?.querySelector<HTMLElement>("a[href], button:not([disabled])") ??
      fallbackRef.current;
    target?.focus({ preventScroll: true });
  }, [idsKey, listRef, fallbackRef]);
};
