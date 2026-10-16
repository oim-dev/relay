/** Состояние выдачи вместо списка. */
export type CatalogStateProps = {
  /** Первое чтение, пустая библиотека или пустая выдача при непустой библиотеке. */
  kind: "loading" | "empty-library" | "empty-result";
  /** Адрес создания материала. */
  createHref: string;
  /** Адрес каталога для возврата из редактора. */
  returnTo: string;
  /** Поиск можно расширить на всю библиотеку с той же строкой. */
  canSearchEverywhere: boolean;
  /** Поиск той же строки по всей библиотеке. */
  onSearchEverywhere: () => void;
  /** Сброс поиска и условий. */
  onReset: () => void;
};
