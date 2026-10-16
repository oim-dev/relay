import type { HTMLAttributes, ReactNode } from "react";

/** Параметры строки записи. */
export type RecordRowParams = {
  /**
   * Название записи. Переход к записи — ссылка внутри названия, а не вся строка:
   * так текст строки можно выделять, а кнопки в trailing остаются отдельными.
   */
  title: ReactNode;
  /** Технический ключ записи над названием: показывается моноширинным шрифтом. */
  code?: ReactNode;
  /** Начало строки: checkbox выбора, значок вида записи. */
  leading?: ReactNode;
  /** Пояснения под названием: краткое содержание, тип, раздел, теги. */
  meta?: ReactNode;
  /**
   * Конец строки: состояние (StatusBadge), сведения и действия. При нехватке ширины
   * переносится под название.
   */
  trailing?: ReactNode;
  /** Запись выбрана для массового действия. */
  selected?: boolean;
  /** Корневой элемент: li — пункт списка, article — самостоятельная запись выдачи. */
  component?: "div" | "li" | "article";
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<HTMLAttributes<HTMLElement>, "children" | "title">;
/** Свойства строки записи. */
export type RecordRowProps = RootAttrs & RecordRowParams;
