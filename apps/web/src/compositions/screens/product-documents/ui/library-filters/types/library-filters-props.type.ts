import type { ComponentPropsWithoutRef } from "react";
import type { DocumentInput, MaterialFacets, MaterialFormat } from "domains/documents";

/** Параметры фильтров каталога. */
export type LibraryFiltersParams = {
  /** Проект для выбора записи и подсказок тегов. */
  projectId: string;
  /** Серверные счётчики вариантов при текущих условиях; undefined до первого чтения. */
  facets: MaterialFacets | undefined;
  /** Выбранный тип или null. */
  kind: DocumentInput["documentKind"] | null;
  /** Выбранный формат или null. */
  format: MaterialFormat | null;
  /** Выбранное состояние или null. */
  status: "draft" | "active" | null;
  /** Состояние задано представлением и не выбирается. */
  isStatusFixed: boolean;
  /** Выбранные теги. */
  tags: string[];
  /** Адрес выбранной записи или null. */
  target: string | null;
  /** Изменение одного условия; null снимает его. */
  onChange: (name: "kind" | "format" | "status" | "target", value: string | null) => void;
  /** Изменение набора тегов. */
  onTagsChange: (tags: string[]) => void;
};
/** Атрибуты группы фильтров. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onChange">;
/** Свойства фильтров каталога. */
export type LibraryFiltersProps = RootAttrs & LibraryFiltersParams;
