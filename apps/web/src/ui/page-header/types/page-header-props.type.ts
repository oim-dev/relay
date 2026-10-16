import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/** Параметры шапки страницы. */
export type PageHeaderParams = {
  /** Единственный заголовок страницы первого уровня. */
  title: ReactNode;
  /**
   * Ссылка на заголовок, если экран переводит на него фокус при входе:
   * заголовок становится программно фокусируемым.
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /** Контекст над заголовком: проект, раздел, идентификатор. */
  meta?: ReactNode;
  /** Пояснение или краткое содержание под заголовком. */
  description?: ReactNode;
  /** Действия и сведения о состоянии страницы. */
  actions?: ReactNode;
  /**
   * Раскладка действий: stack — столбец сведений и действия у правого края,
   * inline — строка действий записи справа от заголовка,
   * toolbar — строка инструментов каталога (поиск, фильтры, создание) шириной до 44rem.
   */
  actionsLayout?: "stack" | "inline" | "toolbar";
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"header">, "children" | "title">;
/** Свойства шапки страницы. */
export type PageHeaderProps = RootAttrs & PageHeaderParams;
