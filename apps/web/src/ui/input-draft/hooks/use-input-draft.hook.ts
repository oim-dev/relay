import { useEffect, useRef, useState } from "react";

/**
 * Хранит ввод поля локально и передаёт каждое изменение владельцу значения (например, адресу).
 *
 * Поле, управляемое напрямую из адреса, теряет символы быстрого ввода: адрес обновляется
 * навигацией позже нажатий, и поле успевает отрисовать устаревшее значение. Здесь поле
 * показывает собственный черновик, а внешнее значение остаётся источником для изменений
 * извне (Back/Forward, переход по ссылке, сброс фильтров): собственные записи, вернувшиеся
 * из адреса, пропускаются, любое другое значение заменяет черновик.
 *
 * @param value Текущее значение у владельца, например строка поиска из адреса.
 * @param onCommit Записывает новое значение у владельца.
 * @returns Черновик для поля и обработчик его изменения.
 */
export const useInputDraft = (
  value: string,
  onCommit: (nextValue: string) => void,
): [string, (nextValue: string) => void] => {
  const [draft, setDraft] = useState(value);
  const writtenRef = useRef<string[]>([]);
  useEffect(() => {
    const index = writtenRef.current.indexOf(value);
    if (index >= 0) {
      writtenRef.current = writtenRef.current.slice(index + 1);
      return;
    }
    writtenRef.current = [];
    setDraft(value);
  }, [value]);
  const change = (nextValue: string): void => {
    setDraft(nextValue);
    writtenRef.current.push(nextValue);
    onCommit(nextValue);
  };
  return [draft, change];
};
