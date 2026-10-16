import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type MarkdownViewParams = {
  /** Безопасно отображаемый Markdown. */
  text: string;
  /** Компактная типографика для сообщений и раскрываемых подробностей. */
  compact?: boolean;
  /** Подсказка для незаполненного раздела. */
  emptyText?: string;
  /** Смещение уровней заголовков во вложенном материале; текст Markdown не меняется. */
  headingOffset?: 0 | 1 | 2 | 3 | 4 | 5;
  /** Начальный уровень первого реального заголовка; нормализует иерархию без пропусков, имеет приоритет над headingOffset. */
  headingStartLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Разрешает фокус на таблицах и блоках кода для клавиатурной прокрутки широких материалов. */
  focusableBlocks?: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type MarkdownViewProps = RootAttrs & MarkdownViewParams;
