import { useState } from "react";
import { readStored, writeStored } from "infra/browser-storage";

/**
 * Помнит раскрытие панели каталога для этого браузера: удобство зрителя, а не условие выдачи.
 * Без доступного хранилища панель начинает с исходного положения и переключается как обычно.
 */
export const usePanelPreference = (
  name: string,
  initial: boolean,
): [boolean, (value: boolean) => void] => {
  const storageKey = `relay:library:${name}`;
  const [value, setValue] = useState(() => {
    const stored = readStored(storageKey);
    return typeof stored === "boolean" ? stored : initial;
  });
  const update = (next: boolean): void => {
    setValue(next);
    writeStored(storageKey, next);
  };
  return [value, update];
};
