import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры страницы продукта. */
export type ProductPageParams = {
  /** Заголовок страницы первого уровня; также задаёт заголовок вкладки. */
  title: string;
  /** Краткий смысл под заголовком; пустая строка не выводится. */
  description?: string;
  /** Контекст над заголовком: ключ, готовность, тип записи. */
  meta?: ReactNode;
  /** Действия страницы либо поиск и фильтры каталога. */
  actions?: ReactNode;
  /**
   * Раскладка действий: inline — действия записи справа от заголовка,
   * toolbar — поиск, фильтры и создание в каталоге.
   */
  actionsLayout?: "inline" | "toolbar";
  /** Содержимое страницы. */
  children?: ReactNode;
};
/** Атрибуты сцены страницы. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "title">;
/** Свойства страницы. */
export type ProductPageProps = RootAttrs & ProductPageParams;
