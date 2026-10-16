import { useEffect, useState } from "react";
import { isDefined } from "shared/value-predicates";

/**
 * Не теряет фокус при перечитывании каталога после ошибки: кнопка «Перечитать список»
 * исчезает вместе с сообщением об ошибке. После успешного чтения фокус переходит к первой
 * восстановленной записи (продолжению, прочитанному сверх показанного), а если новых записей
 * нет — к первой записи. Фокус, оставшийся на элементе страницы, не перехватывается.
 *
 * @param itemIds Идентификаторы показанных записей по порядку.
 * @param reread Перечитывает каталог; завершается после ответа сервера.
 * @returns Обработчик кнопки перечитывания.
 */
export const useRereadFocus = (itemIds: string[], reread: () => Promise<unknown>): (() => void) => {
  const [request, setRequest] = useState<{ from: number } | null>(null);
  useEffect(() => {
    if (request === null) return;
    setRequest(null);
    const active = document.activeElement;
    const isFocusFree = active === null || active === document.body || !active.isConnected;
    const targetId = itemIds[request.from] ?? itemIds[0];
    if (!isFocusFree || !isDefined(targetId)) return;
    document
      .querySelector<HTMLElement>(
        `[data-material-id="${CSS.escape(targetId)}"] [data-material-link]`,
      )
      ?.focus();
  }, [request, itemIds]);
  return () => {
    const from = itemIds.length;
    void reread().then(() => setRequest({ from }));
  };
};
