import type { ComponentPropsWithoutRef } from "react";

/** Параметры описания области поиска. */
export type SearchScopeParams = {
  /** Строка поиска; пустая — описываются только условия. */
  query: string;
  /** Части выбранной области: представление, раздел, тип, прикрепление. */
  scopeParts: string[];
  /** Выбранная область уже всей библиотеки. */
  isNarrow: boolean;
  /** Поиск той же строки по всей библиотеке. */
  onSearchEverywhere: () => void;
  /** Сброс поиска и всех условий. */
  onReset: () => void;
};
/** Атрибуты строки области. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства описания области поиска. */
export type SearchScopeProps = RootAttrs & SearchScopeParams;
