import type { LibrarySettings } from "domains/documents";

/** Навигация общей библиотеки. */
export type LibraryNavigationProps = {
  /** Прочитанные настройки разделов. */
  settings: LibrarySettings;
  /** Выбранное представление либо section:ID. */
  selected: string;
  /** Серверные счётчики представлений и разделов: all, pinned, draft, none, unattached, archived, section:ID. */
  counts: Partial<Record<string, number>>;
  /** Пояснение, по какой области посчитаны числа. */
  countScope: string;
  /** Переход без потери поискового контекста. */
  onSelect: (value: string) => void;
};
